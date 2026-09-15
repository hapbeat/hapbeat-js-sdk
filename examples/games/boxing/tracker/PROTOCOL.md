# PoseInput v3

`ws://localhost:8770` sends one JSON `PoseInputFrame` per capture. This is the only tracker interface; v1 `landmarks`, joints, `xyz`, and DepthAI metadata are not accepted.

```json
{"v":3,"seq":812,"capturedAtMs":1723459200123,"points":{"head":{"x":0.51,"y":0.28,"depthM":1.08,"confidence":0.99},"torso":{"x":0.50,"y":0.52,"depthM":1.12,"confidence":0.98},"leftHand":null,"rightHand":{"x":0.62,"y":0.47,"depthM":0.82,"confidence":0.95},"leftShoulder":{"x":0.59,"y":0.39,"confidence":0.98},"rightShoulder":{"x":0.41,"y":0.39,"confidence":0.98},"leftElbow":{"x":0.66,"y":0.52,"confidence":0.95},"rightElbow":{"x":0.34,"y":0.52,"confidence":0.95}},"preview":"data:image/jpeg;base64,...","diagnostics":{"fps":25}}
```

- Required: `v: 3`, non-negative integer `seq`, finite `capturedAtMs`, and all eight named `points`: `head`, `torso`, `leftHand`, `rightHand`, `leftShoulder`, `rightShoulder`, `leftElbow`, `rightElbow`. A point is `null` or normalized `x`/`y` and confidence 0..1.
- `x`/`y` always come from the same RGB MediaPipe frame, with `x` mirrored for browser display while retaining MediaPipe body-side names. Only `head`, `torso`, `leftHand`, and `rightHand` carry nullable `depthM`: the aligned-depth 5×5 region-of-interest median in metres. Shoulder and elbow points never carry or sample depth.
- A browser rejects out-of-order and stale frames. Rendering interpolates only points for 50 ms; `seq` and diagnostics remain the latest raw values. Missing depth holds that point for 100 ms, then remains 2D/lost without invalidating other points.
- `preview` is optional annotated RGB (OAK default: 5 fps, 480 px, JPEG quality 55): Pose skeleton, all landmark depth labels, and the eight game points use the same synchronized RGB-D capture as the frame. `--no-preview` disables it. `diagnostics` is optional and semantic only.
