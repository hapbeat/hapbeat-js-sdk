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
  streamBeginEndpoint(endpoint) { this.calls.push(["begin", { ...endpoint }]); }
  streamDataEndpoint(endpoint, offset, data) {
    this.calls.push(["data", { ...endpoint }, offset, new Uint8Array(data)]);
  }
  streamEndEndpoint(endpoint) { this.calls.push(["end", { ...endpoint }]); }
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

test("after END, a replacement BEGIN waits for the 300 ms cooldown", async () => {
  const sink = new StreamSink([{ ip: "10.0.0.1", address: "p1" }]);
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
