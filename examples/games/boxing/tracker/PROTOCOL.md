# 外部トラッカー・プロトコル（現行 schema）

`ws://localhost:8770` の WebSocketへ、1 JSON message = 1フレームを送る。これは release 前の現行schemaであり、旧 schema との後方互換は持たない。座標は非ミラー、右手系・m（+X右、+Y上、-Zカメラ前方）。

```json
{
  "t": 1723459200123, "seq": 812,
  "joints": { "nose": { "px": {"x":0.51,"y":0.28,"visibility":0.99}, "xyz": {"x":0.02,"y":0.35,"z":-1.90}, "depth": {"valid":23,"samples":25,"validRatio":0.92} } },
  "hands": [{ "handedness":"Left", "landmarks":[{"x":0.5,"y":0.4,"z":0.0}] }],
  "telemetry": {
    "source":"oak", "sentAtMs":1723459200123, "trackerFps":24.9,
    "device":{"deviceId":"18443010...","usbSpeed":"SUPER"},
    "rgb":{"width":1280,"height":720,"seq":812,"deviceTimestampMs":8432.4},
    "depth":{"width":1280,"height":720,"seq":812,"deviceTimestampMs":8434.1},
    "syncDeltaMs":1.7, "sequenceDelta":0, "validDepthRatio":0.92, "joint3dCount":8,
    "jointDepth":{"wristR":{"valid":23,"samples":25,"validRatio":0.92}},
    "intrinsics":{"fx":920.1,"fy":919.8,"cx":640.0,"cy":360.0,"width":1280,"height":720},
    "processingLatencyMs":31.2, "dropCounts":{"sync":0,"size":0,"sequence":0,"timestamp":0,"error":0}
  },
  "debug":{"previewDataUrl":"data:image/jpeg;base64,..."}
}
```

- 必須: `t`、単調増加の整数`seq`、`telemetry.sentAtMs`、`nose`/`shoulderL`/`shoulderR`の有限`px`。`xyz` を含むフレームは各`x/y/z`がすべて有限で、上記必須点の`xyz`も必須。違反、逆順、送信時刻から750ms超のフレームはブラウザが棄却する。
- `rgb`/`depth`: サイズ、sequence、device timestampを送る。OAK送信側はサイズ不一致、sequence差の上限超過、FPS由来のSync threshold超過を送信前に棄却する。
- `jointDepth`: Pose関節ごとの小ROI（既定5×5）の有効サンプル数・総サンプル数・比率。`validDepthRatio`は全関節ROIの集計。
- `intrinsics`: `rgbFrame.getTransformation().getIntrinsicMatrix()`から取り、Cameraのcrop/resize済みの値を送る。
- `debug.previewDataUrl`: `--debug-preview`時のみ、RGB+depth overlay+landmarkのJPEG data URL。localhost診断用で最大10fps程度、幅/quality/fpsは引数で制限する。
- 受信側は接続断またはフレームtimeoutでLocalMediaPipeを実際に開始し、外部接続の復帰時は世代番号で古いsocket eventを無視して外部へ戻す。
