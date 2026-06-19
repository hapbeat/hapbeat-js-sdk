# web-sdk (Node transport): default to ephemeral receive bind

- **起点:** workspace セッション（hapbeat-python-sdk）/ 2026-06-19 / DEC-036
- **関連:** `hapbeat-contracts/specs/ports.md`（ポート台帳 + ホスト bind 方針）

## 背景

DEC-036 で「デバイスのコマンドポート 7700 をローカル bind するのは daemon
（hapbeat-helper）ただ一つ。各 SDK は **ephemeral 受信** + 送信先のみ 7700」を
エコシステム共通方針として制定した。理由・全体像は contracts の `specs/ports.md`。

現状の web-sdk Node transport（`src/transport-node.ts`）は `DEFAULT_PORT = 7700`
を**先に試し**、busy のとき ephemeral にフォールバックする実装になっている。
helper が起動していれば EADDRINUSE で fallback して概ね共存できるが、

- helper が後から起動するケースや、OS によってはフォールバックが効かず
  7700 を取り合う余地が残る（python SDK で実際に Studio が落ちる事象が出た）。
- Unity（`new UdpClient(0)`）・python（DEC-036 で既定 ephemeral 化済み）と**非対称**。

## 依頼

Node transport の**既定の受信 bind を ephemeral**（port 0）にする。

- 送信先（destination）は従来どおりデバイスの 7700 を維持する（`socket.send(..., this.port, ...)`）。
- 受信用 bind を既定で `bind(0)`（OS 任せ）にする。PING への PONG は送信元 ephemeral
  ポートに返るため discovery は成立する。
- 明示的に 7700 を bind して**非同期ブロードキャストを受けたい**ケース（daemon 的用途）の
  ために、`bindPort`（or `recvPort`）オプションで opt-in できるようにする。
  - 例: `new HapbeatNode({ port: 7700, bindPort: 7700 })` のときだけ 7700 を bind。
  - 既定（`bindPort` 省略）は ephemeral。
- 既存の「busy → ephemeral fallback」ロジックは、明示 7700 bind を選んだ場合の
  保険として残してよい。

## 完了条件

- 既定構築（`new HapbeatNode()` 相当）で `socket.address().port` が 7700 以外になる。
- helper が 7700 を保持した状態でも Node SDK が起動でき、helper の受信を妨げない。
- `bindPort: 7700` 明示時のみ 7700 を bind しようとする（busy なら従来 fallback）。
- 既存テスト（`node:test`）が通る。可能なら「既定は ephemeral」の回帰テストを追加。
- README / types のコメントを ports.md 方針に整合（送信=7700 / 受信=ephemeral 既定）。

## 参考実装（python SDK）

`hapbeat-python-sdk` の `src/hapbeat/client.py`:
- `UdpClient(port, bind_port=0)` … 既定 ephemeral、`bind_port==port` のときだけ
  `SO_REUSEADDR` を要求して well-known を bind、それ以外は ephemeral。
- 送信は常に `self.port`（7700）宛て。
