# Changelog

`@hapbeat/sdk` の主要な変更点をまとめます。
形式は [Keep a Changelog](https://keepachangelog.com/) に、バージョン付けは
[Semantic Versioning](https://semver.org/) に従います。

## [Unreleased]

（次リリースに向けた未確定の変更をここに溜めます。現在はありません）

## [0.2.1] - 2026-06-29

### 変更（Changed）

- **Node / React Native transport の受信ソケットを、既定で ephemeral
  （OS 任せ）ポートに bind するよう変更**しました（従来は well-known の `7700`
  を先に試す挙動）。DEC-036 の方針に整合させたものです。`7700` を bind するのは
  デーモン（`hapbeat-helper`）だけにすべきで、SDK が先に `7700` を奪うと、後から
  起動した helper（および Studio）が壊れる恐れがありました。送信は従来どおり
  `7700` 宛てで、PONG は送信元 ephemeral ポートに返るため discovery は影響を
  受けません。これにより Python / Unity SDK と挙動が揃います。

### 追加（Added）

- **`bindPort` オプション** — ローカルの受信ポートを明示的に bind する opt-in
  （例: 非要求のブロードキャストを受けたいデーモン用途で `bindPort: 7700`）。
  指定ポートが使用中なら ephemeral にフォールバックします。既定は `0`（ephemeral）。

## [0.2.0] - 2026-06-29

### 追加（Added）

- **React Native transport** — `connect()` の 3 つ目のビルド。package の
  `exports` の `"react-native"` 条件で解決されます（`dist/react-native.js`）。
  optional peer dependency の **`react-native-udp`** 経由で実 UDP ソケットを開き、
  スマホから Wi-Fi で直接ブロードキャストします — **`hapbeat-helper` は不要**
  （スマホはブラウザのようにサンドボックス化されていない）。wire 形式は Node と同一。
  - `react-native-udp` は optional peer dependency。アプリ側でインストールします。
  - `TextDecoder` の polyfill（`fast-text-encoding`）が必要です。RN Hermes
    （**0.86** 含む）は `TextEncoder` は持つが `TextDecoder` は持たないため。
    `examples/react-native/` 参照。
  - **実機 Android で検証済み（RN 0.86 / Hermes / New Architecture）:**
    UDP ソケット bind・Hapbeat の discovery・command + streaming の発火を helper
    なしで確認。
- **`examples/react-native/`** — 最小の Android デモ。ボタンタップで command
  （`play`）と 1 秒の合成ストリーミングバッファを送信します。

### 変更（Changed）

- 内部: Node と React Native transport が `UdpTransportBase` を共有するように
  なりました（protocol / keepalive / discovery のロジックすべて）。差分はソケット
  実装のみ。Node / Browser ビルドの公開 API 変更はありません。

### 修正（Fixed）

- `src/index.ts` の wire レイヤ再エクスポートを `export * as protocol` から
  `import * as protocol; export { protocol }` に変更。React Native の Metro が
  `@babel/plugin-transform-export-namespace-from` プラグインなしでバンドルできる
  ようになります。

## [0.1.0] - 2026-06-25

初回公開リリース。1 つの API・2 つの transport。

### 追加（Added）

- **`connect(options?)`** — Node（`@hapbeat/sdk` → `dist/node.js`、UDP
  ブロードキャスト直送）と Browser（`dist/browser.js`、`hapbeat-helper` の
  WebSocket `ws://localhost:7703` 経由）。バンドラ / ランタイムが package の
  `exports` マップから自動でビルドを選択します。
- **`Hapbeat`** ファサード — level-1 の「fire」面:
  - `play(eventId, opts?)` — `EventMap`（kit manifest）がモードを決定。
    **command**（`events`）はデバイスにインストール済みの clip を再生、
    **clip**（`stream_events`）はイベントの WAV をホストからストリームします。
  - `streamPcm(pcm, opts?)` — その場の PCM16 バッファをストリーム（L/R 方向性
    触覚向けにステレオ可）。
  - `openStream(opts?)` → `LiveStream` — 連続変調する触覚向けの**永続**ストリーム
    （`STREAM_BEGIN` を 1 回、以降 `handle.write()` でチャンク送出、
    `handle.close()`）。チャンクごとの teardown が不要。
  - `preloadClips()`, `stop()`, `stopAll()`, `ping()`, `discover()`, `close()`。
- **`EventMap`** — 直交する調整側。`fromManifest()`（kit manifest schema 2.0.0）、
  `fromGains()`、および `get` / `gainFor` / `has` / `ids` / `size`。
- **`parseWav`**, **`ClipStreamer`**, **`LiveStream`** を advanced 用途向けの
  named export として公開。さらに `protocol.*`（Layer-1 wire の builder / parser）。
- デバイス discovery（ブロードキャスト PING/PONG）と target addressing
  （`"player_1/chest"` / `"*/chest"` / `""` = ブロードキャスト）。
- サンプル: `examples/node-minimal.mjs`、`examples/browser-minimal.html`、および
  `examples/games/` 配下のブラウザ触覚デモ集。

[Unreleased]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hapbeat/hapbeat-js-sdk/releases/tag/v0.1.0
