import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamHub } from "../dist/stream.js";

function monoPcm(value, frames) {
  const data = new Uint8Array(frames * 2);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame++) view.setInt16(frame * 2, value, true);
  return data;
}

class StreamSink {
  constructor(endpoints = []) {
    this.endpoints = endpoints;
    this.calls = [];
  }

  streamEndpoints() { return this.endpoints; }
  streamBeginEndpoint(endpoint) {
    this.calls.push(["begin", { ...endpoint }]);
    return { epoch: endpoint.wireEpoch };
  }
  streamDataEndpoint(endpoint, offset, data, wire) {
    this.calls.push(["data", { ...endpoint }, offset, new Uint8Array(data), wire]);
  }
  streamEndEndpoint(endpoint, wire) { this.calls.push(["end", { ...endpoint }, wire]); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("same endpoint mixes logical sources into one saturated stereo session", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0.02 });
  hub.playPcm(monoPcm(10_000, 128), { target: "p1" });
  hub.playPcm(monoPcm(-2_500, 128), { target: "p1" });
  await wait(20);

  assert.equal(sink.calls.filter(([kind]) => kind === "begin").length, 1);
  const data = sink.calls.find(([kind]) => kind === "data")[3];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(view.getInt16(0, true), 7_500);
  assert.equal(view.getInt16(2, true), 7_500);
  hub.close();
});

test("gain and pan belong to each source before endpoint mixing", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0.02 });
  hub.playPcm(monoPcm(20_000, 64), { target: "p1", gain: 0.5, pan: -1 });
  hub.playPcm(monoPcm(20_000, 64), { target: "p1", gain: 0.25, pan: 1 });
  await wait(20);

  const data = sink.calls.find(([kind]) => kind === "data")[3];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(view.getInt16(0, true), 10_000);
  assert.equal(view.getInt16(2, true), 5_000);
  hub.close();
});

test("finite source waits for a late endpoint and starts there at byte offset zero", async () => {
  const sink = new StreamSink();
  const hub = new StreamHub(sink, { sendAheadSec: 0.02 });
  const playback = hub.playPcm(monoPcm(1_000, 64), { target: "p1" });
  assert.equal(playback.status, "Deferred");
  assert.equal(playback.deferredReason, "NoResolvedEndpoint");
  assert.deepEqual(sink.calls, []);

  sink.endpoints = [{ ip: "10.0.0.1", address: "p1" }];
  hub.reconcile();
  assert.equal(playback.status, "Active");
  await wait(20);
  const data = sink.calls.find(([kind]) => kind === "data");
  assert.equal(data[2], 0);
  hub.close();
});

test("route-only endpoint migration keeps the wire session and byte cursor", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0.01 });
  const live = hub.openLive({ target: "p1" });
  assert.equal(live.write(monoPcm(1_000, 64)), true);
  await wait(20);
  const firstData = sink.calls.filter(([kind]) => kind === "data").at(-1);
  const nextOffset = firstData[2] + firstData[3].length;

  sink.endpoints = [{ ip: "10.0.0.2", address: "p1" }];
  hub.reconcile();
  assert.equal(sink.calls.filter(([kind]) => kind === "begin").length, 1);
  assert.equal(sink.calls.filter(([kind]) => kind === "end").length, 0);
  assert.equal(live.write(monoPcm(2_000, 64)), true);
  await wait(20);

  const migrated = sink.calls.filter(([kind, endpoint]) =>
    kind === "data" && endpoint.ip === "10.0.0.2"
  );
  assert.ok(migrated.length > 0);
  assert.equal(migrated[0][2], nextOffset);
  hub.close();
});

test("a new cue during the empty linger reuses the session without END/BEGIN", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0.01 });
  hub.playPcm(monoPcm(1_000, 32), { target: "p1" });
  await wait(25);
  hub.playPcm(monoPcm(2_000, 32), { target: "p1" });
  await wait(25);

  assert.equal(sink.calls.filter(([kind]) => kind === "begin").length, 1);
  assert.equal(sink.calls.filter(([kind]) => kind === "end").length, 0);
  const offsets = sink.calls.filter(([kind]) => kind === "data").map((call) => call[2]);
  assert.ok(offsets.length >= 2);
  assert.ok(offsets[1] > offsets[0]);
  hub.close();
});

test("live input queue is bounded and reports backpressure", () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  const live = hub.openLive({ target: "p1", channels: 1 });
  assert.equal(live.write(monoPcm(1_000, 4096)), true);
  assert.equal(live.write(monoPcm(1_000, 1)), false);
  hub.close();
});

test("legacy endpoint: after END, a replacement BEGIN waits for the 300 ms guard", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1", legacy: true, wireEpoch: "legacy" }]);
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(1_000, 16), { target: "p1" });
  await wait(350);
  assert.equal(sink.calls.filter(([kind]) => kind === "end").length, 1);

  hub.playPcm(monoPcm(2_000, 16), { target: "p1" });
  assert.equal(sink.calls.filter(([kind]) => kind === "begin").length, 1);
  await wait(380);
  assert.equal(sink.calls.filter(([kind]) => kind === "begin").length, 2);
  hub.close();
});

test("legacy guard is per endpoint: another device with the same address is not delayed", async () => {
  const a = { ip: "10.0.0.1", address: "p1/same", legacy: true, wireEpoch: "legacy" };
  const b = { ip: "10.0.0.2", address: "p1/same", legacy: true, wireEpoch: "legacy" };
  const sink = new StreamSink([a]);
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(1_000, 16), { target: "p1" });
  await wait(350);
  sink.endpoints = [a, b];
  hub.playPcm(monoPcm(2_000, 16), { target: "p1" });
  const beginsAt = (ip) => sink.calls.filter(([kind, e]) => kind === "begin" && e.ip === ip).length;
  assert.equal(beginsAt("10.0.0.2"), 1, "no guard on the other device");
  assert.equal(beginsAt("10.0.0.1"), 1, "guarded");
  await wait(380);
  assert.equal(beginsAt("10.0.0.1"), 2);
  hub.close();
});

async function playedElsewhereWhileGuarded() {
  const v2 = { ip: "10.0.0.2", address: "p1/v2", wireEpoch: "v2:1:1" };
  const legacy = { ip: "10.0.0.1", address: "p1/legacy", legacy: true, wireEpoch: "legacy" };
  const sink = new StreamSink([v2, legacy]);
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  hub.playPcm(monoPcm(1_000, 16), { target: "p1" });
  await wait(350);
  const playback = hub.playPcm(monoPcm(2_000, 16), { target: "p1" });
  await wait(30); // played out on v2; the legacy endpoint is still guarded
  const count = (kind, ip) => sink.calls.filter(([k, e]) => k === kind && e.ip === ip).length;
  assert.equal(count("data", v2.ip), 2);
  assert.equal(count("begin", legacy.ip), 1);
  assert.notEqual(playback.status, "Stopped");
  return { sink, hub, playback, v2, legacy, count };
}

test("finite source completes when its guarded endpoint disappears (no replay on return)", async () => {
  const { sink, hub, playback, v2, legacy, count } = await playedElsewhereWhileGuarded();
  sink.endpoints = [v2];
  hub.reconcile();
  assert.equal(playback.status, "Stopped");
  assert.equal(hub.sources.size, 0);
  await wait(350);
  assert.equal(hub.sessions.size, 0);
  assert.equal(hub.timer, undefined, "hub idles");
  sink.endpoints = [v2, legacy]; // the device returns after its guard
  hub.reconcile();
  await wait(30);
  assert.equal(count("begin", legacy.ip), 1, "the old cue is not replayed from frame 0");
  hub.close();
});

test("finite source completes when its guarded endpoint stops matching the target", async () => {
  const { sink, hub, playback, v2, legacy, count } = await playedElsewhereWhileGuarded();
  sink.endpoints = [v2, { ...legacy, address: "p2/legacy" }];
  hub.reconcile();
  assert.equal(playback.status, "Stopped");
  await wait(350);
  assert.equal(count("begin", legacy.ip), 1);
  hub.close();
});

test("enabling loop clears per-endpoint completion exclusions", () => {
  const endpoint = { ip: "10.0.0.1", address: "p1", port: 7700 };
  const sink = new StreamSink([endpoint]);
  const hub = new StreamHub(sink, { sendAheadSec: 0 });
  const playback = hub.playPcm(monoPcm(1_000, 64), { target: "p1", loop: true });
  const source = [...hub.sources.values()][0];
  source.completedEndpoints.add(`${endpoint.ip}\u0000${endpoint.address}\u0000${endpoint.port}`);
  assert.equal(source.completedEndpoints.size, 1);
  playback.loop = true;
  assert.equal(source.completedEndpoints.size, 0);
  hub.close();
});
