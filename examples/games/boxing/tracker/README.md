# 外部姿勢トラッカー（boxing デモ用）

ブラウザの Web カメラの代わりに、**外部プロセスから姿勢を流し込む**ための小さなサーバー。
本命は深度カメラ（OAK-D Lite）で**本物の 3D（メートル）**を送ることだが、
Web カメラだけでも同じプロトコルで動く。

- プロトコル: [`PROTOCOL.md`](./PROTOCOL.md)（WebSocket・1 メッセージ 1 フレームの JSON）
- 既定ポート: `ws://localhost:8770`
- ブラウザ側は**起動時にここへ繋ぎに行き、繋がらなければ Web カメラへ自動フォールバック**する。
  途中で切れた場合も Web カメラへ切り替わる。今どちらを使っているかは画面の設定（⚙）に出る。

## 使い方

```powershell
cd examples/games/boxing/tracker
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

.\.venv\Scripts\python.exe tracker.py --source webcam          # Web カメラ（2D のみ）
.\.venv\Scripts\python.exe tracker.py --source webcam --hands  # 手の 21 点も送る
.\.venv\Scripts\python.exe tracker.py --source oak --hands --debug-preview # OAK-D Lite で3D + PIP debug
.\.venv\Scripts\python.exe tracker.py --selftest               # カメラ・依存なしでフレーム生成だけ検証
```

起動したままブラウザで `http://localhost:8170/examples/games/boxing/` を開く。

## モード

| モード | 内容 | 状態 |
|---|---|---|
| `--source webcam` | OpenCV の Web カメラ + MediaPipe Pose(+Hands)。`px`（正規化 2D）のみ送る | 実装済み。ブラウザ側は従来どおり奥行きを推定する |
| `--source oak` | OAK-D Lite（DepthAI v3）で同期RGB-Dを取り、関節画素まわりの5×5有効値medianと変換後intrinsicsから `xyz` を送る | OAK-D Lite / DepthAI 3.9.0で同期frameとtelemetryを実機確認済み。RVC2/RVC4公式Depth Align構成を使用 |

`xyz` が届いているフレームでは、ブラウザは**前方リーチの推定（単眼の手のサイズ・肘角度など）を
使わず、実測の 3D 手首位置をそのまま IK の目標**にする。前後の立ち位置も実測の胴の z を使う。
骨の長さは固定なので、実測が多少暴れても腕が伸び縮みすることはない。

## 検証状況

- `--selftest`: deprojection、ROI有効値median/sample数、変換後intrinsics、同期閾値計算を実機なしで確認する。
- `--source webcam`: 実カメラでの通し確認は**利用者の環境で実施**（このリポジトリの CI では未実施）。
  依存が入っていない場合は導入方法を出して終了する。
- `--source oak`: OAK-D Lite実機でUSB SuperSpeed、RGB/Depth 1280×720、同期差、変換後intrinsics、
  3D関節、debug previewのWebSocket受信を確認済み。出力queueは最新1組だけを保持し、低速なMediaPipeで古い姿勢が滞留しない。

## OAK-D Lite再起動時の既知問題

DepthAI 3.9.0でOAK-D Liteのstereo pipelineを異常終了後に再起動すると、約6秒周期で
`X_LINK_ERROR` と再接続を繰り返す場合がある。同じ症状は [Luxonis issue #1248](https://github.com/luxonis/depthai/issues/1248)
で未解決として追跡中。trackerはdevice ID/USB speedを起動時に1回だけ取得し、毎frameのdevice RPCによる再現要因を除去している。
それでも発生した場合は、OAK側のUSB-Cを抜いて10秒待ってから同じUSB 3ポートへ再接続し、trackerを1プロセスだけ起動する。
