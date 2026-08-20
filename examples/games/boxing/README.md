# 🥊 触覚ボクシング（Boxing）

PC のカメラ + [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) で
全身を使って戦うブラウザデモ。パンチ・ガード・回避を姿勢推定で取り、
**当たった / 受けた / かわした** の違いを Hapbeat の触覚で返す。

コントローラを持たない＝手がふさがらないので、フィードバックを画面外（体）に出す意味が分かりやすい題材。

---

## 動かし方

```bash
cd hapbeat-js-sdk
npm run dev      # dist/ をビルド + 静的配信 + ホットリロード
```

ブラウザで <http://localhost:8170/examples/games/boxing/> を開く。

- **カメラ許可が必要**（getUserMedia）。`file://` では動かない — 必ず HTTP / localhost で開く。
- 触覚を出すには `hapbeat-helper` の起動が必要（`pipx install hapbeat-helper` → `hapbeat-helper`）。
  未起動でも音と映像だけで最後まで遊べる（右パネルの Helper バッジが「未接続(音/映像のみ)」になる）。
- 推奨ブラウザ: Chrome / Edge。MediaPipe の wasm + モデルは CDN（jsdelivr / storage.googleapis.com）から
  読むのでオンラインが前提。オフライン展示ではローカルに置いて `pose.js` 冒頭の 3 つの URL を差し替える。
- 立ち位置は **カメラから 1.5〜2m**、上半身がしっかり収まる位置。明るい場所ほど安定する。

---

## ジェスチャー

画面はミラー表示（鏡と同じ）なので、**画面の左＝自分の左**。

| 操作 | 動き | 判定 |
|---|---|---|
| 🥊 パンチ（左右独立） | 手をカメラへ突き出す | 3D 手首速度がしきい値超え＆カメラ方向成分が優勢、または肘が 150ms 以内に伸展。手ごとに 400ms クールダウン。ガード中は取らない |
| 🛡 ガード | 両手を顔の前に上げる | 両手首が顔の近く（肩幅比）かつ手首が肘より上。継続判定 |
| ◀▶ リーン | 上体を左右に倒す | 肩中点 x の基準からのずれ ÷ 肩幅。ヒステリシス付き（継続判定） |
| ⬇ ダック | しゃがむ | 鼻 y が基準から下がった量 ÷ 肩幅。継続判定 |

開始時に **約 1.5 秒の構え計測**（肩幅・鼻位置・肩中点）を行い、以降はゆっくり基準を追従させる
（体やカメラのじわじわしたズレを吸収する）。姿勢が崩れて判定が渋くなったら、右パネルの
**「構えを取り直す」** で計測し直せる。

現在の検出状態は画面左下のアイコン（🥊L / R🥊 / 🛡 / ◀▶ / ⬇）で確認できる。
右パネルの **🦴 骨格デバッグ表示** で骨格を重ねられる。

---

## 戦い方

敵は `idle → 予告(telegraph) → 打撃(strike) → 硬直(recover)` を繰り返す。

- **予告**（グローブが光ってリングが出る・文字で種類が出る）: 何が来るか分かる時間。
  - 左フック → 右へリーン（またはガード）
  - 右フック → 左へリーン（またはガード）
  - ストレート → ダック（またはガード）
- **打撃の瞬間**に判定: ガード成功 → `boxing_block` ／ 正しい回避 → `boxing_dodge` ／ どちらでもない → `boxing_player_hit`（HP 減・画面フラッシュ＋強い触覚）
- **予告中と硬直中の敵は隙**。ここに自分のパンチを当てると大ダメージ（`boxing_punch_hit`・ヒットストップ＋粒子）。
  隙でないときに打つとガードされる（`boxing_punch_blocked`・ごく軽い触覚）。
- 敵 HP 0 で **KO**（`boxing_ko` + スローモー）、自分の HP 0 でダウン、時間切れは残 HP で判定。
- ラウンド開始 / 終了にゴング（`boxing_bell`）。

---

## 触覚・音の配線

| 論理イベント | 触覚 kitEvent（初期値・fps-kit 流用） | 強度の狙い |
|---|---|---|
| `boxing_player_hit` | `fps-kit.damage` | 最強（被弾） |
| `boxing_ko` | `fps-kit.kill-enemy` | 強・長い |
| `boxing_block` | `fps-kit.block` | 中（受け止めた手応え） |
| `boxing_punch_hit` | `fps-kit.shot-player` | 中（刺さった） |
| `boxing_punch_blocked` | `fps-kit.block` (gain 0.5) | 弱 |
| `boxing_dodge` | `fps-kit.footstep-0` (gain 0.45) | ごく弱（空振り） |
| `boxing_bell` | `fps-kit.kill-enemy` (gain 0.4) | 弱 |

- 対応表は [`eventmap.json`](./eventmap.json)。`gain` は Kit manifest の intensity に掛かる倍率、
  `directional: true` の行は手／攻撃の左右で L/R パンする。
- 触覚 clip・音の中身は [`../shared/event-content.js`](../shared/event-content.js) の `boxing_*`（合成 PCM + 合成音）。
  ボクシング専用 Kit はまだ無いので、触覚クリップは fps-kit を流用した**仮置き**。最終調整はここで行う。

---

## チューニング

閾値・バランスはすべて [`tuning.js`](./tuning.js) に集約している（コード側に数値を直書きしない）。

**`TUNING`（ジェスチャー）** — 体格・カメラ位置・照明で効きが変わるので、まずここを触る。

| キー | 意味 |
|---|---|
| `calibrationMs` | 構え計測の長さ [ms] |
| `baselineTauSec` | FIGHT 中の基準追従の時定数 [s]（大きいほど動じない） |
| `minVisibility` | この可視度未満のランドマークは無視 |
| `punch.speedThreshMps` | パンチと見なす手首速度 [m/s]（下げると出やすい） |
| `punch.forwardRatio` | 速度のうちカメラ方向成分が占める比率の下限（横振りを弾く） |
| `punch.cooldownMs` | 片手ごとの連打間隔 |
| `punch.flexAngleDeg` / `extendAngleDeg` / `extendWindowMs` | 肘の伸展でのパンチ判定 |
| `punch.velocityEma` | 手首速度の平滑化（小さいほど鈍く安定） |
| `block.faceRadiusRatio` | 顔の前と見なす半径（肩幅比） |
| `lean.enterRatio` / `exitRatio` | リーンの入り／抜け閾値（肩幅比・ヒステリシス） |
| `duck.enterRatio` / `exitRatio` | ダックの入り／抜け閾値（肩幅比） |

**`GAME`（バランス・演出）** — `roundSec` / `playerHp` / `enemyHp` / `telegraphMs`（予告の長さ・難易度で短縮）/
`strikeMs` / `recoverMs` / `idleGapMs` / `rampSec`（難易度が上がりきるまでの秒数）/ `damage.*` / `score.*` /
`hitstopMs` / `koSlowMo` / `attackWeights`（攻撃種の抽選比）。

---

## ファイル構成

```
boxing/
  index.html     # 独立ページ（import map → ../../../dist/browser.js）
  boxing.js      # ゲーム本体（状態遷移・敵 AI・描画・HUD・触覚配線）
  pose.js        # カメラ + MediaPipe PoseLandmarker（失敗は日本語 1 行に畳む）
  gestures.js    # ランドマーク → パンチ / ガード / リーン / ダック
  tuning.js      # ★ 閾値・バランスの集約先
  eventmap.json  # 論理イベント → Kit の eventId + gain/pan
```

## 既知の制約

- 触覚クリップは fps-kit の流用（仮置き）。ボクシング用の音・触覚は未設計。
- MediaPipe の wasm / モデルは CDN 依存（オフライン不可・初回ロードに数秒）。
- パンチ判定は単眼推定の 3D 速度なので、照明が暗い・体の一部が隠れると取りこぼす。
  取りこぼすときは `punch.speedThreshMps` を下げ、誤爆するときは `punch.forwardRatio` を上げる。
- 実カメラでの当たり判定の詰めは未実施（数値は机上の初期値）。
