// stopAll() then a new stream, a new session under an old lease, and a helper
// "deferred" destination (1.0.1).
//
// - STOP_ALL ends every matching device's session, so the SDK ends its own
//   there at once instead of letting it linger: a source started right after
//   begins a new generation instead of sending DATA the device rejects with
//   STREAM_STOPPED (sdk-multi-stream.md §6.13).
// - The device lets an unused lease expire one TTL after its last extended
//   PING: a new session waits for a refreshed lease instead of a BEGIN the
//   device would answer with STREAM_LEASE_INVALID. A running session is not held.
// - A destination hapbeat-helper deferred never started: a finite cue that
//   played to its end on the ready device completes (helper-streaming.md).
//
// Fake transports only: nothing here opens a socket, reaches a device or makes a sound.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { Hapbeat } from "../dist/node.js";
import { BrowserWsTransport } from "../dist/transport-browser.js";
import { StreamHub } from "../dist/stream.js";
import {
  Probe, makeError, envelopeOf, parsePacketAnyVersion, begins, generations, wait,
} from "./helpers/udp-probe.mjs";

const IP = "10.0.0.1";

/** Mono PCM16 whose sample k is k (a cursor can be read back from the output). */
function rampPcm(frames) {
  const data = new Uint8Array(frames * 2);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame++) view.setInt16(frame * 2, frame % 30_000, true);
  return data;
}

/** Left samples of a Gen 2 DATA packet (envelope 16 + offset 4, then stereo PCM16). */
function leftSamples(pkt) {
  const pcm = pkt.payload.subarray(20);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = [];
  for (let i = 0; i < pcm.length / 4; i++) out.push(view.getInt16(i * 4, true));
  return out;
}

/** Gen 2 stream packets of one command sent to `ip` since `mark` (an index into t.sends). */
function sentSince(t, mark, cmd, ip = IP) {
  return t.sends.slice(mark)
    .filter(([raw, to]) => raw[3] === cmd && to === ip)
    .map(([raw]) => parsePacketAnyVersion(raw));
}

async function quietly(fn) {
  const info = console.info;
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.info = info;
  }
}

async function streamingDevice(address = "p1") {
  const t = new Probe();
  await t.connect();
  t.replyV2(IP, t.pingNow(IP, address), { address, bootId: 0xb1n, ticket: 4 });
  return t;
}

/** As if the device last confirmed the lease `ms` ago, and the last lease PING went out then. */
function ageLease(t, ip, ms) {
  t.streamStates.get(ip).acceptedAt = Date.now() - ms;
  t.extras.get(ip).lastLeaseRequestAt = Date.now() - ms;
}

/** Answer the newest outstanding lease PING to `ip`. */
function answerLeasePing(t, ip, opts) {
  const [seq, pending] = [...t.pendingPings.entries()].filter(([, p]) => p.ip === ip).at(-1);
  t.replyV2(ip, { seq, timestamp: pending.timestampUs, incarnation: pending.clientIncarnation }, opts);
}

const leasePings = (t, ip) => t.packets(protocol.CMD_PING).filter(({ ip: to, pkt }) => to === ip && pkt.payload.length === 16);

// ── stopAll() then a new stream ──────────────────────────────────────────

test("stopAll: the session ends at once, before STOP_ALL; a new stream begins a new generation and plays", (ctx) => quietly(async () => {
  const t = await streamingDevice();
  const hb = new Hapbeat(t, { streamSendAheadSec: 0.01 });
  ctx.after(() => hb.close());
  const first = hb.streamPcm(rampPcm(16_000), { loop: true });
  await wait(30);
  const old = envelopeOf(sentSince(t, 0, protocol.CMD_STREAM_DATA).at(-1));
  hb.stopAll();
  assert.equal(first.status, "Stopped");
  const order = t.sends.map(([raw]) => raw[3]);
  const endAt = order.lastIndexOf(protocol.CMD_STREAM_END);
  assert.ok(endAt >= 0 && endAt < order.lastIndexOf(protocol.CMD_STOP_ALL), "END at once, before STOP_ALL");
  assert.equal(envelopeOf(parsePacketAnyVersion(t.sends[endAt][0])).generation, old.generation);

  const mark = t.sends.length;
  const second = hb.streamPcm(rampPcm(16_000));
  assert.equal(second.status, "Active");
  assert.deepEqual(generations(begins(t, IP)), [old.generation, old.generation + 1]);
  await wait(30);
  const data = sentSince(t, mark, protocol.CMD_STREAM_DATA);
  assert.ok(data.length > 0);
  assert.deepEqual([...new Set(data.map((pkt) => envelopeOf(pkt).generation))], [old.generation + 1]);
  assert.equal(leftSamples(data[0])[0], 0, "from frame 0");

  // A late DATA of the stopped generation is rejected: not about the new Playback.
  const stale = sentSince(t, 0, protocol.CMD_STREAM_DATA).find((pkt) => envelopeOf(pkt).generation === old.generation);
  t.handleMessage(makeError(protocol.ERR_STREAM_STOPPED, { detail: stale.payload.slice(0, 16) }), IP, 7700);
  assert.equal(second.status, "Active");
  await hb.close();
}));

test("stopAll(target): a source of another target leaves that device for good and plays on", (ctx) => quietly(async () => {
  const t = new Probe();
  await t.connect();
  t.replyV2("10.0.0.1", t.pingNow("10.0.0.1", "p1/a"), { address: "p1/a", bootId: 1n });
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p1/b"), { address: "p1/b", bootId: 2n });
  const lost = [];
  const hb = new Hapbeat(t, { streamSendAheadSec: 0.01, onStreamLost: (e) => lost.push(e) });
  ctx.after(() => hb.close());
  const both = hb.streamPcm(rampPcm(16_000), { loop: true, target: "p1" });
  await wait(30);
  hb.stopAll("p1/a");
  assert.equal(both.status, "Active");
  assert.deepEqual(lost, [{ playbackId: both.id, ip: "10.0.0.1", reason: "stopped" }]);
  const mark = t.sends.length;
  await wait(40);
  assert.equal(sentSince(t, mark, protocol.CMD_STREAM_DATA, "10.0.0.1").length, 0, "not on the stopped device");
  assert.ok(sentSince(t, mark, protocol.CMD_STREAM_DATA, "10.0.0.2").length > 0, "the other goes on");
  const fresh = hb.streamPcm(rampPcm(16_000), { loop: true, target: "p1/a" });
  assert.equal(fresh.status, "Active");
  assert.deepEqual(generations(begins(t, "10.0.0.1")), [1, 2], "a new Playback, a new generation");
  await hb.close();
}));

// ── a new session under an old lease ─────────────────────────────────────

test("lease older than the TTL: a new session waits for the refresh, then starts at frame 0", (ctx) => quietly(async () => {
  const t = await streamingDevice();
  ageLease(t, IP, 20_000); // idle 20 s, no lease PING
  const pings = leasePings(t, IP).length;
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  ctx.after(() => hub.close());
  const playback = hub.playPcm(rampPcm(16_000), { target: "p1" });
  assert.equal(playback.status, "Deferred");
  assert.equal(playback.deferredReason, "LeaseUnavailable");
  assert.equal(begins(t, IP).length, 0, "no BEGIN under the old lease");
  assert.equal(leasePings(t, IP).length, pings + 1, "the lease is asked for at once");
  answerLeasePing(t, IP, { bootId: 0xb1n, ticket: 5 });
  assert.equal(playback.status, "Active", "starts on the reply, not at the next tick");
  assert.deepEqual(begins(t, IP).map(({ pkt }) => envelopeOf(pkt).ticket), [5]);
  await wait(20);
  const [first] = sentSince(t, 0, protocol.CMD_STREAM_DATA);
  assert.equal(leftSamples(first)[0], 0, "the start is not skipped");
  hub.close();
}));

test("lease confirmed within the TTL: a new session begins at once", (ctx) => quietly(async () => {
  const t = await streamingDevice();
  ageLease(t, IP, 13_000);
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  ctx.after(() => hub.close());
  const playback = hub.playPcm(rampPcm(16_000), { target: "p1", loop: true });
  assert.equal(playback.status, "Active");
  assert.deepEqual(begins(t, IP).map(({ pkt }) => envelopeOf(pkt).ticket), [4]);
  hub.close();
}));

test("old lease: a running session goes on, and a re-splice in it still begins its next generation", (ctx) => quietly(async () => {
  const t = await streamingDevice();
  const hub = new StreamHub(t, { sendAheadSec: 0.15 });
  ctx.after(() => hub.close());
  const playback = hub.playPcm(rampPcm(32_000), { target: "p1" });
  await wait(30);
  ageLease(t, IP, 20_000); // three lease replies lost
  const mark = t.sends.length;
  await wait(30);
  assert.equal(sentSince(t, mark, protocol.CMD_STREAM_END).length, 0);
  assert.ok(sentSince(t, mark, protocol.CMD_STREAM_DATA).every((pkt) => envelopeOf(pkt).generation === 1));
  assert.equal(playback.status, "Active");
  hub.playPcm(rampPcm(4_000), { target: "p1" }); // inside the sent-ahead audio
  assert.deepEqual(generations(begins(t, IP)), [1, 2], "re-spliced under the same lease");
  hub.close();
}));

// ── hapbeat-helper: a deferred destination ───────────────────────────────

class FakeWS {
  constructor() {
    this.readyState = 1;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWS.sent = [];
    setTimeout(() => this.onopen && this.onopen({}), 0);
  }
  send(s) { FakeWS.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}

test("browser: a one-shot that played to its end on the ready device completes though another was deferred", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  globalThis.WebSocket = FakeWS;
  try {
    const transport = new BrowserWsTransport({});
    const connecting = transport.connect();
    t.mock.timers.tick(1);
    await connecting;
    const say = (type, payload) => transport.onMessage(JSON.stringify({ type, payload }));
    const sent = (type) => FakeWS.sent.filter((m) => m.type === type);
    say("device_list", { devices: [
      { ip: "192.168.1.10", name: "a", address: "p1/a", online: true },
      { ip: "192.168.1.11", name: "b", address: "p1/b", online: true },
    ] });
    const hub = new StreamHub(transport, { sendAheadSec: 0.01 });
    t.after(() => hub.close());
    const playback = hub.playPcm(rampPcm(1_600), { target: "p1" }); // 100 ms
    const byIp = new Map(sent("stream_begin").map((m) => [m.payload.ip, m.payload.stream_id]));
    say("stream_ack", { stream_id: byIp.get("192.168.1.10"), status: "ok", targets: ["192.168.1.10"] });
    say("stream_ack", { stream_id: byIp.get("192.168.1.11"), status: "ok", targets: [], deferred: ["192.168.1.11"] });
    assert.equal(playback.status, "Active");
    for (let i = 0; i < 60; i++) t.mock.timers.tick(5); // the cue plays out on a
    assert.equal(playback.status, "Stopped", "done: b never started it");
    const begun = sent("stream_begin").length;
    t.mock.timers.tick(3_000);
    assert.equal(sent("stream_begin").length, begun, "b is not given the finished cue after the backoff");
    hub.close();
  } finally {
    delete globalThis.WebSocket;
  }
});
