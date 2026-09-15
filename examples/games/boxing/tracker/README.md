# Boxing external tracker

`tracker.py` is a local camera adapter. It emits PoseInput v3's eight semantic points (`head`, `torso`, `leftHand`, `rightHand`, `leftShoulder`, `rightShoulder`, `leftElbow`, `rightElbow`) over localhost WebSocket; it does not define game movement, IK, or hit rules. The browser applies the same body-side, mirrored normalized 2D mapping for Web camera and OAK. OAK contributes aligned-depth ROI medians only for torso forward motion and hand forward punches; shoulder and elbow points do not sample depth.

```powershell
cd examples/games/boxing/tracker
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe tracker.py --selftest
.\.venv\Scripts\python.exe tracker.py --source oak
```

OAK takes synchronized RGB and aligned depth from the same capture group, runs MediaPipe Pose on RGB, calculates the eight semantic points, and samples every Pose landmark with the same 5×5 depth region-of-interest median for the 33-point overlay. Game-point depth sampling remains limited to head, torso, and hands. It sends the latest frame without waiting for WebSocket clients. The default preview is annotated RGB: the standard Pose skeleton, all 33 landmark indices with depth in metres (colour encodes near-to-far depth), and prominent game-point labels using the exact values sent to the game. Preview remains 5 fps, width 480, JPEG quality 55; use `--no-preview` to disable it.

## OAK restart check

The tracker handles the first `Ctrl+C` as a normal stop request. It exits at a frame boundary, calls DepthAI's `pipeline.stop()` and `pipeline.wait()`, then closes MediaPipe. Do not press `Ctrl+C` twice: the second press is an intentional forced exit. Automatic DepthAI reconnection is disabled by default (`--reconnect-attempts 0`) because a background reconnect can contend with the next explicit start.

Use the time-limited run first to check the normal shutdown path without a console signal:

```powershell
.\.venv\Scripts\python.exe tracker.py --source oak --no-preview --run-for 15
```

It should print `shutdown requested: timer` followed by `shutdown: host cleanup complete`. Start the exact same command again without reconnecting USB. Then repeat with a first `Ctrl+C` instead of `--run-for`; it should print `Ctrl+C: current frame boundaryで停止します` and the same host-cleanup message. A failure on only the Ctrl+C case points to the signal/shutdown path; a failure on both cases points to the DepthAI RVC2 pipeline restart path instead.

The wire format and browser acceptance rules are in [PROTOCOL.md](./PROTOCOL.md). Run the self-test without a camera before a hardware check; it covers center construction and ROI median behavior only, not OAK hardware.
