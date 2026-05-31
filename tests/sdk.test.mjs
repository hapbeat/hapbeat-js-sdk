// Contract round-trip + EventMap + Node transport smoke.
// Run with: npm test  (builds to dist/ first, then `node --test`)
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { EventMap } from "../dist/index.js";
import { connect } from "../dist/node.js";

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
