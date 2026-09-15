import { parsePoseInputFrame, poseInputFromMediaPipe } from "./pose-input.js";
import { GestureTracker } from "./gestures.js";
import { TUNING } from "./tuning.js";

export const shouldContinueTrackerStartup = (sourceMode, ok) => ok || sourceMode === "oak";
export const getStartFightState = ({ trackerActive = false, poseReady = false, sourceMode = "auto" } = {}) => {
  const canStart = Boolean(trackerActive || poseReady);
  const label = sourceMode === "oak" ? "OAK-D Lite" : sourceMode === "webcam" ? "Web camera" : sourceMode === "mock" ? "Mock" : "カメラ";
  return { canStart, reason: canStart ? "" : `${label}入力待機中/接続エラー` };
};
export const parseTrackerMessage = (message) => parsePoseInputFrame(message);

export class ExternalFrameGate {
  constructor({ staleTtlMs = 750 } = {}) { this.staleTtlMs = staleTtlMs; this.lastSeq = -1; this.lastCapturedAtMs = -1; this.drops = 0; }
  accept(frame, nowMs = Date.now()) {
    if (!frame || frame.seq <= this.lastSeq || frame.capturedAtMs <= this.lastCapturedAtMs || nowMs - frame.capturedAtMs > this.staleTtlMs) { this.drops++; return false; }
    this.lastSeq = frame.seq; this.lastCapturedAtMs = frame.capturedAtMs; return true;
  }
  stale(nowMs = Date.now()) { return this.lastCapturedAtMs < 0 || nowMs - this.lastCapturedAtMs > this.staleTtlMs; }
}

const lerpPoint = (a, b, t) => a && b ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  depthM: Number.isFinite(a.depthM) && Number.isFinite(b.depthM) ? a.depthM + (b.depthM - a.depthM) * t : null,
  confidence: a.confidence + (b.confidence - a.confidence) * t,
  ...(Number.isFinite(a.forward) && Number.isFinite(b.forward) ? { forward: a.forward + (b.forward - a.forward) * t } : {}) } : (t < .5 ? a : b);

/** Rendering interpolation changes points only: sequence and diagnostics always remain raw/integer. */
export class TrackerFrameBuffer {
  constructor({ delayMs = 50, holdMs = 100, capacity = 4 } = {}) { Object.assign(this, { delayMs, holdMs, capacity, samples: [] }); }
  push(frame, captureMs = frame?.capturedAtMs) {
    const previous = this.samples.at(-1);
    if (!frame || !Number.isFinite(captureMs) || previous && (frame.seq <= previous.seq || captureMs <= previous.captureMs)) return false;
    this.samples.push({ ...frame, captureMs }); if (this.samples.length > this.capacity) this.samples.shift(); return true;
  }
  sample(nowMs) {
    const latest = this.samples.at(-1);
    if (!latest) return { freshness: "lost", ageMs: Infinity, points: null };
    const ageMs = Math.max(0, nowMs - latest.captureMs);
    if (ageMs > this.holdMs) return { freshness: "lost", ageMs, points: null };
    const target = nowMs - this.delayMs;
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1], b = this.samples[i];
      if (a.captureMs < target && target < b.captureMs) {
        const t = (target - a.captureMs) / (b.captureMs - a.captureMs);
        return { ...b, points: Object.fromEntries(Object.keys(b.points).map((name) => [name, lerpPoint(a.points[name], b.points[name], t)])), captureMs: target, freshness: "interpolated", ageMs };
      }
    }
    return { ...latest, freshness: ageMs === 0 ? "fresh" : "hold", ageMs };
  }
}

class BaseSource {
  constructor(options = {}) { this._cbs = new Set(); this._fresh = null; this.last = null; this.clock = options.clock ?? (() => performance.now()); this.buffer = new TrackerFrameBuffer(options); this.error = ""; this.label = ""; }
  onFrame(callback) { this._cbs.add(callback); return () => this._cbs.delete(callback); }
  _pushFresh(frame, captureMs = frame?.capturedAtMs ?? this.clock()) { if (!this.buffer.push(frame, captureMs)) return false; this.last = { ...frame, captureMs }; this._fresh = this.last; for (const callback of this._cbs) callback(this.last); return true; }
  consumeFresh() { const frame = this._fresh; this._fresh = null; return frame; }
  poll(nowMs = this.clock()) { return this.buffer.sample(nowMs); }
}

export class LocalMediaPipeSource extends BaseSource {
  constructor(pose, options) { super(options); this.pose = pose; this.kind = "local"; this.label = "Web カメラ"; this.seq = 0; this.gestures = new GestureTracker(TUNING); this.lastGestureMs = null; }
  async start(video, opts) { const ok = await this.pose.start(video, opts); this.error = this.pose.error; return ok; }
  recalibrate() { this.gestures.recalibrate(); this.lastGestureMs = null; }
  poll(nowMs) { const result = this.pose.detect(nowMs); if (this.pose.lastWasFresh) { const hands = this.pose.detectHands(nowMs); const frame = poseInputFromMediaPipe(result?.landmarks, { seq: ++this.seq, capturedAtMs: Date.now() }); const aspect = this.pose.video?.videoWidth / Math.max(1, this.pose.video?.videoHeight) || 16 / 9; const dt = this.lastGestureMs == null ? 1 / 30 : Math.max(.001, Math.min(.1, (nowMs - this.lastGestureMs) / 1000)); this.lastGestureMs = nowMs; const g = this.gestures.update(result, nowMs, dt, { aspect, calibrating: false, hands }); if (frame) { for (const [name, side] of [["leftHand", "left"], ["rightHand", "right"]]) if (frame.points[name]) frame.points[name].forward = g.frame?.arms?.[side]?.reach ?? 0; this._pushFresh(frame, nowMs); } } return super.poll(nowMs); }
  stop() { this.pose.stop(); }
}

export class WebSocketTrackerSource extends BaseSource {
  constructor(url = "ws://localhost:8770", { onLost, staleTtlMs = 750, timeoutMs = 10000, ...options } = {}) {
    // OAK already has camera and pose-inference latency.  Rendering it 50 ms in
    // the past only makes an intermittent stream feel less responsive.
    super({ delayMs: 0, ...options });
    Object.assign(this, { url, onLost, staleTtlMs, timeoutMs, kind: "oak", label: "OAK-D Lite", ws: null, generation: 0, gate: new ExternalFrameGate({ staleTtlMs }) });
  }
  start() { const generation = ++this.generation; this.gate = new ExternalFrameGate({ staleTtlMs: this.staleTtlMs }); return new Promise((resolve) => { let settled = false, lostNotified = false; const done = (ok) => { if (!settled) { settled = true; clearTimeout(this._startTimer); resolve(ok); } }; const lost = (reason) => { if (generation !== this.generation || lostNotified) return; lostNotified = true; this.error = reason; clearTimeout(this._startTimer); clearInterval(this._watchdog); if (settled) this.onLost?.(reason); else done(false); }; try { this.ws = new WebSocket(this.url); } catch { lost("接続できません"); return; } this._startTimer = setTimeout(() => lost("有効フレーム待機タイムアウト"), this.timeoutMs); this.ws.onerror = () => lost("接続できません"); this.ws.onclose = () => lost("接続が切れました"); this.ws.onmessage = ({ data }) => { if (generation !== this.generation) return; const frame = parseTrackerMessage(data); if (!frame || !this.gate.accept(frame)) return; const transportAgeMs = Date.now() - frame.capturedAtMs; frame.diagnostics = { ...frame.diagnostics, transportAgeMs: Number.isFinite(transportAgeMs) ? Math.max(0, transportAgeMs) : null }; this._pushFresh(frame, this.clock()); if (!settled) { done(true); this._watchdog = setInterval(() => { if (this.gate.stale()) lost("フレーム停止"); }, Math.min(250, this.staleTtlMs)); } }; }); }
  stop() { ++this.generation; clearTimeout(this._startTimer); clearInterval(this._watchdog); try { this.ws?.close(); } catch {} this.ws = null; }
}

export class TrackerSourceController extends BaseSource {
  constructor({ pose, video, url, startOpts = {}, sourceMode = "auto", deviceId = "", onStatus, externalFactory, localFactory, retryDelayMs = 1500, ...options }) { super(options); Object.assign(this, { pose, video, url, startOpts, sourceMode, deviceId, onStatus, externalFactory: externalFactory ?? ((onLost) => new WebSocketTrackerSource(url, { onLost })), localFactory: localFactory ?? (() => new LocalMediaPipeSource(pose)), retryDelayMs, active: null, generation: 0, activationTicket: 0, stopped: true, externalFlight: null, localFlight: null, fallbackFlight: null }); }
  async start() {
    const token = ++this.generation; this.stopped = false;
    if (this.sourceMode === "oak") return this._external(token, true);
    if (this.sourceMode === "webcam" || this.sourceMode === "mock") return this._local(token);
    if (await this._external(token)) return true;
    return this._fallback(token);
  }
  async _external(token = this.generation, retry = false) {
    if (this.stopped || token !== this.generation) return false;
    if (this.externalFlight) return this.externalFlight;
    const ticket = ++this.activationTicket;
    const source = this.externalFactory((reason) => {
      if (this.stopped || token !== this.generation) return;
      this.onStatus?.({ mode: "external", lost: true, reason });
      if (this.sourceMode === "auto") this._fallback(token);
      else if (this.sourceMode === "oak") this._scheduleExternal(token);
    });
    const flight = (async () => {
      const ok = await source.start();
      if (!ok) { source.stop(); if (retry && !this.stopped && token === this.generation) this._scheduleExternal(token); return false; }
      return this._activate(source, token, ticket);
    })();
    this.externalFlight = flight;
    try { return await flight; } finally { if (this.externalFlight === flight) this.externalFlight = null; }
  }
  async _local(token = this.generation) {
    if (this.stopped || token !== this.generation) return false;
    if (this.localFlight) return this.localFlight;
    const ticket = ++this.activationTicket;
    const source = this.localFactory();
    const flight = (async () => {
      const ok = await source.start(this.video, { ...this.startOpts, deviceId: this.deviceId || undefined, mock: this.sourceMode === "mock" });
      if (!ok) { source.stop(); return false; }
      return this._activate(source, token, ticket);
    })();
    this.localFlight = flight;
    try { return await flight; } finally { if (this.localFlight === flight) this.localFlight = null; }
  }
  _activate(source, token = this.generation, ticket = this.activationTicket) {
    if (this.stopped || token !== this.generation || ticket !== this.activationTicket) { source.stop(); return false; }
    this.active?.stop(); this.active = source; this.kind = source.kind; this.label = source.label;
    source.onFrame((frame) => this._pushFresh(frame, frame.captureMs)); this.onStatus?.({ mode: source.kind === "oak" ? "external" : "local" }); return true;
  }
  async _fallback(token = this.generation) {
    if (this.stopped || token !== this.generation) return false;
    if (this.fallbackFlight) return this.fallbackFlight;
    const flight = (async () => { const ok = await this._local(token); if (!this.stopped && token === this.generation) this._scheduleExternal(token); return ok; })();
    this.fallbackFlight = flight;
    try { return await flight; } finally { if (this.fallbackFlight === flight) this.fallbackFlight = null; }
  }
  _scheduleExternal(token = this.generation) { if (this.sourceMode === "webcam" || this.sourceMode === "mock" || this.stopped || token !== this.generation) return; clearTimeout(this._retry); this._retry = setTimeout(() => this._external(token, true), this.retryDelayMs); }
  poll(nowMs) { return this.active?.poll(nowMs) ?? { freshness: "lost", ageMs: Infinity, points: null }; }
  consumeFresh() { return this.active?.consumeFresh() ?? null; }
  recalibrate() { this.active?.recalibrate?.(); }
  stop() { ++this.generation; ++this.activationTicket; this.stopped = true; clearTimeout(this._retry); this.active?.stop(); this.active = null; }
}

export async function createTrackerSource(options) { const source = new TrackerSourceController(options); return { source, ok: await source.start() }; }
export class LatestTrackerStart { constructor() { this.generation = 0; } begin() { return ++this.generation; } activate(token, picked, activate) { if (token !== this.generation) { picked.source.stop(); return false; } activate(picked); return true; } }
