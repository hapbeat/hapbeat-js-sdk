# 外部姿勢トラッカー（boxing デモ用）

ブラウザの Web カメラの代わりに、**外部プロセスから姿勢を流し込む**ための小さなサーバー。
本命は深度カメラ（OAK-D Lite）で**本物の 3D（メートル）**を送ることだが、
Web カメラだけでも同じプロトコルで動く。

- プロトコル: [`PROTOCOL.md`](./PROTOCOL.md)（WebSocket・1 メッセージ 1 フレームの JSON）
- 既定ポート: `ws://localhost:8770`
- ブラウザ側は**起動時にここへ繋ぎに行き、繋がらなければ Web カメラへ自動フォールバック**する。
  途中で切れた場合も Web カメラへ切り替わる。今どちらを使っているかは画面の設定（⚙）に出る。

## 使い方

```bash
cd examples/games/boxing/tracker
pip install -r requirements.txt

python tracker.py --source webcam          # Web カメラ（2D のみ）
python tracker.py --source webcam --hands  # 手の 21 点も送る
python tracker.py --source oak             # OAK-D Lite で 3D（未検証）
python tracker.py --selftest               # カメラ・依存なしでフレーム生成だけ検証
```

起動したままブラウザで `http://localhost:8170/examples/games/boxing/` を開く。

## モード

| モード | 内容 | 状態 |
|---|---|---|
| `--source webcam` | OpenCV の Web カメラ + MediaPipe Pose(+Hands)。`px`（正規化 2D）のみ送る | 実装済み。ブラウザ側は従来どおり奥行きを推定する |
| `--source oak` | OAK-D Lite（DepthAI）で RGB + 深度（RGB にアライン）を取り、関節画素まわりの 5×5 メディアン深度と内部パラメータから 3D 化して `xyz` も送る | **ハード未入手のため未検証**。DepthAI の使い方はコード内コメントに公式 docs の URL を残してある |

`xyz` が届いているフレームでは、ブラウザは**前方リーチの推定（単眼の手のサイズ・肘角度など）を
使わず、実測の 3D 手首位置をそのまま IK の目標**にする。前後の立ち位置も実測の胴の z を使う。
骨の長さは固定なので、実測が多少暴れても腕が伸び縮みすることはない。

## 検証状況

- `--selftest`: 2m 先の被写体が `z = -2.0`（カメラ前方が −Z）になること、画像上寄りが `+Y` に
  なること、無効値 0 を除いたメディアン深度が正しいことを確認済み。
- `--source webcam`: 実カメラでの通し確認は**利用者の環境で実施**（このリポジトリの CI では未実施）。
  依存が入っていない場合は導入方法を出して終了する。
- `--source oak`: **未検証**（OAK-D Lite 未入手）。パイプラインの組み方・深度アライン・
  内部パラメータの取得は公式 docs に沿って書いてあるが、実機で動かして確かめていない。
