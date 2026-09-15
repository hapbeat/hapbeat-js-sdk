import assert from "node:assert/strict";
import { test } from "node:test";
import { createPoseInputFrame, parsePoseInputFrame, poseInputFromMediaPipe, PlayerInputSmoother, PoseInputCalibration, poseInputToPlayerInput } from "../examples/games/boxing/pose-input.js";
import { ExternalFrameGate, getStartFightState, LocalMediaPipeSource, TrackerFrameBuffer, TrackerSourceController, WebSocketTrackerSource } from "../examples/games/boxing/tracker-source.js";
import { COMBAT } from "../examples/games/boxing/tuning.js";
import { buildPlayerPose } from "../examples/games/boxing/combat.js";

const points = (over = {}) => ({
  head: { x: .5, y: .25, depthM: null, confidence: 1 }, torso: { x: .5, y: .5, depthM: null, confidence: 1 },
  leftHand: { x: .35, y: .5, depthM: null, confidence: 1 }, rightHand: { x: .65, y: .5, depthM: null, confidence: 1 },
  leftShoulder: { x: .4, y: .4, confidence: 1 }, rightShoulder: { x: .6, y: .4, confidence: 1 },
  leftElbow: { x: .32, y: .5, confidence: 1 }, rightElbow: { x: .68, y: .5, confidence: 1 }, ...over,
});
const frame = (seq, capturedAtMs, over = {}) => createPoseInputFrame({ seq, capturedAtMs, points: points(over) });
const calibrated = (seed = points()) => { const calibration = new PoseInputCalibration(); calibration.observe(frame(1, 0, seed), { calibrating: true }); calibration.observe(frame(2, 1500, seed), { calibrating: true }); return calibration; };

test("v3 parses eight semantic points and rejects the old landmarks schema", () => {
  const valid = frame(1, 1000);
  assert.deepEqual(parsePoseInputFrame(JSON.stringify(valid)), valid);
  assert.equal(parsePoseInputFrame({ seq: 1, t: 1, joints: {} }), null);
  assert.equal(parsePoseInputFrame({ ...valid, v: 1 }), null);
});

test("MediaPipe adapter derives semantic centers without exposing landmark indexes", () => {
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  landmarks[0] = { x: .5, y: .2, visibility: 1 }; landmarks[11] = { x: .4, y: .4, visibility: 1 }; landmarks[12] = { x: .6, y: .4, visibility: 1 };
  landmarks[23] = { x: .4, y: .6, visibility: 1 }; landmarks[24] = { x: .6, y: .6, visibility: 1 }; landmarks[15] = { x: .3, y: .5, visibility: 1 }; landmarks[16] = { x: .7, y: .5, visibility: 1 };
  const output = poseInputFromMediaPipe(landmarks, { seq: 1, capturedAtMs: 1 });
  assert.deepEqual(Object.keys(output.points), ["head", "torso", "leftHand", "rightHand", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow"]);
  assert.equal(output.points.torso.x, .5);
  assert.deepEqual(output.points.leftShoulder, { x: .6, y: .4, confidence: 1 });
  assert.deepEqual(output.points.rightElbow, { x: .5, y: .5, confidence: 1 });
});

test("MediaPipe semantic centers exclude out-of-frame landmarks", () => {
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  landmarks[11] = { x: .4, y: .4, visibility: 1 }; landmarks[12] = { x: .6, y: .4, visibility: 1 };
  landmarks[23] = { x: .4, y: 1.2, visibility: 1 }; landmarks[24] = { x: .6, y: 1.2, visibility: 1 };
  const partial = poseInputFromMediaPipe(landmarks, { seq: 2, capturedAtMs: 2 });
  assert.deepEqual(partial.points.torso, { x: .5, y: .4, depthM: null, confidence: 1 });
  for (const index of [11, 12, 23, 24]) landmarks[index] = { x: -.1, y: 1.2, visibility: 1 };
  const absent = poseInputFromMediaPipe(landmarks, { seq: 3, capturedAtMs: 3 });
  assert.equal(absent.points.torso, null);
});

test("invalid optional hands do not discard a valid head and torso", () => {
  const output = frame(1, 1, { rightHand: { ...points().rightHand, x: 1.1 } });
  assert.ok(output); assert.ok(output.points.head); assert.equal(output.points.rightHand, null);
});

test("shoulder and elbow points have no depth field and all eight names are required", () => {
  const valid = frame(1, 1);
  assert.equal(Object.hasOwn(valid.points.leftShoulder, "depthM"), false);
  const normalized = createPoseInputFrame({ ...valid, points: { ...valid.points, leftElbow: { ...valid.points.leftElbow, depthM: 1 } } });
  assert.equal(normalized.points.leftElbow.depthM, undefined);
  const { rightElbow, ...oldFourPointSchema } = valid.points;
  assert.equal(createPoseInputFrame({ ...valid, points: oldFourPointSchema }), null);
});

test("calibration waits for all eight semantic points then releases its samples", () => {
  const calibration = new PoseInputCalibration();
  calibration.observe(frame(1, 0, { rightHand: null }), { calibrating: true });
  calibration.observe(frame(2, 1500, { rightHand: null }), { calibrating: true });
  assert.equal(calibration.ready, false); assert.equal(calibration.samples.length, 0);
  calibration.observe(frame(3, 1600), { calibrating: true });
  assert.equal(calibration.ready, false, "8点が初めて同時に揃った時点から計測する");
  calibration.observe(frame(4, 3100), { calibrating: true });
  assert.equal(calibration.ready, true); assert.deepEqual(calibration.samples, []);
});

test("local gesture filtering uses the measured capture interval", () => {
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
  const pose = { lastWasFresh: true, video: { videoWidth: 1280, videoHeight: 720 }, detect: () => ({ landmarks }), detectHands: () => null };
  const source = new LocalMediaPipeSource(pose); const dts = [];
  source.gestures.update = (_result, _nowMs, dt) => { dts.push(dt); return { frame: null }; };
  source.poll(1000); source.poll(1066);
  assert.ok(Math.abs(dts[0] - 1 / 30) < 1e-9); assert.ok(Math.abs(dts[1] - .066) < 1e-9);
});

test("local and OAK semantic x/y map to the same 2D player input", () => {
  const calibration = calibrated();
  const local = frame(3, 1600);
  const oak = frame(2, 2, Object.fromEntries(Object.entries(points()).map(([name, value]) => [name, { ...value, depthM: 1.05 }])));
  const a = poseInputToPlayerInput(local, calibration, COMBAT.rig);
  const b = poseInputToPlayerInput(oak, calibration, COMBAT.rig);
  assert.equal(a.head.x, b.head.x); assert.equal(a.arms.right.wrist.x, b.arms.right.wrist.x);
});

test("torso depth changes only global forward and hand depth changes only reach", () => {
  const basePoints = Object.fromEntries(Object.entries(points()).map(([name, value]) => [name, { ...value, depthM: 1 }])); const calibration = calibrated(basePoints);
  const forward = poseInputToPlayerInput(frame(2, 2, { torso: { ...points().torso, depthM: .8 }, leftHand: { ...points().leftHand, depthM: 1 }, rightHand: { ...points().rightHand, depthM: 1 } }), calibration, COMBAT.rig);
  const punch = poseInputToPlayerInput(frame(3, 3, { torso: { ...points().torso, depthM: 1 }, leftHand: { ...points().leftHand, depthM: 1 }, rightHand: { ...points().rightHand, depthM: .7 } }), calibration, COMBAT.rig);
  assert.ok(forward.stepMeters > 0); assert.equal(forward.arms.right.reach, 0);
  assert.equal(punch.stepMeters, 0); assert.ok(punch.arms.right.reach > 0);
});

test("partial depth loss holds only the missing arm and retains 2D input", () => {
  const calibration = calibrated(); const first = frame(3, 1600); calibration.observe(first); const previous = poseInputToPlayerInput(first, calibration, COMBAT.rig); const second = frame(4, 1602, { rightHand: null });
  const output = poseInputToPlayerInput(second, calibration, COMBAT.rig, previous);
  assert.ok(output.head); assert.deepEqual(output.arms.right.wrist, previous.arms.right.wrist);
});

test("missing current depth keeps current x/y and briefly uses the last finite depth", () => {
  const calibration = calibrated();
  const withDepth = frame(3, 1600, { torso: { ...points().torso, depthM: 1 }, rightHand: { ...points().rightHand, depthM: .7 } });
  calibration.observe(withDepth);
  const before = poseInputToPlayerInput(withDepth, calibration, COMBAT.rig);
  const lostDepth = frame(4, 1650, { torso: { ...points().torso, depthM: null }, rightHand: { ...points().rightHand, x: .75, depthM: null } });
  const after = poseInputToPlayerInput(lostDepth, calibration, COMBAT.rig);
  assert.equal(after.arms.right.reach, before.arms.right.reach); assert.ok(after.arms.right.wrist.x > before.arms.right.wrist.x);
});

test("mirrored image coordinates give normalized lateral motion and down-positive body deltas", () => {
  const calibration = calibrated();
  const output = poseInputToPlayerInput(frame(3, 1600, { torso: { ...points().torso, x: .75 }, head: { ...points().head, x: .75, y: .35 }, rightHand: { ...points().rightHand, x: .85, y: .6 } }), calibration, COMBAT.rig);
  assert.equal(output.root.x, 1); assert.ok(output.head.y > 0); assert.ok(output.arms.right.wrist.y > 0);
  const world = buildPlayerPose(output, COMBAT.rig);
  assert.ok(world.head.y < 0); assert.ok(world.head.x > COMBAT.rig.shoulderWidthM * .7);
});

test("calibrated shoulder and elbow x/y update the shared display and hit-test pose without depth", () => {
  const calibration = calibrated();
  const base = poseInputToPlayerInput(frame(3, 1600), calibration, COMBAT.rig);
  const moved = poseInputToPlayerInput(frame(4, 1601, {
    rightShoulder: { ...points().rightShoulder, x: .72, y: .48 },
    rightElbow: { ...points().rightElbow, x: .82, y: .62 },
  }), calibration, COMBAT.rig);
  assert.ok(moved.arms.right.shoulder.x > 0 && moved.arms.right.shoulder.y > 0);
  assert.ok(moved.arms.right.elbow.x > 0 && moved.arms.right.elbow.y > 0);
  const baseWorld = buildPlayerPose(base, COMBAT.rig);
  const movedWorld = buildPlayerPose(moved, COMBAT.rig);
  assert.ok(movedWorld.shoulders.right.x > baseWorld.shoulders.right.x);
  assert.ok(movedWorld.shoulders.right.y < baseWorld.shoulders.right.y);
  const scale = COMBAT.rig.shoulderWidthM * COMBAT.rig.lateralGain;
  const expectedElbow = {
    x: movedWorld.shoulders.right.x + (moved.arms.right.elbow.x - moved.arms.right.shoulder.x) * scale,
    y: movedWorld.shoulders.right.y - (moved.arms.right.elbow.y - moved.arms.right.shoulder.y) * scale,
  };
  assert.ok(Math.abs(movedWorld.right.elbow.x - expectedElbow.x) < 1e-9, "肘の横位置は取得点を直接反映する");
  assert.ok(Math.abs(movedWorld.right.elbow.y - expectedElbow.y) < 1e-9, "肘の高さは取得点を直接反映する");
  assert.ok(movedWorld.right.elbow.z < movedWorld.shoulders.right.z, "肘は常に体の前側に置く");
});

test("render smoothing turns a stepped external pose into continuous visual motion without delaying raw input", () => {
  const smoother = new PlayerInputSmoother({ minHz: 5, maxHz: 5, motionGainHz: 0 });
  const still = { head: { x: 0, y: 0 }, root: { x: 0 }, stepMeters: 0, yaw: 0,
    arms: { left: { shoulder: { x: 0, y: 0 }, elbow: { x: -.2, y: .2 }, wrist: { x: -.3, y: .1 }, reach: 0 },
      right: { shoulder: { x: 0, y: 0 }, elbow: { x: .2, y: .2 }, wrist: { x: .3, y: .1 }, reach: 0 } } };
  const jumped = structuredClone(still);
  jumped.head.x = 1; jumped.root.x = 1; jumped.stepMeters = .5; jumped.arms.right.elbow.y = .8; jumped.arms.right.wrist.x = .9; jumped.arms.right.reach = 1;
  assert.deepEqual(smoother.sample(still, 0).head, still.head);
  const firstVisual = smoother.sample(jumped, 16);
  assert.ok(firstVisual.head.x > 0 && firstVisual.head.x < jumped.head.x, "描画は受信点へ一気に飛ばない");
  assert.ok(firstVisual.arms.right.elbow.y > still.arms.right.elbow.y && firstVisual.arms.right.elbow.y < jumped.arms.right.elbow.y);
  assert.equal(jumped.head.x, 1, "生のゲーム入力はスムーザが書き換えない");
  let settled = firstVisual;
  for (let nowMs = 32; nowMs <= 400; nowMs += 16) settled = smoother.sample(jumped, nowMs);
  assert.ok(settled.head.x > .99 && settled.arms.right.reach > .99, "追従遅延は残し続けない");
});

test("異なる静止肘高さを校正しても、体幹基準の腕形状はモデル肘に残る", () => {
  const highPoints = points({ rightElbow: { ...points().rightElbow, y: .44 } });
  const lowPoints = points({ rightElbow: { ...points().rightElbow, y: .62 } });
  const high = poseInputToPlayerInput(frame(3, 1600, highPoints), calibrated(highPoints), COMBAT.rig);
  const low = poseInputToPlayerInput(frame(3, 1600, lowPoints), calibrated(lowPoints), COMBAT.rig);
  const highModel = buildPlayerPose(high, COMBAT.rig);
  const lowModel = buildPlayerPose(low, COMBAT.rig);
  assert.ok(highModel.right.elbow.y > lowModel.right.elbow.y,
    `静止肘高さが消えている (${highModel.right.elbow.y} <= ${lowModel.right.elbow.y})`);
});

test("visual interpolation keeps the newest raw integer sequence", () => {
  const buffer = new TrackerFrameBuffer(); buffer.push(frame(1, 0, { rightHand: { ...points().rightHand, forward: .2 } }), 0); buffer.push(frame(2, 100, { head: { ...points().head, x: .7 }, rightHand: { ...points().rightHand, forward: .8 } }), 100);
  const visual = buffer.sample(100); assert.equal(visual.seq, 2); assert.equal(visual.freshness, "interpolated"); assert.equal(visual.points.head.x, .6); assert.equal(visual.points.rightHand.forward, .5);
});

test("OAK rendering uses the latest received frame without the local 50 ms interpolation delay", () => {
  const source = new WebSocketTrackerSource("ws://test", { clock: () => 100 });
  assert.equal(source.buffer.delayMs, 0);
  source.buffer.push(frame(1, 0), 0); source.buffer.push(frame(2, 100, { head: { ...points().head, x: .7 } }), 100);
  const visual = source.poll(100);
  assert.equal(visual.seq, 2); assert.equal(visual.points.head.x, .7);
});

test("external gate accepts increasing v3 capture frames only", () => {
  const gate = new ExternalFrameGate(); assert.equal(gate.accept(frame(1, 1000), 1001), true); assert.equal(gate.accept(frame(1, 1001), 1002), false);
});

test("start reports the source-specific input wait state and becomes available after recovery", () => {
  assert.deepEqual(getStartFightState({ trackerActive: false, poseReady: false, sourceMode: "oak" }), {
    canStart: false, reason: "OAK-D Lite入力待機中/接続エラー",
  });
  assert.deepEqual(getStartFightState({ trackerActive: false, poseReady: false, sourceMode: "webcam" }), {
    canStart: false, reason: "Web camera入力待機中/接続エラー",
  });
  assert.deepEqual(getStartFightState({ trackerActive: false, poseReady: false, sourceMode: "auto" }), {
    canStart: false, reason: "カメラ入力待機中/接続エラー",
  });
  assert.deepEqual(getStartFightState({ trackerActive: false, poseReady: false, sourceMode: "mock" }), {
    canStart: false, reason: "Mock入力待機中/接続エラー",
  });
  assert.deepEqual(getStartFightState({ trackerActive: true, poseReady: false, sourceMode: "oak" }), { canStart: true, reason: "" });
});

const deferred = () => { let resolve; return { promise: new Promise((done) => { resolve = done; }), resolve }; };
class FakeSource {
  constructor(kind, start) { this.kind = kind; this.label = kind; this.start = start; this.stopped = false; this.callbacks = new Set(); }
  onFrame(fn) { this.callbacks.add(fn); return () => this.callbacks.delete(fn); }
  stop() { this.stopped = true; }
  poll() { return { freshness: "lost", ageMs: Infinity, points: null }; }
  consumeFresh() { return null; }
}

test("auto fallback waits for deferred local startup before retry and an OAK recovery wins", async () => {
  const firstLocal = deferred(), secondLocal = deferred(); let externalStarts = 0, localStarts = 0;
  const externalFactory = (onLost) => new FakeSource("oak", async () => {
    externalStarts++;
    if (externalStarts === 1) return false;
    return true;
  });
  const localFactory = () => new FakeSource("local", () => (++localStarts === 1 ? firstLocal.promise : secondLocal.promise));
  const controller = new TrackerSourceController({ sourceMode: "auto", externalFactory, localFactory, retryDelayMs: 0 });
  const started = controller.start(); await new Promise((done) => setImmediate(done));
  assert.equal(externalStarts, 1); assert.equal(localStarts, 1);
  firstLocal.resolve(true); await started; assert.equal(controller.kind, "local");
  await new Promise((done) => setTimeout(done, 0)); assert.equal(externalStarts, 2); assert.equal(controller.kind, "oak");
  const slowLocal = controller._local(controller.generation); await Promise.resolve();
  const recovered = controller._external(controller.generation, true); await recovered;
  secondLocal.resolve(true); await slowLocal;
  assert.equal(controller.kind, "oak"); controller.stop();
});

test("WebSocket loss is notified once and stop prevents a deferred source activation", async () => {
  const oldWebSocket = globalThis.WebSocket; const sockets = [];
  class FakeWebSocket { constructor() { sockets.push(this); } close() { this.onclose?.(); } }
  globalThis.WebSocket = FakeWebSocket;
  try {
    let losses = 0; const source = new WebSocketTrackerSource("ws://test", { onLost: () => { losses++; } });
    const opening = source.start(); const socket = sockets[0]; socket.onmessage({ data: JSON.stringify(frame(1, Date.now())) }); await opening;
    socket.onerror(); socket.onclose(); assert.equal(losses, 1);
    const local = deferred(); const controller = new TrackerSourceController({ sourceMode: "webcam", localFactory: () => new FakeSource("local", () => local.promise) });
    const starting = controller.start(); controller.stop(); local.resolve(true); assert.equal(await starting, false); assert.equal(controller.active, null);
  } finally { globalThis.WebSocket = oldWebSocket; }
});

test("explicit OAK retries after an active source is lost", async () => {
  let starts = 0, notifyLost = null; const statuses = [];
  const externalFactory = (onLost) => {
    notifyLost = onLost;
    return new FakeSource("oak", async () => { starts++; return true; });
  };
  const controller = new TrackerSourceController({
    sourceMode: "oak", externalFactory, retryDelayMs: 0,
    onStatus: (status) => statuses.push(status),
  });
  await controller.start(); const first = controller.active;
  notifyLost("接続が切れました");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(starts, 2); assert.equal(controller.kind, "oak"); assert.notEqual(controller.active, first);
  assert.deepEqual(statuses.find((status) => status.lost), { mode: "external", lost: true, reason: "接続が切れました" });
  controller.stop();
});

test("menu, DOM PIP, and throttled semantic diagnostics are present", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../examples/games/boxing/boxing.js", import.meta.url), "utf8");
  assert.match(src, /id="trackerPip"/); assert.match(src, /position: fixed/); assert.match(src, /nowMs - frame\.lastDiagnosticAt >= 250/); assert.match(src, /深度 valid/); assert.match(src, /処理 \$\{processing\}/);
  assert.match(src, /tracker\?\.kind === "oak"/); assert.match(src, /external && srcFrame\?\.preview/);
  assert.match(src, /function startFight\(\) \{[\s\S]*getStartFightState/);
  assert.match(src, /#recalBtn"\)\.onclick = \(\) => \{[\s\S]*getStartFightState/);
  assert.match(src, /function setPaused\(next\)/); assert.match(src, /e\.code === "Escape" && state === "FIGHT"/); assert.match(src, /gamePaused = state === "FIGHT" && paused/);
});
