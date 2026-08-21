// Contract round-trip + EventMap + Node transport smoke.
// Run with: npm test  (builds to dist/ first, then `node --test`)
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { EventMap, Hapbeat, parseWav } from "../dist/index.js";
import { connect, NodeUdpTransport } from "../dist/node.js";
import * as dgram from "node:dgram";

// Build a minimal 16-bit PCM WAV in memory for clip tests.
function makeWav({ sampleRate = 16000, channels = 1, samples = [] }) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i); };
  wr(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); wr(8, "WAVE");
  wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
  wr(36, "data"); dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

class FakeTransport {
  constructor() { this.calls = []; }
  async connect() {}
  play(id, gain, target, targetTimeUs, pan) { this.calls.push(["play", id, gain, target, pan]); }
  stop(id, target) { this.calls.push(["stop", id, target]); }
  stopAll(target) { this.calls.push(["stopAll", target]); }
  ping() {}
  async discover() { return []; }
  close() {}
  streamBegin(meta) { this.calls.push(["begin", meta]); }
  streamData(offset, data) { this.calls.push(["data", offset, data.length]); }
  streamEnd() { this.calls.push(["end"]); }
}

test("header magic, version, size", () => {
  const h = protocol.buildHeader(protocol.CMD_PING, 1, 0);
  assert.equal(h.length, protocol.HEADER_SIZE);
  const dv = new DataView(h.buffer);
  assert.equal(dv.getUint16(0, true), protocol.MAGIC); // 0x4842 "HB"
  assert.equal(dv.getUint8(2), protocol.VERSION);
});

// Read back the PLAY tail: i64 target_time + f32 gain + f32 pan.
function readPlayTail(pkt, eventId, target) {
  const p = protocol.parsePacket(pkt);
  const prefix = new TextEncoder().encode(`${eventId}\0${target}\0`);
  assert.deepEqual(p.payload.subarray(0, prefix.length), prefix);
  assert.equal(p.payload.length, prefix.length + 16, "tail is 16 bytes (time + gain + pan)");
  const dv = new DataView(p.payload.buffer, p.payload.byteOffset + prefix.length, 16);
  return {
    pkt: p,
    targetTimeUs: dv.getBigInt64(0, true),
    gain: dv.getFloat32(8, true),
    pan: dv.getFloat32(12, true),
  };
}

test("PLAY layout: event_id\\0 target\\0 + i64 time + f32 gain + f32 pan", () => {
  const t = readPlayTail(
    protocol.buildPlay(7, "explosion", { target: "player_1/chest", gain: 0.5, pan: -0.25 }),
    "explosion",
    "player_1/chest",
  );
  assert.equal(t.pkt.commandType, protocol.CMD_PLAY);
  assert.equal(t.pkt.seq, 7);
  assert.equal(t.targetTimeUs, 0n);
  assert.ok(Math.abs(t.gain - 0.5) < 1e-6);
  assert.ok(Math.abs(t.pan - -0.25) < 1e-6);
});

test("PLAY pan defaults to centre and clamps to [-1, 1]", () => {
  assert.equal(readPlayTail(protocol.buildPlay(1, "boom"), "boom", "").pan, 0);
  assert.equal(readPlayTail(protocol.buildPlay(1, "boom", { pan: 3 }), "boom", "").pan, 1);
  assert.equal(readPlayTail(protocol.buildPlay(1, "boom", { pan: -3 }), "boom", "").pan, -1);
  assert.equal(readPlayTail(protocol.buildPlay(1, "boom", { pan: NaN }), "boom", "").pan, 0);
});

test("PLAY broadcast has empty target", () => {
  const p = protocol.parsePacket(protocol.buildPlay(1, "boom"));
  const expect = new TextEncoder().encode("boom\0\0");
  assert.deepEqual(p.payload.subarray(0, expect.length), expect);
});

test("STOP / STOP_ALL layout", () => {
  const stop = protocol.parsePacket(protocol.buildStop(3, "boom", "p1"));
  assert.deepEqual(stop.payload, new TextEncoder().encode("boom\0p1\0"));
  const all = protocol.parsePacket(protocol.buildStopAll(4, "*/chest"));
  assert.deepEqual(all.payload, new TextEncoder().encode("*/chest\0"));
});

test("CONNECT_STATUS layout matches Unity byte order", () => {
  const pkt = protocol.buildConnectStatus(9, {
    connected: true,
    group: 3,
    appName: "MyApp",
    deviceName: "host",
  });
  const p = protocol.parsePacket(pkt);
  assert.equal(p.commandType, protocol.CMD_CONNECT_STATUS);
  const expect = new Uint8Array([1, 3, ...new TextEncoder().encode("MyApp\0host\0")]);
  assert.deepEqual(p.payload, expect);
});

test("packet size cap throws", () => {
  assert.throws(() => protocol.buildPlay(1, "x".repeat(600)));
});

test("parsePong extended", () => {
  const head = protocol.buildHeader(protocol.CMD_PONG, 1, 0);
  const body = [];
  const num = new Uint8Array(16);
  const dv = new DataView(num.buffer);
  dv.setBigInt64(0, 12345n, true);
  dv.setBigInt64(8, 67890n, true);
  const tail = new TextEncoder().encode("hb-test\0player_1/chest\0v1.2.3\0");
  const vol = new Uint8Array([100, 50, 7]);
  const payload = new Uint8Array(num.length + tail.length + vol.length);
  payload.set(num, 0);
  payload.set(tail, num.length);
  payload.set(vol, num.length + tail.length);
  const full = new Uint8Array(head.length + payload.length);
  full.set(protocol.buildHeader(protocol.CMD_PONG, 1, payload.length), 0);
  full.set(payload, head.length);
  const pong = protocol.parsePong(full);
  assert.equal(pong.timestamp, 12345n);
  assert.equal(pong.deviceName, "hb-test");
  assert.equal(pong.address, "player_1/chest");
  assert.equal(pong.firmwareVersion, "v1.2.3");
  assert.equal(pong.volumeLevel, 100);
});

test("EventMap.fromManifest reads schema 2.0.0 intensity", () => {
  const em = EventMap.fromManifest({
    schema_version: "2.0.0",
    events: { "sample-kit.sine_100hz": { clip: "sine_100hz.wav", parameters: { intensity: 0.42 } } },
  });
  assert.equal(em.gainFor("sample-kit.sine_100hz"), 0.42);
  assert.equal(em.gainFor("unknown"), 1.0);
});

test("Node transport: socket open + broadcast send + close (no device needed)", async () => {
  const hb = await connect({ appName: "WebSdkTest", keepalive: false });
  assert.equal(hb.play("sample-kit.sine_100hz", { gain: 0.1 }), undefined); // does not throw
  hb.stopAll();
  await hb.close();
});

test("Node transport: default receive bind is ephemeral, not 7700 (DEC-036)", async () => {
  const t = new NodeUdpTransport({ keepalive: false });
  await t.connect();
  const port = t.socket.address().port; // TS-private at compile; present at runtime
  assert.notEqual(port, 7700, "default bind must not take the well-known 7700");
  assert.ok(port > 0);
  await t.close();
});

test("Node transport: coexists with a daemon holding 7700 (DEC-036)", async () => {
  // Simulate hapbeat-helper owning the well-known receive port.
  const daemon = dgram.createSocket({ type: "udp4", reuseAddr: true });
  await new Promise((res, rej) => {
    daemon.once("error", rej);
    daemon.bind(7700, res);
  });
  const t = new NodeUdpTransport({ keepalive: false });
  await t.connect();
  assert.notEqual(t.socket.address().port, 7700, "SDK must not fight for 7700");
  await t.close();
  daemon.close();
});

test("Node transport: bindPort opt-in binds the well-known port when free", async () => {
  const t = new NodeUdpTransport({ keepalive: false, bindPort: 7700 });
  await t.connect();
  assert.equal(t.socket.address().port, 7700);
  await t.close();
});

// ── Clip streaming (contracts §0x30–0x32) ──────────────────────────────────

test("STREAM_BEGIN/DATA/END layout", () => {
  const b = protocol.parsePacket(
    protocol.buildStreamBegin(1, { sampleRate: 16000, channels: 2, format: 0, totalSamples: 800, gain: 0.5, target: "p1" }),
  );
  assert.equal(b.commandType, protocol.CMD_STREAM_BEGIN);
  const dv = new DataView(b.payload.buffer, b.payload.byteOffset, b.payload.byteLength);
  assert.equal(dv.getUint16(0, true), 16000);
  assert.equal(dv.getUint8(2), 2);
  assert.equal(dv.getUint8(3), 0);
  assert.equal(dv.getUint32(4, true), 800);
  assert.ok(Math.abs(dv.getFloat32(8, true) - 0.5) < 1e-6);
  assert.deepEqual(b.payload.subarray(12), new TextEncoder().encode("p1\0"));

  const d = protocol.parsePacket(protocol.buildStreamData(2, 1024, new Uint8Array([1, 2, 3, 4])));
  assert.equal(d.commandType, protocol.CMD_STREAM_DATA);
  assert.equal(new DataView(d.payload.buffer, d.payload.byteOffset, 4).getUint32(0, true), 1024);
  assert.deepEqual(d.payload.subarray(4), new Uint8Array([1, 2, 3, 4]));

  const e = protocol.parsePacket(protocol.buildStreamEnd(3));
  assert.equal(e.commandType, protocol.CMD_STREAM_END);
  assert.equal(e.payload.length, 0);
});

test("STREAM_DATA uses the 1472-byte stream cap (not 512)", () => {
  const pkt = protocol.buildStreamData(1, 0, new Uint8Array(1400)); // would throw on the 512 cap
  assert.ok(pkt.length > 512 && pkt.length <= protocol.MAX_STREAM_PACKET_SIZE);
});

test("parseWav reads PCM16; rejects non-WAV", () => {
  const pcm = parseWav(makeWav({ sampleRate: 16000, channels: 1, samples: [0, 100, -100, 32767] }));
  assert.equal(pcm.sampleRate, 16000);
  assert.equal(pcm.channels, 1);
  assert.equal(pcm.data.length, 8);
  assert.throws(() => parseWav(new ArrayBuffer(4)));
});

test("EventMap.fromManifest marks stream_events as clip mode", () => {
  const em = EventMap.fromManifest({
    schema_version: "2.0.0",
    events: { "k.hit": { clip: "sine_100hz.wav", parameters: { intensity: 0.4 } } },
    stream_events: { "k.loop": { clip: "loop.wav", parameters: { intensity: 0.6 } } },
  });
  assert.equal(em.get("k.hit").streaming, false);
  assert.equal(em.get("k.loop").streaming, true);
  assert.equal(em.get("k.loop").clip, "loop.wav");
});

test("facade play() branches fire vs clip from the manifest", async () => {
  const eventMap = EventMap.fromManifest({
    schema_version: "2.0.0",
    events: { "k.hit": { clip: "sine_100hz.wav", parameters: { intensity: 0.4 } } },
    stream_events: { "k.stream": { clip: "loop.wav", parameters: { intensity: 0.6 } } },
  });
  const wav = makeWav({ sampleRate: 16000, channels: 1, samples: new Array(320).fill(1000) }); // 20ms
  const transport = new FakeTransport();
  const hb = new Hapbeat(transport, {
    eventMap,
    clipBase: "clips/",
    clipLoader: async (ref) => { assert.equal(ref, "clips/loop.wav"); return wav; },
    streamSendAheadSec: 0.05,
  });

  // fire event → PLAY command, no streaming
  hb.play("k.hit", { gain: 0.3 });
  assert.deepEqual(transport.calls[0], ["play", "k.hit", 0.3, "", 0]);

  // pan reaches the transport (fire events only — a clip carries L/R in its PCM)
  hb.play("k.hit", { gain: 0.3, pan: 1 });
  assert.deepEqual(transport.calls[1], ["play", "k.hit", 0.3, "", 1]);

  // clip event → async load then STREAM_BEGIN/DATA*/END
  hb.play("k.stream");
  await new Promise((r) => setTimeout(r, 130));
  const begin = transport.calls.find((c) => c[0] === "begin");
  assert.ok(begin, "streamBegin called");
  assert.equal(begin[1].channels, 1);
  assert.equal(begin[1].sampleRate, 16000);
  assert.ok(Math.abs(begin[1].gain - 0.6) < 1e-6, "clip gain = manifest intensity");
  const dataBytes = transport.calls.filter((c) => c[0] === "data").reduce((s, c) => s + c[2], 0);
  assert.equal(dataBytes, 320 * 2, "all PCM bytes streamed");
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(transport.calls.some((c) => c[0] === "end"), "streamEnd called after drain");
});

// ── Persistent stream (openStream / LiveStream) ────────────────────────────

test("openStream: BEGIN once, write() streams DATA with running offset, close() ENDs", () => {
  const transport = new FakeTransport();
  const hb = new Hapbeat(transport);
  const s = hb.openStream({ sampleRate: 16000, channels: 2, gain: 0.7, target: "p1" });
  const begin = transport.calls.find((c) => c[0] === "begin");
  assert.ok(begin, "STREAM_BEGIN sent on open");
  assert.equal(begin[1].channels, 2);
  assert.equal(begin[1].sampleRate, 16000);
  assert.ok(Math.abs(begin[1].gain - 0.7) < 1e-6);
  assert.equal(begin[1].totalSamples, 0, "open-ended (totalSamples 0)");
  assert.equal(begin[1].target, "p1");

  s.write(new Uint8Array(8));
  s.write(new Uint8Array(12));
  const data = transport.calls.filter((c) => c[0] === "data");
  assert.deepEqual(data.map((c) => [c[1], c[2]]), [[0, 8], [8, 12]], "running offset");

  s.close();
  assert.equal(transport.calls.filter((c) => c[0] === "end").length, 1);
  assert.equal(s.closed, true);
  s.write(new Uint8Array(4)); // no-op after close
  assert.equal(transport.calls.filter((c) => c[0] === "data").length, 2);
  s.close(); // idempotent
  assert.equal(transport.calls.filter((c) => c[0] === "end").length, 1);
});

test("openStream chunks large writes to <=1024 frame-aligned DATA packets", () => {
  const transport = new FakeTransport();
  const hb = new Hapbeat(transport);
  const s = hb.openStream({ channels: 2 }); // bytesPerFrame = 4
  s.write(new Uint8Array(3000)); // → 1024 + 1024 + 952
  const data = transport.calls.filter((c) => c[0] === "data");
  assert.deepEqual(data.map((c) => c[2]), [1024, 1024, 952]);
  assert.ok(data.every((c) => c[2] % 4 === 0), "frame-aligned");
  assert.deepEqual(data.map((c) => c[1]), [0, 1024, 2048], "contiguous offsets");
  s.close();
});

test("a new openStream / streamPcm / stopAll ends the previous live stream (1 session = 1 stream)", () => {
  const transport = new FakeTransport();
  const hb = new Hapbeat(transport);
  const s1 = hb.openStream({ channels: 1 });
  transport.calls.length = 0;
  const s2 = hb.openStream({ channels: 1 }); // ends s1, begins s2
  assert.equal(s1.closed, true);
  assert.equal(transport.calls[0][0], "end");
  assert.equal(transport.calls[1][0], "begin");

  transport.calls.length = 0;
  hb.streamPcm(new Uint8Array(8), { channels: 1 }); // a clip ends the live stream
  assert.equal(s2.closed, true);
  assert.ok(transport.calls.some((c) => c[0] === "end"));

  const s3 = hb.openStream({ channels: 1 });
  hb.stopAll();
  assert.equal(s3.closed, true);
});

test("browser transport: stream_* WS messages match the helper shape", async () => {
  const sent = [];
  class FakeWS {
    constructor() {
      this.readyState = 1;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      setTimeout(() => this.onopen && this.onopen({}), 0);
    }
    send(s) { sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWS;
  try {
    const { BrowserWsTransport } = await import("../dist/transport-browser.js");
    const t = new BrowserWsTransport({});
    await t.connect();
    t.streamBegin({ sampleRate: 16000, channels: 2, format: 0, totalSamples: 800, gain: 0.5 });
    t.streamData(0, new Uint8Array([1, 2, 3, 4]));
    t.streamEnd();
    const begin = sent.find((m) => m.type === "stream_begin");
    assert.equal(begin.payload.sample_rate, 16000);
    assert.equal(begin.payload.channels, 2);
    assert.equal(begin.payload.format, "pcm"); // format 0 → "pcm" for helper
    assert.equal(begin.payload.total_samples, 800);
    assert.ok(Math.abs(begin.payload.gain - 0.5) < 1e-6);
    const data = sent.find((m) => m.type === "stream_data");
    assert.equal(data.payload.offset, 0);
    assert.equal(data.payload.data, Buffer.from([1, 2, 3, 4]).toString("base64")); // base64 PCM
    assert.ok(sent.some((m) => m.type === "stream_end"));
  } finally {
    delete globalThis.WebSocket;
  }
});

// ── Device addressing + unicast routing (contracts device-addressing.md) ───

// (target, device address, expected) — transcribed from §4.2's example table.
// This decides which devices a packet is unicast to, so it must agree with the
// firmware's addressMatch(): disagreeing either skips a device that should have
// played (silent loss) or writes to one that ignores the packet anyway.
const MATCH_TABLE = [
  ["", "player_1/pos_neck", true],                        // empty = all devices
  ["player_1", "player_1/pos_neck", true],                // front match
  ["player_1", "player_2/pos_neck", false],               // player mismatch
  ["player_1/pos_neck", "player_1/pos_neck", true],       // exact
  ["player_1/pos_neck", "player_1/pos_r_wrist", false],   // position mismatch
  ["*/pos_neck", "player_1/pos_neck", true],              // wildcard
  ["*/pos_neck", "player_2/pos_neck", true],
  // Firmware only treats a segment that is entirely "*" as a wildcard
  // (address_match.cpp: `t_len == 1 && *tp == '*'`), so "pos_*" is a literal.
  ["player_1/pos_*", "player_1/pos_neck", false],
  ["player_1/*", "player_1/pos_neck", true],
  ["red", "red/player_1/pos_neck", true],
  ["red/*/player_1", "red/alpha/player_1/pos_neck", true],
  ["player_1/pos_neck/group_1", "player_1/pos_neck/group_1", true],
  ["player_1/pos_neck/group_1", "player_1/pos_neck/group_2", false],
  ["player_1/pos_neck", "player_1/pos_neck/group_1", true], // no group = any group
  ["*/*/group_1", "player_2/pos_chest/group_1", true],      // group only
  ["player_1/pos_neck/group_1", "player_1/pos_neck", false], // target longer
  // The trap the positional rule sets: "group_2" lands in the player slot.
  ["group_2", "player_1/pos_neck/group_2", false],
  // Firmware's pointer walk ends at the terminator, so one trailing "/" is not
  // an empty segment; splitting naively would drop a device it would accept.
  ["player_1/", "player_1/pos_neck", true],
  ["player_1//", "player_1/pos_neck", false],
];

test("addressMatches follows the spec table (and firmware)", () => {
  for (const [target, address, expected] of MATCH_TABLE) {
    assert.equal(
      protocol.addressMatches(target, address), expected,
      `target=${JSON.stringify(target)} address=${JSON.stringify(address)}`,
    );
  }
});

// A device's PONG reply (contracts §5.4): two int64s then the extended
// null-terminated strings. The SDK only builds SDK->device packets, so the
// reply is assembled here.
function makePong({ deviceName = "dev", address = "player_1/pos_neck", firmware = "0.3.1" } = {}) {
  const strs = new TextEncoder().encode(`${deviceName}\0${address}\0${firmware}\0`);
  const payload = new Uint8Array(16 + strs.length);
  new DataView(payload.buffer).setBigInt64(0, 0n, true);
  new DataView(payload.buffer).setBigInt64(8, 0n, true);
  payload.set(strs, 16);
  return protocol.buildPacket(protocol.CMD_PONG, 1, payload);
}

// A transport that records where each datagram went instead of opening a socket.
class RoutingProbe extends NodeUdpTransport {
  constructor(opts = {}) { super({ keepalive: false, ...opts }); this.sends = []; }
  async openSocket() {}
  closeSocket() {}
  // Pinned so these tests do not depend on the machine's real interfaces.
  localSubnets() { return [{ address: "192.168.1.5", netmask: "255.255.255.0" }]; }
  sendBytes(pkt) { this.sends.push([pkt, null]); }        // null = broadcast
  sendBytesTo(pkt, ip) { this.sends.push([pkt, ip]); }
  saw(ip, address = "player_1/pos_neck") {
    this.handleMessage(makePong({ address }), ip);
  }
  dests() { return this.sends.map(([, ip]) => ip); }
}

test("UDP transport: broadcasts until a device is known", async () => {
  const t = new RoutingProbe();
  await t.connect();
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), [null]);
});

test("UDP transport: unicasts to known devices, no double delivery", async () => {
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10");
  t.saw("192.168.1.11", "player_2/pos_neck");
  t.sends.length = 0;
  t.play("kit.evt", 1, "", 0);
  // One packet per device and nothing else: firmware older than the
  // (src ip, seq) dedupe would fire the same PLAY twice.
  assert.deepEqual(t.dests().sort(), ["192.168.1.10", "192.168.1.11"]);
});

test("UDP transport: target filters unicast destinations", async () => {
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10", "player_1/pos_neck/group_1");
  t.saw("192.168.1.11", "player_2/pos_neck/group_1");
  t.sends.length = 0;
  t.play("kit.evt", 1, "player_1", 0);
  assert.deepEqual(t.dests(), ["192.168.1.10"]);
});

test("UDP transport: a device with no reported address fails open", async () => {
  const t = new RoutingProbe();
  await t.connect();
  t.handleMessage(protocol.buildPacket(protocol.CMD_PONG, 1, new Uint8Array(16)),
    "192.168.1.10"); // bridge-form PONG: no extended address field
  t.sends.length = 0;
  t.play("kit.evt", 1, "player_9", 0);
  assert.deepEqual(t.dests(), ["192.168.1.10"]);
});

test("UDP transport: all-mismatched commands fall back to broadcast", async () => {
  // Not a skip: a stale cached address must not swallow a STOP, or a looping
  // clip would never stop. The device re-applies the filter anyway.
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10", "player_1/pos_neck/group_1");
  t.sends.length = 0;
  t.stop("kit.evt", "player_7");
  assert.deepEqual(t.dests(), [null]);
});

test("UDP transport: a device stops being a destination once its PONG ages out", async () => {
  const t = new RoutingProbe({ deviceTtlMs: 0 });
  await t.connect();
  t.saw("192.168.1.10");
  t.sends.length = 0;
  await new Promise((r) => setTimeout(r, 5));
  t.stopAll("");
  assert.deepEqual(t.dests(), [null]);
});

test("UDP transport: unicast:false always broadcasts", async () => {
  const t = new RoutingProbe({ unicast: false });
  await t.connect();
  t.saw("192.168.1.10");
  t.sends.length = 0;
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), [null]);
});

test("UDP transport: PING stays broadcast (discovery)", async () => {
  // Never unicast to the one device we happen to know — discovery has to keep
  // reaching devices we have not heard from. (Which broadcast address it goes
  // to once a device has answered is covered in broadcast.test.mjs.)
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10");
  t.sends.length = 0;
  t.ping();
  assert.deepEqual(t.dests(), [null]);
});

test("UDP transport: stream snapshot is reused for DATA and END", async () => {
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10");
  t.sends.length = 0;
  t.streamBegin({ sampleRate: 16000, channels: 1, totalSamples: 10, gain: 1, target: "" });
  t.streamData(0, new Uint8Array([0, 0]));
  t.streamEnd();
  assert.deepEqual(t.dests(), ["192.168.1.10", "192.168.1.10", "192.168.1.10"]);
});

test("UDP transport: a stream matching nobody is dropped, not broadcast", async () => {
  // Hundreds of packets of airtime for devices that would ignore them; and a
  // lost stream leaves nothing stuck, unlike a lost STOP.
  const t = new RoutingProbe();
  await t.connect();
  t.saw("192.168.1.10", "player_1/pos_neck/group_1");
  t.sends.length = 0;
  t.streamBegin({ sampleRate: 16000, channels: 1, totalSamples: 10, gain: 1, target: "player_5" });
  t.streamData(0, new Uint8Array([0, 0]));
  assert.deepEqual(t.dests(), []);
});
