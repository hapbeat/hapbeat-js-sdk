# Changelog

`@hapbeat/sdk` の主要な変更点をまとめます。
形式は [Keep a Changelog](https://keepachangelog.com/) に、バージョン付けは
[Semantic Versioning](https://semver.org/) に従います。

## [Unreleased]

### 追加（Added）

- `play(id, { pan })` で左右バランスを指定できるようにしました（-1 = 左のみ / 0 = 中央 / +1 = 右のみ）。command event は PLAY パケット末尾の `pan`(f32)、clip event は source mixer で適用します（contracts §0x01, DEC-055）。
- target に一致するデバイス endpoint ごとに独立した WifiUdp ストリームを
  管理する `StreamHub` を追加しました。同じ endpoint の複数 source は 16 kHz
  stereo PCM16 に正規化して mix し、異なる endpoint は別 session / cursor で
  同時送信します。
- `streamPcm()` は source 単位の `StreamPlayback` を返し、`gain` / `pan` /
  `loop` / `status` と冪等な `stop()` を公開します。`openStream()` の handle も
  同じ source 制御を持ちます。
- manifest clip を source 単位で制御する `playStream(eventId, opts)` を追加し、
  `StreamPlayback` を同期的に返します。初回 WAV load 中も proxy handle から
  stop / gain / pan / loop / status を扱えます。従来の `play()` は
  fire-and-forget の利便 API として同じ StreamHub へ委譲します。

### 変更（Changed）

- ストリームは broadcast fallback せず、PONG で判明した exact `(IP, address)`
  endpoint だけへ送ります。未解決の finite source は `Deferred`、live input は
  遅延を蓄積せず `write() === false` で drop します。
- Browser 経路も helper の全 `stream_begin` / `stream_data` / `stream_end` に
  endpoint IP を明示し、BEGIN には完全 address target も載せます。offline device
  は endpoint table から除外し、target ごとの同時 session に対応しました。
- source ごとの gain / pan、target 指定 stop、300 ms 以上の空 session linger、
  route-only endpoint 変更時の session / offset 継続に対応しました。
- 旧 single-session 実装の `ClipStreamer` / `LiveStream` は削除しました。
- Node / React Native の直接 UDP は stream session v2 に対応しました（DEC-074 /
  075 / 081）。PING に client incarnation を付け、照合済みの直接 PONG の HBS2
  tail で機器ごとに v2 / 旧ファームを判定します。v2 機器には lease と generation
  の envelope を付けて END 直後でも待たずに次の session を始め、旧ファームの機器
  だけ v1 stream と 300 ms の END→BEGIN 待ちを維持します。再起動・lease 更新・
  判定変更では旧形式で END してから新形式で BEGIN し、superseded lease は
  `Hapbeat.reacquireStreamOwnership()`（新しい incarnation で再 PING）を呼ぶまで送信を
  保留します。Browser 経路では helper が同じ判定と待ちを機器ごとに行うため、SDK 側の
  待ちは掛けず、`reacquireStreamOwnership()` は警告を出して `false` を返します。
  volume_wiper 以降が完全な `HBS2` marker でない（"HB" 等の途中までを含む）PONG は
  旧ファームとして扱います。300 ms 待ちは endpoint（IP・port・address の組）単位で、
  同じ address の別機器には掛かりません。待ち中の endpoint が消えた・target に一致
  しなくなった有限 source は、その時点で完了します（機器復帰時に先頭から再生し直し
  ません）。
- mixer は再生中の gain / pan 変更を block 内でサンプルごとに補間し、和のピークが
  32768 を超えた block だけ limiter（-32768 を含む full scale の clip 1 本では作動しない）（目標 0.9·FS、soft knee 0.95·FS）を掛けます。
  hard clamp だけで過大な和を処理しません（sdk-multi-stream.md §5.7–5.8）。
- PONG の `volumeSteps` 解析を削除しました（ファームは PONG に載せておらず、
  HBS2 tail の先頭を誤読するため）。

### 検証（Validation）

- `npm run build`、通信・multi-stream・broadcast の 52 test が通過しました。
- 実機、および React Native 実機は未検証です。

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
- **Hapbeat 実機（duo_wl_v3 / fw 0.3.1）で疎通確認済み（Node）**:
  探索がサブネット宛てに送られ、PONG でそのサブネットに確定し、PLAY / STOP が
  デバイスへユニキャスト**各 1 データグラム**であることをソケット層で実測した。
- **未検証**: React Native 実機（実装上は従来の limited broadcast のままで挙動不変）

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
