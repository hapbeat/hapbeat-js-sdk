/** PoseInput v3 is the only seam between camera adapters and the boxing game. */
export const POSE_INPUT_VERSION = 3;
export const POINT_NAMES = ["head", "torso", "leftHand", "rightHand", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow"];
const DEPTH_POINT_NAMES = new Set(["head", "torso", "leftHand", "rightHand"]);
const FORWARD_POINT_NAMES = new Set(["leftHand", "rightHand"]);
const finite = (n) => Number.isFinite(n);
const point = (name, value) => value && finite(value.x) && finite(value.y)
  && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1
  ? { x: value.x, y: value.y,
    confidence: finite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : 1,
    ...(DEPTH_POINT_NAMES.has(name) ? { depthM: finite(value.depthM) && value.depthM > 0 ? value.depthM : null } : {}),
    ...(FORWARD_POINT_NAMES.has(name) && finite(value.forward) ? { forward: clamp(value.forward, 0, 1) } : {}) } : null;

export function createPoseInputFrame({ seq, capturedAtMs, points, preview, diagnostics } = {}) {
  if (!Number.isSafeInteger(seq) || seq < 0 || !finite(capturedAtMs) || !points || typeof points !== "object") return null;
  const normalized = {};
  for (const name of POINT_NAMES) {
    if (!Object.hasOwn(points, name)) return null;
    const value = points[name];
    const normalizedPoint = value == null ? null : point(name, value);
    if (value != null && !normalizedPoint && (name === "head" || name === "torso")) return null;
    normalized[name] = normalizedPoint;
  }
  return { v: POSE_INPUT_VERSION, seq, capturedAtMs, points: normalized,
    ...(typeof preview === "string" ? { preview } : {}),
    ...(diagnostics && typeof diagnostics === "object" ? { diagnostics } : {}) };
}

/** MediaPipe stays inside this adapter: callers only receive semantic game points. */
export function poseInputFromMediaPipe(landmarks, { seq, capturedAtMs } = {}) {
  const lm = (index) => landmarks?.[index];
  const mean = (values) => {
    const usable = values.filter((v) => v && finite(v.x) && finite(v.y)
      && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1);
    if (!usable.length) return null;
    return { x: 1 - usable.reduce((n, v) => n + v.x, 0) / usable.length,
      y: usable.reduce((n, v) => n + v.y, 0) / usable.length,
      confidence: usable.reduce((n, v) => n + (finite(v.visibility) ? v.visibility : 1), 0) / usable.length };
  };
  const handCenter = (poseIndices) => mean(poseIndices.map(lm));
  return createPoseInputFrame({ seq, capturedAtMs, points: {
    head: mean([lm(0), lm(2), lm(5), lm(7), lm(8)]), torso: mean([lm(11), lm(12), lm(23), lm(24)]),
    leftHand: handCenter([15, 17, 19, 21]), rightHand: handCenter([16, 18, 20, 22]),
    leftShoulder: mean([lm(11)]), rightShoulder: mean([lm(12)]),
    leftElbow: mean([lm(13)]), rightElbow: mean([lm(14)]),
  } });
}

export function parsePoseInputFrame(message) {
  let raw = message;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return null; } }
  if (!raw || raw.v !== POSE_INPUT_VERSION) return null;
  return createPoseInputFrame(raw);
}

const copyJoint = (joint) => joint ? { x: joint.x, y: joint.y } : null;
const copyArmInput = (arm) => arm ? {
  shoulder: copyJoint(arm.shoulder), elbow: copyJoint(arm.elbow), wrist: copyJoint(arm.wrist),
  reach: arm.reach, swingActive: !!arm.swingActive, depthLost: !!arm.depthLost,
} : null;
const copyPlayerInput = (input) => input ? {
  head: copyJoint(input.head), root: { x: input.root?.x ?? 0 }, stepMeters: input.stepMeters ?? 0, yaw: input.yaw ?? 0,
  arms: { left: copyArmInput(input.arms?.left), right: copyArmInput(input.arms?.right) },
} : null;

/**
 * Render-only adaptive low-pass filter. It is fed on every animation frame, so
 * a 15 fps tracker stream moves continuously at display refresh rate without
 * placing a fixed queue delay in front of game input.
 */
export class PlayerInputSmoother {
  constructor({ minHz = 5, maxHz = 12, motionGainHz = .65 } = {}) {
    this.minHz = minHz; this.maxHz = Math.max(minHz, maxHz); this.motionGainHz = motionGainHz;
    this.reset();
  }
  reset() { this.current = null; this.lastMs = null; }
  _alpha(distance, dt) {
    const speed = distance / Math.max(.001, dt);
    const hz = Math.min(this.maxHz, this.minHz + speed * this.motionGainHz);
    return 1 - Math.exp(-2 * Math.PI * hz * dt);
  }
  _number(current, target, dt) { return current + (target - current) * this._alpha(Math.abs(target - current), dt); }
  _joint(current, target, dt) {
    const alpha = this._alpha(Math.hypot(target.x - current.x, target.y - current.y), dt);
    return { x: current.x + (target.x - current.x) * alpha, y: current.y + (target.y - current.y) * alpha };
  }
  _arm(current, target, dt) {
    if (!target) return null;
    if (!current) return copyArmInput(target);
    return {
      shoulder: this._joint(current.shoulder, target.shoulder, dt),
      elbow: this._joint(current.elbow, target.elbow, dt),
      wrist: this._joint(current.wrist, target.wrist, dt),
      reach: this._number(current.reach, target.reach, dt),
      // Collision and gesture recognition use raw input; these are visual metadata.
      swingActive: !!target.swingActive, depthLost: !!target.depthLost,
    };
  }
  sample(input, nowMs = performance.now()) {
    if (!input) { this.reset(); return null; }
    if (!this.current || !finite(nowMs) || this.lastMs == null) {
      this.current = copyPlayerInput(input); this.lastMs = nowMs; return copyPlayerInput(this.current);
    }
    const dt = Math.max(.001, Math.min(.1, (nowMs - this.lastMs) / 1000));
    const current = this.current;
    this.current = {
      head: this._joint(current.head, input.head, dt),
      root: { x: this._number(current.root.x, input.root.x, dt) },
      stepMeters: this._number(current.stepMeters, input.stepMeters, dt),
      yaw: this._number(current.yaw, input.yaw, dt),
      arms: { left: this._arm(current.arms.left, input.arms.left, dt), right: this._arm(current.arms.right, input.arms.right, dt) },
    };
    this.lastMs = nowMs;
    return copyPlayerInput(this.current);
  }
}

export class PoseInputCalibration {
  constructor() { this.reset(); }
  reset() { this.startedAtMs = null; this.ready = false; this.samples = []; this.base = null; this.lastPoints = {}; this.lastDepth = {}; }
  observe(frame, { calibrating = false } = {}) {
    for (const name of POINT_NAMES) if (frame?.points?.[name]) { this.lastPoints[name] = { point: frame.points[name], capturedAtMs: frame.capturedAtMs }; if (DEPTH_POINT_NAMES.has(name) && finite(frame.points[name].depthM)) this.lastDepth[name] = { depthM: frame.points[name].depthM, capturedAtMs: frame.capturedAtMs }; }
    if (!calibrating || !POINT_NAMES.every((name) => frame?.points?.[name])) return;
    this.startedAtMs ??= frame.capturedAtMs;
    this.samples.push({ capturedAtMs: frame.capturedAtMs, points: frame.points });
    if (this.samples.length > 120) this.samples.shift();
    if (frame.capturedAtMs - this.startedAtMs < 1500) return;
    const average = (name, key) => { const values = this.samples.map((f) => f.points[name]?.[key]).filter(finite); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
    this.base = Object.fromEntries(POINT_NAMES.map((name) => [name, {
      x: average(name, "x"), y: average(name, "y"),
      ...(DEPTH_POINT_NAMES.has(name) ? { depthM: average(name, "depthM") } : {}),
    }]));
    this.base.torsoDepthM = average("torso", "depthM");
    this.ready = true;
    this.samples = [];
  }
  get progress() { return this.startedAtMs == null ? 0 : this.ready ? 1 : Math.min(1, (this.samples.at(-1)?.capturedAtMs - this.startedAtMs) / 1500); }
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
export function poseInputToPlayerInput(frame, calibration, cfg, previous = null) {
  const p = frame?.points;
  if (!p?.torso || !p.head || !calibration?.base) return null;
  const torsoHeight = Math.max(.08, Math.abs(calibration.base.torso.y - calibration.base.head.y));
  const xy = (value, base) => value ? { x: (value.x - p.torso.x - (base.x - calibration.base.torso.x)) / torsoHeight, y: (value.y - p.torso.y - (base.y - calibration.base.torso.y)) / torsoHeight } : null;
  // 肩・肘・手はそれぞれのキャリブ値を引かない。各腕の肩だけを共通の
  // 体幹基準に固定すれば、体ごとの移動をゼロにしつつ静止時の腕形状を保てる。
  const armXY = (value, side) => {
    const shoulderBase = calibration.base[`${side}Shoulder`];
    return value ? {
      x: (value.x - p.torso.x - (shoulderBase.x - calibration.base.torso.x)) / torsoHeight,
      y: (value.y - p.torso.y - (shoulderBase.y - calibration.base.torso.y)) / torsoHeight,
    } : null;
  };
  const torsoDepth = finite(p.torso.depthM) ? p.torso.depthM : (calibration.lastDepth.torso?.capturedAtMs + 100 >= frame.capturedAtMs ? calibration.lastDepth.torso.depthM : null);
  if (finite(torsoDepth) && !finite(calibration.base.torsoDepthM)) calibration.base.torsoDepthM = torsoDepth;
  const stepMeters = finite(torsoDepth) && finite(calibration.base.torsoDepthM) ? clamp(calibration.base.torsoDepthM - torsoDepth, cfg.stepClamp[0], cfg.stepClamp[1]) : 0;
  const heldPoint = (name) => {
    const held = calibration.lastPoints[name];
    return p[name] ?? (held && frame.capturedAtMs - held.capturedAtMs <= 100 ? held.point : null);
  };
  const arm = (name, side) => {
    const value = heldPoint(name);
    const shoulder = heldPoint(`${side}Shoulder`);
    const elbow = heldPoint(`${side}Elbow`);
    if (!value || !shoulder || !elbow) return null;
    const depthM = finite(value.depthM) ? value.depthM : (calibration.lastDepth[name]?.capturedAtMs + 100 >= frame.capturedAtMs ? calibration.lastDepth[name].depthM : null);
    if (finite(depthM) && !finite(calibration.base[name].depthM)) calibration.base[name].depthM = depthM;
    const relative = finite(depthM) && finite(torsoDepth) && finite(calibration.base[name].depthM)
      ? (calibration.base[name].depthM - depthM) - (calibration.base.torsoDepthM - torsoDepth) : null;
    const reach = relative == null ? (finite(value.forward) ? value.forward : 0) : clamp(relative / (cfg.forwardMeters || .62), 0, 1);
    const wrist = armXY(value, side);
    return { shoulder: armXY(shoulder, side), elbow: armXY(elbow, side), wrist, reach, swingActive: reach > .35, depthLost: relative == null };
  };
  return { head: xy(p.head, calibration.base.head), root: { x: clamp((p.torso.x - calibration.base.torso.x) / torsoHeight, -1, 1) }, stepMeters, yaw: 0, arms: { left: arm("leftHand", "left"), right: arm("rightHand", "right") } };
}
