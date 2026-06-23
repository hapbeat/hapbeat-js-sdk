// Contract round-trip + EventMap + Node transport smoke.
// Run with: npm test  (builds to dist/ first, then `node --test`)
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { EventMap, Hapbeat, parseWav } from "../dist/index.js";
import { connect } from "../dist/node.js";

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
  play(id, gain, target) { this.calls.push(["play", id, gain, target]); }
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

test("PLAY layout: event_id\\0 target\\0 + i64 time + f32 gain", () => {
  const pkt = protocol.buildPlay(7, "explosion", { target: "player_1/chest", gain: 0.5 });
  const p = protocol.parsePacket(pkt);
  assert.equal(p.commandType, protocol.CMD_PLAY);
  assert.equal(p.seq, 7);
  const prefix = new TextEncoder().encode("explosion\0player_1/chest\0");
  assert.deepEqual(p.payload.subarray(0, prefix.length), prefix);
  const dv = new DataView(p.payload.buffer, p.payload.byteOffset + prefix.length, 12);
  assert.equal(dv.getBigInt64(0, true), 0n);
  assert.ok(Math.abs(dv.getFloat32(8, true) - 0.5) < 1e-6);
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
    events: { "impact.hit": { clip: "hit.wav", parameters: { intensity: 0.42 } } },
  });
  assert.equal(em.gainFor("impact.hit"), 0.42);
  assert.equal(em.gainFor("unknown"), 1.0);
});

test("Node transport: socket open + broadcast send + close (no device needed)", async () => {
  const hb = await connect({ appName: "WebSdkTest", keepalive: false });
  assert.equal(hb.play("impact.hit", { gain: 0.1 }), undefined); // does not throw
  hb.stopAll();
  await hb.close();
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
    events: { "k.hit": { clip: "hit.wav", parameters: { intensity: 0.4 } } },
    stream_events: { "k.loop": { clip: "loop.wav", parameters: { intensity: 0.6 } } },
  });
  assert.equal(em.get("k.hit").streaming, false);
  assert.equal(em.get("k.loop").streaming, true);
  assert.equal(em.get("k.loop").clip, "loop.wav");
});

test("facade play() branches fire vs clip from the manifest", async () => {
  const eventMap = EventMap.fromManifest({
    schema_version: "2.0.0",
    events: { "k.hit": { clip: "hit.wav", parameters: { intensity: 0.4 } } },
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
  assert.deepEqual(transport.calls[0], ["play", "k.hit", 0.3, ""]);

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
