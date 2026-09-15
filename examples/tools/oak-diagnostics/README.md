# OAK-D Lite diagnostics

Standalone native Python diagnostics for an OAK-D Lite. This is independent of the boxing demo, MediaPipe, WebSocket, browser, Hapbeat SDK, PC audio, and Hapbeat output. It continuously displays raw RGB, aligned depth color, and their overlay so USB link quality and RGB-D alignment can be checked without application-side effects.

The DepthAI v3 pipeline uses Camera + StereoDepth + Sync. On RVC2 it aligns StereoDepth with `inputAlignTo`; on RVC4 it uses ImageAlign. The host receives one synchronized RGB/aligned-depth group through a latest-only (`maxSize=1`, nonblocking) queue.

## Windows setup

Create an isolated environment from this directory:

```powershell
cd examples/tools/oak-diagnostics
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Or reuse the existing boxing tracker environment, which already pins compatible DepthAI and OpenCV packages:

```powershell
cd examples/tools/oak-diagnostics
..\..\games\boxing\tracker\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

No firmware, driver, or camera setting is changed by this tool.

## Run

```powershell
.\.venv\Scripts\python.exe oak_diagnostics.py
```

The default `balanced` profile requests RGB/aligned depth at `960x540` and `25 FPS`. The window is a 2x2 layout: RGB and aligned depth on the top row, then the overlay and a diagnostics text panel. Each tile is letterboxed to at most `640x360`, so the source resolution is not stretched and the full layout stays at most `1280x720`. Each image has a center crosshair and 5x5 depth ROI. The overlay and diagnostics panel show the selected profile, configured size/FPS, short device ID, USB link classification, sequences, sync delta, valid-depth percentage, center median depth, and failure counts.

Use the other profiles when comparing occasional stutter:

```powershell
.\.venv\Scripts\python.exe oak_diagnostics.py --profile full     # 1280x720 at 30 FPS
.\.venv\Scripts\python.exe oak_diagnostics.py --profile compact  # 640x360 at 25 FPS
```

If USB remains `SUPER` and only `compact` improves the stutter, the issue is more likely transfer/host load. If `full` and `compact` behave the same, it is more likely device cadence/driver related.

- `q` or `Esc`: quit.
- `s`: save the composite PNG and same-frame JSON telemetry in `captures/`.
- USB `SUPER` or faster: `PASS`; `HIGH` (USB 2) is `FAIL`; unknown is `WARN`. OAK-D Lite is expected to use USB 3 Gen1/SuperSpeed.

For unattended validation, request a finite frame count. It exits non-zero when the USB link is not SuperSpeed, RGB and aligned depth sizes differ, intrinsics are invalid, sync exceeds the threshold, valid depth is too sparse, or the requested frame count is not reached.

```powershell
.\.venv\Scripts\python.exe oak_diagnostics.py --headless --frames 120 --json
```

`--json` writes one JSON summary to stdout; diagnostics go to stderr. `--min-valid-depth-ratio` defaults to `0.01`; adjust it only for a deliberately empty scene.

## GUI-free fault isolation

`--isolate` runs discovery, minimal RGB, Stereo, RGB-D, then the DepthAI health check. It does not import OpenCV or open a window. Each attempt runs in a separate Python worker process, so a native DepthAI hang or crash cannot prevent the parent from retaining the preceding report. Every streaming worker creates a new DepthAI `Device` and `Pipeline`, captures the requested frames, then stops and closes both objects. This exposes failures that occur only after a Stereo restart.

```powershell
cd examples/tools/oak-diagnostics
.\.venv\Scripts\python.exe oak_diagnostics.py --isolate --attempts 2 --frames 60 --json `
  --viewer-failed --host workstation-a --cable rear-usb-c --power direct --setup desk-1 `
  --attempt-timeout-seconds 90 --report oak-report-workstation-a-direct.json
```

Use `--stages discover,rgb,stereo,rgbd,health` to select the default sequence, or pass a subset while narrowing a problem. `--timeout-seconds` bounds the worker's frame wait; the outer `--attempt-timeout-seconds` defaults to 90 and terminates a worker that hangs in native code. A timed-out worker records the timeout and the tail of captured native logs. `--report PATH` is valid JSON after every completed attempt: it is written to a temporary file and atomically replaced, so it remains readable after an interruption. The final stdout JSON is also retained, without native DepthAI log lines mixed into it. `--viewer-failed` records that Viewer failed separately, so clean Python stages can be classified as `VIEWER_OR_APP`. `--mxid <MXID>` selects one device; reports and captured logs redact full MXIDs as `...` plus their final eight characters. The health stage uses DepthAI 3.9 `Device.performHealthCheck(DeviceInfo, HealthCheckConfig)` and records USB generation, bandwidth, camera/calibration, IMU, power, and reported issues. Each stage attempt records duration, first-frame time, frame count, USB speed, exception type/message, X_LINK detection, crash state, and captured child-log tails.

The JSON verdict is evidence-based: `PASS`, `DEPTHAI_STEREO_RESTART`, `USB_OR_POWER_OR_HOST`, `DEVICE_OR_FIRMWARE`, or `INCONCLUSIVE`. Health `issues` such as `No IR drivers detected` are recorded but are not, on their own, hardware-failure evidence; explicit camera/calibration/IMU failures are. An explicit power-supply failure is classified as the USB/power/host path. `VIEWER_OR_APP` is emitted only when `--viewer-failed` records a separately observed viewer/application symptom and all isolated stages are clean. A result from one PC never proves a product defect.

For a comparison matrix, keep the command and requested stages/frames unchanged, change exactly one label or physical condition, and save each JSON result. At minimum compare (1) a second PC, (2) a known-good USB 3 cable/port, and (3) a different power condition such as direct versus powered setup. Compare the verdict, USB speed, first-frame times, and the same stage/attempt before assigning the cause to the device or firmware.

## Device-free tests

```powershell
python -m unittest discover -s tests -p "test_*.py"
python oak_diagnostics.py --selftest
```

The unit tests exercise only pure helpers; they neither import DepthAI/OpenCV nor access a camera.
