// playClipUrl / playClipFile: one-line clip playback without a kit.
// Nothing here reaches the LAN: the facade tests use a fake transport, and the
// end-to-end test sends only to a fake device on 127.0.0.1.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as dgram from "node:dgram";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as protocol from "../dist/protocol.js";
import { connect, Hapbeat } from "../dist/node.js";

const HIT_WAV = new URL("../examples/hit_80hz.wav", import.meta.url);

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
  return new Uint8Array(buf);
}

class FakeTransport {
  constructor() {
    this.calls = [];
    this.endpoints = [{ ip: "192.0.2.10", address: "p1" }];
  }
  async connect() {}
  play() {}
  stop() {}
  stopAll() {}
  ping() {}
  async discover() { return []; }
  close() {}
  streamEndpoints() { return this.endpoints; }
  streamBeginEndpoint(endpoint) { this.calls.push(["begin", endpoint]); }
  streamDataEndpoint(endpoint, offset, data) { this.calls.push(["data", endpoint, offset, data.length]); }
  streamEndEndpoint(endpoint) { this.calls.push(["end", endpoint]); }
  dataBytes() { return this.calls.filter(([k]) => k === "data").reduce((s, c) => s + c[3], 0); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHttpServer(routes, fn) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "audio/wav" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("playClipUrl fetches, parses and streams the WAV with the given options", async () => {
  const wav = makeWav({ samples: new Array(320).fill(1000) }); // 20 ms mono
  await withHttpServer({ "/hit.wav": wav }, async (base) => {
    const transport = new FakeTransport();
    const hb = new Hapbeat(transport, { streamSendAheadSec: 0.05 });
    await hb.connect();
    const playback = await hb.playClipUrl(`${base}/hit.wav`, { gain: 0.5, pan: -1, target: "p1" });
    assert.equal(playback.gain, 0.5);
    assert.equal(playback.pan, -1);
    assert.equal(playback.loop, false);
    await wait(80);
    assert.ok(transport.calls.some(([k]) => k === "begin"), "stream began");
    assert.equal(transport.dataBytes(), 320 * 4, "mono clip is sent as canonical stereo PCM16");
    await hb.close();
  });
});

test("playClipUrl rejects on an HTTP error and on a non-WAV body", async () => {
  await withHttpServer({ "/not.wav": new TextEncoder().encode("hello") }, async (base) => {
    const hb = new Hapbeat(new FakeTransport());
    await hb.connect();
    await assert.rejects(hb.playClipUrl(`${base}/missing.wav`), /clip fetch 404/);
    await assert.rejects(hb.playClipUrl(`${base}/not.wav`), /not a RIFF\/WAVE file/);
    await hb.close();
  });
});

test("playClipFile reads a path or a file: URL (Node)", async () => {
  const transport = new FakeTransport();
  const hb = new Hapbeat(transport, { streamSendAheadSec: 0.05 });
  await hb.connect();
  const fromUrl = await hb.playClipFile(HIT_WAV, { gain: 0.6, loop: true });
  assert.equal(fromUrl.loop, true);
  fromUrl.stop();
  const fromPath = await hb.playClipFile(fileURLToPath(HIT_WAV));
  assert.equal(fromPath.gain, 1, "gain defaults to 1");
  await wait(60);
  assert.ok(transport.calls.some(([k]) => k === "begin"));

  const dir = await mkdtemp(join(tmpdir(), "hapbeat-clip-"));
  try {
    const bad = join(dir, "bad.wav");
    await writeFile(bad, "not a wav");
    await assert.rejects(hb.playClipFile(bad), /not a RIFF\/WAVE file/);
    await assert.rejects(hb.playClipFile(join(dir, "missing.wav")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await hb.close();
  }
});

test("playClipFile is Node-only: without the Node entry it rejects, and the shared modules never import node:fs", async () => {
  const indexUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `
    import { Hapbeat } from ${JSON.stringify(indexUrl)};
    const t = { connect: async () => {}, close() {}, streamEndpoints: () => [] };
    new Hapbeat(t).playClipFile("x.wav").then(
      () => console.log("resolved"), (e) => console.log(e.message));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.match(out, /Node-only; use playClipUrl/);

  // The browser entry's module graph must stay free of node:fs.
  for (const mod of ["hapbeat.js", "index.js", "browser.js", "wav.js"]) {
    const src = await readFile(new URL(`../dist/${mod}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /(from|import\s*\()\s*["']node:fs/, `${mod} must not import node:fs`);
  }
});

test("end to end over UDP: playClipFile reaches a fake device on 127.0.0.1 only", async () => {
  // Fake device on loopback: answers PING with a pre-v2 PONG (so the SDK
  // resolves it as a stream endpoint) and records what it receives.
  const device = dgram.createSocket("udp4");
  await new Promise((r) => device.bind(0, "127.0.0.1", r));
  const port = device.address().port;
  const received = [];
  device.on("message", (msg, rinfo) => {
    const u8 = new Uint8Array(msg);
    const cmd = u8[3];
    received.push(cmd);
    if (cmd !== protocol.CMD_PING) return;
    const ping = protocol.parsePacket(u8);
    const strs = new TextEncoder().encode("fake\0player_1/pos_chest\x000.4.0\0");
    const payload = new Uint8Array(16 + strs.length + 2);
    payload.set(ping.payload.subarray(0, 8), 0); // echoed timestamp
    payload.set(strs, 16);
    const pong = protocol.buildPacket(protocol.CMD_PONG, ping.seq, payload);
    device.send(pong, rinfo.port, rinfo.address);
  });

  const hb = await connect({ broadcastAddr: "127.0.0.1", port, appName: "ClipTest" });
  try {
    for (let i = 0; i < 50 && !(await hb.discover(20)).length; i++) { /* wait for PONG */ }
    await hb.playClipFile(HIT_WAV, { gain: 0.6 });
    await wait(500);
  } finally {
    await hb.close();
    await wait(20);
    device.close();
  }

  assert.ok(received.includes(protocol.CMD_PING), "PING reached the fake device");
  assert.ok(received.includes(protocol.CMD_STREAM_BEGIN), "STREAM_BEGIN reached the fake device");
  const dataPackets = received.filter((c) => c === protocol.CMD_STREAM_DATA).length;
  assert.ok(dataPackets > 0, `STREAM_DATA packets: ${dataPackets}`);
  assert.ok(received.includes(protocol.CMD_STREAM_END), "STREAM_END reached the fake device");
});
