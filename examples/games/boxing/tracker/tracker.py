#!/usr/bin/env python3
"""boxing demo external tracker (webcam 2D / OAK-D Lite RGB-D)."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from datetime import timedelta
from http import HTTPStatus
from urllib.parse import urlparse

JOINTS = {"nose": 0, "shoulderL": 11, "shoulderR": 12, "elbowL": 13, "elbowR": 14,
          "wristL": 15, "wristR": 16, "hipL": 23, "hipR": 24}
DEFAULT_PORT = 8770


def _missing(dep: str, extra: str = "") -> None:
    print(f"[tracker] {dep} が見つかりません。pip install -r requirements.txt {extra}".rstrip(), file=sys.stderr)
    raise SystemExit(2)


def is_allowed_origin(origin: str | None) -> bool:
    """Only a local browser origin or an Origin-less CLI client may subscribe."""
    if origin is None:
        return True
    try:
        parsed = urlparse(origin)
        return parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1"}
    except ValueError:
        return False


async def reject_external_origin(connection, request):
    if not is_allowed_origin(request.headers.get("Origin")):
        return connection.respond(HTTPStatus.FORBIDDEN, "localhost origin required\n")
    return None


class FrameHub:
    def __init__(self) -> None:
        self.clients: set = set()
        self.latest: dict | None = None

    async def broadcast(self, frame: dict) -> None:
        self.latest = frame
        if not self.clients:
            return
        message = json.dumps(frame, separators=(",", ":"))
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


class FpsCounter:
    def __init__(self) -> None:
        self.times: list[float] = []

    def tick(self) -> float:
        now = time.monotonic()
        self.times.append(now)
        self.times = self.times[-30:]
        return self.value

    @property
    def value(self) -> float:
        return 0.0 if len(self.times) < 2 else (len(self.times) - 1) / (self.times[-1] - self.times[0])


def px_of(lm, with_visibility: bool = True) -> dict:
    out = {"x": float(lm.x), "y": float(lm.y)}
    if getattr(lm, "z", None) is not None:
        out["z"] = float(lm.z)
    if with_visibility and getattr(lm, "visibility", None) is not None:
        out["visibility"] = float(lm.visibility)
    return out


def median_depth_stats(depth_frame, cx: int, cy: int, k: int = 2):
    """Return median millimetres plus valid and sampled pixel counts for a small ROI."""
    height, width = depth_frame.shape[:2]
    values: list[int] = []
    samples = 0
    for y in range(max(0, cy - k), min(height, cy + k + 1)):
        for x in range(max(0, cx - k), min(width, cx + k + 1)):
            samples += 1
            value = int(depth_frame[y][x])
            if value > 0:
                values.append(value)
    if not values:
        return None, 0, samples
    values.sort()
    return values[len(values) // 2], len(values), samples


def median_depth(depth_frame, cx: int, cy: int, k: int = 2):
    return median_depth_stats(depth_frame, cx, cy, k)[0]


def intrinsics_from_transform(transform, width: int, height: int) -> dict:
    """Use ImgFrame transformation intrinsics, which include Camera crop/resize."""
    matrix = transform.getIntrinsicMatrix()
    return {"fx": float(matrix[0][0]), "fy": float(matrix[1][1]), "cx": float(matrix[0][2]),
            "cy": float(matrix[1][2]), "width": int(width), "height": int(height)}


def deproject(nx: float, ny: float, depth_mm: float, intr: dict):
    z_m = depth_mm / 1000.0
    x = (nx * intr["width"] - intr["cx"]) * z_m / intr["fx"]
    y = (ny * intr["height"] - intr["cy"]) * z_m / intr["fy"]
    return (x, -y, -z_m)


def finite_xyz(xyz) -> bool:
    return xyz is not None and all(math.isfinite(v) for v in xyz)


def build_frame(pose_landmarks, hand_results=None, depth_fn=None) -> dict:
    joints: dict = {}
    for name, index in JOINTS.items():
        if pose_landmarks is None or index >= len(pose_landmarks):
            continue
        landmark = pose_landmarks[index]
        entry = {"px": px_of(landmark)}
        if depth_fn is not None:
            xyz, depth_info = depth_fn(landmark.x, landmark.y)
            if finite_xyz(xyz):
                entry["xyz"] = {"x": xyz[0], "y": xyz[1], "z": xyz[2]}
            entry["depth"] = depth_info
        joints[name] = entry
    frame = {"t": int(time.time() * 1000), "joints": joints}
    if hand_results:
        frame["hands"] = hand_results
    return frame


def device_timestamp_ms(frame) -> float:
    return frame.getTimestampDevice().total_seconds() * 1000.0


def colorize_depth(cv2, depth):
    import numpy as np
    valid = depth[depth > 0]
    if not len(valid):
        return cv2.cvtColor((depth > 0).astype("uint8"), cv2.COLOR_GRAY2BGR)
    lo, hi = float(np.percentile(valid, 3)), float(np.percentile(valid, 95))
    scaled = np.clip((depth.astype("float32") - lo) * 255 / max(1, hi - lo), 0, 255).astype("uint8")
    return cv2.applyColorMap(255 - scaled, cv2.COLORMAP_TURBO)


def debug_preview(cv2, rgb, depth, landmarks, width: int, quality: int):
    """RGB + depth overlay + pose points, for localhost-only diagnostic PIP."""
    view = cv2.addWeighted(rgb, 0.58, colorize_depth(cv2, depth), 0.42, 0)
    if landmarks:
        h, w = view.shape[:2]
        for landmark in landmarks:
            x, y = int(landmark.x * w), int(landmark.y * h)
            if 0 <= x < w and 0 <= y < h:
                cv2.circle(view, (x, y), 3, (255, 220, 0), -1)
    if width > 0 and view.shape[1] > width:
        view = cv2.resize(view, (width, round(view.shape[0] * width / view.shape[1])))
    ok, encoded = cv2.imencode(".jpg", view, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None
    import base64
    return "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")


async def run_webcam(hub: FrameHub, args) -> None:
    try:
        import cv2
        import mediapipe as mp
    except ImportError:
        _missing("opencv-python / mediapipe")
    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        print(f"[tracker] カメラ {args.camera} を開けません", file=sys.stderr)
        raise SystemExit(1)
    pose = mp.solutions.pose.Pose(model_complexity=1, smooth_landmarks=True)
    hands = mp.solutions.hands.Hands(max_num_hands=2) if args.hands else None
    fps = FpsCounter(); sequence = 0
    print(f"[tracker] webcam モードで待受: ws://localhost:{args.port}")
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                await asyncio.sleep(0.01); continue
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            pose_result = pose.process(rgb)
            hand_out = None
            if hands:
                hand_result = hands.process(rgb)
                if hand_result.multi_hand_landmarks:
                    hand_out = [{"handedness": hand_result.multi_handedness[i].classification[0].label,
                                 "landmarks": [px_of(p, False) for p in hand.landmark]}
                                for i, hand in enumerate(hand_result.multi_hand_landmarks)]
            frame = build_frame(pose_result.pose_landmarks.landmark if pose_result.pose_landmarks else None, hand_out)
            frame["seq"] = sequence; sequence += 1
            frame["telemetry"] = {"source": "webcam", "sentAtMs": int(time.time() * 1000), "trackerFps": fps.tick(),
                                  "rgb": {"width": rgb.shape[1], "height": rgb.shape[0], "seq": frame["seq"], "deviceTimestampMs": None},
                                  "dropCounts": {"sync": 0, "size": 0, "sequence": 0, "timestamp": 0, "error": 0}}
            await hub.broadcast(frame)
            await asyncio.sleep(0)
    finally:
        cap.release()


async def run_oak(hub: FrameHub, args) -> None:
    """DepthAI v3 depth-align pipeline; no v2 XLinkOut/tryGet pairing."""
    try:
        import cv2
        import depthai as dai
        import mediapipe as mp
    except ImportError:
        _missing("depthai>=3.7 / opencv-python / mediapipe")
    pipeline = dai.Pipeline()
    platform = pipeline.getDefaultDevice().getPlatform()
    rgb_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_A)
    left_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_B)
    right_camera = pipeline.create(dai.node.Camera).build(dai.CameraBoardSocket.CAM_C)
    stereo = pipeline.create(dai.node.StereoDepth)
    stereo.setExtendedDisparity(True)
    sync = pipeline.create(dai.node.Sync)
    align = pipeline.create(dai.node.ImageAlign) if platform == dai.Platform.RVC4 else None
    sync_threshold_ms = 1000.0 / (2.0 * args.fps)
    sync.setSyncThreshold(timedelta(milliseconds=sync_threshold_ms))
    rgb_out = rgb_camera.requestOutput(size=(args.width, args.height), fps=args.fps, enableUndistortion=True)
    left_camera.requestOutput(size=(640, 400), fps=args.fps).link(stereo.left)
    right_camera.requestOutput(size=(640, 400), fps=args.fps).link(stereo.right)
    rgb_out.link(sync.inputs["rgb"])
    if align:
        stereo.depth.link(align.input)
        rgb_out.link(align.inputAlignTo)
        align.outputAligned.link(sync.inputs["depth_aligned"])
    else:
        stereo.depth.link(sync.inputs["depth_aligned"])
        rgb_out.link(stereo.inputAlignTo)
    # MediaPipe is slower than the camera on many PCs. Keep only the newest
    # synchronized pair so the browser doesn't receive a 16-frame-old pose.
    queue = sync.out.createOutputQueue(maxSize=1, blocking=False)
    pose = mp.solutions.pose.Pose(model_complexity=1, smooth_landmarks=True)
    hands = mp.solutions.hands.Hands(max_num_hands=2) if args.hands else None
    drops = {"sync": 0, "size": 0, "sequence": 0, "timestamp": 0, "hostQueue": 0, "error": 0}
    fps = FpsCounter(); last_preview = 0.0
    print(f"[tracker] oak DepthAI v3 ({platform}) で待受: ws://localhost:{args.port}")
    pipeline.start()
    device = pipeline.getDefaultDevice()
    device_info = {"deviceId": device.getDeviceId(), "usbSpeed": str(device.getUsbSpeed())}
    last_rgb_seq = None
    try:
        while pipeline.isRunning():
            group = queue.get()  # One Sync MessageGroup is the only RGB/depth host boundary.
            rgb_frame = group["rgb"]
            depth_frame = group["depth_aligned"]
            if rgb_frame is None or depth_frame is None:
                drops["sync"] += 1; continue
            rgb = rgb_frame.getCvFrame()
            depth = depth_frame.getFrame()
            rgb_seq, depth_seq = int(rgb_frame.getSequenceNum()), int(depth_frame.getSequenceNum())
            if last_rgb_seq is not None and rgb_seq > last_rgb_seq + 1:
                drops["hostQueue"] += rgb_seq - last_rgb_seq - 1
            last_rgb_seq = rgb_seq
            rgb_device_ms, depth_device_ms = device_timestamp_ms(rgb_frame), device_timestamp_ms(depth_frame)
            sequence_delta, sync_delta_ms = abs(rgb_seq - depth_seq), abs(rgb_device_ms - depth_device_ms)
            if rgb.shape[:2] != depth.shape[:2]:
                drops["size"] += 1; continue
            if sequence_delta > args.max_seq_delta:
                drops["sequence"] += 1; continue
            if sync_delta_ms > sync_threshold_ms:
                drops["timestamp"] += 1; continue
            started = time.perf_counter()
            rgb_for_mediapipe = cv2.cvtColor(rgb, cv2.COLOR_BGR2RGB)
            pose_result = pose.process(rgb_for_mediapipe)
            hand_out = None
            if hands:
                hand_result = hands.process(rgb_for_mediapipe)
                if hand_result.multi_hand_landmarks:
                    hand_out = [{"handedness": hand_result.multi_handedness[i].classification[0].label,
                                 "landmarks": [px_of(p, False) for p in hand.landmark]}
                                for i, hand in enumerate(hand_result.multi_hand_landmarks)]
            intr = intrinsics_from_transform(rgb_frame.getTransformation(), rgb.shape[1], rgb.shape[0])
            depth_counts: dict[str, dict] = {}
            def depth_fn(nx, ny):
                cx, cy = int(nx * depth.shape[1]), int(ny * depth.shape[0])
                if not (0 <= cx < depth.shape[1] and 0 <= cy < depth.shape[0]):
                    return None, {"valid": 0, "samples": 0, "validRatio": 0.0}
                value, valid, samples = median_depth_stats(depth, cx, cy, args.depth_roi)
                info = {"valid": valid, "samples": samples, "validRatio": valid / samples if samples else 0.0}
                return (deproject(nx, ny, value, intr) if value else None), info
            landmarks = pose_result.pose_landmarks.landmark if pose_result.pose_landmarks else None
            frame = build_frame(landmarks, hand_out, depth_fn)
            for name, entry in frame["joints"].items():
                depth_counts[name] = entry.get("depth", {"valid": 0, "samples": 0, "validRatio": 0.0})
            valid = sum(v["valid"] for v in depth_counts.values())
            samples = sum(v["samples"] for v in depth_counts.values())
            frame["seq"] = rgb_seq
            frame["telemetry"] = {"source": "oak", "sentAtMs": int(time.time() * 1000), "trackerFps": fps.tick(),
                "device": device_info,
                "rgb": {"width": rgb.shape[1], "height": rgb.shape[0], "seq": rgb_seq, "deviceTimestampMs": rgb_device_ms},
                "depth": {"width": depth.shape[1], "height": depth.shape[0], "seq": depth_seq, "deviceTimestampMs": depth_device_ms},
                "syncDeltaMs": sync_delta_ms, "sequenceDelta": sequence_delta, "validDepthRatio": valid / samples if samples else 0.0,
                "jointDepth": depth_counts, "joint3dCount": sum(1 for entry in frame["joints"].values() if "xyz" in entry),
                "intrinsics": intr, "processingLatencyMs": (time.perf_counter() - started) * 1000.0, "dropCounts": dict(drops)}
            if args.debug_preview and time.monotonic() - last_preview >= 1.0 / args.preview_fps:
                preview = debug_preview(cv2, rgb, depth, landmarks, args.preview_width, args.preview_quality)
                if preview:
                    frame["debug"] = {"previewDataUrl": preview}
                last_preview = time.monotonic()
            await hub.broadcast(frame)
            await asyncio.sleep(0)
    finally:
        pipeline.stop()


async def serve(hub: FrameHub, args) -> None:
    try:
        import websockets
    except ImportError:
        _missing("websockets")
    async def handler(ws):
        hub.clients.add(ws)
        try: await ws.wait_closed()
        finally: hub.clients.discard(ws)
    async with websockets.serve(handler, "localhost", args.port, process_request=reject_external_origin):
        await (run_oak(hub, args) if args.source == "oak" else run_webcam(hub, args))


def selftest() -> int:
    class LM:
        def __init__(self, x, y, z=0.0, visibility=1.0): self.x, self.y, self.z, self.visibility = x, y, z, visibility
    lms = [LM(0.5, 0.3)] * 33
    frame = build_frame(lms)
    assert set(frame["joints"]) == set(JOINTS) and "xyz" not in frame["joints"]["nose"]
    intr = {"fx": 800.0, "fy": 800.0, "cx": 640.0, "cy": 360.0, "width": 1280, "height": 720}
    xyz = deproject(0.5, 0.3, 2000, intr)
    assert math.isclose(xyz[0], 0.0) and math.isclose(xyz[1], 0.36) and math.isclose(xyz[2], -2.0) and finite_xyz(xyz)
    class DepthRows(list):
        shape = (3, 3)
    value, valid, samples = median_depth_stats(DepthRows([[0, 0, 0], [0, 1500, 1600], [0, 1400, 0]]), 1, 1, 1)
    assert (value, valid, samples) == (1500, 3, 9)
    class Transform:
        def getIntrinsicMatrix(self): return [[800, 0, 640], [0, 801, 360], [0, 0, 1]]
    assert intrinsics_from_transform(Transform(), 1280, 720)["fy"] == 801.0
    assert abs(1000 / (2 * 25) - 20) < 1e-9
    assert is_allowed_origin(None) and is_allowed_origin("http://localhost:8170") and is_allowed_origin("https://127.0.0.1:9443")
    assert not is_allowed_origin("https://example.com") and not is_allowed_origin("file://")
    print("[tracker] selftest OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="boxing デモ用の外部姿勢トラッカー")
    ap.add_argument("--source", choices=["webcam", "oak"], default="webcam")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT); ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280); ap.add_argument("--height", type=int, default=720); ap.add_argument("--fps", type=float, default=25.0)
    ap.add_argument("--hands", action="store_true"); ap.add_argument("--depth-roi", type=int, default=2)
    ap.add_argument("--max-seq-delta", type=int, default=1); ap.add_argument("--debug-preview", action="store_true")
    ap.add_argument("--preview-fps", type=float, default=10.0); ap.add_argument("--preview-width", type=int, default=480); ap.add_argument("--preview-quality", type=int, default=70)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest: return selftest()
    try: asyncio.run(serve(FrameHub(), args))
    except KeyboardInterrupt: print("\n[tracker] 終了")
    return 0


if __name__ == "__main__": raise SystemExit(main())
