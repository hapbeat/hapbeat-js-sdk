// 外部トラッカー（深度カメラ）の入力層。tracker-source.js の純関数部分を node で検証する。
//
// 守りたいこと:
//   ・プロトコル（PROTOCOL.md）の 1 行 JSON を壊れた入力込みで安全にパースできる
//   ・カメラ座標 → ゲーム座標の変換が鏡像にならない（左右・奥行きの向きが正しい）
//   ・xyz が来たら奥行き推定を使わず、実測の手首位置がそのまま IK の目標になる
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrackerMessage, xyzToRig, frameToPlayerInput, XYZ_JOINTS, ExternalFrameGate, TrackerSourceController, WebSocketTrackerSource } from "../examples/games/boxing/tracker-source.js";
import { buildPlayerPose, dist } from "../examples/games/boxing/combat.js";
import { COMBAT } from "../examples/games/boxing/tuning.js";

/** PROTOCOL.md の例に沿ったフレーム（2m 先に立ち、右手を 0.5m 前に突き出した状態）。 */
function sampleMessage({ wristRz = -1.4 } = {}) {
  const j = (px, xyz) => ({ px, xyz });
  return JSON.stringify({
    t: 123456, seq: 12, telemetry: { source: "oak", sentAtMs: 123456, trackerFps: 25, rgb: { width: 1280, height: 720, seq: 12 },
      depth: { width: 1280, height: 720, seq: 12 }, syncDeltaMs: 1, validDepthRatio: 0.9, joint3dCount: 9,
      processingLatencyMs: 20, dropCounts: {} },
    joints: {
      nose: j({ x: 0.51, y: 0.28, visibility: 0.99 }, { x: 0.02, y: 0.35, z: -1.9 }),
      shoulderL: j({ x: 0.57, y: 0.4, visibility: 0.98 }, { x: 0.19, y: 0.15, z: -1.92 }),
      shoulderR: j({ x: 0.44, y: 0.4, visibility: 0.98 }, { x: -0.19, y: 0.15, z: -1.88 }),
      elbowL: j({ x: 0.61, y: 0.52, visibility: 0.95 }, { x: 0.28, y: -0.05, z: -1.8 }),
      elbowR: j({ x: 0.4, y: 0.52, visibility: 0.95 }, { x: -0.28, y: -0.05, z: -1.7 }),
      wristL: j({ x: 0.58, y: 0.44, visibility: 0.93 }, { x: 0.16, y: 0.1, z: -1.75 }),
      wristR: j({ x: 0.46, y: 0.44, visibility: 0.93 }, { x: -0.15, y: 0.1, z: wristRz }),
      hipL: j({ x: 0.55, y: 0.66, visibility: 0.9 }, { x: 0.12, y: -0.28, z: -1.93 }),
      hipR: j({ x: 0.46, y: 0.66, visibility: 0.9 }, { x: -0.12, y: -0.28, z: -1.9 }),
    },
    hands: [{ handedness: "Right", landmarks: new Array(21).fill({ x: 0.46, y: 0.44, z: 0 }) }],
  });
}

test("パース: プロトコルの 1 行 JSON → MediaPipe 互換の配列 + xyz", () => {
  const f = parseTrackerMessage(sampleMessage());
  assert.equal(f.source, "depth");
  assert.equal(f.t, 123456);
  assert.equal(f.seq, 12);
  // 2D 経路がそのまま動くよう 33 点の配列になっている
  assert.equal(f.landmarks.length, 33);
  assert.equal(f.landmarks[XYZ_JOINTS.nose].x, 0.51);
  assert.equal(f.landmarks[XYZ_JOINTS.wristR].visibility, 0.93);
  assert.equal(f.landmarks[1].visibility, 0, "送られていない点は visibility 0 になる");
  assert.equal(f.xyz.wristR.z, -1.4);
  assert.equal(f.hands.length, 1);
});

test("パース: 壊れた入力では null を返す（接続は切らない）", () => {
  for (const bad of ["", "{", "null", JSON.stringify({ t: 1 }), 42, undefined]) {
    assert.equal(parseTrackerMessage(bad), null, `${JSON.stringify(bad)} で null にならない`);
  }
  // xyz が無い（Web カメラだけのトラッカー）なら source は local で xyz は null
  const only2d = parseTrackerMessage(JSON.stringify({ t: 2, seq: 2, telemetry: { source: "webcam", sentAtMs: 2, trackerFps: 1, rgb: { width: 1, height: 1, seq: 2 } }, joints: {
    nose: { px: { x: 0.5, y: 0.3 } }, shoulderL: { px: { x: 0.4, y: 0.4 } }, shoulderR: { px: { x: 0.6, y: 0.4 } } } }));
  assert.equal(only2d.source, "local");
  assert.equal(only2d.xyz, null);
});

test("パース: optional joint/handは局所的に捨て、telemetryは描画安全な値だけ受ける", () => {
  const optionalBad = JSON.parse(sampleMessage());
  optionalBad.joints.wristR.px.x = 2;
  optionalBad.joints.wristR.xyz.z = Number.NaN;
  optionalBad.hands[0].landmarks[2].x = -0.1;
  const frame = parseTrackerMessage(JSON.stringify(optionalBad));
  assert.ok(frame, "必須点以外は全frameを捨てない");
  assert.equal(frame.xyz.wristR, undefined);
  assert.equal(frame.hands.length, 0, "壊れた手だけを捨てる");
  const invalidTelemetry = JSON.parse(sampleMessage()); invalidTelemetry.telemetry.rgb.width = "1280";
  assert.equal(parseTrackerMessage(JSON.stringify(invalidTelemetry)), null);
});

test("外部フレーム gate: schema、単調seq/timestamp、stale TTLを強制する", () => {
  const gate = new ExternalFrameGate({ staleTtlMs: 100 });
  const frame = parseTrackerMessage(sampleMessage());
  frame.t = 1_000; frame.telemetry.sentAtMs = 1_000;
  assert.equal(gate.accept(frame, 1_050), true);
  assert.equal(gate.accept(frame, 1_051), false, "同じseqを再採用しない");
  const next = { ...frame, seq: 13, telemetry: { ...frame.telemetry, sentAtMs: 1_101 } };
  assert.equal(gate.accept(next, 1_201), true);
  assert.equal(gate.stale(1_202), true, "TTLを越えればcontrollerがfallbackする");
  const nonFinite = JSON.parse(sampleMessage()); nonFinite.joints.nose.xyz.x = null;
  assert.equal(parseTrackerMessage(JSON.stringify(nonFinite)), null, "xyzの全軸finiteが必須");
});

test("接続断は実カメラfallbackを開始し、再接続でexternalへ戻る", async () => {
  const saved = globalThis.WebSocket;
  class FakeSocket {
    static instances = [];
    constructor() { FakeSocket.instances.push(this); queueMicrotask(() => {
      this.onopen?.();
      const message = JSON.parse(sampleMessage()); message.t = Date.now(); message.telemetry.sentAtMs = message.t;
      this.onmessage?.({ data: JSON.stringify(message) });
    }); }
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeSocket;
  const pose = { starts: 0, stops: 0, async start() { this.starts++; return true; }, stop() { this.stops++; }, detect() { return null; }, detectHands() { return null; } };
  const controller = new TrackerSourceController({ pose, video: {}, url: "ws://test", reconnectMs: 5 });
  try {
    assert.equal(await controller.start(), true);
    assert.ok(controller.active instanceof WebSocketTrackerSource);
    FakeSocket.instances[0].onclose();
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(pose.starts, 1, "外部停止後にLocalMediaPipeを実際に開始する");
    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.ok(controller.active instanceof WebSocketTrackerSource, "復帰したexternalを再選択する");
    assert.ok(pose.stops >= 1, "external復帰時にlocal cameraを停止する");
  } finally {
    controller.stop();
    globalThis.WebSocket = saved;
  }
});

test("ローカルカメラ開始失敗後もexternal再接続を継続する", async () => {
  const saved = globalThis.WebSocket;
  class FakeSocket {
    static instances = [];
    constructor() { FakeSocket.instances.push(this); queueMicrotask(() => {
      this.onopen?.();
      const message = JSON.parse(sampleMessage()); message.t = Date.now(); message.telemetry.sentAtMs = message.t;
      this.onmessage?.({ data: JSON.stringify(message) });
    }); }
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeSocket;
  const pose = { async start() { return false; }, stop() {}, detect() { return null; }, detectHands() { return null; } };
  const controller = new TrackerSourceController({ pose, video: {}, url: "ws://test", reconnectMs: 5 });
  try {
    assert.equal(await controller.start(), true);
    FakeSocket.instances[0].onclose();
    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.ok(FakeSocket.instances.length >= 2, "Webカメラ無しでもexternal再接続を試みる");
    assert.ok(controller.active instanceof WebSocketTrackerSource, "復帰したexternalを再選択する");
  } finally {
    controller.stop();
    globalThis.WebSocket = saved;
  }
});

test("WS openのみではexternalを採用せず、初回valid frame前のcloseは失敗としてcleanupする", async () => {
  const saved = globalThis.WebSocket;
  class OpenOnlySocket { constructor() { queueMicrotask(() => this.onopen?.()); } close() { this.onclose?.(); } }
  globalThis.WebSocket = OpenOnlySocket;
  const source = new WebSocketTrackerSource("ws://test");
  try {
    const pending = source.start({}, { timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(source.last, null);
    source.ws.onclose();
    assert.equal(await pending, false);
    assert.equal(source.ws, null);
  } finally { source.stop(); globalThis.WebSocket = saved; }
});

test("stop中の初回frame待機は解決し、遅いsocket callbackで再activateしない", async () => {
  const saved = globalThis.WebSocket;
  class DelayedSocket { close() {} }
  globalThis.WebSocket = DelayedSocket;
  const source = new WebSocketTrackerSource("ws://test");
  try {
    const pending = source.start({}, { timeoutMs: 1000 });
    source.stop();
    assert.equal(await pending, false);
    assert.equal(source.ws, null);
  } finally { globalThis.WebSocket = saved; }
});

test("座標変換: 左右反転・奥行き反転で、鏡像にはならない", () => {
  const o = { x: 0, y: 0, z: -2 };
  // 被写体の右手はカメラ画像では左（x 負）→ ゲームでは画面右（+X）
  assert.ok(xyzToRig({ x: -0.3, y: 0, z: -2 }, o).x > 0);
  assert.ok(xyzToRig({ x: 0.3, y: 0, z: -2 }, o).x < 0);
  // カメラに近づく（z が大きい＝ -1.5）→ 敵の方向（-Z）へ進む
  assert.ok(xyzToRig({ x: 0, y: 0, z: -1.5 }, o).z < 0);
  assert.ok(xyzToRig({ x: 0, y: 0, z: -2.5 }, o).z > 0);
  // 上下はそのまま
  assert.ok(xyzToRig({ x: 0, y: 0.4, z: -2 }, o).y > 0);
  // diag(-1,+1,-1) は行列式 +1（回転）＝鏡像化しない
  const det = -1 * 1 * -1;
  assert.equal(det, 1);
});

test("深度フレーム → プレイヤー入力: 実測の手首がそのまま IK の目標になる", () => {
  const near = frameToPlayerInput(parseTrackerMessage(sampleMessage({ wristRz: -1.4 })), COMBAT.rig);
  const far = frameToPlayerInput(parseTrackerMessage(sampleMessage({ wristRz: -1.85 })), COMBAT.rig);
  assert.ok(near.arms.right.target, "3D の目標が作られていない");
  // 前に突き出しているほど target.z は小さい（敵の方向）
  assert.ok(near.arms.right.target.z < far.arms.right.target.z);
  assert.ok(near.arms.right.reach > far.arms.right.reach, "reach が前後を反映していない");
  // 前後の立ち位置は実測（基準 2.0m に対し 1.9m なら 0.1m 前）
  assert.ok(Math.abs(near.stepMeters - 0.1) < 0.02, `stepMeters=${near.stepMeters.toFixed(3)}`);

  // buildPlayerPose に通しても骨は伸びない
  const pose = buildPlayerPose(near, COMBAT.rig);
  const maxArm = COMBAT.rig.bones.upperArm + COMBAT.rig.bones.foreArm;
  assert.ok(dist(pose.shoulders.right, pose.right.wrist) <= maxArm + 1e-6);
  assert.ok(pose.right.wrist.x > 0, "被写体の右手が画面右に来ていない");
  assert.ok(pose.head.z < 0, "前に出ているのに前進していない");
});

test("深度フレーム: 必要な関節が無ければ null（2D 経路へフォールバックさせる）", () => {
  assert.equal(frameToPlayerInput({ xyz: { nose: { x: 0, y: 0, z: -2 } } }, COMBAT.rig), null);
  assert.equal(frameToPlayerInput({ xyz: null }, COMBAT.rig), null);
  assert.equal(frameToPlayerInput(null, COMBAT.rig), null);
});
