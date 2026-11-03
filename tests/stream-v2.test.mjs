// Stream Gen 2 + the Gen 1 fallback (contracts stream-session.md) and the
// mixer contract (sdk-multi-stream.md §5.7-5.9, §7). Fake transports only:
// nothing here opens a socket or reaches a device.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { Hapbeat } from "../dist/node.js";
import { BrowserWsTransport } from "../dist/transport-browser.js";
import { StreamHub } from "../dist/stream.js";
import {
  Probe, makePong, leaseTail, envelopeOf, monoPcm, begins, ends, generations, wait,
} from "./helpers/udp-probe.mjs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

// ── Wire format ────────────────────────────────────────────────────────────

// Transcribed from hapbeat-contracts/fixtures/stream-session-v2.json.
const V2_FIXTURE = {
  identity: { bootId: 0x0102030405060708n, ticket: 7, generation: 42 },
  seq: 4660,
  envelope: "0807060504030201070000002a000000",
  begin: "4248023034121e000807060504030201070000002a000000803e0200000000000000803f2a00",
  data: "42480231341218000807060504030201070000002a000000000000001000f0ff",
  end: "42480232341210000807060504030201070000002a000000",
};

test("Gen 2 stream packets match the contracts fixture byte for byte", () => {
  const { identity, seq } = V2_FIXTURE;
  assert.equal(hex(protocol.buildStreamEnvelope(identity)), V2_FIXTURE.envelope);
  assert.equal(hex(protocol.buildStreamBeginV2(seq, identity, {
    sampleRate: 16000, channels: 2, format: protocol.STREAM_FORMAT_PCM16,
    totalSamples: 0, gain: 1, target: "*",
  })), V2_FIXTURE.begin);
  const audio = new Uint8Array(4);
  new DataView(audio.buffer).setInt16(0, 16, true);
  new DataView(audio.buffer).setInt16(2, -16, true);
  assert.equal(hex(protocol.buildStreamDataV2(seq, identity, 0, audio)), V2_FIXTURE.data);
  assert.equal(hex(protocol.buildStreamEndV2(seq, identity)), V2_FIXTURE.end);
});

test("Gen 1 stream (firmware 0.4.x) keeps header version 1, no envelope, empty END", () => {
  const begin = protocol.buildStreamBegin(1, { channels: 2, target: "p1" });
  assert.equal(begin[2], 0x01);
  assert.equal(protocol.parsePacket(begin).payload.length, 12 + 3);
  assert.equal(protocol.parsePacket(protocol.buildStreamEnd(2)).payload.length, 0);
});

test("extended PING is 16 bytes: timestamp then client incarnation", () => {
  const pkt = protocol.buildPing(5, 1_000_000, 0x1122334455667788n);
  const { payload } = protocol.parsePacket(pkt);
  assert.equal(pkt[2], 0x01);
  assert.equal(payload.length, 16);
  const view = new DataView(payload.buffer, payload.byteOffset, 16);
  assert.equal(view.getBigInt64(0, true), 1_000_000n);
  assert.equal(view.getBigUint64(8, true), 0x1122334455667788n);
  assert.equal(protocol.parsePacket(protocol.buildPing(5, 1)).payload.length, 8);
});

test("parsePong (1.x rules): valid / absent / ignored", () => {
  const valid = protocol.parsePong(makePong({ timestamp: 7n, tail: leaseTail({ incarnation: 9n, flags: 3, highWater: 4 }) }));
  assert.equal(valid.leaseTail, "valid");
  assert.equal(valid.volumeLevel, 5);
  assert.equal(valid.volumeWiper, 9);
  assert.equal(valid.echoedClientIncarnation, 9n);
  assert.equal(valid.bootId, 0xb007n);
  assert.equal(valid.leaseTicket, 3);
  assert.equal(valid.highWaterTicket, 4);
  assert.equal(valid.leaseValid, true);
  assert.equal(valid.leaseSuperseded, true);
  assert.equal(valid.leaseReissued, false);

  assert.equal(protocol.parsePong(makePong()).leaseTail, "absent");
  // Bytes that do not start with HBS2, and a cut marker, are ignored now
  // (0.x read them as Stream Gen 1).
  assert.equal(protocol.parsePong(makePong({ tail: new Uint8Array([1, 2, 3]) })).leaseTail, "ignored");
  for (const length of [1, 2, 3, 4, 31]) {
    assert.equal(protocol.parsePong(makePong({ tail: leaseTail({ incarnation: 1n, length }) })).leaseTail, "ignored", `${length}`);
  }
  assert.equal(protocol.parsePong(makePong({ tail: leaseTail({ incarnation: 1n, version: 2 }) })).leaseTail, "ignored");
  // A later major may use the reserved field and flag bits 3-7, or append
  // bytes after the 32: still a Stream Gen 2 tail.
  for (const tail of [
    leaseTail({ incarnation: 1n, flags: 1 | 8 }),
    leaseTail({ incarnation: 1n, reserved: 1 }),
    leaseTail({ incarnation: 1n, length: 40 }),
  ]) {
    const pong = protocol.parsePong(makePong({ tail }));
    assert.equal(pong.leaseTail, "valid");
    assert.equal(pong.leaseValid, true);
  }
  assert.equal(protocol.parsePong(makePong({ tail: leaseTail({ incarnation: 1n, flags: 1 | 4 }) })).leaseReissued, true);
  const zeroTicket = protocol.parsePong(makePong({ tail: leaseTail({ incarnation: 1n, ticket: 0 }) }));
  assert.equal(zeroTicket.leaseValid, false);
});

// ── Per-device class and lease ─────────────────────────────────────────────

async function connected() {
  const t = new Probe();
  await t.connect();
  return t;
}

test("class: a matched reply without a tail selects Gen 1, with a valid tail Gen 2", async () => {
  const t = await connected();
  t.replyLegacy("10.0.0.1", t.pingNow("10.0.0.1", "p1"), "p1");
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p2"), { address: "p2" });
  const byIp = Object.fromEntries(t.streamEndpoints().map((e) => [e.ip, e]));
  assert.equal(byIp["10.0.0.1"].legacy, true);
  assert.equal(byIp["10.0.0.1"].wireEpoch, "gen1");
  assert.equal(byIp["10.0.0.1"].streamClass, "gen1");
  assert.equal(byIp["10.0.0.2"].legacy, false);
  assert.equal(byIp["10.0.0.2"].wireEpoch, "gen2:45063:3:0");
  assert.equal(byIp["10.0.0.2"].streamClass, "gen2");
  assert.equal(byIp["10.0.0.2"].leaseState, "valid");
});

test("class: unsolicited, unmatched and unreadable-tail replies never classify", async () => {
  const t = await connected();
  const ping = t.pingNow("10.0.0.1", "p1");
  t.handleMessage(makePong({ address: "p1" }), "10.0.0.1", 7700); // unsolicited (timestamp 0)
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  t.handleMessage(makePong({ seq: ping.seq + 1, timestamp: ping.timestamp, address: "p1" }), "10.0.0.1", 7700);
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  t.handleMessage(makePong({ seq: ping.seq, timestamp: ping.timestamp + 1n, address: "p1" }), "10.0.0.1", 7700);
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  // A matched reply from another ip than the one the PING went to.
  t.handleMessage(makePong({ seq: ping.seq, timestamp: ping.timestamp, address: "p1", name: "other" }), "10.0.0.9", 7700);
  assert.equal(t.epoch("10.0.0.9"), "deferred");
  t.handleMessage(makePong({
    seq: ping.seq, timestamp: ping.timestamp, address: "p1",
    tail: leaseTail({ incarnation: ping.incarnation, version: 9 }),
  }), "10.0.0.1", 7700);
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  // An unknown device defers: no BEGIN is sent.
  const endpoint = t.streamEndpoints().find((e) => e.ip === "10.0.0.1");
  assert.equal(endpoint.deferredReason, "UnknownClass");
  assert.equal(t.streamBeginEndpoint(endpoint), false);
  assert.equal(t.streamPackets().length, 0);
});

test("lease: an invalid or superseded lease defers and is never treated as Gen 1", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 0 });
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  assert.equal(t.streamEndpoints()[0].legacy, false);
  assert.equal(t.streamEndpoints()[0].deferredReason, "LeaseUnavailable");
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 | 2 });
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  assert.equal(t.streamEndpoints()[0].deferredReason, "Superseded");
  // A later periodic reply of the same incarnation does not take over.
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1, ticket: 4 });
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  // Explicit reacquisition: fresh incarnation, the new lease is usable.
  t.reacquireStreamOwnership();
  const ping = t.pingNow();
  t.replyV2("10.0.0.1", ping, { flags: 1, ticket: 5 });
  assert.equal(t.epoch("10.0.0.1"), "gen2:45063:5:0");
});

test("lease: a late old-boot PONG never reverts a newer lease; unsolicited PONG keeps it", async () => {
  const t = await connected();
  const older = t.pingNow();
  const newer = t.pingNow();
  t.replyV2("10.0.0.1", newer, { bootId: 2n, ticket: 1 });
  t.replyV2("10.0.0.1", older, { bootId: 1n, ticket: 9 });
  assert.equal(t.epoch("10.0.0.1"), "gen2:2:1:0");
  t.handleMessage(makePong({ address: "p1" }), "10.0.0.1", 7700);
  assert.equal(t.epoch("10.0.0.1"), "gen2:2:1:0");
  // A reply echoing a previous incarnation is discarded.
  t.reacquireStreamOwnership();
  t.replyV2("10.0.0.1", t.pingNow(), { incarnation: older.incarnation });
  assert.equal(t.epoch("10.0.0.1"), "deferred");
});

test("Gen 2 transport: envelope on BEGIN/DATA/END, a fresh generation per session, exact unicast", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow(), { bootId: 0x0102030405060708n, ticket: 7 });
  const [endpoint] = t.streamEndpoints();
  const first = t.streamBeginEndpoint(endpoint);
  t.streamDataEndpoint(endpoint, 0, new Uint8Array(4), first);
  t.streamEndEndpoint(endpoint, first);
  const second = t.streamBeginEndpoint(endpoint); // immediately, no cooldown
  const packets = t.streamPackets();
  // The first DATA carries a repeated BEGIN in front of it (Sender requirement 2).
  assert.deepEqual(packets.map(({ pkt }) => [pkt.version, pkt.cmd]), [
    [2, protocol.CMD_STREAM_BEGIN], [2, protocol.CMD_STREAM_BEGIN], [2, protocol.CMD_STREAM_DATA],
    [2, protocol.CMD_STREAM_END], [2, protocol.CMD_STREAM_BEGIN],
  ]);
  assert.ok(packets.every(({ ip }) => ip === "10.0.0.1"));
  assert.deepEqual(packets.slice(0, 4).map(({ pkt }) => envelopeOf(pkt).generation), [1, 1, 1, 1]);
  assert.equal(envelopeOf(packets[4].pkt).generation, 2);
  assert.equal(envelopeOf(packets[0].pkt).bootId, 0x0102030405060708n);
  assert.equal(packets[3].pkt.payload.length, 16);
  assert.equal(second.identity.generation, 2);
});

// ── StreamHub over the transport ───────────────────────────────────────────

test("Gen 2 endpoint: a new session begins right after END (no 300 ms wait)", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow());
  const hub = new StreamHub(t, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(1_000, 16), { target: "p1" });
  await wait(350); // finished + linger -> END
  assert.equal(ends(t).length, 1);
  hub.playPcm(monoPcm(2_000, 16), { target: "p1" });
  assert.deepEqual(generations(begins(t)), [1, 2], "BEGIN is immediate on a Gen 2 endpoint");
  hub.close();
});

test("Gen 1 guard applies to the Gen 1 device only; a Gen 2 device beside it is immediate", async () => {
  const t = await connected();
  t.replyLegacy("10.0.0.1", t.pingNow("10.0.0.1", "p1/a"), "p1/a");
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p1/b"), { address: "p1/b" });
  const hub = new StreamHub(t, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(1_000, 16), { target: "p1" });
  assert.equal(begins(t, "10.0.0.1")[0].pkt.version, 1);
  assert.equal(begins(t, "10.0.0.2")[0].pkt.version, 2);
  await wait(350);
  assert.equal(ends(t, "10.0.0.1").length, 1);
  assert.equal(ends(t, "10.0.0.1")[0].pkt.payload.length, 0);
  assert.equal(ends(t, "10.0.0.2").length, 1);

  const playback = hub.playPcm(monoPcm(2_000, 16), { target: "p1" });
  assert.deepEqual(generations(begins(t, "10.0.0.2")), [1, 2]);
  // The Gen 1 END is at most ~40 ms old here, so its BEGIN waits.
  assert.equal(begins(t, "10.0.0.1").length, 1);
  assert.equal(playback.status, "Active");
  await wait(320);
  assert.equal(begins(t, "10.0.0.1").length, 2, "Gen 1 BEGIN is never repeated");
  hub.close();
});

test("class change: the session ends in its old format before the next BEGIN", async () => {
  const t = await connected();
  t.replyLegacy("10.0.0.1", t.pingNow());
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  hub.playPcm(monoPcm(1_000, 16_000), { target: "p1" });
  await wait(20);
  t.replyV2("10.0.0.1", t.pingNow()); // firmware updated to Stream Gen 2
  hub.reconcile();
  const kinds = t.streamPackets().map(({ pkt }) => `${pkt.cmd}/${pkt.version}`);
  const endAt = kinds.indexOf(`${protocol.CMD_STREAM_END}/1`);
  const gen2BeginAt = kinds.indexOf(`${protocol.CMD_STREAM_BEGIN}/2`);
  assert.ok(endAt > 0 && gen2BeginAt > endAt, kinds.join(","));
  await wait(20);
  const afterBegin = t.streamPackets().slice(gen2BeginAt + 1);
  assert.ok(afterBegin.length > 0);
  assert.ok(afterBegin.every(({ pkt }) => pkt.version === 2), "no Gen 1 DATA after the switch");
  hub.close();
});

test("device reboot: the old-boot session ends and DATA continues only under the new boot", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow(), { bootId: 1n, ticket: 1 });
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  const live = hub.openLive({ target: "p1" });
  live.write(monoPcm(500, 256));
  await wait(20);
  t.replyV2("10.0.0.1", t.pingNow(), { bootId: 2n, ticket: 1 });
  hub.reconcile();
  live.write(monoPcm(500, 256));
  await wait(20);
  const packets = t.streamPackets();
  const rebootBegin = packets.findIndex(({ pkt }) =>
    pkt.cmd === protocol.CMD_STREAM_BEGIN && envelopeOf(pkt).bootId === 2n);
  assert.ok(rebootBegin > 0);
  assert.equal(packets[rebootBegin - 1].pkt.cmd, protocol.CMD_STREAM_END);
  assert.equal(envelopeOf(packets[rebootBegin - 1].pkt).bootId, 1n);
  assert.ok(packets.slice(rebootBegin).every(({ pkt }) => envelopeOf(pkt).bootId === 2n));
  assert.equal(envelopeOf(packets[rebootBegin].pkt).generation, 1);
  hub.close();
});

test("superseded lease: DATA stops at once and the source defers", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow());
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  const playback = hub.playPcm(monoPcm(1_000, 16_000), { target: "p1" });
  await wait(20);
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 | 2 });
  hub.reconcile();
  const count = t.streamPackets().length;
  assert.equal(t.streamPackets().at(-1).pkt.cmd, protocol.CMD_STREAM_END);
  assert.equal(playback.status, "Deferred");
  assert.equal(playback.deferredReason, "Superseded");
  await wait(30);
  assert.equal(t.streamPackets().length, count, "nothing more is sent");
  hub.close();
});

test("Hapbeat.reacquireStreamOwnership(): a new incarnation retakes a superseded lease", async () => {
  const t = await connected();
  const hb = new Hapbeat(t);
  const first = t.pingNow();
  t.replyV2("10.0.0.1", first, { flags: 1 | 2 });
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  t.sends.length = 0;
  assert.equal(hb.reacquireStreamOwnership(), true);
  const sent = t.sends.filter(([pkt]) => pkt[3] === protocol.CMD_PING);
  assert.equal(sent.length, 1, "re-PINGs at once");
  assert.deepEqual(sent.map(([pkt, ip]) => [ip, protocol.parsePacket(pkt).payload.length]), [["10.0.0.1", 16]],
    "by unicast only");
  const ping = t.pingNow();
  assert.notEqual(ping.incarnation, first.incarnation);
  t.replyV2("10.0.0.1", ping, { flags: 1, ticket: 5 });
  assert.equal(t.epoch("10.0.0.1"), "gen2:45063:5:0");
  await hb.close();
});

test("Hapbeat.reacquireStreamOwnership() is a reported no-op on the helper transport", () => {
  const hb = new Hapbeat(new BrowserWsTransport({}));
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(hb.reacquireStreamOwnership(), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hapbeat-helper/);
});

test("no stream packet is ever broadcast", async () => {
  const t = await connected();
  t.replyLegacy("10.0.0.1", t.pingNow("10.0.0.1", "p1/a"), "p1/a");
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p1/b"), { address: "p1/b" });
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  hub.playPcm(monoPcm(1_000, 64), { target: "" });
  await wait(30);
  hub.close();
  const destinations = new Set(t.streamPackets().map(({ ip }) => ip));
  assert.deepEqual([...destinations].sort(), ["10.0.0.1", "10.0.0.2"]);
});

// ── Routing fixture (sdk-multi-stream.md §7 cases 1, 2, 4) ─────────────────

// Transcribed from hapbeat-contracts/fixtures/sdk-multi-stream-routing.json.
const ROUTING = {
  devices: [
    { id: "left", ip: "192.0.2.10", address: "player_1/pos_l_arm/group_1" },
    { id: "right", ip: "192.0.2.11", address: "player_1/pos_r_arm/group_1" },
  ],
  sources: [
    { id: "left_only", target: "player_1/pos_l_arm", endpoints: ["left"], status: "Active" },
    { id: "both", target: "player_1/*", endpoints: ["left", "right"], status: "Active" },
    { id: "missing", target: "player_2/*", endpoints: [], status: "Deferred" },
  ],
  sessions: [
    { endpoint: "left", begin_target: "player_1/pos_l_arm/group_1" },
    { endpoint: "right", begin_target: "player_1/pos_r_arm/group_1" },
  ],
};

test("routing fixture: one session per endpoint, BEGIN carries the full address", async () => {
  const t = await connected();
  // Each device has its own (random) boot id, so their leases never collide.
  ROUTING.devices.forEach((device, index) => {
    t.replyV2(device.ip, t.pingNow(device.ip, device.address), { address: device.address, bootId: BigInt(index + 1) });
  });
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  const playbacks = ROUTING.sources.map((source) =>
    [source, hub.playPcm(monoPcm(1_000, 64), { target: source.target })]);
  for (const [source, playback] of playbacks) {
    assert.equal(playback.status, source.status, source.id);
    if (source.status === "Deferred") assert.equal(playback.deferredReason, "NoResolvedEndpoint");
  }
  for (const session of ROUTING.sessions) {
    const ip = ROUTING.devices.find((device) => device.id === session.endpoint).ip;
    const sent = begins(t, ip);
    assert.deepEqual(generations(sent), [1], session.endpoint); // one session (repeats are the same tuple)
    const body = sent[0].pkt.payload.subarray(16 + 12);
    assert.equal(new TextDecoder().decode(body), `${session.begin_target}\0`);
  }
  hub.close();
});

// ── Mixer (sdk-multi-stream.md §5.7-5.9, §7 cases 8-9) ─────────────────────

class RecordingSink {
  constructor() { this.data = []; }
  streamEndpoints() { return [{ ip: "10.0.0.1", address: "p1" }]; }
  streamBeginEndpoint() { return {}; }
  streamDataEndpoint(endpoint, offset, data) { this.data.push(new Uint8Array(data)); }
  streamEndEndpoint() {}
  samples() {
    const out = [];
    for (const chunk of this.data) {
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let i = 0; i < chunk.length / 2; i++) out.push(view.getInt16(i * 2, true));
    }
    return out;
  }
}

function sinePcm(frames, amplitude, period, phase = 0) {
  const data = new Uint8Array(frames * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 2, Math.round(amplitude * Math.sin(2 * Math.PI * (i + phase) / period)), true);
  }
  return data;
}

const maxStep = (values) => {
  let m = 0;
  for (let i = 1; i < values.length; i++) m = Math.max(m, Math.abs(values[i] - values[i - 1]));
  return m;
};

test("gain change ramps within a block: no step at the block boundary (§7 case 8)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  const playback = hub.playPcm(monoPcm(20_000, 16_000), { target: "p1" });
  // DC input: the steady output is flat, so any adjacent difference is a step.
  await wait(40);
  playback.gain = 0.2;
  await wait(40);
  hub.close();
  const left = sink.samples().filter((_, i) => i % 2 === 0);
  assert.ok(left.includes(20_000) && left.includes(4_000), "both steady levels were reached");
  // A 16 000-count drop spread over a 256-frame block is ~63 per sample.
  assert.ok(maxStep(left) <= 16_000 / 256 + 1, `max step ${maxStep(left)}`);
});

test("a new source starts at its own gain (onset is not ramped)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(10_000, 256), { target: "p1", gain: 0.5 });
  await wait(20);
  hub.close();
  assert.equal(sink.samples()[0], 5_000);
});

test("limiter: an in-range block passes bit-identical (32000 peak, idle limiter)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  const input = sinePcm(512, 32_000, 64);
  hub.playPcm(input, { target: "p1" });
  await wait(60);
  hub.close();
  const view = new DataView(input.buffer);
  const left = sink.samples().filter((_, i) => i % 2 === 0).slice(0, 512);
  for (let i = 0; i < 512; i++) assert.equal(left[i], view.getInt16(i * 2, true), `frame ${i}`);
});

test("limiter: one full-scale clip containing -32768 passes bit-identical (§5.8)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  const values = [32_767, -32_768, 0, -32_768, 16_000, -16_000, 32_767, -32_768];
  const input = new Uint8Array(512 * 2);
  const view = new DataView(input.buffer);
  for (let i = 0; i < 512; i++) view.setInt16(i * 2, values[i % values.length], true);
  hub.playPcm(input, { target: "p1" });
  await wait(60);
  const session = [...hub.sessions.values()][0];
  if (session) assert.equal(session.limit, 1, "limiter stays idle");
  hub.close();
  const samples = sink.samples().slice(0, 512 * 2);
  for (let i = 0; i < 512; i++) {
    const expected = values[i % values.length];
    assert.equal(samples[i * 2], expected, `left frame ${i}`);
    assert.equal(samples[i * 2 + 1], expected, `right frame ${i}`);
  }
});

test("limiter: four full-gain sines never pin at full scale and stay smooth (§7 case 9)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  for (let k = 0; k < 4; k++) hub.playPcm(sinePcm(4_096, 32_767, 80, k * 3), { target: "p1" });
  await wait(300);
  hub.close();
  const left = sink.samples().filter((_, i) => i % 2 === 0);
  assert.ok(left.length >= 4_096);
  assert.ok(Math.max(...left.map(Math.abs)) <= 32_767); // 0.95·FS + 0.05·FS, never past it
  // The attack ramps across the first loud block, whose first samples are
  // only knee-shaped (as in the Python SDK test); check from the third block.
  const settled = left.slice(2 * 256, 4_096);
  const pinned = settled.filter((v) => Math.abs(v) >= 32_767).length;
  assert.equal(pinned, 0, "no sample sticks to ±32767");
  const peak = Math.max(...settled.map(Math.abs));
  assert.ok(peak >= 0.85 * 32_767 && peak <= 0.95 * 32_767, `peak ${peak}`);
  // Still a sine (no flat tops, no step at block edges): adjacent samples
  // differ at most by the steepest slope of a sine of this peak.
  const clean = peak * 2 * Math.sin(Math.PI / 80);
  assert.ok(maxStep(settled) <= 1.1 * clean, `max step ${maxStep(settled)} vs ${clean}`);
});

test("input resampling is linear, not nearest (§5.9)", async () => {
  const sink = new RecordingSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  // 8 kHz ramp 0, 1000, 2000 ...: at 16 kHz the in-between frames are midpoints.
  const frames = 64;
  const input = new Uint8Array(frames * 2);
  for (let i = 0; i < frames; i++) new DataView(input.buffer).setInt16(i * 2, i * 1000 % 30_000, true);
  hub.playPcm(input, { target: "p1", sampleRate: 8_000 });
  await wait(30);
  hub.close();
  const left = sink.samples().filter((_, i) => i % 2 === 0);
  assert.deepEqual(left.slice(0, 6), [0, 500, 1000, 1500, 2000, 2500]);
});
