# CLAUDE.md — hapbeat-web-sdk

## repo の目的

JavaScript / TypeScript 向け SDK（npm `@hapbeat/sdk`）。1 つの API で 2 トランスポート:
- **Node**（Electron / server / CLI / creative-coding）→ Wi-Fi UDP broadcast 直送
- **Browser**（WebXR / three.js / p5.js / jsPsych）→ hapbeat-helper(WS 7703) 経由

主対象: Web ゲーム・WebXR・メディアアート・ブラウザ研究実験。

## 全体アーキテクチャ上の役割

contracts の Layer 1 仕様の上に薄く載る code SDK。Unity SDK と同じ
「起点(fire) ↔ 調整(EventMap) を互いに素に分け、event id で紐づける」設計を踏襲。

## 責務

- Layer 1 protocol の TS 実装（`protocol.ts` — wire 仕様に byte 単位で追従）
- `Transport` 抽象（意味コマンド層）。`NodeUdpTransport`(dgram) と `BrowserWsTransport`(helper WS)
- `Hapbeat` facade（transport 非依存）: `connect/play/stop/stopAll/ping/discover`
- `EventMap`（kit manifest schema 2.0.0 → default gain = 調整側）

## 重要な設計制約

- **dgram をブラウザバンドルに漏らさない**: `node:dgram` import は `transport-node.ts`
  のみ。entry を `node.ts` / `browser.ts` に分け、package.json `exports` の
  `node` / `browser` condition で出し分ける。`index.ts` は env 非依存の共有 export のみ。
- **wire 互換の正**は firmware が受理する byte 列。`HapbeatProtocol.cs` / helper `protocol.py` が参照。
- **CONNECT_STATUS の byte 順**は `HapbeatProtocol.cs`（connected,group,appName,deviceName）に合わせる。

## 管理対象 / 対象外

- 対象: `src/` TS、`tests/`（node:test）、docs、examples
- 対象外: helper 本体実装 / ファームウェア / Kit ビルドツール / Unity・Unreal コード

## 依存関係

- 依存してよい: hapbeat-contracts（仕様）、hapbeat-helper（browser transport の WS 相手 — 仕様のみ参照）
- ランタイム依存パッケージ: なし（dgram / WebSocket はプラットフォーム提供）

## やってはいけないこと

- 独自プロトコルを作る（contracts に従う）
- 後方互換 alias を作る（リリース前）
- browser transport で helper の WS スキーマを勝手に拡張する（helper 側は別 repo。必要なら instructions 起票）

## まだ作らないもの（level-2 以降）

- 高レベル trigger 抽象（DOM event / three.js raycast / collision → 自動 fire）
- streaming clip 再生（Web Audio からの取り込み）
- browser transport の device_list 厳密スキーマ追従（現状は defensive parse。helper と実機で要検証）

## テスト

```bash
npm run build && node --test     # protocol round-trip + EventMap + Node socket smoke
npm run typecheck                # tsc --noEmit
```

## 検証状況メモ

- protocol / EventMap / Node transport は本 SDK 単体で検証済（tsc + node:test 9/9）。
- **browser transport は helper + 実機での結合検証が未了**（device_list payload 形は defensive parse）。

## 指示書 / メモリ

- `instructions/`（`completed/` `applied/`）。横断編集の事後承認 note は `applied/`。
- セッション知見は workspace の `../docs/claude-memory/`（INDEX.md 更新）。
