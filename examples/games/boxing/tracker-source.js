/** External RGB-D and local MediaPipe input, with strict external-frame gating. */
import { LM } from "./pose.js";

export const XYZ_JOINTS = {
  nose: LM.nose, shoulderL: LM.shoulderL, shoulderR: LM.shoulderR,
  elbowL: LM.elbowL, elbowR: LM.elbowR, wristL: LM.wristL, wristR: LM.wristR,
  hipL: LM.hipL, hipR: LM.hipR,
};
export const REQUIRED_JOINTS = ["nose", "shoulderL", "shoulderR"];
const finitePoint = (point) => point && [point.x, point.y, point.z].every(Number.isFinite);
const finitePx = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;
const safeSize = (size) => size && Number.isSafeInteger(size.width) && size.width > 0
  && Number.isSafeInteger(size.height) && size.height > 0 && Number.isSafeInteger(size.seq) && size.seq >= 0;

function normalizeTelemetry(value) {
  if (!value || typeof value !== "object" || typeof value.source !== "string" || !finiteNonNegative(value.sentAtMs)
    || !finiteNonNegative(value.trackerFps) || !safeSize(value.rgb)) return null;
  const numeric = ["syncDeltaMs", "sequenceDelta", "validDepthRatio", "joint3dCount", "processingLatencyMs"];
  if (numeric.some((key) => value[key] != null && !finiteNonNegative(value[key]))) return null;
  if (value.depth != null && !safeSize(value.depth)) return null;
  if (value.dropCounts != null && (typeof value.dropCounts !== "object"
    || Object.values(value.dropCounts).some((count) => !Number.isSafeInteger(count) || count < 0))) return null;
  const device = value.device && typeof value.device === "object" ? {
    deviceId: typeof value.device.deviceId === "string" ? value.device.deviceId : "",
    usbSpeed: typeof value.device.usbSpeed === "string" ? value.device.usbSpeed : "",
  } : null;
  return { ...value, device, dropCounts: value.dropCounts ?? {} };
}

/** Parse the current tracker schema. Reject malformed 3D rather than letting it reach combat. */
export function parseTrackerMessage(msg) {
  let obj = msg;
  if (typeof msg === "string") { try { obj = JSON.parse(msg); } catch { return null; } }
  if (!obj || typeof obj !== "object" || !obj.joints || !Number.isSafeInteger(obj.seq) || !Number.isFinite(obj.t)) return null;
  const telemetry = normalizeTelemetry(obj.telemetry);
  if (!telemetry) return null;
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const xyz = {};
  for (const [name, index] of Object.entries(XYZ_JOINTS)) {
    const joint = obj.joints[name];
    if (!joint) continue;
    if (joint.px && finitePx(joint.px)) {
      landmarks[index] = { x: joint.px.x, y: joint.px.y, z: Number.isFinite(joint.px.z) ? joint.px.z : 0,
        visibility: Number.isFinite(joint.px.visibility) ? joint.px.visibility : 1 };
    }
    if (joint.xyz && finitePoint(joint.xyz)) {
      xyz[name] = { x: joint.xyz.x, y: joint.xyz.y, z: joint.xyz.z };
    }
  }
  if (!REQUIRED_JOINTS.every((name) => finitePx(obj.joints[name]?.px))) return null;
  const has3d = Object.keys(xyz).length > 0;
  if (has3d && !REQUIRED_JOINTS.every((name) => finitePoint(xyz[name]))) return null;
  const hands = Array.isArray(obj.hands) ? obj.hands.filter((hand) => Array.isArray(hand?.landmarks)
    && hand.landmarks.every(finitePx)).map((hand) => ({ landmarks: hand.landmarks, handedness: hand.handedness ?? "" })) : null;
  return { t: obj.t, seq: obj.seq, source: has3d ? "depth" : "local", landmarks, worldLandmarks: null, hands,
    xyz: has3d ? xyz : null, telemetry, debug: obj.debug ?? null };
}

/** Stateful order/freshness gate, intentionally exported for non-browser tests. */
export class ExternalFrameGate {
  constructor({ staleTtlMs = 750 } = {}) { this.staleTtlMs = staleTtlMs; this.lastSeq = -1; this.lastSentAtMs = -1; this.drops = 0; }
  accept(frame, nowMs = Date.now()) {
    if (!frame || frame.seq <= this.lastSeq || frame.telemetry.sentAtMs <= this.lastSentAtMs
      || nowMs - frame.telemetry.sentAtMs > this.staleTtlMs) { this.drops++; return false; }
    this.lastSeq = frame.seq; this.lastSentAtMs = frame.telemetry.sentAtMs; return true;
  }
  stale(nowMs = Date.now()) { return this.lastSentAtMs < 0 || nowMs - this.lastSentAtMs > this.staleTtlMs; }
}

export function xyzToRig(point, origin = { x: 0, y: 0, z: 0 }) {
  return { x: -(point.x - origin.x), y: point.y - origin.y, z: -(point.z - origin.z) };
}

export function frameToPlayerInput(frame, cfg) {
  const joints = frame?.xyz;
  if (!joints || !REQUIRED_JOINTS.every((name) => finitePoint(joints[name]))) return null;
  const middle = { x: (joints.shoulderL.x + joints.shoulderR.x) / 2, y: (joints.shoulderL.y + joints.shoulderR.y) / 2,
    z: (joints.shoulderL.z + joints.shoulderR.z) / 2 };
  const rig = (point) => xyzToRig(point, middle);
  const shoulderWidth = Math.hypot(joints.shoulderL.x - joints.shoulderR.x, joints.shoulderL.z - joints.shoulderR.z) || cfg.shoulderWidthM;
  const head = rig(joints.nose);
  const output = { head: { x: head.x / shoulderWidth, y: -head.y / shoulderWidth }, root: { x: 0 },
    stepMeters: (cfg.trackerBaseDistance ?? 2) + middle.z,
    yaw: Math.atan2(rig(joints.shoulderR).z - rig(joints.shoulderL).z, rig(joints.shoulderR).x - rig(joints.shoulderL).x), arms: {} };
  for (const [side, wristName] of [["left", "wristL"], ["right", "wristR"]]) {
    if (!finitePoint(joints[wristName])) { output.arms[side] = null; continue; }
    const target = rig(joints[wristName]);
    output.arms[side] = { elbow: { x: 0, y: 0 }, wrist: { x: 0, y: 0 }, target,
      reach: Math.max(0, Math.min(1, -target.z / (cfg.forwardMeters || 0.62))) };
  }
  return output;
}

class BaseSource {
  constructor() { this._cbs = new Set(); this.label = ""; this.error = ""; this.last = null; }
  onFrame(callback) { this._cbs.add(callback); return () => this._cbs.delete(callback); }
  _emit(frame) { this.last = frame; for (const callback of this._cbs) { try { callback(frame); } catch {} } }
}

export class LocalMediaPipeSource extends BaseSource {
  constructor(pose) { super(); this.pose = pose; this.label = "Web カメラ"; }
  async start(video, opts) { const ok = await this.pose.start(video, opts); this.error = this.pose.error; return ok; }
  poll(nowMs) {
    const result = this.pose.detect(nowMs);
    const frame = { t: Date.now(), seq: Math.floor(nowMs), source: "local", landmarks: result?.landmarks ?? null,
      worldLandmarks: result?.worldLandmarks ?? null, hands: this.pose.detectHands(nowMs), xyz: null, telemetry: null };
    this._emit(frame); return frame;
  }
  stop() { this.pose.stop(); }
}

export class WebSocketTrackerSource extends BaseSource {
  constructor(url = "ws://localhost:8770", { onLost, staleTtlMs = 750 } = {}) {
    super(); this.url = url; this.onLost = onLost; this.label = "OAK-D Lite"; this.staleTtlMs = staleTtlMs;
    this.ws = null; this.generation = 0; this.gate = new ExternalFrameGate({ staleTtlMs }); this._lost = false;
  }
  start(_video, { timeoutMs = 10_000 } = {}) {
    const generation = ++this.generation; this._lost = false; this.gate = new ExternalFrameGate({ staleTtlMs: this.staleTtlMs });
    return new Promise((resolve) => {
      let settled = false, timer = null;
      const clear = () => { clearTimeout(timer); this._timer = null; clearInterval(this._watchdog); this._watchdog = null; };
      const done = (ok) => {
        if (!settled) { settled = true; clearTimeout(timer); this._timer = null; if (this._settle === done) this._settle = null; resolve(ok); }
      };
      this._settle = done;
      const lose = (reason) => {
        if (generation !== this.generation || this._lost) return;
        this._lost = true; this.error = reason; clear();
        const socket = this.ws; this.ws = null;
        try { socket?.close(); } catch {}
        if (settled) this.onLost?.(reason); else done(false);
      };
      try { this.ws = new WebSocket(this.url); } catch (error) { this.error = String(error?.message ?? error); done(false); return; }
      timer = setTimeout(() => { try { this.ws?.close(); } catch {} lose("接続タイムアウト"); }, timeoutMs);
      this._timer = timer;
      this.ws.onopen = () => { /* A TCP/WS open is not an external tracker frame. */ };
      this.ws.onerror = () => { if (generation === this.generation) lose("接続できません"); };
      this.ws.onclose = () => lose("接続が切れました");
      this.ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        const frame = parseTrackerMessage(event.data);
        if (!frame || !this.gate.accept(frame)) return;
        this._emit(frame);
        if (!settled) {
          done(true);
          this._watchdog = setInterval(() => {
            if (generation === this.generation && this.gate.stale()) lose("フレームタイムアウト");
          }, Math.min(250, this.staleTtlMs));
        }
      };
    });
  }
  poll() { return this.last; }
  stop() { this._settle?.(false); ++this.generation; clearTimeout(this._timer); clearInterval(this._watchdog); this._watchdog = null; const socket = this.ws; this.ws = null; try { socket?.close(); } catch {} }
}

/** Switches actual camera ownership on loss, and retries external input without stale socket events. */
export class TrackerSourceController extends BaseSource {
  constructor({ pose, video, url, startOpts = {}, onStatus, reconnectMs = 1500 }) {
    super(); Object.assign(this, { pose, video, url, startOpts, onStatus, reconnectMs, active: null, stopped: false }); this.label = "入力を準備中";
  }
  async start() { return this._tryExternalOrLocal(); }
  async _tryExternalOrLocal() {
    if (this.stopped) return false;
    const external = new WebSocketTrackerSource(this.url, { onLost: (reason) => this._fallback(reason) });
    if (await external.start(this.video) && !this.stopped) { this._activate(external); return true; }
    external.stop();
    if (this.stopped) return false;
    return this._startLocal(external.error);
  }
  _activate(source) {
    if (this.stopped) { source.stop(); return; }
    if (this.active && this.active !== source) this.active.stop();
    this.active = source; this.label = source.label; this.error = source.error;
    source.onFrame((frame) => this._emit(frame)); this.onStatus?.({ mode: source instanceof WebSocketTrackerSource ? "external" : "local", reason: source.error });
  }
  async _startLocal(reason = "") {
    const local = new LocalMediaPipeSource(this.pose);
    const ok = await local.start(this.video, this.startOpts);
    if (this.stopped) { local.stop(); return false; }
    if (ok) { this._activate(local); this.error = reason; this._scheduleReconnect(); }
    else { this.error = local.error || reason; this._scheduleReconnect(); }
    return ok || !this.stopped;
  }
  async _fallback(reason) {
    if (this.stopped || !(this.active instanceof WebSocketTrackerSource)) return;
    this.active.stop();
    this.active = null;
    await this._startLocal(reason);
  }
  _scheduleReconnect() {
    clearTimeout(this._reconnect);
    this._reconnect = setTimeout(async () => {
      if (this.stopped || (this.active && !(this.active instanceof LocalMediaPipeSource))) return;
      const external = new WebSocketTrackerSource(this.url, { onLost: (reason) => this._fallback(reason) });
      if (await external.start(this.video) && !this.stopped) this._activate(external);
      else { external.stop(); if (!this.stopped) this._scheduleReconnect(); }
    }, this.reconnectMs);
  }
  poll(nowMs) { return this.active?.poll(nowMs) ?? null; }
  stop() { this.stopped = true; clearTimeout(this._reconnect); this.active?.stop(); }
}

export async function createTrackerSource(options) {
  const source = new TrackerSourceController(options);
  return { source, ok: await source.start() };
}
