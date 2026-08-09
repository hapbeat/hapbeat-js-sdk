# Changelog

`@hapbeat/sdk` の主要な変更点をまとめます。
形式は [Keep a Changelog](https://keepachangelog.com/) に、バージョン付けは
[Semantic Versioning](https://semver.org/) に従います。

## [0.4.0] - 2026-08-09

Unity SDK v0.4.0 で確定した接続まわりの修正を移植しました。Node / React Native
transport（直接 UDP）が対象です。Browser transport は hapbeat-helper 経由のため
送信経路は helper 側が決めます。

### 修正（Fixed）

- **マルチホーム PC でデバイスを 1 台も発見できない問題**を修正しました（Node）。
  `255.255.255.255`（limited broadcast）は**インターフェイスメトリックが最小の
  1 本からしか送出されません**。Hyper-V / WSL2 / Docker を入れると作られる仮想
  アダプタは **LAN ケーブルを繋いでいなくても常時 Connected** で、Windows の既定で
  Wi-Fi より優先されることがあります。この場合パケットは Hapbeat のいるネットワークに
  一生届きません。ケーブルを挿していないため症状がマルチホームに見えないのが厄介な点です。
  - 探索（PING / CONNECT_STATUS）を**ローカルの各サブネット宛て**へ送るようにしました。
    宛先は `os.networkInterfaces()` が返す実マスクから `(ip & mask) | ~mask` で算出します
    （/16 は `x.y.255.255`、/25 は `x.y.z.127` になるため `.255` 決め打ちにはできません）。
    同一サブネットに NIC が 2 枚ある場合（Ethernet と Wi-Fi を同時に使うノート PC）は
    宛先で重複排除します。
  - **PONG が返ったサブネットに確定**し、以後のブロードキャストをそこへ向けます。
    設定項目は増やしていません（`broadcastAddr` を明示した場合はその宛先をそのまま使います）。
  - `255.255.255.255` は catch-all として常に候補に残します。SoftAP 構成、単一 NIC 環境、
    および **React Native は従来どおり** limited broadcast のみで動きます（スマートフォンや
    HMD は実質単一 NIC のため、`node:os` の無い環境で無理に実装していません）。
  - **PLAY / STOP / STOP_ALL / STREAM_\* は従来どおり単一宛先**です。ファームウェア
    v0.3.0 未満は PLAY/STOP の seq 重複排除を持たないため、再生コマンドを複数経路へ
    送ると触覚が 2 回鳴ります。探索系と再生系で送信経路を分けています。
- **送信エラーのログが埋め尽くされる問題**を修正しました。宛先ごとに障害 1 回だけ警告し、
  復旧時に 1 行出します。ストリームは 1 秒あたり約 100 パケット送るため、抑制しないと
  現場調査に使えるログが残りません。探索の一部の宛先が失敗するのは正常な状態
  （Bluetooth PAN や Wi-Fi Direct のアダプタはブロードキャストを運べません）なので
  警告しません。

### 検証

- `npm test` 45 件（マルチホーム宛先算出・重複排除・探索と再生の経路分離・
  単一 NIC / React Native の非回帰・ログ抑制を含む）、`tsc --noEmit` 通過
- **未検証**: Hapbeat 実機での疎通

## [0.3.0] - 2026-08-03

Node / React Native transport（直接 UDP）のみが対象です。Browser transport は
hapbeat-helper 経由のため、送信経路は helper 側が決めます。

### 変更（Changed）

- **PLAY / STOP / STOP_ALL とクリップストリームを、PING に応答した既知デバイスへ
  ユニキャスト送信**するようになりました（`{ unicast: false }` で従来のブロード
  キャストに戻せます）。Wi-Fi AP は、同じ AP に省電力状態の端末が 1 台でもいると
  ブロードキャストフレームを次の DTIM ビーコン（100〜300 ms 周期）まで保留します。
  これが単発コマンドの発火遅れ、連続ストリームの周期的な途切れとして出ていました。
  デバイス側の設定では回避できない（原因は無関係な他端末）ため、送信側で対処します。
  Unity SDK で実測・検証済みの方針をそのまま移植したものです。
  - 応答があったデバイスが 1 台も無い間はブロードキャストで送ります（起動直後など）。
  - **ユニキャストとブロードキャストの二重送信はしません。**
  - `target` に一致しないデバイスは宛先から外します。アドレス未報告のデバイスは
    宛先に残します（デバイス側で同じ判定をするため、外すと取りこぼしになる）。
  - 既知デバイスがいて全て `target` 不一致だった場合、コマンドはブロードキャストに
    フォールバックします（キャッシュしたアドレスが古いときに STOP が消えて
    ループ再生が止まらなくなるのを防ぐため）。ストリームは送信しません
    （数百パケット分の電波を無駄にするため。取りこぼしても何も残らない）。
  - PING と CONNECT_STATUS はデバイス検出のためブロードキャストのままです。
- **キープアライブが PING も送るようになりました**（従来は CONNECT_STATUS のみ）。
  デバイスが PONG を返すのは PING に対してだけなので、これが無いとユニキャストの
  宛先表が `deviceTtlMs` で空になり、以後ずっとブロードキャストに戻ってしまいます。
  `appName` を渡していない接続でもキープアライブが動くようになりました。

### 追加（Added）

- **`unicast`（既定 `true`）/ `deviceTtlMs`（既定 15000）オプション** — ユニキャストの
  有効・無効と、最後の PONG から何 ms デバイスを宛先として保持するか。
- **`protocol.addressMatches(target, deviceAddress)`** — ファームウェアの
  `addressMatch()` と同一セマンティクスの判定関数。contracts §4.2 の例表を
  そのままテストに移植しています。

### 注意

- **部分ワイルドカードは使えません。** `*` はセグメント全体が `*` のときだけ
  ワイルドカードとして働きます（`player_1/pos_*` は不一致、`player_1/*` は一致）。
  contracts の例表に誤りがあったため、仕様側も併せて訂正しました。

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

[0.3.0]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hapbeat/hapbeat-js-sdk/releases/tag/v0.1.0
