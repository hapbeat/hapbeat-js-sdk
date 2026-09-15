#!/usr/bin/env python3
"""boxing demo OAK-D Lite RGB-D adapter."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import signal
import sys
import threading
import time
from datetime import timedelta
from http import HTTPStatus
from urllib.parse import urlparse

POINTS = {"head": (0, 2, 5, 7, 8), "torso": (11, 12, 23, 24),
          "leftHand": (15, 17, 19, 21), "rightHand": (16, 18, 20, 22),
          "leftShoulder": (11,), "rightShoulder": (12,),
          "leftElbow": (13,), "rightElbow": (14,)}
DEPTH_POINTS = frozenset(("head", "torso", "leftHand", "rightHand"))
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
        self.mailboxes: dict = {}

    async def broadcast(self, frame: dict) -> None:
        self.latest = frame
        if not self.clients:
            return
        message = json.dumps(frame, separators=(",", ":"))
        for ws in list(self.clients):
            box = self.mailboxes.setdefault(ws, {"message": None, "task": None})
            box["message"] = message
            if box["task"] is None or box["task"].done():
                box["task"] = asyncio.create_task(self._drain(ws, box))

    async def _drain(self, ws, box) -> None:
        while box["message"] is not None:
            message, box["message"] = box["message"], None
            try:
                await ws.send(message)
            except Exception:
                self.remove(ws); return

    def remove(self, ws) -> None:
        self.clients.discard(ws)
        box = self.mailboxes.pop(ws, None)
        task = box.get("task") if box else None
        if task and not task.done():
            task.cancel()


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


def semantic_center(landmarks, indexes):
    def in_frame(point) -> bool:
        try:
            return math.isfinite(point.x) and math.isfinite(point.y) and 0 <= point.x <= 1 and 0 <= point.y <= 1
        except (AttributeError, TypeError):
            return False
    def visibility(point) -> float:
        try:
            value = point.visibility
            return value if math.isfinite(value) else 1.0
        except (AttributeError, TypeError):
            return 1.0
    values = [landmarks[i] for i in indexes if landmarks is not None and i < len(landmarks) and in_frame(landmarks[i])]
    if not values:
        return None
    confidence = sum(visibility(p) for p in values) / len(values)
    return {"x": 1 - sum(p.x for p in values) / len(values), "y": sum(p.y for p in values) / len(values),
            "confidence": max(0.0, min(1.0, confidence))}


def build_frame(pose_landmarks, depth_fn=None, seq: int = 0, preview=None, diagnostics=None, captured_at_ms=None) -> dict:
    points = {}
    for name, indexes in POINTS.items():
        value = semantic_center(pose_landmarks, indexes)
        if value is not None and name in DEPTH_POINTS and depth_fn is not None:
            # PoseInput x is mirrored for the browser; aligned RGB/depth pixels are not.
            value["depthM"] = depth_fn(1 - value["x"], value["y"])
        elif value is not None and name in DEPTH_POINTS:
            value["depthM"] = None
        points[name] = value
    frame = {"v": 3, "seq": seq,
             "capturedAtMs": int(time.time() * 1000) if captured_at_ms is None else int(captured_at_ms),
             "points": points}
    if preview:
        frame["preview"] = preview
    if diagnostics:
        frame["diagnostics"] = diagnostics
    return frame


def device_timestamp_ms(frame) -> float:
    return frame.getTimestampDevice().total_seconds() * 1000.0


def depth_m_at_normalized(depth_frame, nx: float, ny: float, k: int) -> float | None:
    """Sample an aligned-depth ROI with the same validity rule used by game points."""
    height, width = depth_frame.shape[:2]
    cx, cy = int(nx * width), int(ny * height)
    if not (0 <= cx < width and 0 <= cy < height):
        return None
    value, _valid, _samples = median_depth_stats(depth_frame, cx, cy, k)
    return value / 1000.0 if value else None


def landmark_depths_m(landmarks, depth_frame, k: int) -> list[float | None]:
    """Return one depth value for every Pose landmark from this RGB-D frame."""
    if landmarks is None:
        return []
    result = []
    for landmark in landmarks:
        try:
            valid = math.isfinite(landmark.x) and math.isfinite(landmark.y)
        except (AttributeError, TypeError):
            valid = False
        result.append(depth_m_at_normalized(depth_frame, landmark.x, landmark.y, k) if valid else None)
    return result


def preview_pixel(nx: float, ny: float, width: int, height: int, mirrored: bool = True):
    """Convert a normalized landmark to the browser-facing preview pixel."""
    if not (math.isfinite(nx) and math.isfinite(ny) and 0 <= nx <= 1 and 0 <= ny <= 1):
        return None
    x = (1 - nx) if mirrored else nx
    return round(x * (width - 1)), round(ny * (height - 1))


def depth_color_bgr(depth_m: float | None) -> tuple[int, int, int]:
    """Near is warm and far is cool; missing depth stays neutral gray."""
    if depth_m is None or not math.isfinite(depth_m) or depth_m <= 0:
        return (140, 140, 140)
    t = max(0.0, min(1.0, (depth_m - 0.25) / 3.75))
    return round(255 * t), round(255 * (1 - abs(2 * t - 1))), round(255 * (1 - t))


def depth_text(depth_m: float | None) -> str:
    return f"{depth_m:.1f}m" if depth_m is not None and math.isfinite(depth_m) and depth_m > 0 else "--"


def pose_overlay_annotations(landmarks, landmark_depths, semantic_points, connections, width: int, height: int) -> dict:
    """Build drawable pose/depth annotations without OpenCV for self-test coverage."""
    pose_points = []
    for index, landmark in enumerate(landmarks or []):
        pixel = preview_pixel(landmark.x, landmark.y, width, height)
        if pixel is None:
            continue
        depth_m = landmark_depths[index] if index < len(landmark_depths) else None
        pose_points.append({"index": index, "pixel": pixel, "depthM": depth_m,
                            "label": f"{index}:{depth_text(depth_m)}", "color": depth_color_bgr(depth_m)})
    by_index = {point["index"]: point for point in pose_points}
    lines = [(by_index[a]["pixel"], by_index[b]["pixel"])
             for a, b in connections if a in by_index and b in by_index]
    semantic = []
    for name, point in semantic_points.items():
        if point is None:
            continue
        pixel = preview_pixel(point["x"], point["y"], width, height, mirrored=False)
        if pixel is not None:
            depth_m = point.get("depthM") if name in DEPTH_POINTS else None
            semantic.append({"name": name, "pixel": pixel, "depthM": depth_m,
                             "label": f"{name} {depth_text(depth_m)}" if name in DEPTH_POINTS else name})
    return {"lines": lines, "landmarks": pose_points, "semantic": semantic}


def pose_depth_preview(cv2, rgb, landmarks, landmark_depths, semantic_points, connections, width: int, quality: int):
    """Encode a mirrored RGB preview with Pose skeleton and aligned-depth annotations."""
    view = cv2.flip(rgb, 1)
    if width > 0 and view.shape[1] > width:
        view = cv2.resize(view, (width, round(view.shape[0] * width / view.shape[1])))
    height, preview_width = view.shape[:2]
    annotations = pose_overlay_annotations(landmarks, landmark_depths, semantic_points, connections, preview_width, height)
    for start, end in annotations["lines"]:
        cv2.line(view, start, end, (210, 210, 210), 1, cv2.LINE_AA)
    offsets = ((4, -4), (4, 9), (-30, -4), (-30, 9))
    for point in annotations["landmarks"]:
        x, y = point["pixel"]
        color = point["color"]
        cv2.circle(view, (x, y), 3, (20, 20, 20), -1, cv2.LINE_AA)
        cv2.circle(view, (x, y), 2, color, -1, cv2.LINE_AA)
        dx, dy = offsets[point["index"] % len(offsets)]
        cv2.putText(view, point["label"], (max(0, x + dx), max(8, y + dy)), cv2.FONT_HERSHEY_SIMPLEX, 0.27, color, 1, cv2.LINE_AA)
    major_colors = {"head": (0, 255, 255), "torso": (255, 0, 255), "leftHand": (0, 255, 0), "rightHand": (255, 255, 0),
                    "leftShoulder": (0, 180, 0), "rightShoulder": (0, 180, 180), "leftElbow": (0, 120, 0), "rightElbow": (0, 120, 120)}
    for point in annotations["semantic"]:
        x, y = point["pixel"]
        color = major_colors[point["name"]]
        cv2.circle(view, (x, y), 6, (20, 20, 20), -1, cv2.LINE_AA)
        cv2.circle(view, (x, y), 4, color, -1, cv2.LINE_AA)
        label = point["label"]
        (label_width, label_height), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.43, 1)
        tx, ty = min(max(0, x + 8), max(0, preview_width - label_width - 2)), max(label_height + 2, y - 8)
        cv2.rectangle(view, (tx - 1, ty - label_height - 1), (tx + label_width + 1, ty + baseline + 1), (20, 20, 20), -1)
        cv2.putText(view, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.43, color, 1, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".jpg", view, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None
    import base64
    return "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")


class ShutdownController:
    """Converts the first Ctrl+C into a frame-boundary shutdown request."""
    def __init__(self) -> None:
        self._requested = threading.Event()
        self.reason: str | None = None

    @property
    def requested(self) -> bool:
        return self._requested.is_set()

    def request(self, reason: str) -> bool:
        if self._requested.is_set():
            return False
        self.reason = reason
        self._requested.set()
        return True


async def next_message_group(queue, shutdown: ShutdownController, poll_interval_s: float = 0.004):
    """Get the newest synchronized frame without blocking graceful shutdown."""
    while True:
        if shutdown.requested:
            return None
        group = queue.tryGet()
        if group is not None:
            return group
        await asyncio.sleep(poll_interval_s)


def _close_oak_resource(resource, label: str) -> None:
    if resource is None:
        return
    close = getattr(resource, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception as exc:
        # A device that has already dropped off USB must not prevent the rest of
        # the shutdown sequence from running.
        print(f"[tracker] shutdown: {label}.close() failed: {exc}", file=sys.stderr)


def close_oak_resources(pose, pipeline) -> bool:
    """Match DepthAI's context-manager shutdown sequence: stop, then wait."""
    clean = True
    started = time.monotonic()
    print("[tracker] shutdown: pipeline.stop")
    if pipeline is not None:
        try:
            pipeline.stop()
        except Exception as exc:
            clean = False
            print(f"[tracker] shutdown: DepthAI pipeline.stop() failed: {exc}", file=sys.stderr)
        print("[tracker] shutdown: pipeline.wait")
        try:
            pipeline.wait()
        except Exception as exc:
            clean = False
            print(f"[tracker] shutdown: DepthAI pipeline.wait() failed: {exc}", file=sys.stderr)
    try:
        _close_oak_resource(pose, "MediaPipe Pose")
    except Exception as exc:
        clean = False
        print(f"[tracker] shutdown: MediaPipe Pose close failed: {exc}", file=sys.stderr)
    elapsed_ms = round((time.monotonic() - started) * 1000)
    print(f"[tracker] shutdown: host cleanup {'complete' if clean else 'incomplete'} ({elapsed_ms}ms)")
    return clean


async def run_oak(hub: FrameHub, args, shutdown: ShutdownController) -> None:
    """Run the DepthAI v3 pipeline and stop only at a safe frame boundary."""
    try:
        import cv2
        import depthai as dai
        import mediapipe as mp
    except ImportError:
        _missing("depthai>=3.7 / opencv-python / mediapipe")
    pipeline = queue = pose = None
    try:
        pipeline = dai.Pipeline()
        device = pipeline.getDefaultDevice()
        # A tracker restart is preferable to DepthAI's background reconnect loop:
        # the latter has been observed to block the next explicit pipeline start.
        device.setMaxReconnectionAttempts(args.reconnect_attempts)
        platform = device.getPlatform()
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
        # Keep only the newest synchronized pair so the browser cannot accrue lag.
        queue = sync.out.createOutputQueue(maxSize=1, blocking=False)
        pose = mp.solutions.pose.Pose(model_complexity=args.pose_model_complexity,
                                      smooth_landmarks=args.smooth_landmarks)
        drops = {"sync": 0, "size": 0, "timestamp": 0, "hostQueue": 0, "error": 0}
        fps = FpsCounter(); last_preview = 0.0; pending_preview = None
        stop_at = time.monotonic() + args.run_for if args.run_for > 0 else None
        print(f"[tracker] oak DepthAI v3 ({platform}) で待受: ws://localhost:{args.port} "
              f"(pose model={args.pose_model_complexity}, smooth={args.smooth_landmarks}, "
              f"reconnect attempts={args.reconnect_attempts})")
        pipeline.start()
        last_rgb_seq = None
        while pipeline.isRunning() and not shutdown.requested:
            if stop_at is not None and time.monotonic() >= stop_at:
                shutdown.request("timer")
                break
            group = await next_message_group(queue, shutdown)
            if group is None:
                break
            captured_at_ms = int(time.time() * 1000)
            processing_started = time.perf_counter()
            rgb_frame = group["rgb"]
            depth_frame = group["depth_aligned"]
            if rgb_frame is None or depth_frame is None:
                drops["sync"] += 1; continue
            rgb = rgb_frame.getCvFrame()
            depth = depth_frame.getFrame()
            rgb_seq = int(rgb_frame.getSequenceNum())
            if last_rgb_seq is not None and rgb_seq > last_rgb_seq + 1:
                drops["hostQueue"] += rgb_seq - last_rgb_seq - 1
            last_rgb_seq = rgb_seq
            rgb_device_ms, depth_device_ms = device_timestamp_ms(rgb_frame), device_timestamp_ms(depth_frame)
            sync_delta_ms = abs(rgb_device_ms - depth_device_ms)
            if rgb.shape[:2] != depth.shape[:2]:
                drops["size"] += 1; continue
            if sync_delta_ms > sync_threshold_ms:
                drops["timestamp"] += 1; continue
            pose_bgr = rgb
            if args.pose_width > 0 and rgb.shape[1] > args.pose_width:
                pose_bgr = cv2.resize(rgb, (args.pose_width, round(rgb.shape[0] * args.pose_width / rgb.shape[1])), interpolation=cv2.INTER_AREA)
            rgb_for_mediapipe = cv2.cvtColor(pose_bgr, cv2.COLOR_BGR2RGB)
            pose_result = pose.process(rgb_for_mediapipe)
            def depth_fn(nx, ny):
                return depth_m_at_normalized(depth, nx, ny, args.depth_roi)
            landmarks = pose_result.pose_landmarks.landmark if pose_result.pose_landmarks else None
            processing_ms = round((time.perf_counter() - processing_started) * 1000, 1)
            frame = build_frame(landmarks, depth_fn, rgb_seq, diagnostics={"fps": fps.tick(), "processingMs": processing_ms},
                                captured_at_ms=captured_at_ms)
            if pending_preview:
                frame["preview"] = pending_preview
                pending_preview = None
            await hub.broadcast(frame)
            if not args.no_preview and time.monotonic() - last_preview >= 1.0 / args.preview_fps:
                landmark_depths = landmark_depths_m(landmarks, depth, args.depth_roi)
                pending_preview = pose_depth_preview(cv2, rgb, landmarks, landmark_depths, frame["points"],
                                                     mp.solutions.pose.POSE_CONNECTIONS, args.preview_width, args.preview_quality)
                last_preview = time.monotonic()
            await asyncio.sleep(0)
    finally:
        if shutdown.requested:
            print(f"[tracker] shutdown requested: {shutdown.reason}")
        close_oak_resources(pose, pipeline)


async def serve(hub: FrameHub, args, shutdown: ShutdownController) -> None:
    try:
        import websockets
    except ImportError:
        _missing("websockets")
    async def handler(ws):
        hub.clients.add(ws)
        try: await ws.wait_closed()
        finally: hub.remove(ws)
    async with websockets.serve(handler, "localhost", args.port, process_request=reject_external_origin):
        await run_oak(hub, args, shutdown)


def selftest() -> int:
    class LM:
        def __init__(self, x, y, z=0.0, visibility=1.0): self.x, self.y, self.z, self.visibility = x, y, z, visibility
    lms = [LM(0.5, 0.3)] * 33
    frame = build_frame(lms, seq=1)
    assert frame["v"] == 3 and set(frame["points"]) == set(POINTS) and frame["points"]["head"]["depthM"] is None
    assert "depthM" not in frame["points"]["leftShoulder"] and "depthM" not in frame["points"]["leftElbow"]
    for index in POINTS["head"]: lms[index] = LM(0.2, 0.3)
    seen = []
    mirrored = build_frame(lms, lambda x, y: seen.append((x, y)) or 1.0, seq=2)
    assert abs(mirrored["points"]["head"]["x"] - 0.8) < 1e-9
    assert abs(seen[0][0] - 0.2) < 1e-9 and abs(seen[0][1] - 0.3) < 1e-9
    for index, x, y in ((11, 0.4, 0.4), (12, 0.6, 0.4), (23, 0.4, 1.2), (24, 0.6, 1.2)):
        lms[index] = LM(x, y)
    partial = semantic_center(lms, POINTS["torso"])
    assert partial == {"x": 0.5, "y": 0.4, "confidence": 1.0}
    for index in POINTS["torso"]: lms[index] = LM(-0.1, 1.2)
    depth_calls = []
    absent = build_frame(lms, lambda x, y: depth_calls.append((x, y)) or 1.0, seq=3)
    assert absent["points"]["torso"] is None and len(depth_calls) == len(DEPTH_POINTS) - 1
    class DepthRows(list):
        shape = (3, 3)
    depth_rows = DepthRows([[0, 0, 0], [0, 1500, 1600], [0, 1400, 0]])
    value, valid, samples = median_depth_stats(depth_rows, 1, 1, 1)
    assert (value, valid, samples) == (1500, 3, 9)
    assert depth_m_at_normalized(depth_rows, 0.5, 0.5, 1) == 1.5
    assert depth_m_at_normalized(depth_rows, 1.0, 0.5, 1) is None
    landmark_depths = landmark_depths_m([LM(0.5, 0.5), LM(1.0, 0.5)], depth_rows, 1)
    assert landmark_depths == [1.5, None]
    annotations = pose_overlay_annotations([LM(0.25, 0.5), LM(0.75, 0.5)], [1.0, None],
                                            {"head": {"x": 0.75, "y": 0.5, "depthM": 1.0}, "torso": None},
                                            {(0, 1)}, 100, 50)
    assert annotations["lines"] == [((74, 24), (25, 24))]
    assert annotations["landmarks"][0]["label"] == "0:1.0m" and annotations["landmarks"][1]["label"] == "1:--"
    assert annotations["semantic"] == [{"name": "head", "pixel": (74, 24), "depthM": 1.0, "label": "head 1.0m"}]
    assert abs(1000 / (2 * 25) - 20) < 1e-9
    assert is_allowed_origin(None) and is_allowed_origin("http://localhost:8170") and is_allowed_origin("https://127.0.0.1:9443")
    assert not is_allowed_origin("https://example.com") and not is_allowed_origin("file://")
    class SlowClient:
        def __init__(self):
            self.sent, self.started, self.release = [], asyncio.Event(), asyncio.Event()
        async def send(self, message):
            self.sent.append(json.loads(message)["seq"]); self.started.set(); await self.release.wait()
    async def coalesce_test():
        hub, client = FrameHub(), SlowClient(); hub.clients.add(client)
        await hub.broadcast({"seq": 1}); await client.started.wait()
        await hub.broadcast({"seq": 2}); await hub.broadcast({"seq": 3})
        client.release.set(); await asyncio.sleep(0); await asyncio.sleep(0)
        assert client.sent == [1, 3] and len(hub.mailboxes) == 1
        hub.remove(client); assert not hub.clients and not hub.mailboxes
    asyncio.run(coalesce_test())
    class PollingQueue:
        def __init__(self): self.values, self.calls = [None, None, "frame"], 0
        def tryGet(self):
            self.calls += 1
            return self.values.pop(0)
        def get(self): raise AssertionError("blocking get() must not be used")
    async def polling_test():
        queue = PollingQueue()
        shutdown = ShutdownController()
        assert await next_message_group(queue, shutdown, poll_interval_s=0) == "frame"
        assert queue.calls == 3
        assert shutdown.request("timer") and not shutdown.request("ctrl-c") and shutdown.reason == "timer"
        assert await next_message_group(queue, shutdown, poll_interval_s=0) is None
    asyncio.run(polling_test())
    closed = []
    class Closable:
        def __init__(self, name): self.name = name
        def close(self): closed.append(f"{self.name}.close")
    class Stoppable:
        def stop(self): closed.append("pipeline.stop")
        def wait(self): closed.append("pipeline.wait")
    assert close_oak_resources(Closable("pose"), Stoppable())
    assert closed == ["pipeline.stop", "pipeline.wait", "pose.close"]
    print("[tracker] selftest OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="boxing デモ用の外部姿勢トラッカー")
    ap.add_argument("--source", choices=["oak"], default="oak", help=argparse.SUPPRESS)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--width", type=int, default=1280); ap.add_argument("--height", type=int, default=720); ap.add_argument("--fps", type=float, default=25.0)
    ap.add_argument("--depth-roi", type=int, default=2)
    ap.add_argument("--pose-model-complexity", type=int, choices=[0, 1, 2], default=1,
                    help="MediaPipe Pose model (0=fast, 1=balanced, 2=accurate)")
    ap.add_argument("--pose-width", type=int, default=960,
                    help="MediaPipe inference width only (0 keeps camera RGB resolution; default: 960)")
    ap.add_argument("--smooth-landmarks", action=argparse.BooleanOptionalAction, default=True,
                    help="MediaPipe temporal landmark smoothing (default: enabled)")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--preview-fps", type=float, default=5.0); ap.add_argument("--preview-width", type=int, default=480); ap.add_argument("--preview-quality", type=int, default=55)
    ap.add_argument("--reconnect-attempts", type=int, default=0,
                    help="DepthAI reconnection attempts after an XLink loss (default: 0)")
    ap.add_argument("--run-for", type=float, default=0.0,
                    help="Gracefully stop after this many seconds; use for restart diagnostics (default: disabled)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest: return selftest()
    shutdown = ShutdownController()
    previous_sigint = signal.getsignal(signal.SIGINT)
    def on_sigint(_signum, _frame):
        if shutdown.request("ctrl-c"):
            print("\n[tracker] Ctrl+C: current frame boundaryで停止します", flush=True)
        else:
            raise KeyboardInterrupt
    signal.signal(signal.SIGINT, on_sigint)
    try:
        asyncio.run(serve(FrameHub(), args, shutdown))
    except KeyboardInterrupt:
        print("\n[tracker] 強制終了")
        return 130
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
    return 0


if __name__ == "__main__": raise SystemExit(main())
