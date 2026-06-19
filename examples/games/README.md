# Hapbeat Arcade — 触覚ミニゲーム集（ブラウザ + helper デモ）

`@hapbeat/sdk`（browser transport）+ `hapbeat-helper` で動く、Hapbeat 無線版のデモ。
展示会で 1〜2 分ずつ遊べる 4 本のミニゲームを収録。いずれも **触覚があることで成立する／体験が変わる**ことを狙っている。

| ゲーム | 触覚機構 | Hapbeat ならではのポイント | 操作 |
|---|---|---|---|
| 🧭 **見えない壁の迷路** (Invisible Maze) | 衝突＝二値 | 壁が見えない。触覚だけを頼りに進む（壁表示 ON/OFF 切替可） | 矢印 / WASD |
| 🥁 **触覚リズム** (Haptic Rhythm) | タイミング | 音・映像・触覚を個別 ON/OFF → モダリティ A/B。「触覚だけ」で叩ける | Space |
| 💎 **宝探し** (Hot & Cold) | 近接＝連続 | 近づくほど触覚が強く・速くなる（ガイガーカウンタ式）。純触覚誘導 | マウス |
| ⚡ **反応速度** (Haptic Reflex) | 合図への反応 | GO を触覚で受けて最速反応。画面 GO を消せば「触覚だけ」勝負。視覚より速い警告チャネルを実感 | Space |

各ゲームに 難易度（Normal/Hard/Expert）・自己ベスト（localStorage 保存）・クリア後の「もう一度 / メニュー」導線・画面シェイク＋粒子の演出を実装。ヘッダーに全画面（⛶）ボタンあり（キオスク向け）。

---

## アーキテクチャ

ブラウザは生 UDP を開けないため、ローカルで動く `hapbeat-helper` が UDP ブロードキャストを代行する。

```
ブラウザ (このデモ)
   │  @hapbeat/sdk  →  ws://localhost:7703
   ▼
hapbeat-helper (pipx install hapbeat-helper)
   │  UDP 7700 broadcast
   ▼
Hapbeat デバイス（demo-kit を配備済み）
```

helper 無しでも **音と映像だけで試遊**できる（触覚は出ない。画面上部に警告が出る）。

---

## 動かし方

### 1. helper を起動

```bash
pipx install hapbeat-helper   # 初回のみ
hapbeat-helper                # ws://localhost:7703 で待受
```

### 2. デバイスに demo-kit を配備（触覚を出すなら必須）

ゲームが送る event id（例 `hapbeat-arcade.maze_bump`）は、**デバイスに同名の Kit がインストールされている**ことが前提。
[`demo-kit/`](./demo-kit/) の `hapbeat-arcade` を **Hapbeat Studio** から配備する:

1. <https://devtools.hapbeat.com> を開く（helper 起動中）
2. Kit に [`demo-kit/`](./demo-kit/) フォルダを読み込む（`hapbeat-arcade-manifest.json` + `install-clips/`）
3. 対象デバイスへ Deploy

> 配備しない場合、ゲームは動くが触覚は鳴らない（device 側に event が無く無視される）。

### 3. デモを HTTP で配信して開く

ES Modules + import map + WAV fetch は `file://` では動かない。HTTP で配信する。

**おすすめ（ワンコマンド・ホットリロード付き）:**

```bash
cd @repos-sdk/hapbeat-web-sdk
npm run dev            # dist/ をビルド + tsc --watch + 静的配信 + 自動リロード
```

ブラウザで開く: **http://localhost:8170/examples/games/**
（ポート変更は `PORT=8080 npm run dev`）

- `src/*.ts` を編集 → `tsc --watch` が `dist/` を再ビルド → ブラウザ自動リロード
- `examples/` の HTML/JS/CSS を編集 → 即ブラウザ自動リロード

> ゼロ依存（Node 標準のみ）。Server-Sent Events で reload を通知し、配信 HTML に小さな購読スクリプトを自動注入する。

**手動でやる場合:**

```bash
npm run serve          # ビルド済み dist/ を静的配信のみ（watch/reload なし）
# または
npm run build && npx serve .     # http://localhost:3000/examples/games/
```

---

## 操作・モダリティ

- 画面右上の **🔊 音 / 📳 触覚** がマスタースイッチ。OFF にするとそのチャンネルが止まる。
- **触覚テスト** ボタンでデバイスの反応を確認できる（展示前チェック用）。
- **再スキャン** で helper にデバイス再探索させる。
- 各ゲーム内に **難易度（Normal / Hard / Expert）** と、ゲーム固有の表示トグル
  （迷路＝壁表示 / リズム＝ノーツ表示 / 宝探し＝ヒート表示）がある。

### モダリティ A/B のおすすめ手順（リズム）
1. 映像 ON・音 ON・触覚 ON で普通に叩く
2. 映像 OFF（音＋触覚）→ 音だけ／触覚だけ、と減らしていく
3. **音 OFF・映像 OFF・触覚 ON**＝「触覚だけ」でリズムを取れるか体感

---

## チューニング

各ゲームが鳴らす event の clip / 強度（gain）は **studio の `showcase-kit` から流用した仮置き**。
最終調整はユーザーが行う前提。対応表は:

- [`TUNING.md`](./TUNING.md) — 人が読む対応表（ゲーム→event→clip→gain→調整メモ）
- [`tuning.csv`](./tuning.csv) — スプレッドシート取り込み用

調整の起点（source of truth）は [`shared/events.js`](./shared/events.js) の `EVENTS`。
clip 差し替えは [`demo-kit/hapbeat-arcade-manifest.json`](./demo-kit/hapbeat-arcade-manifest.json) と
[`demo-kit/install-clips/`](./demo-kit/install-clips/) で行い、Studio から再配備する。

---

## ファイル構成

```
examples/games/
  index.html                 # エントリ（import map → ../../dist/browser.js）
  shared/
    app.js                   # シェル（メニュー / ルーティング / ヘッダー / 全画面）
    hapbeat-bridge.js        # @hapbeat/sdk + 音 + モダリティゲート（helper 無しフォールバック / 切断検知）
    audio.js                 # WebAudio プレースホルダ再生
    events.js                # ★ イベント定義（チューニングの source of truth）
    fx.js                    # 画面シェイク + 粒子（演出）
    scores.js                # 自己ベスト永続化（localStorage）
    ui.js                    # 結果オーバーレイ（もう一度 / メニュー）
    style.css
  games/
    maze.js                  # 見えない壁の迷路
    rhythm.js                # 触覚リズム
    hotcold.js               # 宝探し
    reflex.js                # 反応速度
  demo-kit/
    hapbeat-arcade-manifest.json   # 配備用 Kit manifest（schema 2.0.0）
    install-clips/*.wav            # プレースホルダ触覚 clip（studio showcase-kit 由来）
  README.md / TUNING.md / tuning.csv
```

## 展示会セットアップ & トラブルシュート

**開場前チェック（推奨手順）**
1. `hapbeat-helper` を起動 → デモを開いてヘッダーの状態 pill が「helper 接続済」になるか確認
2. demo-kit を配備済みのデバイスの電源を入れ、ヘッダー「触覚テスト」で実際に振動するか確認
3. 全画面（⛶）にして、各ゲームを 1 周ずつ試遊（自己ベストはこのとき記録され、メニューに表示される）
4. デバイスを複数置く場合は、helper が同一 LAN にいることを確認（UDP ブロードキャスト）

**症状 → 対処**

| 症状 | 対処 |
|---|---|
| pill が「helper 未接続」 | helper が起動しているか確認 → 「再スキャン」。`pipx install hapbeat-helper` → `hapbeat-helper` |
| pill は接続済だが触覚が出ない | demo-kit（`hapbeat-arcade`）をデバイスに配備したか確認（event 名が一致しないと無視される）。📳 がオンか確認 |
| 音が出ない | 🔊 がオンか確認。ブラウザの自動再生制限のため、最初の操作（クリック/キー）後に鳴る |
| 途中で触覚が止まった | helper の再起動・スリープ復帰時など。pill が「未接続」に変わるので「再スキャン」で再接続 |
| 画面が `file://` で動かない | ES Modules の制約。必ず HTTP 配信（`npx serve .`）で開く |
| マルチホーム PC でデバイスを見つけない | Wi-Fi と有線を同時接続していると broadcast 経路がずれることがある（dev-notes 参照）。一方を切る |

> キオスク運用のヒント: 各ゲームのクリア後オーバーレイは「もう一度」（Enter / Space）と「メニュー」（Esc）。難易度は各ゲーム左上で切替。

## 注意 / 既知の制約

- browser transport は helper + 実機での結合検証が SDK 側で未了（`hapbeat-web-sdk/CLAUDE.md` 参照）。
  本デモはその初の実地確認も兼ねる。
- helper WS は `targetTime` スケジューリングを公開していない（即時再生）。リズムは即時発火前提で設計。
- 触覚 clip は studio 由来のプレースホルダ。著作権・素材方針は studio 側のライセンス方針に従う。
