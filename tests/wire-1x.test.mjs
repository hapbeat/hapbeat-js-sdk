// The 1.x wire rules (DEC-096): PONG classification, unicast extended PINGs,
// CAPS, ERROR, BEGIN repetition, the 3 s own-gap rule, silence for idle live
// sources, STREAM_STOPPED, re-splice, one-motor endpoints, deferred reasons,
// the endpoint state API and the browser (helper) path.
//
// Fixture hex is transcribed from hapbeat-contracts (commit 46f246e;
// fixtures/stream-session-cases.json `pong_classification`,
// fixtures/wire-extension-cases.json `caps_req` / `caps` / `error`).
// Fake transports and sockets only: nothing here opens a socket, reaches a
// device or makes a sound.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { Hapbeat } from "../dist/node.js";
import { BrowserWsTransport } from "../dist/transport-browser.js";
import { StreamHub } from "../dist/stream.js";
import { SDK_MAJOR } from "../dist/version.js";
import {
  Probe, makePong, makeError, leaseTail, envelopeOf, monoPcm, begins, ends, generations, wait,
} from "./helpers/udp-probe.mjs";

const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** Mono PCM16 whose sample k is k (a cursor can be read back from the output). */
function rampPcm(frames) {
  const data = new Uint8Array(frames * 2);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame++) view.setInt16(frame * 2, frame % 30_000, true);
  return data;
}

/** Left samples of a Gen 2 DATA packet (envelope 16 + offset 4, then stereo PCM16). */
function leftSamples(packet) {
  const pcm = packet.pkt.payload.subarray(20);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = [];
  for (let i = 0; i < pcm.length / 4; i++) out.push(view.getInt16(i * 4, true));
  return out;
}

function stereoSamples(packet) {
  const pcm = packet.pkt.payload.subarray(20);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = [];
  for (let i = 0; i < pcm.length / 4; i++) out.push([view.getInt16(i * 4, true), view.getInt16(i * 4 + 2, true)]);
  return out;
}

const dataOf = (t, ip) => t.streamPackets().filter(({ pkt, ip: to }) =>
  pkt.cmd === protocol.CMD_STREAM_DATA && (ip === undefined || to === ip));
const offsetOf = (packet) => new DataView(packet.pkt.payload.buffer, packet.pkt.payload.byteOffset + 16, 4).getUint32(0, true);

async function connected(opts) {
  const t = new Probe(opts);
  await t.connect();
  return t;
}

function captureConsole(method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => { console[method] = original; } };
}

/** CAPS (0x13) with TLV entries [[type, bytes], ...] in reply to `seq`. */
function makeCaps(seq, entries) {
  const body = [1, 0];
  for (const [type, bytes] of entries) body.push(type, bytes.length, ...bytes);
  return protocol.buildPacket(protocol.CMD_CAPS, seq, new Uint8Array(body));
}

// ── 1. PONG classification (stream-session-cases.json, expected_1x) ────────

const PONG_PING = { seq: 257, timestamp: 1700000000000000n, incarnation: 1234605616436508552n };
const PONG_HEAD = "00401e18240a060088531e18240a0600486170626561742d4100706c617965725f312f706f735f63686573742f67726f75705f3100312e302e300008c8";
const PONG_CASES = [
  ["no_tail", "4248011101013d00" + PONG_HEAD, { class: "gen1" }],
  ["tail_32", "4248011101015d00" + PONG_HEAD + "4842533201010000887766554433221108070605040302010700000007000000",
    { class: "gen2", lease_valid: true, superseded: false, ticket: 7, high_water_ticket: 7, lease_reissued: false }],
  ["tail_superseded", "4248011101015d00" + PONG_HEAD + "4842533201030000887766554433221108070605040302010500000007000000",
    { class: "gen2", lease_valid: true, superseded: true, ticket: 5, high_water_ticket: 7, lease_reissued: false }],
  ["tail_40", "4248011101016500" + PONG_HEAD + "48425332010100008877665544332211080706050403020107000000070000000001020304050607",
    { class: "gen2", lease_valid: true, superseded: false, ticket: 7, high_water_ticket: 7, lease_reissued: false }],
  ["tail_reissued", "4248011101015d00" + PONG_HEAD + "4842533201050000887766554433221108070605040302010900000007000000",
    { class: "gen2", lease_valid: true, superseded: false, ticket: 9, high_water_ticket: 7, lease_reissued: true }],
  ["tail_unknown_flag", "4248011101015d00" + PONG_HEAD + "4842533201090000887766554433221108070605040302010700000007000000",
    { class: "gen2", lease_valid: true, superseded: false, ticket: 7, high_water_ticket: 7, lease_reissued: false }],
  ["tail_reserved_nonzero", "4248011101015d00" + PONG_HEAD + "4842533201010201887766554433221108070605040302010700000007000000",
    { class: "gen2", lease_valid: true, superseded: false, ticket: 7, high_water_ticket: 7, lease_reissued: false }],
  ["tail_ext_version_2", "4248011101015d00" + PONG_HEAD + "4842533202010000887766554433221108070605040302010700000007000000",
    { class: "ignored" }],
  ["tail_short", "4248011101015500" + PONG_HEAD + "484253320101000088776655443322110807060504030201", { class: "ignored" }],
  ["other_bytes", "4248011101015d00" + PONG_HEAD + "5854524100000000000000000000000000000000000000000000000000000000",
    { class: "ignored" }],
  ["truncated_marker", "4248011101014000" + PONG_HEAD + "484253", { class: "ignored" }],
  ["non_streaming_node", "4248011101015d00" + PONG_HEAD + "4842533201000000887766554433221108070605040302010000000000000000",
    { class: "gen2", lease_valid: false, superseded: false, ticket: 0, high_water_ticket: 0, lease_reissued: false }],
];

test("PONG fixtures: parsePong classifies all 12 cases as expected_1x", () => {
  assert.equal(PONG_CASES.length, 12);
  for (const [name, h, expected] of PONG_CASES) {
    const pong = protocol.parsePong(fromHex(h));
    assert.ok(pong, name);
    assert.equal(pong.seq, PONG_PING.seq, name);
    assert.equal(pong.timestamp, PONG_PING.timestamp, name);
    const cls = { absent: "gen1", valid: "gen2", ignored: "ignored" }[pong.leaseTail];
    assert.equal(cls, expected.class, name);
    if (cls !== "gen2") continue;
    assert.equal(pong.echoedClientIncarnation, PONG_PING.incarnation, name);
    assert.deepEqual({
      class: cls, lease_valid: pong.leaseValid, superseded: pong.leaseSuperseded, ticket: pong.leaseTicket,
      high_water_ticket: pong.highWaterTicket, lease_reissued: pong.leaseReissued,
    }, expected, name);
  }
});

test("PONG fixtures: a matched reply classifies the endpoint; an ignored one leaves it unknown", async () => {
  const warn = captureConsole("warn");
  try {
    for (const [name, h, expected] of PONG_CASES) {
      const t = await connected();
      t.handleMessage(makePong({ name: "Hapbeat-A", address: "player_1/pos_chest/group_1", firmware: "1.0.0" }), "10.0.0.1", 7700);
      // The fixture PING was this transport's: same seq, timestamp, incarnation and ip.
      t.clientIncarnation = PONG_PING.incarnation;
      t.pendingPings.set(PONG_PING.seq, {
        timestampUs: PONG_PING.timestamp, clientIncarnation: PONG_PING.incarnation, sentAt: Date.now(), ip: "10.0.0.1",
      });
      t.handleMessage(fromHex(h), "10.0.0.1", 7700);
      const [endpoint] = t.streamEndpoints();
      const want = { gen1: "gen1", gen2: "gen2", ignored: "unknown" }[expected.class];
      assert.equal(endpoint.streamClass, want, name);
      if (expected.class === "ignored") assert.equal(endpoint.deferredReason, "UnknownClass", name);
      if (expected.class === "gen2") {
        const lease = expected.superseded ? "superseded" : expected.lease_valid ? "valid" : "unavailable";
        assert.equal(endpoint.leaseState, lease, name);
      }
      t.close();
    }
  } finally {
    warn.restore();
  }
  // "Warn once per endpoint": one warning for each of the 4 ignored cases (one endpoint each).
  assert.equal(warn.lines.filter((l) => l.includes("cannot read")).length, 4);
});

test("an ignored matched reply warns once per endpoint and changes nothing", async () => {
  const warn = captureConsole("warn");
  try {
    const t = await connected();
    t.replyV2("10.0.0.1", t.pingNow());
    const epoch = t.epoch("10.0.0.1");
    for (let i = 0; i < 3; i++) {
      const ping = t.pingNow();
      t.handleMessage(makePong({ seq: ping.seq, timestamp: ping.timestamp, tail: leaseTail({ incarnation: ping.incarnation, version: 2 }) }), "10.0.0.1", 7700);
    }
    assert.equal(t.epoch("10.0.0.1"), epoch, "the lease is kept");
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.filter((l) => l.includes("cannot read")).length, 1);
});

test("a reply to the 8-byte discovery PING never classifies (it carries no tail by design)", async () => {
  const t = await connected();
  t.handleMessage(makePong({ address: "p1" }), "10.0.0.1", 7700);
  t.sends.length = 0;
  t.ping();
  const discovery = t.packets(protocol.CMD_PING).find(({ pkt }) => pkt.payload.length === 8);
  assert.equal(discovery.ip, "255.255.255.255");
  const timestamp = new DataView(discovery.pkt.payload.buffer, discovery.pkt.payload.byteOffset, 8).getBigInt64(0, true);
  t.replyLegacy("10.0.0.1", { seq: discovery.pkt.seq, timestamp });
  assert.equal(t.streamEndpoints()[0].streamClass, "unknown");
});

// ── 3. lease_reissued and ticket changes ──────────────────────────────────

test("superseded: only a matched reply with lease_reissued clears it, not a plain new ticket", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 | 2, ticket: 3 });
  assert.equal(t.streamEndpoints()[0].deferredReason, "Superseded");
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1, ticket: 9 }); // our entry expired and got a new ticket
  assert.equal(t.epoch("10.0.0.1"), "deferred");
  assert.equal(t.streamEndpoints()[0].leaseState, "superseded");
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 | 4, ticket: 10 }); // re-issued: the other writer left
  assert.equal(t.epoch("10.0.0.1"), "gen2:45063:10:0");
  assert.equal(t.streamEndpoints()[0].leaseState, "valid");
});

test("a new ticket for the same incarnation: END under the old one, BEGIN under the new, the cue continues", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow(), { ticket: 3 });
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  hub.playPcm(rampPcm(16_000), { target: "p1" });
  await wait(40);
  const lastOld = dataOf(t).at(-1);
  t.replyV2("10.0.0.1", t.pingNow(), { ticket: 4 });
  hub.reconcile();
  await wait(30);
  hub.close();
  const packets = t.streamPackets();
  const newBegin = packets.findIndex(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_BEGIN && envelopeOf(pkt).ticket === 4);
  assert.ok(newBegin > 0);
  assert.equal(packets[newBegin - 1].pkt.cmd, protocol.CMD_STREAM_END);
  assert.equal(envelopeOf(packets[newBegin - 1].pkt).ticket, 3);
  const firstNew = packets.slice(newBegin).find(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_DATA);
  assert.equal(offsetOf(firstNew), 0);
  assert.equal(leftSamples(firstNew)[0], leftSamples(lastOld).at(-1) + 1, "from its cursor, not frame 0");
});

// ── 5. Extended PINGs: unicast, to endpoints of interest, ≤ TTL/3 ──────────

test("extended PINGs go by unicast only, to endpoints of interest, at most every 5 s", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
  const p = new Probe({ keepalive: true, defaultTarget: "p1/*" });
  await p.connect();
  p.handleMessage(makePong({ name: "a", address: "p1/a" }), "10.0.0.1", 7700);
  p.handleMessage(makePong({ name: "b", address: "p2/a" }), "10.0.0.2", 7700);
  const leasePings = () => p.packets(protocol.CMD_PING).filter(({ pkt }) => pkt.payload.length === 16);
  assert.deepEqual(leasePings().map(({ ip }) => ip), ["10.0.0.1"], "a newly found device of interest is asked at once");
  const times = [Date.now()];
  let seen = leasePings().length;
  for (let elapsed = 0; elapsed < 12_000; elapsed += 250) {
    t.mock.timers.tick(250);
    if (leasePings().length > seen) { times.push(Date.now()); seen = leasePings().length; }
  }
  const pings = p.packets(protocol.CMD_PING);
  assert.ok(pings.every(({ pkt }) => [8, 16].includes(pkt.payload.length)), "PING is 8 or 16 bytes only");
  assert.ok(pings.filter(({ pkt }) => pkt.payload.length === 8).every(({ ip }) => ip === "255.255.255.255"));
  assert.ok(leasePings().every(({ ip }) => ip === "10.0.0.1"), "16-byte PINGs only to the endpoint of interest");
  assert.ok(times.length >= 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 5000, `gap ${times[i] - times[i - 1]}`);

  // A new source on a known endpoint whose class is unknown asks for its lease now.
  const hub = new StreamHub(p);
  const playback = hub.playPcm(monoPcm(1_000, 64), { target: "p2" });
  assert.equal(playback.deferredReason, "UnknownClass");
  assert.equal(leasePings().at(-1).ip, "10.0.0.2");
  hub.close();
  p.close();
});

// ── 6. CAPS ───────────────────────────────────────────────────────────────

const CAPS_FIXTURES = [
  ["band_1x", "424801130202240001000101010205312e302e3003010204010705040f20050006010207013f080403000000", {
    capsVersion: 1, generation: 1, firmwareVersion: "1.0.0", streamGens: [2], streamFormats: ["pcm16", "adpcm", "opus"],
    leaseTtlS: 15, leaseSlots: 32, inactivityTimeoutS: 5, hapticChannels: 2, addressMaxLen: 63,
    features: ["play_pan", "error_reply"],
  }],
  ["future_entries", "4248011302021c0001000903010203010101800365787005060f20050009090600010107", {
    capsVersion: 1, generation: 1, leaseTtlS: 15, leaseSlots: 32, inactivityTimeoutS: 5,
  }],
];

test("CAPS_REQ and CAPS match the wire-extension fixtures", () => {
  assert.equal(hex(protocol.buildCapsReq(0x0202, 1)), "424801120202010001");
  for (const [name, h, expected] of CAPS_FIXTURES) assert.deepEqual(protocol.parseCaps(fromHex(h)), expected, name);
});

test("CAPS_REQ: unicast after the first matched reply, 3 tries 500 ms apart, then not again this boot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const p = await connected();
  p.replyLegacy("10.0.0.1", p.pingNow());
  const requests = () => p.packets(protocol.CMD_CAPS_REQ);
  assert.deepEqual(requests().map(({ ip }) => ip), ["10.0.0.1"]);
  t.mock.timers.tick(500);
  assert.equal(requests().length, 2);
  t.mock.timers.tick(500);
  assert.equal(requests().length, 3);
  t.mock.timers.tick(5_000);
  assert.equal(requests().length, 3, "no answer: no capability report (firmware 0.x)");
  p.replyLegacy("10.0.0.1", p.pingNow()); // same firmware: not asked again
  t.mock.timers.tick(2_000);
  assert.equal(requests().length, 3);
  p.close();
});

test("CAPS: stored per device; a newer generation warns once; Stream Gen comes from the PONG only", async () => {
  const warn = captureConsole("warn");
  try {
    const t = await connected();
    t.replyV2("10.0.0.1", t.pingNow());
    const [request] = t.packets(protocol.CMD_CAPS_REQ);
    const caps = makeCaps(request.pkt.seq, [[0x01, [2]], [0x03, [0]], [0x06, [1]]]);
    t.handleMessage(caps, "10.0.0.1", 7701); // wrong port: ignored
    t.handleMessage(makeCaps(request.pkt.seq + 1, [[0x01, [2]]]), "10.0.0.1", 7700); // wrong seq: ignored
    assert.equal(t.devices()[0].caps, undefined);
    t.handleMessage(caps, "10.0.0.1", 7700);
    assert.equal(t.devices()[0].caps.generation, 2);
    assert.equal(t.devices()[0].caps.hapticChannels, 1);
    assert.equal(t.streamEndpoints()[0].streamClass, "gen2", "stream_gens 0 does not change the class");
    assert.equal(t.streamEndpoints()[0].hapticChannels, 1);
    t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p2"), { address: "p2", bootId: 2n });
    const second = t.packets(protocol.CMD_CAPS_REQ).find(({ ip }) => ip === "10.0.0.2");
    t.handleMessage(makeCaps(second.pkt.seq, [[0x01, [3]]]), "10.0.0.2", 7700);
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.filter((l) => l.includes("generation")).length, 1, "once per process");
});

test("SDK_MAJOR matches the package.json major", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SDK_MAJOR, Number(pkg.version.split(".")[0]));
});

// ── 7. ERROR ──────────────────────────────────────────────────────────────

test("ERROR fixtures parse with and without the reference fields", () => {
  const timedOut = protocol.parseError(fromHex("424801ff03032700140073747265616d2074696d6564206f7574003134121008070605040302010700000029000000"));
  assert.equal(timedOut.errorCode, protocol.ERR_STREAM_TIMED_OUT);
  assert.equal(timedOut.errorCode, 20);
  assert.equal(timedOut.message, "stream timed out");
  assert.equal(timedOut.refCommand, 49);
  assert.equal(timedOut.refSeq, 4660);
  assert.equal(hex(timedOut.detail), "08070605040302010700000029000000");
  const old = protocol.parseError(fromHex("424801ff03031800100073747265616d2067656e203220726571756972656400"));
  assert.equal(old.errorCode, protocol.ERR_STREAM_GEN_UNSUPPORTED);
  assert.equal(old.message, "stream gen 2 required");
  assert.equal(old.refCommand, undefined);
  assert.equal(old.detail, undefined);
});

async function gen2Session(opts = {}) {
  const t = await connected(opts);
  t.replyV2("10.0.0.1", t.pingNow());
  const [endpoint] = t.streamEndpoints();
  const wire = t.streamBeginEndpoint(endpoint);
  const events = [];
  t.setSessionListener((event) => events.push(event));
  return { t, endpoint, wire, events };
}

test("ERROR is accepted only from the device's address and port 7700, and only for a tracked envelope", async () => {
  const info = captureConsole("info");
  try {
    const { t, wire, events } = await gen2Session();
    const stopped = (detail) => makeError(protocol.ERR_STREAM_STOPPED, { detail });
    t.handleMessage(stopped(wire.envelope), "10.0.0.1", 7701);
    t.handleMessage(stopped(wire.envelope), "10.0.0.99", 7700);
    const other = protocol.buildStreamEnvelope({ ...wire.identity, generation: wire.identity.generation + 5 });
    t.handleMessage(stopped(other), "10.0.0.1", 7700);
    t.handleMessage(makeError(protocol.ERR_STREAM_STOPPED), "10.0.0.1", 7700); // no envelope
    assert.equal(events.length, 0);
    t.handleMessage(stopped(wire.envelope), "10.0.0.1", 7700);
    assert.deepEqual(events.map((e) => [e.kind, e.reason, e.wire === wire]), [["stopped", "stopped", true]]);
  } finally {
    info.restore();
  }
});

test("ERROR codes: NOT_STARTED resends BEGIN, LEASE_INVALID / TIMED_OUT / TARGET_MISMATCH begin anew, SUPERSEDED defers", async () => {
  const info = captureConsole("info");
  const warn = captureConsole("warn");
  try {
    // NOT_STARTED: the same BEGIN again, at once.
    {
      const { t, wire } = await gen2Session();
      t.sends.length = 0;
      t.handleMessage(makeError(protocol.ERR_STREAM_NOT_STARTED, { detail: wire.envelope }), "10.0.0.1", 7700);
      assert.deepEqual(begins(t).map(({ pkt }) => envelopeOf(pkt)), [wire.identity]);
    }
    // LEASE_INVALID: an extended PING by unicast, and the epoch moves on even if the ticket comes back.
    {
      const { t, endpoint, wire } = await gen2Session();
      t.sends.length = 0;
      t.handleMessage(makeError(protocol.ERR_STREAM_LEASE_INVALID, { detail: wire.envelope }), "10.0.0.1", 7700);
      const [ping] = t.packets(protocol.CMD_PING);
      assert.equal(ping.ip, "10.0.0.1");
      assert.equal(ping.pkt.payload.length, 16);
      assert.equal(t.epoch("10.0.0.1"), "deferred");
      assert.equal(t.streamEndpoints()[0].deferredReason, "LeaseUnavailable");
      const view = new DataView(ping.pkt.payload.buffer, ping.pkt.payload.byteOffset, 16);
      t.replyV2("10.0.0.1", { seq: ping.pkt.seq, timestamp: view.getBigInt64(0, true), incarnation: view.getBigUint64(8, true) });
      assert.notEqual(t.epoch("10.0.0.1"), endpoint.wireEpoch);
      assert.equal(t.epoch("10.0.0.1"), "gen2:45063:3:1");
    }
    // TIMED_OUT and TARGET_MISMATCH: a new epoch (a new generation), same lease.
    for (const code of [protocol.ERR_STREAM_TIMED_OUT, protocol.ERR_STREAM_TARGET_MISMATCH]) {
      const { t, wire } = await gen2Session();
      t.sends.length = 0;
      t.handleMessage(makeError(code, { detail: wire.envelope }), "10.0.0.1", 7700);
      assert.equal(t.epoch("10.0.0.1"), "gen2:45063:3:1", `0x${code.toString(16)}`);
      if (code === protocol.ERR_STREAM_TARGET_MISMATCH) assert.equal(t.packets(protocol.CMD_PING)[0].ip, "10.0.0.1");
    }
    // SUPERSEDED: deferred, no automatic takeover.
    {
      const { t, wire } = await gen2Session();
      t.handleMessage(makeError(protocol.ERR_STREAM_SUPERSEDED, { detail: wire.envelope }), "10.0.0.1", 7700);
      assert.equal(t.epoch("10.0.0.1"), "deferred");
      assert.equal(t.streamEndpoints()[0].deferredReason, "Superseded");
      t.replyV2("10.0.0.1", t.pingNow(), { flags: 1, ticket: 3 });
      assert.equal(t.epoch("10.0.0.1"), "deferred", "a plain reply does not take it back");
    }
    // GEN_UNSUPPORTED: classify again by unicast extended PING.
    {
      const { t } = await gen2Session();
      t.sends.length = 0;
      t.handleMessage(makeError(protocol.ERR_STREAM_GEN_UNSUPPORTED), "10.0.0.1", 7700);
      assert.deepEqual(t.packets(protocol.CMD_PING).map(({ ip, pkt }) => [ip, pkt.payload.length]), [["10.0.0.1", 16]]);
    }
    // UNKNOWN_COMMAND for CAPS_REQ: never asked again.
    {
      const { t } = await gen2Session();
      t.handleMessage(makeError(protocol.ERR_UNKNOWN_COMMAND, { refCommand: protocol.CMD_CAPS_REQ }), "10.0.0.1", 7700);
      assert.equal(t.extras.get("10.0.0.1").capsStatus, "none");
    }
  } finally {
    info.restore();
    warn.restore();
  }
  // One line per device and code, however many arrive.
  assert.ok(info.lines.filter((l) => l.includes("STREAM_NOT_STARTED")).length === 1);
});

test("ERROR STREAM_TIMED_OUT through StreamHub: a new generation continues the cue from its cursor", async () => {
  const info = captureConsole("info");
  try {
    const t = await connected();
    t.replyV2("10.0.0.1", t.pingNow());
    const hub = new StreamHub(t, { sendAheadSec: 0.01 });
    hub.playPcm(rampPcm(16_000), { target: "p1" });
    await wait(40);
    const lastOld = dataOf(t).at(-1);
    t.handleMessage(makeError(protocol.ERR_STREAM_TIMED_OUT, { detail: lastOld.pkt.payload.slice(0, 16) }), "10.0.0.1", 7700);
    hub.reconcile();
    await wait(30);
    hub.close();
    const packets = t.streamPackets();
    const after = packets.slice(packets.findIndex((p) => p.raw === lastOld.raw) + 1);
    assert.equal(after[0].pkt.cmd, protocol.CMD_STREAM_END);
    assert.equal(after[1].pkt.cmd, protocol.CMD_STREAM_BEGIN);
    assert.equal(envelopeOf(after[1].pkt).generation, envelopeOf(lastOld.pkt).generation + 1);
    const firstNew = after.find(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_DATA);
    assert.equal(leftSamples(firstNew)[0], leftSamples(lastOld).at(-1) + 1);
  } finally {
    info.restore();
  }
});

// ── 8. BEGIN repetition ───────────────────────────────────────────────────

test("BEGIN repetition: before each of the first 3 DATA, then every 500 ms, with the current address; never on Gen 1", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow());
  t.replyLegacy("10.0.0.2", t.pingNow("10.0.0.2", "p2"), "p2");
  const [gen2, gen1] = ["10.0.0.1", "10.0.0.2"].map((ip) => t.streamEndpoints().find((e) => e.ip === ip));
  const wire2 = t.streamBeginEndpoint(gen2);
  const wire1 = t.streamBeginEndpoint(gen1);
  for (let i = 0; i < 6; i++) {
    t.streamDataEndpoint(gen2, i * 4, new Uint8Array(4), wire2);
    t.streamDataEndpoint(gen1, i * 4, new Uint8Array(4), wire1);
  }
  assert.equal(begins(t, "10.0.0.1").length, 1 + 3);
  assert.deepEqual(generations(begins(t, "10.0.0.1")), [1], "one tuple");
  const kinds = t.streamPackets().filter(({ ip }) => ip === "10.0.0.1").map(({ pkt }) => pkt.cmd);
  assert.deepEqual(kinds.slice(0, 8), [0x30, 0x30, 0x31, 0x30, 0x31, 0x30, 0x31, 0x31]);
  assert.equal(begins(t, "10.0.0.2").length, 1, "Gen 1 firmware restarts on BEGIN: no repeat");
  await wait(520);
  t.streamDataEndpoint({ ...gen2, address: "p1/moved" }, 24, new Uint8Array(4), wire2);
  assert.equal(begins(t, "10.0.0.1").length, 5);
  const target = new TextDecoder().decode(begins(t, "10.0.0.1").at(-1).pkt.payload.subarray(28));
  assert.equal(target, "p1/moved\0", "a repeated BEGIN carries the endpoint's current address");
});

// ── 9. The 3 s own-gap rule ───────────────────────────────────────────────

test("own gap of 3 s: END, a new generation, the cue continues, no burst of missed audio", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const p = await connected();
  p.replyV2("10.0.0.1", p.pingNow());
  const hub = new StreamHub(p, { sendAheadSec: 0.05 });
  hub.playPcm(rampPcm(160_000), { target: "p1" });
  for (let i = 0; i < 20; i++) t.mock.timers.tick(5);
  const lastOld = dataOf(p).at(-1);
  const before = p.streamPackets().length;
  t.mock.timers.setTime(Date.now() + 3_500); // the process was suspended
  t.mock.timers.tick(5);
  const after = p.streamPackets().slice(before);
  hub.close();
  assert.equal(after[0].pkt.cmd, protocol.CMD_STREAM_END);
  assert.equal(after[1].pkt.cmd, protocol.CMD_STREAM_BEGIN);
  assert.equal(envelopeOf(after[1].pkt).generation, envelopeOf(lastOld.pkt).generation + 1);
  const data = after.filter(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_DATA);
  assert.equal(offsetOf(data[0]), 0);
  assert.equal(leftSamples(data[0])[0], leftSamples(lastOld).at(-1) + 1);
  assert.ok(data.length <= 5, `${data.length} blocks: only the send-ahead, not 3.5 s of audio`);
});

// ── 10. Silence for an idle live source (§7 case 10) ──────────────────────

test("live source without input: the open session keeps sending silent DATA; input resumes from there", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow());
  const hub = new StreamHub(t, { sendAheadSec: 0.01 });
  const live = hub.openLive({ target: "p1" });
  await wait(80);
  const idle = dataOf(t);
  assert.ok(idle.length >= 3, `${idle.length} DATA while idle`);
  assert.ok(idle.every((packet) => leftSamples(packet).every((v) => v === 0)), "silence");
  assert.equal(ends(t).length, 0, "the session stays open");
  assert.equal(live.write(monoPcm(5_000, 256)), true);
  await wait(30);
  hub.close();
  assert.ok(dataOf(t).slice(idle.length).some((packet) => leftSamples(packet).includes(5_000)));
});

// ── 11. STREAM_STOPPED (§6.13) ────────────────────────────────────────────

async function twoDevices() {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow("10.0.0.1", "p1/a"), { address: "p1/a", bootId: 1n });
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p1/b"), { address: "p1/b", bootId: 2n });
  return t;
}

test("STREAM_STOPPED: the Playback leaves that endpoint for good, keeps the other; a new Playback joins", async () => {
  const info = captureConsole("info");
  try {
    const t = await twoDevices();
    const lost = [];
    const hub = new StreamHub(t, { sendAheadSec: 0.01, onStreamLost: (e) => lost.push(e) });
    const playback = hub.playPcm(rampPcm(16_000), { target: "p1" });
    await wait(30);
    const envelope = dataOf(t, "10.0.0.1").at(-1).pkt.payload.slice(0, 16);
    t.handleMessage(makeError(protocol.ERR_STREAM_STOPPED, { detail: envelope }), "10.0.0.1", 7700);
    assert.deepEqual(lost, [{ playbackId: playback.id, ip: "10.0.0.1", reason: "stopped" }]);
    assert.equal(playback.lostReason, "stopped");
    assert.equal(playback.status, "Active");
    const marks = [dataOf(t, "10.0.0.1").length, dataOf(t, "10.0.0.2").length];
    await wait(40);
    assert.equal(dataOf(t, "10.0.0.1").length, marks[0], "no more DATA for it there");
    assert.ok(dataOf(t, "10.0.0.2").length > marks[1], "the other endpoint goes on");
    const fresh = hub.playPcm(monoPcm(1_000, 512), { target: "p1/a" });
    assert.equal(fresh.status, "Active");
    assert.deepEqual(generations(begins(t, "10.0.0.1")), [1, 2], "a new generation for the new Playback");
    hub.close();
  } finally {
    info.restore();
  }
});

test("STREAM_STOPPED on the only endpoint: a one-shot completes (counted as played), a loop stops", async () => {
  const info = captureConsole("info");
  try {
    for (const loop of [false, true]) {
      const t = await connected();
      t.replyV2("10.0.0.1", t.pingNow());
      const hub = new StreamHub(t, { sendAheadSec: 0.01 });
      const playback = hub.playPcm(rampPcm(16_000), { target: "p1", loop });
      await wait(30);
      const envelope = dataOf(t).at(-1).pkt.payload.slice(0, 16);
      t.handleMessage(makeError(protocol.ERR_STREAM_STOPPED, { detail: envelope }), "10.0.0.1", 7700);
      assert.equal(playback.status, "Stopped", `loop=${loop}`);
      assert.equal(playback.lostReason, "stopped");
      hub.close();
    }
  } finally {
    info.restore();
  }
});

// ── 12. deferredReason ────────────────────────────────────────────────────

test("deferredReason: NoResolvedEndpoint, UnknownClass, LeaseUnavailable, Superseded, and their priority", async () => {
  const t = await connected();
  const hub = new StreamHub(t, { sendAheadSec: 0 });
  const play = (target) => hub.playPcm(monoPcm(1_000, 64), { target });
  assert.equal(play("p9").deferredReason, "NoResolvedEndpoint");
  t.handleMessage(makePong({ name: "u", address: "p1/u" }), "10.0.0.1", 7700);
  assert.equal(play("p1/u").deferredReason, "UnknownClass");
  t.replyV2("10.0.0.2", t.pingNow("10.0.0.2", "p1/l"), { address: "p1/l", flags: 0, bootId: 2n });
  assert.equal(play("p1/l").deferredReason, "LeaseUnavailable");
  t.replyV2("10.0.0.3", t.pingNow("10.0.0.3", "p1/s"), { address: "p1/s", flags: 1 | 2, bootId: 3n });
  assert.equal(play("p1/s").deferredReason, "Superseded");
  // Matching endpoints disagree: Superseded > LeaseUnavailable > UnknownClass.
  assert.equal(play("p1").deferredReason, "Superseded");
  hub.close();
});

// ── Re-splice (§6.14, §7 case 11) ─────────────────────────────────────────

test("re-splice: a cue added inside sent-ahead audio restarts the Gen 2 session and enters at frame 0", async () => {
  const t = await connected();
  t.replyV2("10.0.0.1", t.pingNow());
  const hub = new StreamHub(t, { sendAheadSec: 0.15 });
  hub.playPcm(rampPcm(32_000), { target: "p1" });
  await wait(30);
  const lastOld = dataOf(t).at(-1);
  const sentUpTo = leftSamples(lastOld).at(-1);
  const before = t.streamPackets().length;
  hub.playPcm(monoPcm(10_000, 4_000), { target: "p1" });
  const now = t.streamPackets().slice(before);
  assert.deepEqual(now.slice(0, 2).map(({ pkt }) => pkt.cmd), [protocol.CMD_STREAM_END, protocol.CMD_STREAM_BEGIN]);
  assert.equal(envelopeOf(now[0].pkt).generation, 1);
  assert.equal(envelopeOf(now[1].pkt).generation, 2, "same lease, next generation");
  assert.equal(envelopeOf(now[1].pkt).ticket, envelopeOf(lastOld.pkt).ticket);
  await wait(20);
  hub.close();
  const first = t.streamPackets().slice(before).find(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_DATA);
  assert.equal(offsetOf(first), 0);
  const [s0] = leftSamples(first);
  const rewoundTo = s0 - 10_000; // the ramp's cursor + the new cue's frame 0
  assert.ok(rewoundTo < sentUpTo - 16_000 * 0.1, `the other source went back (${rewoundTo} vs ${sentUpTo})`);
  assert.ok(rewoundTo > 0, "but not before its own start");
});

test("re-splice: not on a Gen 1 endpoint, nor when the device holds less than 40 ms", async () => {
  for (const [kind, sendAheadSec] of [["gen1", 0.15], ["gen2", 0.01]]) {
    const t = await connected();
    const ping = t.pingNow();
    if (kind === "gen1") t.replyLegacy("10.0.0.1", ping);
    else t.replyV2("10.0.0.1", ping);
    const hub = new StreamHub(t, { sendAheadSec });
    hub.playPcm(rampPcm(32_000), { target: "p1" });
    await wait(30);
    const before = t.streamPackets().length;
    hub.playPcm(monoPcm(10_000, 4_000), { target: "p1" });
    await wait(20);
    hub.close();
    const mid = t.streamPackets().slice(before, -1); // close() sends the final END
    assert.equal(mid.filter(({ pkt }) => pkt.cmd === protocol.CMD_STREAM_END).length, 0, kind);
  }
});

// ── One motor (§6.15, §7 case 12) ─────────────────────────────────────────

test("haptic_channels 1: pan is not applied, left and right are the same; unknown (no CAPS) keeps pan", async () => {
  for (const channels of [1, undefined]) {
    const t = await connected();
    t.replyV2("10.0.0.1", t.pingNow());
    if (channels !== undefined) {
      const [request] = t.packets(protocol.CMD_CAPS_REQ);
      t.handleMessage(makeCaps(request.pkt.seq, [[0x01, [1]], [0x06, [channels]]]), "10.0.0.1", 7700);
    }
    const hub = new StreamHub(t, { sendAheadSec: 0.01 });
    hub.playPcm(monoPcm(10_000, 512), { target: "p1", pan: -1 });
    await wait(20);
    hub.close();
    const frames = stereoSamples(dataOf(t)[0]);
    if (channels === 1) assert.ok(frames.every(([l, r]) => l === r && l === 10_000), "mono: both channels, no pan");
    else assert.deepEqual(frames[0], [10_000, 0], "stereo or unknown: pan applies");
  }
});

// ── Endpoint state API (sdk-multi-stream.md §3) ───────────────────────────

test("Hapbeat.streamEndpoints() / devices() and onStreamEndpointChanged report class and lease", async () => {
  const changes = [];
  const t = await connected({ onStreamEndpointChanged: (info) => changes.push(info) });
  const hb = new Hapbeat(t);
  t.handleMessage(makePong({ address: "p1" }), "10.0.0.1", 7700);
  assert.deepEqual(hb.streamEndpoints(), [{ ip: "10.0.0.1", address: "p1", streamClass: "unknown", leaseState: "none" }]);
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 });
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 }); // no change: not reported again
  t.replyV2("10.0.0.1", t.pingNow(), { flags: 1 | 2 });
  assert.deepEqual(changes.map((c) => [c.streamClass, c.leaseState]), [
    ["unknown", "none"], ["gen2", "valid"], ["gen2", "superseded"],
  ]);
  const [device] = hb.devices();
  assert.equal(device.ip, "10.0.0.1");
  assert.equal(device.streamClass, "gen2");
  assert.equal(device.leaseState, "superseded");
  await hb.close();
});

// ── 13. Browser transport behind hapbeat-helper ───────────────────────────

class FakeWS {
  constructor() {
    this.readyState = 1;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWS.last = this;
    FakeWS.sent = [];
    setTimeout(() => this.onopen && this.onopen({}), 0);
  }
  send(s) { FakeWS.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}

/** Left samples of a helper stream_data message (base64 stereo PCM16). */
function leftOf(message) {
  const bytes = new Uint8Array(Buffer.from(message.payload.data, "base64"));
  const view = new DataView(bytes.buffer);
  const out = [];
  for (let i = 0; i < bytes.length / 4; i++) out.push(view.getInt16(i * 4, true));
  return out;
}

async function helperHub(t, opts = {}) {
  globalThis.WebSocket = FakeWS;
  const transport = new BrowserWsTransport({});
  const connecting = transport.connect();
  t.mock.timers.tick(1);
  await connecting;
  transport.onMessage(JSON.stringify({
    type: "device_list", payload: { devices: [{ ip: "192.168.1.10", name: "a", address: "p1/a", online: true }] },
  }));
  const lost = [];
  const hub = new StreamHub(transport, { sendAheadSec: 0.01, onStreamLost: (e) => lost.push(e), ...opts });
  const say = (type, payload) => transport.onMessage(JSON.stringify({ type, payload }));
  const sent = (type) => FakeWS.sent.filter((m) => m.type === type);
  return { transport, hub, lost, say, sent };
}

test("browser: stream_ack deferred / no_target back off 2 s, then a new stream_id; no_session begins anew at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { hub, say, sent } = await helperHub(t);
    const playback = hub.playPcm(rampPcm(32_000), { target: "p1" });
    const [first] = sent("stream_begin");
    assert.ok(first.payload.stream_id);
    assert.equal("takeover" in first.payload, false);
    for (const ack of [
      { status: "ok", targets: [], deferred: ["192.168.1.10"] },
      { status: "no_target", targets: [] },
    ]) {
      const id = sent("stream_begin").at(-1).payload.stream_id;
      say("stream_ack", { stream_id: id, ...ack });
      assert.equal(playback.status, "Deferred");
      assert.equal(playback.deferredReason, "LeaseUnavailable");
      t.mock.timers.tick(1_000);
      assert.equal(sent("stream_begin").at(-1).payload.stream_id, id, "backing off");
      t.mock.timers.tick(1_100);
      assert.notEqual(sent("stream_begin").at(-1).payload.stream_id, id, "a new transaction after the backoff");
    }
    const id = sent("stream_begin").at(-1).payload.stream_id;
    say("stream_ack", { stream_id: id, status: "ok", targets: ["192.168.1.10"] });
    assert.equal(playback.status, "Active");
    say("stream_ack", { stream_id: id, status: "no_session" });
    assert.notEqual(sent("stream_begin").at(-1).payload.stream_id, id, "begins again at once");
    assert.equal(sent("stream_end").filter((m) => m.payload.stream_id === id).length, 0,
      "the helper holds no destination: no stream_end for it");
    hub.close();
  } finally {
    delete globalThis.WebSocket;
  }
});

test("browser: stream_lost restarts with the cursor kept; superseded backs off; stopped / displaced exclude", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { hub, lost, say, sent } = await helperHub(t);
    const playback = hub.playPcm(rampPcm(32_000), { target: "p1" });
    for (let i = 0; i < 10; i++) t.mock.timers.tick(5);
    const lastSample = leftOf(sent("stream_data").at(-1)).at(-1);
    const id1 = sent("stream_begin").at(-1).payload.stream_id;
    say("stream_lost", { stream_id: id1, targets: ["192.168.1.10"], reason: "device_rebooted" });
    const id2 = sent("stream_begin").at(-1).payload.stream_id;
    assert.notEqual(id2, id1, "a new stream_id at once");
    t.mock.timers.tick(5);
    const resumed = sent("stream_data").find((m) => m.payload.stream_id === id2);
    assert.equal(resumed.payload.offset, 0);
    assert.equal(leftOf(resumed)[0], lastSample + 1, "the cue continues");

    say("stream_lost", { stream_id: id2, targets: ["192.168.1.10"], reason: "superseded" });
    assert.equal(playback.deferredReason, "Superseded");
    t.mock.timers.tick(2_100);
    const id3 = sent("stream_begin").at(-1).payload.stream_id;
    assert.notEqual(id3, id2);

    say("stream_displaced", { stream_id: id3, targets: ["192.168.1.10"], by: "studio-1", same_client: true });
    assert.equal(lost.length, 0, "our own newer stream is not a loss");
    say("stream_displaced", { stream_id: id3, targets: ["192.168.1.10"], by: "studio-1", same_client: false });
    assert.deepEqual(lost, [{ playbackId: playback.id, ip: "192.168.1.10", reason: "displaced" }]);
    assert.equal(playback.status, "Stopped", "its only endpoint is gone for good");
    assert.equal(playback.lostReason, "displaced");
    const begun = sent("stream_begin").length;
    t.mock.timers.tick(3_000);
    assert.equal(sent("stream_begin").length, begun, "the same Playback does not come back");

    const next = hub.playPcm(rampPcm(32_000), { target: "p1", loop: true });
    const id4 = sent("stream_begin").at(-1).payload.stream_id;
    assert.equal(next.status, "Active", "a new Playback joins");
    say("stream_lost", { stream_id: id4, targets: ["192.168.1.10"], reason: "stopped" });
    assert.equal(next.status, "Stopped");
    assert.equal(lost.at(-1).reason, "stopped");
    hub.close();
  } finally {
    delete globalThis.WebSocket;
  }
});

test("browser: helper_hello with a newer generation warns once; unknown messages are ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const warn = captureConsole("warn");
  try {
    const { transport, hub } = await helperHub(t);
    transport.onMessage(JSON.stringify({ type: "helper_hello", payload: { version: "2.0.0", generation: 2 } }));
    transport.onMessage(JSON.stringify({ type: "helper_hello", payload: { version: "2.0.0", generation: 2 } }));
    transport.onMessage(JSON.stringify({ type: "future_message", payload: { x: 1 } }));
    assert.equal(transport.devices().length, 1);
    hub.close();
  } finally {
    warn.restore();
    delete globalThis.WebSocket;
  }
  assert.equal(warn.lines.filter((l) => l.includes("hapbeat-helper reports generation 2")).length, 1);
});

// ── 14. React Native ──────────────────────────────────────────────────────

/** Every module the given dist entry loads (relative imports), with its source. */
async function moduleGraph(entry) {
  const seen = new Map();
  const visit = async (url) => {
    if (seen.has(url.href)) return;
    const source = await readFile(url, "utf8");
    seen.set(url.href, source);
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (spec.startsWith(".")) await visit(new URL(spec, url));
    }
  };
  await visit(new URL(entry, import.meta.url));
  return seen;
}

test("the Node and browser entries never import react-native", async () => {
  for (const entry of ["../dist/node.js", "../dist/browser.js"]) {
    for (const [url, source] of await moduleGraph(entry)) {
      assert.doesNotMatch(source, /(?:from|import)\s*\(?\s*["']react-native(?:-udp)?["']/, `${entry}: ${url}`);
    }
  }
});

test("React Native: returning to the foreground renews the incarnation and asks for leases", async () => {
  // Resolve "react-native" / "react-native-udp" to fakes for this process only.
  const hooks = `
    export async function resolve(specifier, context, next) {
      if (specifier === "react-native") return { shortCircuit: true, url: "data:text/javascript,export const AppState = globalThis.__fakeAppState;" };
      if (specifier === "react-native-udp") return { shortCircuit: true, url: "data:text/javascript,export default { createSocket: (o) => globalThis.__fakeUdpSocket(o) };" };
      return next(specifier, context);
    }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  let listener;
  globalThis.__fakeAppState = {
    currentState: "active",
    addEventListener: (type, fn) => { listener = fn; return { remove: () => { listener = undefined; } }; },
  };
  const sent = [];
  globalThis.__fakeUdpSocket = () => ({
    bind: (port, cb) => cb(),
    once() {}, on() {}, removeAllListeners() {}, setBroadcast() {},
    send: (pkt, offset, length, port, ip, cb) => { sent.push([new Uint8Array(pkt), ip]); cb?.(); },
    close() {},
  });
  const { ReactNativeUdpTransport } = await import("../dist/react-native.js");
  const t = new ReactNativeUdpTransport({ keepalive: false });
  await t.connect();
  t.handleMessage(makePong({ address: "p1" }), "10.0.0.1", 7700);
  const before = t.clientIncarnation;
  assert.ok(listener, "AppState is watched while connected");
  listener("background");
  listener("active");
  assert.notEqual(t.clientIncarnation, before, "a fresh incarnation on resume");
  const lease = sent.filter(([pkt]) => pkt[3] === protocol.CMD_PING && pkt[6] === 16);
  assert.equal(lease.at(-1)[1], "10.0.0.1", "a lease PING by unicast at once");
  t.close();
  assert.equal(listener, undefined, "unsubscribed on close");
});
