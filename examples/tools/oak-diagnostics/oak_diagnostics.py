#!/usr/bin/env python3
"""Standalone OAK-D Lite RGB-D alignment and USB-link diagnostics."""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence


PROFILE_CONFIGS: dict[str, dict[str, int | float]] = {
    "full": {"width": 1280, "height": 720, "fps": 30.0},
    "balanced": {"width": 960, "height": 540, "fps": 25.0},
    "compact": {"width": 640, "height": 360, "fps": 25.0},
}
DISPLAY_TILE_SIZE = (640, 360)
ISOLATION_STAGES = ("discover", "rgb", "stereo", "rgbd", "health")


def resolve_profile(profile: str) -> dict[str, int | float | str]:
    try:
        config = PROFILE_CONFIGS[profile]
    except KeyError as error:
        raise ValueError(f"unknown profile: {profile}") from error
    return {"profile": profile, **config}


def letterbox_size(source_size: tuple[int, int], max_size: tuple[int, int] = DISPLAY_TILE_SIZE) -> tuple[int, int]:
    source_width, source_height = source_size
    max_width, max_height = max_size
    if source_width <= 0 or source_height <= 0 or max_width <= 0 or max_height <= 0:
        raise ValueError("source and maximum sizes must be positive")
    scale = min(max_width / source_width, max_height / source_height)
    return max(1, round(source_width * scale)), max(1, round(source_height * scale))


def display_layout_size() -> tuple[int, int]:
    return DISPLAY_TILE_SIZE[0] * 2, DISPLAY_TILE_SIZE[1] * 2


def sync_threshold_ms(fps: float) -> float:
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("fps must be a positive finite number")
    return 1000.0 / (2.0 * fps)


def display_device_id(device_id: str) -> str:
    return device_id[-8:] if len(device_id) > 8 else device_id


def usb_link_status(usb_speed: object) -> dict[str, str]:
    """Classify DepthAI USB speed without depending on DepthAI at import time."""
    value = str(usb_speed).upper()
    if "SUPER" in value:
        return {"level": "PASS", "label": "USB 3 SuperSpeed", "value": str(usb_speed)}
    if "HIGH" in value:
        return {"level": "FAIL", "label": "USB 2 High-Speed", "value": str(usb_speed)}
    return {"level": "WARN", "label": "USB speed unknown", "value": str(usb_speed)}


def redact_device_text(value: object, device_id: str | None = None) -> str:
    text = str(value)
    if device_id:
        text = text.replace(device_id, display_device_id(device_id))
    return re.sub(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{16,}(?![0-9A-Fa-f])", lambda match: f"...{match.group(0)[-8:]}", text)


def is_x_link_error(value: object) -> bool:
    normalized = str(value).upper().replace("-", "_")
    return "X_LINK" in normalized or "XLINK" in normalized


def stage_result(
    name: str, attempt: int, *, duration_ms: float = 0.0, first_frame_ms: float | None = 0.0,
    frames: int = 1, usb_speed: object | None = "SUPER", error: str | None = None,
    exception_type: str | None = None, x_link: bool | None = None, has_crashed: bool = False,
    has_crash_dump: bool = False, health: dict[str, Any] | None = None,
    child_logs: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Return the stable JSON shape shared by live isolation and fixture tests."""
    message = error or ""
    result = {
        "stage": name,
        "attempt": attempt,
        "durationMs": round(duration_ms, 3),
        "firstFrameMs": None if first_frame_ms is None else round(first_frame_ms, 3),
        "frames": frames,
        "usbSpeed": None if usb_speed is None else str(usb_speed),
        "exception": None if error is None else {"type": exception_type or "RuntimeError", "message": message},
        "xLink": is_x_link_error(message) if x_link is None else x_link,
        "hasCrashed": has_crashed,
        "hasCrashDump": has_crash_dump,
        "health": health,
    }
    if child_logs is not None:
        result["childLogs"] = child_logs
    return result


def health_has_hardware_failure(health: dict[str, Any] | None) -> bool:
    if not health:
        return False
    for name in ("cameraFunctionality", "cameraCalibration", "imuFunctionality", "imuCalibration"):
        value = str(health.get(name, "")).upper()
        if "FAIL" in value or "ERROR" in value:
            return True
    return False


def health_has_power_failure(health: dict[str, Any] | None) -> bool:
    value = str((health or {}).get("powerSupplyFunctionality", "")).upper()
    return "FAIL" in value or "ERROR" in value


def has_usb2(stage: dict[str, Any]) -> bool:
    value = str(stage.get("usbSpeed", "")).upper()
    return "HIGH" in value or "USB2" in value or "USB 2" in value


def classify_isolation(report: dict[str, Any]) -> dict[str, Any]:
    """Classify only the evidence recorded in an isolation report."""
    stages = report.get("stages", [])
    health_failures = [stage for stage in stages if health_has_hardware_failure(stage.get("health"))]
    power_failures = [stage for stage in stages if health_has_power_failure(stage.get("health"))]
    usb2 = [stage for stage in stages if has_usb2(stage)]
    successful_stereo_attempts = {
        int(stage.get("attempt", 0)) for stage in stages
        if stage.get("stage") == "stereo" and stage.get("frames", 0) > 0 and not stage.get("exception")
    }
    stereo_restart = [
        stage for stage in stages
        if stage.get("stage") == "stereo" and stage.get("xLink")
        and any(previous < int(stage.get("attempt", 0)) for previous in successful_stereo_attempts)
    ]
    failed = [
        stage for stage in stages
        if stage.get("exception")
        or (stage.get("stage") in {"rgb", "stereo", "rgbd"} and stage.get("frames", 0) == 0)
    ]
    if health_failures:
        return {
            "classification": "DEVICE_OR_FIRMWARE", "confidence": "MEDIUM",
            "reasons": ["DepthAI health check reported a camera, calibration, or IMU failure."],
            "nextChecks": ["Compare the same device with current firmware on a second PC and cable/power setup."],
        }
    if usb2 or power_failures:
        return {
            "classification": "USB_OR_POWER_OR_HOST", "confidence": "HIGH",
            "reasons": [
                "USB 2 High-Speed was recorded; RGB-D diagnostics require a SuperSpeed path."
                if usb2 else "DepthAI health check reported a power-supply failure."
            ],
            "nextChecks": ["Use a known-good USB 3 cable and port, then repeat on a second PC or powered setup."],
        }
    if stereo_restart:
        return {
            "classification": "DEPTHAI_STEREO_RESTART", "confidence": "MEDIUM",
            "reasons": ["A later Stereo attempt failed with an X_LINK error after a prior restart."],
            "nextChecks": ["Compare the restart sequence with another USB host, cable, and power condition."],
        }
    if report.get("viewerObservedFailure") and not failed:
        return {
            "classification": "VIEWER_OR_APP", "confidence": "MEDIUM",
            "reasons": ["All isolated camera stages passed while the observed failure is limited to the viewer or application."],
            "nextChecks": ["Compare the visual mode with the application disabled and preserve this report."],
        }
    if stages and not failed:
        return {
            "classification": "PASS", "confidence": "HIGH",
            "reasons": ["All selected isolated stages completed their requested frames without recorded faults."],
            "nextChecks": ["If the original symptom remains, compare visual mode and application settings with this baseline."],
        }
    return {
        "classification": "INCONCLUSIVE", "confidence": "LOW",
        "reasons": ["The recorded failure does not isolate a USB, health-check, or repeatable Stereo restart cause."],
        "nextChecks": ["Repeat the same matrix row on a second PC and a different cable or power condition."],
    }


def make_isolation_report(
    stages: list[dict[str, Any]], *, device_id: str = "", depthai_version: str | None = None,
    setup: dict[str, str | None] | None = None, device: dict[str, Any] | None = None,
    viewer_failed: bool = False,
) -> dict[str, Any]:
    report = {
        "schemaVersion": 1,
        "runId": str(uuid.uuid4()),
        "time": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "depthai": depthai_version or "unknown",
        "os": platform.platform(),
        "setup": setup or {"host": None, "cable": None, "power": None, "label": None},
        "device": {
            "id": display_device_id(device_id), "platform": None, "usbSpeed": None,
            **(device or {}),
        },
        "stages": stages,
        "viewerObservedFailure": viewer_failed,
    }
    report["verdict"] = classify_isolation(report)
    return report


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    """Replace a report only after a complete UTF-8 JSON document is durable on the same volume."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def redact_json_value(value: Any, device_id: str | None) -> Any:
    if isinstance(value, str):
        return redact_device_text(value, device_id)
    if isinstance(value, list):
        return [redact_json_value(item, device_id) for item in value]
    if isinstance(value, dict):
        return {key: redact_json_value(item, device_id) for key, item in value.items()}
    return value


def log_tail(value: str | bytes | None, device_id: str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode(errors="replace")
    lines = value.splitlines()
    return redact_device_text("\n".join(lines[-40:])[-8000:], device_id)


def finish_child_attempt(
    stage: str, attempt: int, worker_result: dict[str, Any] | None, *, stdout: str | bytes | None = None,
    stderr: str | bytes | None = None, returncode: int | None = 0, timed_out: bool = False,
    device_id: str | None = None,
) -> dict[str, Any]:
    """Turn every child outcome into one redacted stage result for a durable parent report."""
    if worker_result is None:
        result = stage_result(stage, attempt, first_frame_ms=None, frames=0, usb_speed=None)
    else:
        result = redact_json_value(worker_result, device_id)
        result["stage"] = stage
        result["attempt"] = attempt
    logs = {"stdout": log_tail(stdout, device_id), "stderr": log_tail(stderr, device_id)}
    result["childLogs"] = logs
    combined_logs = f"{logs['stdout']}\n{logs['stderr']}"
    error: dict[str, str] | None = None
    if timed_out:
        error = {"type": "TimeoutExpired", "message": "child attempt exceeded the configured timeout"}
    elif returncode not in (0, None):
        error = {"type": "ChildProcessError", "message": f"child exited with status {returncode}"}
    elif worker_result is None:
        error = {"type": "WorkerResultMissing", "message": "child exited without a valid result file"}
    if error is not None:
        if result.get("exception") is None:
            result["exception"] = error
        else:
            result["workerException"] = error
    result["xLink"] = bool(result.get("xLink")) or is_x_link_error(combined_logs)
    return redact_json_value(result, device_id)


def finite_intrinsics(transform: object, width: int, height: int) -> dict[str, float | int] | None:
    """Read the RGB transform intrinsics and reject malformed calibration data."""
    try:
        matrix = transform.getIntrinsicMatrix()
        intrinsics = {
            "fx": float(matrix[0][0]), "fy": float(matrix[1][1]),
            "cx": float(matrix[0][2]), "cy": float(matrix[1][2]),
            "width": int(width), "height": int(height),
        }
    except (AttributeError, IndexError, TypeError, ValueError):
        return None
    values = (intrinsics["fx"], intrinsics["fy"], intrinsics["cx"], intrinsics["cy"])
    if width <= 0 or height <= 0 or intrinsics["fx"] <= 0 or intrinsics["fy"] <= 0:
        return None
    return intrinsics if all(math.isfinite(value) for value in values) else None


def median_depth_stats(depth: Sequence[Sequence[int]], cx: int, cy: int, radius: int) -> tuple[int | None, int, int]:
    """Return median valid depth in mm, valid count, and sampled count for an ROI."""
    height = len(depth)
    width = len(depth[0]) if height else 0
    values: list[int] = []
    samples = 0
    for y in range(max(0, cy - radius), min(height, cy + radius + 1)):
        for x in range(max(0, cx - radius), min(width, cx + radius + 1)):
            samples += 1
            value = int(depth[y][x])
            if value > 0:
                values.append(value)
    if not values:
        return None, 0, samples
    values.sort()
    return values[len(values) // 2], len(values), samples


def valid_depth_ratio(depth: Any) -> float:
    """Return the valid-pixel ratio without flattening numpy depth frames in Python."""
    if hasattr(depth, "size"):
        try:
            return float((depth > 0).mean()) if int(depth.size) else 0.0
        except (AttributeError, TypeError, ValueError):
            pass
    values = [int(value) for row in depth for value in row]
    return sum(value > 0 for value in values) / len(values) if values else 0.0


def validate_frame(
    rgb_size: tuple[int, int], depth_size: tuple[int, int], intrinsics: dict[str, float | int] | None,
    sync_delta: float, threshold: float, valid_ratio: float, min_valid_ratio: float,
) -> dict[str, bool]:
    return {
        "alignedSize": rgb_size == depth_size,
        "finiteIntrinsics": intrinsics is not None,
        "syncThreshold": math.isfinite(sync_delta) and sync_delta <= threshold,
        "validDepth": math.isfinite(valid_ratio) and valid_ratio >= min_valid_ratio,
    }


@dataclass
class Summary:
    framesRequested: int
    syncThresholdMs: float
    minValidDepthRatio: float
    profile: str
    configured: dict[str, int | float]
    device: dict[str, Any]
    framesProcessed: int = 0
    framesAccepted: int = 0
    failures: dict[str, int] = field(default_factory=lambda: {
        "sync": 0, "size": 0, "intrinsics": 0, "depth": 0, "usb": 0, "hostQueue": 0, "error": 0,
    })
    lastFrame: dict[str, Any] | None = None


def colorize_depth(cv2: Any, depth: Any) -> Any:
    import numpy as np

    valid = depth[depth > 0]
    if valid.size == 0:
        return cv2.cvtColor((depth > 0).astype("uint8"), cv2.COLOR_GRAY2BGR)
    low, high = float(np.percentile(valid, 3)), float(np.percentile(valid, 95))
    scaled = np.clip((depth.astype("float32") - low) * 255 / max(1.0, high - low), 0, 255).astype("uint8")
    return cv2.applyColorMap(255 - scaled, cv2.COLORMAP_TURBO)


def draw_crosshair(cv2: Any, image: Any, center: tuple[int, int], radius: int) -> None:
    x, y = center
    cv2.drawMarker(image, (x, y), (255, 255, 255), cv2.MARKER_CROSS, 24, 1, cv2.LINE_AA)
    cv2.rectangle(image, (x - radius, y - radius), (x + radius, y + radius), (255, 255, 255), 1, cv2.LINE_AA)


def draw_overlay(cv2: Any, rgb: Any, depth_color: Any, telemetry: dict[str, Any], radius: int) -> Any:
    overlay = cv2.addWeighted(rgb, 0.58, depth_color, 0.42, 0)
    height, width = overlay.shape[:2]
    draw_crosshair(cv2, overlay, (width // 2, height // 2), radius)
    usb = telemetry["usb"]
    configured = telemetry["configured"]
    lines = [
        f"profile {telemetry['profile']}  configured {configured['width']}x{configured['height']} @ {configured['fps']:.0f} FPS",
        f"device ...{telemetry['deviceId']}  {usb['level']} {usb['label']}",
        f"RGB/Depth {width}x{height}  {telemetry['fps']:.1f} FPS  seq {telemetry['rgbSeq']}/{telemetry['depthSeq']}",
        f"sync {telemetry['syncDeltaMs']:.2f}/{telemetry['syncThresholdMs']:.2f} ms  valid {telemetry['validDepthRatio'] * 100:.1f}%",
        f"center ROI {telemetry['centerDepthMm'] if telemetry['centerDepthMm'] is not None else '--'} mm  drops {telemetry['drops']}",
    ]
    for index, line in enumerate(lines):
        y = 28 + index * 24
        cv2.putText(overlay, line, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(overlay, line, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return overlay


def letterbox_image(cv2: Any, image: Any, tile_size: tuple[int, int] = DISPLAY_TILE_SIZE) -> Any:
    import numpy as np

    target_width, target_height = tile_size
    height, width = image.shape[:2]
    render_width, render_height = letterbox_size((width, height), tile_size)
    resized = cv2.resize(image, (render_width, render_height), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((target_height, target_width, 3), dtype=image.dtype)
    x = (target_width - render_width) // 2
    y = (target_height - render_height) // 2
    canvas[y:y + render_height, x:x + render_width] = resized
    return canvas


def diagnostic_panel(cv2: Any, telemetry: dict[str, Any], tile_size: tuple[int, int] = DISPLAY_TILE_SIZE) -> Any:
    import numpy as np

    width, height = tile_size
    panel = np.zeros((height, width, 3), dtype=np.uint8)
    configured = telemetry["configured"]
    checks = ", ".join(name for name, passed in telemetry["checks"].items() if not passed) or "all pass"
    lines = [
        "Diagnostics",
        f"profile: {telemetry['profile']}",
        f"configured: {configured['width']}x{configured['height']} @ {configured['fps']:.0f} FPS",
        f"RGB: {telemetry['rgbSize']['width']}x{telemetry['rgbSize']['height']}  Depth: {telemetry['depthSize']['width']}x{telemetry['depthSize']['height']}",
        f"sync: {telemetry['syncDeltaMs']:.2f}/{telemetry['syncThresholdMs']:.2f} ms",
        f"valid depth: {telemetry['validDepthRatio'] * 100:.1f}%  center: {telemetry['centerDepthMm'] or '--'} mm",
        f"checks: {checks}",
        f"drops: {telemetry['drops']}",
    ]
    for index, line in enumerate(lines):
        y = 30 + index * 32
        cv2.putText(panel, line, (16, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return panel


def display_frame(cv2: Any, rgb: Any, depth_color: Any, overlay: Any, telemetry: dict[str, Any], radius: int) -> Any:
    rgb_view = rgb.copy()
    depth_view = depth_color.copy()
    center = (rgb.shape[1] // 2, rgb.shape[0] // 2)
    draw_crosshair(cv2, rgb_view, center, radius)
    draw_crosshair(cv2, depth_view, center, radius)
    cv2.putText(rgb_view, "RGB", (12, rgb.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(depth_view, "Aligned depth", (12, depth_view.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(overlay, "Overlay", (12, overlay.shape[0] - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    top = cv2.hconcat([letterbox_image(cv2, rgb_view), letterbox_image(cv2, depth_view)])
    bottom = cv2.hconcat([letterbox_image(cv2, overlay), diagnostic_panel(cv2, telemetry)])
    return cv2.vconcat([top, bottom])


def capture(cv2: Any, image: Any, telemetry: dict[str, Any]) -> tuple[Path, Path]:
    directory = Path(__file__).with_name("captures")
    directory.mkdir(exist_ok=True)
    stem = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    png_path = directory / f"oak-diagnostics-{stem}.png"
    json_path = directory / f"oak-diagnostics-{stem}.json"
    if not cv2.imwrite(str(png_path), image):
        raise RuntimeError(f"could not write {png_path}")
    json_path.write_text(json.dumps(telemetry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return png_path, json_path


def build_pipeline(dai: Any, args: argparse.Namespace, device: Any | None = None) -> tuple[Any, Any, float, str]:
    pipeline = dai.Pipeline() if device is None else dai.Pipeline(device)
    platform = pipeline.getDefaultDevice().getPlatform()
    rgb_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_A)
    left_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_B)
    right_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_C)
    stereo = pipeline.create(dai.node.StereoDepth)
    sync = pipeline.create(dai.node.Sync)
    threshold = sync_threshold_ms(args.fps)
    sync.setSyncThreshold(timedelta(milliseconds=threshold))
    rgb = rgb_camera.requestOutput(size=(args.width, args.height), fps=args.fps, enableUndistortion=True)
    left_camera.requestOutput(size=(640, 400), fps=args.fps).link(stereo.left)
    right_camera.requestOutput(size=(640, 400), fps=args.fps).link(stereo.right)
    rgb.link(sync.inputs["rgb"])
    if platform == dai.Platform.RVC4:
        align = pipeline.create(dai.node.ImageAlign)
        stereo.depth.link(align.input)
        rgb.link(align.inputAlignTo)
        align.outputAligned.link(sync.inputs["depth"])
    else:
        stereo.depth.link(sync.inputs["depth"])
        rgb.link(stereo.inputAlignTo)
    return pipeline, sync, threshold, str(platform)


def frame_telemetry(rgb_frame: Any, depth_frame: Any, rgb: Any, depth: Any, threshold: float,
                    min_valid_ratio: float, fps: float, profile: str, configured: dict[str, int | float],
                    device_id: str, usb: dict[str, str], drops: dict[str, int]) -> dict[str, Any]:
    rgb_seq, depth_seq = int(rgb_frame.getSequenceNum()), int(depth_frame.getSequenceNum())
    rgb_time = rgb_frame.getTimestampDevice().total_seconds() * 1000.0
    depth_time = depth_frame.getTimestampDevice().total_seconds() * 1000.0
    center = (depth.shape[1] // 2, depth.shape[0] // 2)
    center_depth, _, _ = median_depth_stats(depth, center[0], center[1], 2)
    intrinsics = finite_intrinsics(rgb_frame.getTransformation(), rgb.shape[1], rgb.shape[0])
    ratio = valid_depth_ratio(depth)
    checks = validate_frame((rgb.shape[1], rgb.shape[0]), (depth.shape[1], depth.shape[0]), intrinsics,
                            abs(rgb_time - depth_time), threshold, ratio, min_valid_ratio)
    return {
        "deviceId": display_device_id(device_id), "usb": usb, "platform": None,
        "profile": profile, "configured": dict(configured),
        "rgbSize": {"width": int(rgb.shape[1]), "height": int(rgb.shape[0])},
        "depthSize": {"width": int(depth.shape[1]), "height": int(depth.shape[0])},
        "fps": fps, "rgbSeq": rgb_seq, "depthSeq": depth_seq,
        "syncDeltaMs": abs(rgb_time - depth_time), "syncThresholdMs": threshold,
        "validDepthRatio": ratio, "centerDepthMm": center_depth, "intrinsics": intrinsics,
        "checks": checks, "drops": dict(drops),
    }


def health_metrics_json(metrics: Any, device_id: str | None) -> dict[str, Any]:
    fields = (
        "usbGeneration", "bandwidthMbps", "cameraFunctionality", "cameraCalibration",
        "imuFunctionality", "imuCalibration", "powerSupplyFunctionality", "deviceInUse",
        "deviceInSetupMode", "missingUdevRules",
    )
    result = {name: redact_device_text(getattr(metrics, name), device_id) for name in fields}
    result["bandwidthMbps"] = float(getattr(metrics, "bandwidthMbps", 0.0))
    result["issues"] = [redact_device_text(issue, device_id) for issue in getattr(metrics, "issues", [])]
    return result


def select_device_info(dai: Any, mxid: str | None) -> Any:
    if mxid:
        return dai.DeviceInfo(mxid)
    devices = list(dai.Device.getAllAvailableDevices())
    if not devices:
        raise RuntimeError("No available DepthAI device was discovered")
    return devices[0]


def device_info_id(device_info: Any) -> str:
    return str(device_info.getDeviceId())


def run_discover_attempt(dai: Any, args: argparse.Namespace, attempt: int) -> tuple[dict[str, Any], Any | None]:
    started = time.monotonic()
    try:
        device_info = select_device_info(dai, args.mxid)
        result = stage_result("discover", attempt, duration_ms=(time.monotonic() - started) * 1000, frames=0)
        result["deviceId"] = display_device_id(device_info_id(device_info))
        return result, device_info
    except Exception as error:
        return stage_result(
            "discover", attempt, duration_ms=(time.monotonic() - started) * 1000, first_frame_ms=None, frames=0,
            usb_speed=None, error=redact_device_text(error, args.mxid), exception_type=type(error).__name__,
        ), None


def run_health_attempt(dai: Any, device_info: Any, device_id: str, attempt: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        metrics = dai.Device.performHealthCheck(device_info, dai.HealthCheckConfig())
        return stage_result(
            "health", attempt, duration_ms=(time.monotonic() - started) * 1000, first_frame_ms=None, frames=0,
            usb_speed=getattr(metrics, "usbGeneration", None), health=health_metrics_json(metrics, device_id),
        )
    except Exception as error:
        return stage_result(
            "health", attempt, duration_ms=(time.monotonic() - started) * 1000, first_frame_ms=None, frames=0,
            usb_speed=None, error=redact_device_text(error, device_id), exception_type=type(error).__name__,
        )


def build_isolation_pipeline(dai: Any, args: argparse.Namespace, device: Any, stage: str) -> tuple[Any, Any, str]:
    if stage == "rgbd":
        pipeline, sync, _, platform_name = build_pipeline(dai, args, device)
        return pipeline, sync.out.createOutputQueue(maxSize=1, blocking=False), platform_name
    pipeline = dai.Pipeline(device)
    platform_name = str(device.getPlatform())
    if stage == "rgb":
        camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_A)
        queue = camera.requestOutput(size=(args.width, args.height), fps=args.fps).createOutputQueue(maxSize=1, blocking=False)
    elif stage == "stereo":
        left = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_B)
        right = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_C)
        stereo = pipeline.create(dai.node.StereoDepth)
        left.requestOutput(size=(640, 400), fps=args.fps).link(stereo.left)
        right.requestOutput(size=(640, 400), fps=args.fps).link(stereo.right)
        queue = stereo.depth.createOutputQueue(maxSize=1, blocking=False)
    else:
        raise ValueError(f"unsupported isolation pipeline stage: {stage}")
    return pipeline, queue, platform_name


def safe_device_flag(device: Any, method: str) -> bool:
    if device is None:
        return False
    try:
        return bool(getattr(device, method)())
    except Exception:
        return False


def record_cleanup_error(result: dict[str, Any], error: Exception, device_id: str) -> None:
    cleanup = {"type": type(error).__name__, "message": redact_device_text(error, device_id)}
    if result["exception"] is None:
        result["exception"] = cleanup
        result["xLink"] = is_x_link_error(cleanup["message"])
    else:
        result["cleanupException"] = cleanup


def run_stream_attempt(dai: Any, args: argparse.Namespace, device_info: Any, device_id: str,
                       stage: str, attempt: int) -> dict[str, Any]:
    started = time.monotonic()
    first_frame_ms: float | None = None
    frames = 0
    device = None
    pipeline = None
    usb_speed: object | None = None
    platform_name: str | None = None
    try:
        device = dai.Device(device_info)
        usb_speed = device.getUsbSpeed()
        pipeline, queue, platform_name = build_isolation_pipeline(dai, args, device, stage)
        pipeline.start()
        while frames < args.frames:
            if time.monotonic() - started > args.timeout_seconds:
                raise TimeoutError(f"{stage} did not produce {args.frames} frames within {args.timeout_seconds:g} seconds")
            frame = queue.tryGet()
            if frame is None:
                time.sleep(0.002)
                continue
            if first_frame_ms is None:
                first_frame_ms = (time.monotonic() - started) * 1000
            frames += 1
        result = stage_result(
            stage, attempt, duration_ms=(time.monotonic() - started) * 1000, first_frame_ms=first_frame_ms,
            frames=frames, usb_speed=usb_speed,
            has_crashed=safe_device_flag(device, "hasCrashed"), has_crash_dump=safe_device_flag(device, "hasCrashDump"),
        )
    except Exception as error:
        result = stage_result(
            stage, attempt, duration_ms=(time.monotonic() - started) * 1000, first_frame_ms=first_frame_ms,
            frames=frames, usb_speed=usb_speed, error=redact_device_text(error, device_id),
            exception_type=type(error).__name__, has_crashed=safe_device_flag(device, "hasCrashed"),
            has_crash_dump=safe_device_flag(device, "hasCrashDump"),
        )
    finally:
        if pipeline is not None:
            try:
                pipeline.stop()
            except Exception as error:
                record_cleanup_error(result, error, device_id)
        if device is not None:
            try:
                device.close()
            except Exception as error:
                record_cleanup_error(result, error, device_id)
        result["durationMs"] = round((time.monotonic() - started) * 1000, 3)
    result["platform"] = platform_name
    return result


def run_isolation_worker(args: argparse.Namespace) -> int:
    """Execute exactly one native DepthAI attempt; the parent owns progress reporting."""
    try:
        import depthai as dai
        if args.worker_stage == "discover":
            result, _ = run_discover_attempt(dai, args, args.worker_attempt)
        else:
            device_info = select_device_info(dai, args.mxid)
            device_id = device_info_id(device_info)
            result = (
                run_health_attempt(dai, device_info, device_id, args.worker_attempt)
                if args.worker_stage == "health"
                else run_stream_attempt(dai, args, device_info, device_id, args.worker_stage, args.worker_attempt)
            )
        result["depthaiVersion"] = str(dai.__version__)
    except Exception as error:
        result = stage_result(
            args.worker_stage, args.worker_attempt, first_frame_ms=None, frames=0, usb_speed=None,
            error=redact_device_text(error, args.mxid), exception_type=type(error).__name__,
        )
    atomic_write_json(args.worker_result, redact_json_value(result, args.mxid))
    return 0


def worker_command(args: argparse.Namespace, stage: str, attempt: int, result_path: Path) -> list[str]:
    command = [
        sys.executable, str(Path(__file__).resolve()), "--_isolation-worker", "--worker-stage", stage,
        "--worker-attempt", str(attempt), "--worker-result", str(result_path), "--profile", args.profile,
        "--frames", str(args.frames), "--timeout-seconds", str(args.timeout_seconds),
        "--attempt-timeout-seconds", str(args.attempt_timeout_seconds),
    ]
    if args.mxid:
        command.extend(["--mxid", args.mxid])
    return command


def load_json_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def run_child_attempt(args: argparse.Namespace, stage: str, attempt: int) -> dict[str, Any]:
    result_path = Path(__file__).with_name(f".oak-diagnostics-worker-{uuid.uuid4().hex}.json")
    try:
        try:
            completed = subprocess.run(
                worker_command(args, stage, attempt, result_path), capture_output=True, text=True,
                timeout=args.attempt_timeout_seconds, check=False,
            )
            return finish_child_attempt(
                stage, attempt, load_json_object(result_path), stdout=completed.stdout, stderr=completed.stderr,
                returncode=completed.returncode, device_id=args.mxid,
            )
        except subprocess.TimeoutExpired as error:
            return finish_child_attempt(
                stage, attempt, load_json_object(result_path), stdout=error.stdout, stderr=error.stderr,
                timed_out=True, device_id=args.mxid,
            )
        except OSError as error:
            return finish_child_attempt(
                stage, attempt, None, stderr=str(error), returncode=1, device_id=args.mxid,
            )
    finally:
        try:
            result_path.unlink(missing_ok=True)
        except OSError:
            pass


def make_progress_report(args: argparse.Namespace, results: list[dict[str, Any]]) -> dict[str, Any]:
    device_id = display_device_id(args.mxid or "")
    device = {"id": device_id, "platform": None, "usbSpeed": None}
    depthai_version = "unknown"
    for result in results:
        if result.get("deviceId"):
            device_id = display_device_id(str(result["deviceId"]))
            device["id"] = device_id
        if result.get("platform"):
            device["platform"] = result["platform"]
        if result.get("usbSpeed"):
            device["usbSpeed"] = str(result["usbSpeed"])
        if result.get("depthaiVersion"):
            depthai_version = str(result["depthaiVersion"])
    return make_isolation_report(
        results, device_id=device_id, depthai_version=depthai_version, setup=args.setup, device=device,
        viewer_failed=args.viewer_failed,
    )


def run_isolation(args: argparse.Namespace) -> int:
    results: list[dict[str, Any]] = []
    report = make_progress_report(args, results)
    if args.report:
        atomic_write_json(args.report, report)
    for stage in args.stages:
        for attempt in range(1, args.attempts + 1):
            results.append(run_child_attempt(args, stage, attempt))
            report = make_progress_report(args, results)
            if args.report:
                atomic_write_json(args.report, report)
    print(json.dumps(report, indent=None if args.json else 2, sort_keys=True))
    return 0 if report["verdict"]["classification"] in {"PASS", "VIEWER_OR_APP"} else 1


def run(args: argparse.Namespace) -> int:
    try:
        import cv2
        import depthai as dai
    except ImportError as error:
        print(f"Missing dependency: {error.name}. Install requirements.txt first.", file=sys.stderr)
        return 2
    pipeline, sync, threshold, platform = build_pipeline(dai, args)
    # A single Sync group is the RGB/depth host boundary. Latest-only prevents host lag.
    queue = sync.out.createOutputQueue(maxSize=1, blocking=False)
    try:
        pipeline.start()
        device = pipeline.getDefaultDevice()
        device_id = device.getDeviceId()
        usb = usb_link_status(device.getUsbSpeed())
        configured = {"width": args.width, "height": args.height, "fps": args.fps}
        summary = Summary(args.frames if args.headless else 0, threshold, args.min_valid_depth_ratio,
                          args.profile, configured,
                          {"id": display_device_id(device_id), "usb": usb, "platform": platform})
        if usb["level"] != "PASS":
            summary.failures["usb"] += 1
        last_seq: int | None = None
        started = time.monotonic()
        fps_times: list[float] = []
        while pipeline.isRunning():
            if args.headless and time.monotonic() - started > args.timeout_seconds:
                summary.failures["error"] += 1
                break
            group = queue.tryGet()
            if group is None:
                time.sleep(0.002)
                continue
            try:
                rgb_frame = group["rgb"]
                depth_frame = group["depth"]
                rgb, depth = rgb_frame.getCvFrame(), depth_frame.getFrame()
            except (KeyError, AttributeError, TypeError):
                summary.failures["error"] += 1
                continue
            summary.framesProcessed += 1
            now = time.monotonic()
            fps_times = (fps_times + [now])[-30:]
            measured_fps = 0.0 if len(fps_times) < 2 else (len(fps_times) - 1) / (fps_times[-1] - fps_times[0])
            telemetry = frame_telemetry(rgb_frame, depth_frame, rgb, depth, threshold, args.min_valid_depth_ratio,
                                        measured_fps, args.profile, configured, device_id, usb, summary.failures)
            telemetry["platform"] = platform
            if last_seq is not None and telemetry["rgbSeq"] > last_seq + 1:
                summary.failures["hostQueue"] += telemetry["rgbSeq"] - last_seq - 1
            last_seq = telemetry["rgbSeq"]
            for check, passed in telemetry["checks"].items():
                if not passed:
                    summary.failures[{"alignedSize": "size", "finiteIntrinsics": "intrinsics", "syncThreshold": "sync", "validDepth": "depth"}[check]] += 1
            telemetry["drops"] = dict(summary.failures)
            summary.lastFrame = telemetry
            if all(telemetry["checks"].values()):
                summary.framesAccepted += 1
            if args.headless:
                if summary.framesProcessed >= args.frames:
                    break
                continue
            depth_color = colorize_depth(cv2, depth)
            overlay = draw_overlay(cv2, rgb, depth_color, telemetry, args.roi_radius)
            canvas = display_frame(cv2, rgb, depth_color, overlay, telemetry, args.roi_radius)
            cv2.imshow("OAK-D Lite diagnostics", canvas)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord("q")):
                break
            if key == ord("s"):
                png, metadata = capture(cv2, canvas, telemetry)
                print(f"capture: {png.name}, {metadata.name}")
        result = asdict(summary)
        result["checks"] = {
            "frameCount": summary.framesProcessed == args.frames if args.headless else True,
            "alignedSize": summary.failures["size"] == 0,
            "finiteIntrinsics": summary.failures["intrinsics"] == 0,
            "syncThreshold": summary.failures["sync"] == 0,
            "validDepth": summary.failures["depth"] == 0,
            "usbSuperSpeed": usb["level"] == "PASS",
        }
        if args.json:
            print(json.dumps(result, sort_keys=True))
        elif args.headless:
            print(json.dumps(result, indent=2, sort_keys=True))
        failed = any(value > 0 for name, value in summary.failures.items() if name != "hostQueue")
        if args.headless:
            failed = failed or summary.framesProcessed != args.frames or summary.framesAccepted != args.frames
        return 1 if failed else 0
    finally:
        del queue
        pipeline.stop()
        if not args.headless:
            cv2.destroyAllWindows()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OAK-D Lite standalone RGB-D diagnostics")
    parser.add_argument("--profile", choices=tuple(PROFILE_CONFIGS), default="balanced")
    parser.add_argument("--roi-radius", type=int, default=2)
    parser.add_argument("--min-valid-depth-ratio", type=float, default=0.01)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--frames", type=int, default=120)
    parser.add_argument("--timeout-seconds", type=float, default=15.0)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--isolate", action="store_true", help="run GUI-free staged fault isolation")
    parser.add_argument("--viewer-failed", action="store_true", help="record a separately observed viewer/application failure")
    parser.add_argument("--stages", default=",".join(ISOLATION_STAGES), help="comma-separated isolation stages")
    parser.add_argument("--attempts", type=int, default=2, help="fresh Device/Pipeline attempts per isolation stage")
    parser.add_argument("--attempt-timeout-seconds", type=float, default=90.0, help="maximum wall time for one isolated child")
    parser.add_argument("--report", type=Path, help="atomically update this JSON report after each attempt")
    parser.add_argument("--mxid", help="select one DepthAI MXID without exposing it in output")
    parser.add_argument("--host", help="optional host label for a comparison matrix")
    parser.add_argument("--cable", help="optional cable label for a comparison matrix")
    parser.add_argument("--power", help="optional power label for a comparison matrix")
    parser.add_argument("--setup", help="optional setup label for a comparison matrix")
    parser.add_argument("--_isolation-worker", dest="isolation_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--worker-stage", choices=ISOLATION_STAGES, help=argparse.SUPPRESS)
    parser.add_argument("--worker-attempt", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--worker-result", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    config = resolve_profile(args.profile)
    args.width = int(config["width"])
    args.height = int(config["height"])
    args.fps = float(config["fps"])
    if args.roi_radius < 0 or args.frames <= 0 or args.timeout_seconds <= 0 or args.attempts <= 0 or args.attempt_timeout_seconds <= 0:
        parser.error("frames, timeouts, and attempts must be positive; roi-radius must be non-negative")
    try:
        sync_threshold_ms(args.fps)
    except ValueError as error:
        parser.error(str(error))
    if not 0.0 <= args.min_valid_depth_ratio <= 1.0:
        parser.error("min-valid-depth-ratio must be between 0 and 1")
    args.stages = tuple(stage.strip() for stage in args.stages.split(",") if stage.strip())
    if not args.stages or any(stage not in ISOLATION_STAGES for stage in args.stages) or len(set(args.stages)) != len(args.stages):
        parser.error(f"stages must be unique values from {','.join(ISOLATION_STAGES)}")
    if args.isolation_worker and (args.worker_stage is None or args.worker_attempt is None or args.worker_result is None):
        parser.error("internal isolation worker requires stage, attempt, and result path")
    args.setup = {"host": args.host, "cable": args.cable, "power": args.power, "label": args.setup}
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.selftest:
        return selftest()
    if args.isolation_worker:
        return run_isolation_worker(args)
    if args.isolate:
        return run_isolation(args)
    return run(args)


def selftest() -> int:
    assert resolve_profile("balanced") == {"profile": "balanced", "width": 960, "height": 540, "fps": 25.0}
    assert display_layout_size() == (1280, 720)
    assert sync_threshold_ms(25.0) == 20.0
    assert display_device_id("18443010A1B2C3D4") == "A1B2C3D4"
    assert usb_link_status("UsbSpeed.SUPER")["level"] == "PASS"
    assert usb_link_status("UsbSpeed.HIGH")["level"] == "FAIL"
    assert classify_isolation(make_isolation_report([stage_result("rgb", 1)]))["classification"] == "PASS"
    depth = [[0, 0, 0], [0, 1500, 1600], [0, 1400, 0]]
    assert median_depth_stats(depth, 1, 1, 1) == (1500, 3, 9)
    checks = validate_frame((2, 2), (2, 2), {"fx": 1}, 1.0, 2.0, 0.5, 0.1)
    assert all(checks.values())
    print("[oak-diagnostics] selftest OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
