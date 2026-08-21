# 🥊 触覚ボクシング（Boxing）

PC のカメラ + [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) で
全身を使って戦うブラウザデモ。パンチ・ガード・回避を姿勢から取り、
**当たった / 受けた / かわした** の違いを Hapbeat の触覚で返す。

コントローラを持たない＝手がふさがらないので、フィードバックを画面外（体）に出す意味が分かりやすい題材。

既定は**テストモード**（勝敗・時間制限なしの無限ループ。どちらかの体力が尽きたら自動で回復して続行）。
当たり方の調整を回し続けるためのモードで、`tuning.js` の `GAME.testMode` を `false` にすると
従来のラウンド制（時間切れ / KO / 勝敗表示）になる。

**攻防はすべて 3D の位置で決まる。** 攻撃の予告テキストも対処の指示も出さない。
敵のグローブがゆっくり近づいてくるのが予告そのもので、
腕をその通り道に置けばガード、上体を振って頭をどければ空振りになる。

表示は **Three.js の背後やや上（over-the-shoulder）視点**。自分の上半身（頭・肩・胴・両腕）が
手前に見え、**頭の当たり判定球が青く光って可視化**されている。そこへ敵のグローブが迫るので、
腕で止めるか頭ごと動かすかを目で見て判断できる。実カメラ映像はトラッキング入力にだけ使い、
確認用のデバッグ PIP でのみ小窓表示する。視点は設定で一人称に切り替えられる（`V` キー）。

---

## 動かし方

```bash
cd hapbeat-js-sdk
npm run dev      # dist/ をビルド + 静的配信 + ホットリロード
```

ブラウザで <http://localhost:8170/examples/games/boxing/> を開く。

- **カメラ許可が必要**（getUserMedia）。`file://` では動かない — 必ず HTTP / localhost で開く。
- 触覚を出すには `hapbeat-helper` の起動が必要（`pipx install hapbeat-helper` → `hapbeat-helper`）。
  未起動でも音と映像だけで最後まで遊べる（⚙ メニューの Helper バッジが「未接続(音/映像のみ)」になる）。
- 推奨ブラウザ: Chrome / Edge。MediaPipe の wasm + モデル、および Three.js は CDN（jsdelivr /
  storage.googleapis.com）からバージョン固定で読むのでオンラインが前提。オフライン展示では
  `pose.js` 冒頭の 3 つの URL と `index.html` の import map（`three`）をローカルへ差し替える。
- 立ち位置は **カメラから 1.5〜2m**、上半身がしっかり収まる位置。明るい場所ほど安定する。

---

## 操作

| 操作 | 動き | どう判定されるか |
|---|---|---|
| 🥊 パンチ | 拳をカメラへ突き出す（左右独立） | 2D から推定した**前方リーチ**で 3D の腕が伸び、グローブ球が敵に触れれば当たり |
| 🛡 ガード | 腕を頭の前に上げる | **ジェスチャー判定なし**。敵グローブが自分のグローブ球 / 前腕カプセルに触れたらガード成立 |
| ↔ 回避 | 上体を左右に振る / しゃがむ | 頭の当たり判定球が実際に動く。敵グローブが当たらなければ空振り（近くを通れば回避成功） |

開始時に **約 1.5 秒の構え計測**（肩幅・鼻位置・肩中点・前腕/上腕の 2D 長さ）を行う。
姿勢が崩れて判定が渋くなったら ⚙ メニューの **「構えを取り直す」** でやり直せる。

### 安定化（プルプル・誤発火への対処）

姿勢推定の値は静止時に細かく震え、素通しすると「ガード中に関節が震えて伸びた判定になる」。
次の 5 段で潰している:

1. **1€ フィルタ**（[`filters.js`](./filters.js)）— 速度に応じてカットオフを上げる方式。
   静止時はしっかり止まり、パンチの立ち上がりはほぼ素通りする。ランドマーク（正規化 / world）と
   リーチ値の両方に掛けている。
2. **可視性ゲート** — `visibility` がしきい値未満のランドマークはそのフレームを捨て、直前値を保持。
3. **デッドバンド + スルーレート制限** — ±0.05 未満の変化は無視。伸びは 6/s、戻りは 4/s で頭打ち。
4. **ガードロック** — 両手首が顔の近く（肩幅 0.7 倍以内）で、かつほぼ動いていなければガード中と
   みなし、リーチを 0.3 で頭打ちにする（震えても腕が伸びない）。
5. **発火はリーチの「速度」で判定** — 150ms 以内に 0.28 以上増え、かつ 0.6 以上に達した時だけ
   パンチ発火。**当たり判定が有効なのはそのスイング窓の間だけ**なので、
   ガード中に静止して腕が伸びていても敵には当たらない。

⚙ メニューの「🎯 当たり判定を表示」を ON にすると、画面左に各信号（angle / shorten / hand /
raw / reach）とスイング状態・ガードロックの簡易バーが出る。実カメラでの調整はここを見ながら行う。

### 前方リーチの推定（単眼カメラに奥行きは無い）

worldLandmarks の z は、拳をカメラへ突き出してもほとんど動かない（＝腕が前に伸びない）。
そこで奥行きは使わず、**2D から取れる 2 つの信号**で前方リーチ 0..1 を推定する:

1. **肘角度** — 70° → 0 ／ 165° → 1 に線形マップ。
   3D（正規化ランドマークの x,y,z）と 2D（x,y のみ）の両方を計算し、
   **フレーム間のブレ（|Δangle| の EMA）が小さい方を毎フレーム自動採用**する
   （どちらが安定かは照明・体格・カメラ位置で変わるので固定しない）。
2. **前腕の短縮率** — 前腕の 2D 長さ ÷ 構え時の長さ。カメラへ向くほど短く映るので、
   短いほど前方成分が大きい。肩幅で正規化してあるのでカメラ距離に依らない。
3. **手の見かけサイズ** — 手首・親指・人差し指・小指の 2D スパン ÷ 構え時のスパン。
   カメラに近いほど大きく映る。単眼で最も素直な奥行きキュー。

3 つを**重み付きメディアン**（既定）で合成する。1 つの信号が誤っても他の 2 つが打ち消すため。
実写真（腕を真横に伸ばした姿勢）で検証すると angle=1.0 と誤るが、shorten=0.0 / handSize=0.01 が
勝ってリーチ 0.06 に収まる。合成方法は `reach.combine` で `weighted` / `max` にも切替できる。
合成後に上記の安定化を通し、パンチ検出が発火した瞬間には
**約 120ms で伸び切る突き出しアニメーション**を重ねる（速いパンチほど深い）。
reach=1 でグローブが敵の頭（1.2m 先）に届くようスケールしてある。

---

## 戦い方

敵は `構え（ガード）→ 接近 → 打ち込み → 戻り` を繰り返す。

- **接近**（700〜1000ms、難易度で短縮）: **腕（肩→肘→グローブ）が伸びてくる**。
  これが予告。文字は出ない。フックは横から回り込み、ストレートは正面から。
- **狙いは頭か胴をランダム**（既定 50/50・`attack.aimTarget`）。頭は上げたガードで、
  胴は前腕を下げたボディガードで止める。どちらも体ごと横へ逃げれば空振りにできる
  （胴は的が大きいぶんシビア）。
- **打ち込み**（130ms）: 最後の 3 割を一気に詰める。
- **判定**は毎フレームの位置関係で決まる:
  腕（グローブ球 / 前腕カプセル）に当たれば `boxing_block` ／ 頭・胴に当たれば
  `boxing_player_hit`（頭は HP -12・胴は -7。赤ビネット・強い触覚）／
  当たらず頭の近く（0.32m 以内）を通れば `boxing_dodge`。
- **戻り**の間は敵のガードが開く＝**こちらの差し込みどころ**。
  自分のグローブ球が 敵の頭 → `boxing_punch_hit`（大）／ 胴 → 同（小）／
  ガード中のグローブ → `boxing_punch_blocked`（ほぼ削れない）。
  同じ手は交差の立ち上がりでのみ 1 回判定（多重ヒットしない）。
- 敵 HP 0 で **KO**（`boxing_ko` + スローモー）、自分の HP 0 でダウン、時間切れは残 HP で判定。

⚙ メニューの **「🎯 当たり判定を表示」** で、実際に使っている球・カプセルをワイヤ表示できる。

---

## 触覚・音の配線

| 論理イベント | 触覚 kitEvent（初期値・fps-kit 流用） | 強度の狙い |
|---|---|---|
| `boxing_player_hit` | `fps-kit.damage` | 最強（被弾） |
| `boxing_ko` | `fps-kit.kill-enemy` | 強・長い |
| `boxing_block` | `fps-kit.block` | 中（受け止めた手応え） |
| `boxing_punch_hit` | `fps-kit.shot-player` | 中（刺さった。頭 1.0 / 胴 0.6） |
| `boxing_punch_blocked` | `fps-kit.block` (gain 0.5) | 弱 |
| `boxing_dodge` | `fps-kit.footstep-0` (gain 0.45) | ごく弱（空振り） |
| `boxing_bell` | `fps-kit.kill-enemy` (gain 0.4) | 弱 |

- 対応表は [`eventmap.json`](./eventmap.json)。`gain` は Kit manifest の intensity に掛かる倍率、
  `directional: true` の行は左右で L/R パンする。
- 触覚 clip・音の中身は [`../shared/event-content.js`](../shared/event-content.js) の `boxing_*`。
  ボクシング専用 Kit はまだ無いので、触覚クリップは fps-kit を流用した**仮置き**。

---

## チューニング

閾値・バランスはすべて [`tuning.js`](./tuning.js) に集約している（コード側に数値を直書きしない）。

**`TUNING`** — ジェスチャーとリーチ推定。体格・カメラ位置・照明で効きが変わるので、まずここ。

| キー | 意味 |
|---|---|
| `filter.landmark` / `filter.world` | ランドマークの 1€ フィルタ。**ぷるぷるするなら `minCutoff` を下げる**（追従は鈍る） |
| `reach.oneEuro` | リーチ側の 1€。**パンチが発火しないなら `minCutoff` / `beta` を上げる** |
| `reach.deadband` / `slewUp` / `slewDown` | 微小変化の無視幅と、伸び / 戻りの最大変化率 |
| `reach.guardLock.faceRadius` / `maxSpeed` / `maxReach` | ガード中とみなす条件と、その時のリーチ上限 |
| `punch.swing.deltaMin` / `reachMin` / `windowMs` | 「突いた」と認める増加量・到達値・時間窓 |
| `punch.swing.endReach` / `maxMs` / `cooldownMs` | スイング窓（＝当たり判定が有効な区間）の閉じ方 |
| `reach.angle` / `shorten` / `handSize` の `min*` / `max*` | 各信号 → リーチのマップ範囲 |
| `reach.combine` / `weights` | 3 信号の合成方法（`median` / `weighted` / `max`）と重み |
| `reach.snap` | パンチ時の突き出しアニメーション（`riseMs` / `holdMs` / `fallMs` / `speedRefMps`） |
| `lean` / `duck` の `enterRatio` / `exitRatio` | 補助検出のヒステリシス（肩幅比） |

**`COMBAT`** — 3D の体格・視点・当たり判定（メートル）。

| キー | 意味 |
|---|---|
| `rig.forwardMeters` | reach=1 でグローブが前へ進む距離（**届かない時はここを上げる**） |
| `rig.convergence` / `aim` | 伸ばした時に狙点へ寄せる量。肩は中心から 0.19m 横なので 0 だと正面の敵を素通りする |
| `rig.headGain` | リーン/ダックで頭が動く量（**避けられない時はここを上げる**） |
| `rig.shoulderWidthM` / `shoulderHalf` / `shoulderDrop` / `lateralGain` | 体格 |
| `view.mode` / `third` / `first` | 既定視点と、カメラの引き・高さ |
| `player.headRadius` / `gloveRadius` / `forearmRadius` | 自分の判定サイズ（ガードのしやすさ） |
| `enemy.headRadius` / `torso*` / `guard` / `open` | 敵の判定サイズとガード位置 |
| `attack.approachMs` / `strikeMs` / `retractMs` / `approachFrac` | 攻撃の見える速さ（**難しすぎる時は approachMs を上げる**） |
| `attack.hookArc` / `aimJitter` / `dodgeNear` | フックの弧・狙点のばらつき・回避成立の距離 |
| `attack.aimTarget` / `torsoAimFrac` | 頭 / 胴を狙う比率と、胴を狙う高さ |
| `enemy.arm.*` | 敵の肩の位置と腕の曲げ方（見た目のみ。判定はグローブ球） |
| `player.torsoRadius` / `rig.torsoLength` | 自分の胴の当たり判定（ボディの当たりやすさ） |
| `punchHit.minReach` / `cooldownMs` / `requireSwing` | 当たり判定を取り始めるリーチ・1 スイング 1 回の間隔・スイング窓に限定するか |

**`GAME`** — `testMode`（既定 true・勝敗なしの無限ループ）/ `testResetDelayMs` /
`roundSec` / HP / `idleGapMs` / `rampSec` / `damage.*`（`playerHit` 頭 / `playerBody` 胴）/ `score.*` / 演出。

---

## ファイル構成

```
boxing/
  index.html     # 独立ページ（import map → ../../../dist/browser.js, three@0.160.0）
  boxing.js      # ゲーム本体（状態遷移・敵 AI・判定の呼び出し・HUD/PIP・触覚配線）
  combat.js      # ★ 体の合成と当たり判定（純関数。node で単体テストできる）
  filters.js     # ★ 1€ フィルタ / スルーレート / デッドバンド / 重み付きメディアン（純関数）
  reach.js       # ★ リーチ 3 信号の合成・安定化・スイング検出（純関数）
  scene3d.js     # 3D 描画（位置は決めない。combat.js の結果を置くだけ）
  pose.js        # カメラ + MediaPipe PoseLandmarker（失敗は日本語 1 行に畳む）
  gestures.js    # ランドマーク → 体基準 2D フレーム + 前方リーチ + パンチ検出
  tuning.js      # ★ 閾値・バランスの集約先
  eventmap.json  # 論理イベント → Kit の eventId + gain/pan
```

### 検証用の URL パラメータ

- `?fakecam=1` — 実カメラの代わりに MediaPipe 公式サンプル写真を流す疑似カメラで起動する
  （カメラが無い / 権限が無い環境でも、本物のランドマークが取れる状態で通し確認できる）。
- `?mute=1` — 音を完全に止める。

例: <http://localhost:8170/examples/games/boxing/?fakecam=1&mute=1>

判定（boxing.js）と描画（scene3d.js）が**同じ combat.js を通す**ので、
「見えている位置」と「当たる位置」は構造的にずれない。その性質と、震え対策の効きは
[`tests/boxing-combat.test.mjs`](../../../tests/boxing-combat.test.mjs) /
[`tests/boxing-reach.test.mjs`](../../../tests/boxing-reach.test.mjs) で守っている（`npm test` に含まれる）。

### 座標の対応（実測で確定）

MediaPipe 公式アセット `storage.googleapis.com/mediapipe-assets/pose.jpg` を IMAGE モードで
推論した実データ（2026-08-21 計測）:

| 実測値 | 結論 |
|---|---|
| 左肩(11) x=+0.165 / 右肩(12) x=-0.147 | **+X は画像右＝被写体の「左」側** |
| 鼻(0) y=-0.619（腰中点が原点） | **+Y は下向き** |
| 鼻(0) z=-0.146、カメラへ伸ばした左手首(15) z=-0.185 | **z は負ほどカメラに近い** |

3D 側は +X=画面右 / +Y=上 / -Z=前方（敵の方向）。ミラー表示の 2D（画面左＝自分の左）から
`x` をそのまま右向きに、`y` を反転して上向きに写す。背後視点でも一人称でもカメラは -Z を
向くので、**自分の右手は画面右**に出る。

---

## 既知の制約

- 触覚クリップは fps-kit の流用（仮置き）。ボクシング用の音・触覚は未設計。
- MediaPipe の wasm / モデルと Three.js は CDN 依存（オフライン不可・初回ロードに数秒）。
- アバターはボーン表示のみ（リグ付きメッシュ・手指・脚は無し）。
- 前方リーチは 2D からの**推定**。3 信号のメディアンと安定化でかなり抑えたが、
  照明・服装・体格で効きは変わる。誤爆するときは `reach.weights` で `handSize` を厚くする、
  `punch.swing.deltaMin` を上げる、`reach.guardLock.maxReach` を下げる。
- 敵は回避しない（ガードの開閉のみ）。プレイヤーの攻撃は伸ばしきれば当たる設計。
