#!/usr/bin/env python3
"""外部姿勢トラッカー — MediaPipe Pose(+Hands) の結果を WebSocket で boxing デモへ流す。

2 つのモードがある:

  --source webcam  OpenCV の Web カメラ + MediaPipe。**2D のみ**（xyz は送らない）。
                   ブラウザ側は従来どおり奥行きを推定する。
  --source oak     OAK-D Lite（DepthAI）で RGB + 深度を取り、各関節の画素まわりの
                   深度から **本物の 3D (m)** を作って送る。**ハード未入手のため未検証**。

プロトコルは ./PROTOCOL.md（1 メッセージ 1 フレームの JSON / 右手系・メートル・
+X 右 / +Y 上 / −Z がカメラ前方）。

    pip install -r requirements.txt          # webcam モード
    pip install -r requirements.txt depthai  # oak モード（未検証）
    python tracker.py --source webcam
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time

# 使う pose ランドマーク（MediaPipe Pose の index）→ プロトコルの関節名
JOINTS = {
    "nose": 0,
    "shoulderL": 11, "shoulderR": 12,
    "elbowL": 13, "elbowR": 14,
    "wristL": 15, "wristR": 16,
    "hipL": 23, "hipR": 24,
}
DEFAULT_PORT = 8770


def _missing(dep: str, extra: str = "") -> None:
    print(f"[tracker] {dep} が見つかりません。pip install -r requirements.txt {extra}".rstrip(),
          file=sys.stderr)
    raise SystemExit(2)


class FrameHub:
    """最新フレームを保持して、接続中の全クライアントへ配る小さなハブ。"""

    def __init__(self) -> None:
        self.clients: set = set()
        self.latest: dict | None = None

    async def broadcast(self, frame: dict) -> None:
        self.latest = frame
        if not self.clients:
            return
        msg = json.dumps(frame, separators=(",", ":"))
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


def px_of(lm, with_visibility: bool = True) -> dict:
    """MediaPipe のランドマーク → プロトコルの px（正規化 2D）。"""
    out = {"x": float(lm.x), "y": float(lm.y)}
    z = getattr(lm, "z", None)
    if z is not None:
        out["z"] = float(z)
    if with_visibility:
        v = getattr(lm, "visibility", None)
        if v is not None:
            out["visibility"] = float(v)
    return out


def build_frame(pose_landmarks, hand_results=None, depth_fn=None) -> dict:
    """MediaPipe の結果 → プロトコルのフレーム。

    depth_fn(nx, ny) -> (x, y, z) [m] を渡すと xyz も載せる（深度カメラ時）。
    """
    joints: dict = {}
    for name, idx in JOINTS.items():
        if pose_landmarks is None or idx >= len(pose_landmarks):
            continue
        lm = pose_landmarks[idx]
        entry = {"px": px_of(lm)}
        if depth_fn is not None:
            xyz = depth_fn(lm.x, lm.y)
            if xyz is not None:
                entry["xyz"] = {"x": xyz[0], "y": xyz[1], "z": xyz[2]}
        joints[name] = entry

    frame = {"t": int(time.time() * 1000), "joints": joints}
    if hand_results:
        frame["hands"] = hand_results
    return frame


def median_depth(depth_frame, cx: int, cy: int, k: int = 2):
    """(cx, cy) まわり (2k+1)^2 のメディアン深度 [mm]。0（無効）は除外する。"""
    h = len(depth_frame)
    w = len(depth_frame[0]) if h else 0
    vals = []
    for y in range(max(0, cy - k), min(h, cy + k + 1)):
        for x in range(max(0, cx - k), min(w, cx + k + 1)):
            d = int(depth_frame[y][x])
            if d > 0:
                vals.append(d)
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]


def deproject(nx: float, ny: float, depth_mm: float, intr: dict):
    """正規化画素 + 深度 → カメラ座標 [m]（+X 右 / +Y 上 / −Z 前方）。

    OpenCV の画像座標は y が下向き、深度はカメラ前方が正なので、
    プロトコルの右手系に合わせて y と z の符号を反転する。
    """
    z_m = depth_mm / 1000.0
    x = (nx * intr["width"] - intr["cx"]) * z_m / intr["fx"]
    y = (ny * intr["height"] - intr["cy"]) * z_m / intr["fy"]
    return (x, -y, -z_m)


async def run_webcam(hub: FrameHub, args) -> None:
    """Web カメラ + MediaPipe（2D のみ）。"""
    try:
        import cv2
    except ImportError:
        _missing("opencv-python")
    try:
        import mediapipe as mp
    except ImportError:
        _missing("mediapipe")

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        print(f"[tracker] カメラ {args.camera} を開けません", file=sys.stderr)
        raise SystemExit(1)

    pose = mp.solutions.pose.Pose(model_complexity=1, smooth_landmarks=True)
    hands = mp.solutions.hands.Hands(max_num_hands=2) if args.hands else None
    print(f"[tracker] webcam モードで待受: ws://localhost:{args.port}  (Ctrl+C で終了)")
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                await asyncio.sleep(0.01)
                continue
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            res = pose.process(rgb)
            hand_out = None
            if hands is not None:
                hres = hands.process(rgb)
                if hres.multi_hand_landmarks:
                    hand_out = [
                        {
                            "handedness": hres.multi_handedness[i].classification[0].label,
                            "landmarks": [px_of(p, with_visibility=False) for p in h.landmark],
                        }
                        for i, h in enumerate(hres.multi_hand_landmarks)
                    ]
            lms = res.pose_landmarks.landmark if res.pose_landmarks else None
            await hub.broadcast(build_frame(lms, hand_out))
            await asyncio.sleep(0)  # 他のタスクへ譲る
    finally:
        cap.release()


async def run_oak(hub: FrameHub, args) -> None:
    """OAK-D Lite（DepthAI）で RGB + 深度 → 3D。**ハード未入手のため未検証**。

    参考（公式 docs）:
      - パイプライン基礎: https://docs.luxonis.com/software/depthai/hello-world/
      - StereoDepth / RGB へのアライン: https://docs.luxonis.com/software/depthai-components/nodes/stereo_depth/
      - キャリブレーション（内部パラメータ）の読み出し: https://docs.luxonis.com/software/depthai/examples/calibration_reader/
    """
    try:
        import depthai as dai
    except ImportError:
        _missing("depthai", "depthai")
    try:
        import cv2
        import mediapipe as mp
    except ImportError:
        _missing("opencv-python / mediapipe")

    pipeline = dai.Pipeline()
    cam = pipeline.create(dai.node.ColorCamera)
    cam.setPreviewSize(args.width, args.height)
    cam.setInterleaved(False)
    cam.setBoardSocket(dai.CameraBoardSocket.CAM_A)

    left = pipeline.create(dai.node.MonoCamera)
    right = pipeline.create(dai.node.MonoCamera)
    left.setBoardSocket(dai.CameraBoardSocket.CAM_B)
    right.setBoardSocket(dai.CameraBoardSocket.CAM_C)
    stereo = pipeline.create(dai.node.StereoDepth)
    stereo.setDefaultProfilePreset(dai.node.StereoDepth.PresetMode.HIGH_DENSITY)
    # 深度を RGB の画角に合わせる（ランドマークの画素でそのまま深度を引けるようにする）
    stereo.setDepthAlign(dai.CameraBoardSocket.CAM_A)
    left.out.link(stereo.left)
    right.out.link(stereo.right)

    xout_rgb = pipeline.create(dai.node.XLinkOut)
    xout_rgb.setStreamName("rgb")
    cam.preview.link(xout_rgb.input)
    xout_depth = pipeline.create(dai.node.XLinkOut)
    xout_depth.setStreamName("depth")
    stereo.depth.link(xout_depth.input)

    pose = mp.solutions.pose.Pose(model_complexity=1, smooth_landmarks=True)
    with dai.Device(pipeline) as device:
        calib = device.readCalibration()
        m = calib.getCameraIntrinsics(dai.CameraBoardSocket.CAM_A, args.width, args.height)
        intr = {"fx": m[0][0], "fy": m[1][1], "cx": m[0][2], "cy": m[1][2],
                "width": args.width, "height": args.height}
        q_rgb = device.getOutputQueue("rgb", 4, False)
        q_depth = device.getOutputQueue("depth", 4, False)
        print(f"[tracker] oak モードで待受: ws://localhost:{args.port}  (未検証)")
        while True:
            rgb_msg = q_rgb.tryGet()
            depth_msg = q_depth.tryGet()
            if rgb_msg is None or depth_msg is None:
                await asyncio.sleep(0.005)
                continue
            frame_rgb = cv2.cvtColor(rgb_msg.getCvFrame(), cv2.COLOR_BGR2RGB)
            depth = depth_msg.getFrame()
            res = pose.process(frame_rgb)
            lms = res.pose_landmarks.landmark if res.pose_landmarks else None

            def depth_fn(nx: float, ny: float):
                cx = int(nx * depth.shape[1])
                cy = int(ny * depth.shape[0])
                if not (0 <= cx < depth.shape[1] and 0 <= cy < depth.shape[0]):
                    return None
                d = median_depth(depth, cx, cy)
                if not d or math.isnan(d):
                    return None
                return deproject(nx, ny, d, intr)

            await hub.broadcast(build_frame(lms, None, depth_fn))
            await asyncio.sleep(0)


async def serve(hub: FrameHub, args) -> None:
    try:
        import websockets
    except ImportError:
        _missing("websockets")

    async def handler(ws):
        hub.clients.add(ws)
        try:
            await ws.wait_closed()
        finally:
            hub.clients.discard(ws)

    async with websockets.serve(handler, "localhost", args.port):
        if args.source == "oak":
            await run_oak(hub, args)
        else:
            await run_webcam(hub, args)


def selftest() -> int:
    """カメラも依存も無しで、フレーム生成まわりだけを検証する（事前確認用）。"""

    class LM:  # MediaPipe のランドマーク相当
        def __init__(self, x, y, z=0.0, visibility=1.0):
            self.x, self.y, self.z, self.visibility = x, y, z, visibility

    lms = [LM(0.5, 0.3)] * 33
    frame = build_frame(lms)
    assert set(frame["joints"]) == set(JOINTS), frame["joints"].keys()
    assert "px" in frame["joints"]["nose"]
    assert "xyz" not in frame["joints"]["nose"], "2D モードで xyz を送っている"

    intr = {"fx": 800.0, "fy": 800.0, "cx": 640.0, "cy": 360.0, "width": 1280, "height": 720}
    frame3d = build_frame(lms, None, lambda nx, ny: deproject(nx, ny, 2000.0, intr))
    nose = frame3d["joints"]["nose"]["xyz"]
    assert abs(nose["z"] + 2.0) < 1e-9, nose          # 2m 先 → z = -2.0（カメラ前方が −Z）
    assert nose["y"] > 0, nose                         # 画像の上寄り → +Y
    assert abs(nose["x"]) < 1e-9, nose                 # 画像中央 → x = 0
    # メディアン深度は 0（無効値）を除外する
    assert median_depth([[0, 0, 0], [0, 1500, 1600], [0, 1400, 0]], 1, 1, k=1) == 1500
    assert median_depth([[0, 0], [0, 0]], 0, 0, k=1) is None
    print(json.dumps(frame3d["joints"]["nose"], ensure_ascii=False))
    print("[tracker] selftest OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="boxing デモ用の外部姿勢トラッカー")
    ap.add_argument("--source", choices=["webcam", "oak"], default="webcam",
                    help="webcam: Web カメラ (2D のみ) / oak: OAK-D Lite で 3D (未検証)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--camera", type=int, default=0, help="webcam モードのカメラ index")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--hands", action="store_true", help="手の 21 点も送る（webcam モード）")
    ap.add_argument("--selftest", action="store_true", help="カメラ無しでフレーム生成だけ検証する")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    hub = FrameHub()
    try:
        asyncio.run(serve(hub, args))
    except KeyboardInterrupt:
        print("\n[tracker] 終了")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
