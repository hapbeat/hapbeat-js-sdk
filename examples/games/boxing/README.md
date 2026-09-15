# 触覚ボクシング

Web camera または OAK-D Lite を入力にした 1 対 1 の正面ボクシングデモ。ゲーム面は 2D（左右の回避、前後の間合い、頭・胴・拳）で、Three.js はその表示だけを行う。敵は正面のまま前後に動く。

入力は [PoseInput v3](./tracker/PROTOCOL.md) の `head` / `torso` / `leftHand` / `rightHand` / `leftShoulder` / `rightShoulder` / `leftElbow` / `rightElbow` で統一する。x は body-side を保ったミラー済み normalized、y は画像下向き normalized。開始後の 1.5 秒で 2D 構えと、得られる場合だけ深度基準を校正する。肩・肘の基準からの2D差分は腕の肩→肘→拳と同じ表示・当たり判定の関節へ反映する。Web camera は MediaPipe の既存 forward 推定、OAK は torso ROI depth による前後移動と hand-vs-torso depth による拳の前進だけを使い、肩・肘の深度は使わない。

```powershell
cd repos-sdk/hapbeat-js-sdk
npm run dev
# http://localhost:8170/examples/games/boxing/

cd examples/games/boxing/tracker
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe tracker.py --selftest
.\.venv\Scripts\python.exe tracker.py --source oak
```

右下 PIP は Web camera のライブ映像または OAK の最新 preview を固定表示する。OAK preview は既定で Pose の33点・骨格線・各ROI深度（m）を重畳し、ゲームへ送る8点を強調表示する。深度をゲームへ送るのは `head` / `torso` / `leftHand` / `rightHand` だけである。転送は既定 5 fps・幅480・JPEG quality 55 のまま、`--no-preview` で無効化できる。実カメラ/OAK/触覚デバイスの手動検証は別途行う。

## 操作

カメラに正対して構える。頭と胴を左右へ動かすと回避、拳を前に出すとパンチになる。胴の前後移動は OAK の torso depth がある場合だけ間合いへ反映される。Web camera では既存の前方リーチ推定を使う。左右移動は構え時の肩幅で正規化され、ゲーム面では約 ±1 の範囲に収める。

⚙ メニューから入力（Auto / OAK-D Lite / Web camera / Mock）、カメラ、PIP、当たり判定と簡易入力表示を選べる。入力の切替または「構えを取り直す」は COUNTDOWN の後、1.5 秒の CALIB を行う。CALIB は8点がそろうまで完了しない。

## 戦い方

敵は正面を保ち、前後の間合いだけを調整する。OBSERVE / AGGRESSIVE / DEFENSIVE / FATIGUE のフェーズ、ジャブ・ストレート・フック・ボディ・フェイント・カウンター、ガード／回避／スイープ判定は従来どおりである。頭か胴を左右へ避け、ガードが開いたタイミングで踏み込んで打つ。

判定は `combat.js` で描画と共通の頭・胴・グローブ球・前腕カプセルを使う。腕に当たれば block、頭か胴なら hit、狙点を外せば dodge になる。敵の HP が 0 なら KO、自分の HP が 0 ならダウンである。

## チューニングとファイル

`tuning.js` は `TUNING`（Web camera の forward/reach 安定化）、`COMBAT`（2Dゲーム面の体格・間合い・当たり判定）、`AI`（攻撃頻度・予備動作・ガード・前後行動）を集約する。ゲーム本体は `boxing.js`、8点変換とCALIBは `pose-input.js`、入力切替は `tracker-source.js`、外部トラッカーは `tracker/` にある。触覚イベントの対応は `eventmap.json` を参照する。

人型アセットは任意で、未配置時はプリミティブ表示になる。Quaternius Universal Base Characters（CC0）の glTF を `assets/downloads/` に置き、`npm run fetch:boxing-assets` を実行すると `player.glb` / `enemy.glb` を抽出できる。

## 制約

MediaPipe のモデルと Three.js は CDN 依存である。OAK は RGB と aligned depth の同一同期グループから head / torso / hands の4点だけに 5×5 ROI median depth を取り、肩・肘は2D関節として送る。深度が無い点は100msだけ点ごとに保持してから2D入力へ戻る。実カメラ、OAK-D Lite、触覚デバイスの通し確認は手動で行う。
