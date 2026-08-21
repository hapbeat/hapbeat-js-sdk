/**
 * tracker-source.js — 姿勢トラッキングの入力層。
 *
 * ゲーム側は「どこから姿勢が来るか」を知らなくてよい。実装は 2 つ:
 *   LocalMediaPipeSource   … 現行の Web カメラ + MediaPipe（2D のみ。奥行きは推定）
 *   WebSocketTrackerSource … 外部トラッカー（深度カメラ）。**本物の 3D (m)** が来る
 *
 * 起動時に WS へ繋がればそちらを使い、失敗・切断したら Web カメラへ自動フォールバックする。
 * フレーム形式とプロトコルは ./tracker/PROTOCOL.md を参照。
 *
 * 統一フレーム:
 *   { t, source: "local"|"depth",
 *     landmarks, worldLandmarks, hands,   // MediaPipe 互換（2D 経路がそのまま使える）
 *     xyz }                               // { nose:{x,y,z}, shoulderL:..., ... } メートル / 深度時のみ
 */

import { LM } from "./pose.js";

/** xyz が来る関節名 → pose ランドマーク index。 */
export const XYZ_JOINTS = {
  nose: LM.nose,
  shoulderL: LM.shoulderL, shoulderR: LM.shoulderR,
  elbowL: LM.elbowL, elbowR: LM.elbowR,
  wristL: LM.wristL, wristR: LM.wristR,
  hipL: LM.hipL, hipR: LM.hipR,
};

/**
 * 外部トラッカーの 1 行 JSON → 統一フレーム。**純関数**（node でテストできる）。
 * 壊れた入力では null を返す（接続は切らない）。
 * @param {string|object} msg
 * @returns {{t:number, source:string, landmarks:Array, worldLandmarks:null, hands:Array|null, xyz:object}|null}
 */
export function parseTrackerMessage(msg) {
  let obj = msg;
  if (typeof msg === "string") {
    try { obj = JSON.parse(msg); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || !obj.joints) return null;
  // MediaPipe 互換の 33 点配列を作る（2D 経路をそのまま動かせるように）
  const landmarks = new Array(33).fill(null).map(() => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const xyz = {};
  for (const [name, idx] of Object.entries(XYZ_JOINTS)) {
    const j = obj.joints[name];
    if (!j) continue;
    if (j.px) {
      landmarks[idx] = { x: j.px.x, y: j.px.y, z: j.px.z ?? 0, visibility: j.px.visibility ?? 1 };
    }
    if (j.xyz && Number.isFinite(j.xyz.z)) xyz[name] = { x: j.xyz.x, y: j.xyz.y, z: j.xyz.z };
  }
  const hands = Array.isArray(obj.hands)
    ? obj.hands.filter((h) => Array.isArray(h?.landmarks)).map((h) => ({ landmarks: h.landmarks, handedness: h.handedness ?? "" }))
    : null;
  return {
    t: Number.isFinite(obj.t) ? obj.t : Date.now(),
    source: Object.keys(xyz).length ? "depth" : "local",
    landmarks, worldLandmarks: null, hands,
    xyz: Object.keys(xyz).length ? xyz : null,
  };
}

/**
 * カメラ座標（+X 右 / +Y 上 / −Z 奥 = カメラ前方）→ ゲームのリグ座標
 * （+X 画面右 = プレイヤーの右 / +Y 上 / −Z 敵の方向）。
 *
 * プレイヤーはカメラと向かい合っているので **左右は反転**し（カメラから見て左に写る手が
 * プレイヤーの右手）、**カメラに近づく = 敵の方へ進む** ので z も反転する。
 * diag(-1, +1, -1) は行列式 +1 の回転なので鏡像にはならない。
 * @param {{x,y,z}} p カメラ座標 [m]
 * @param {{x,y,z}} origin 原点に置きたい点（通常は肩中点や胴の中心）
 */
export function xyzToRig(p, origin = { x: 0, y: 0, z: 0 }) {
  return { x: -(p.x - origin.x), y: p.y - origin.y, z: -(p.z - origin.z) };
}

/**
 * 深度トラッカーのフレーム → buildPlayerPose に渡す入力。**純関数**。
 * xyz があるときは前方リーチの推定を捨てて、**実測の 3D 手首位置**をそのまま目標にする。
 * @returns {{head:{x,y}, root:{x}, stepMeters:number, yaw:number, arms:object}|null}
 */
export function frameToPlayerInput(frame, cfg) {
  const j = frame?.xyz;
  if (!j || !j.shoulderL || !j.shoulderR || !j.nose) return null;
  const mid = {
    x: (j.shoulderL.x + j.shoulderR.x) / 2,
    y: (j.shoulderL.y + j.shoulderR.y) / 2,
    z: (j.shoulderL.z + j.shoulderR.z) / 2,
  };
  const rig = (p) => xyzToRig(p, mid);
  const shoulderWidth = Math.hypot(j.shoulderL.x - j.shoulderR.x, j.shoulderL.z - j.shoulderR.z) || cfg.shoulderWidthM;
  const head = rig(j.nose);
  const out = {
    // head は「体に対する頭の位置」（肩幅で正規化した体基準の量に戻す）
    head: { x: head.x / shoulderWidth, y: -head.y / shoulderWidth },
    root: { x: 0 },
    // 前後は実測。基準距離より近づいた分だけ前へ出る。
    stepMeters: (cfg.trackerBaseDistance ?? 2.0) + mid.z,
    yaw: Math.atan2(rig(j.shoulderR).z - rig(j.shoulderL).z, rig(j.shoulderR).x - rig(j.shoulderL).x),
    arms: {},
  };
  for (const [side, w] of [["left", "wristL"], ["right", "wristR"]]) {
    const wrist = j[w];
    if (!wrist) { out.arms[side] = null; continue; }
    const t = rig(wrist);
    // reach は表示・デバッグ用（実際の手首位置は target で直接渡す）
    const reach = Math.max(0, Math.min(1, -t.z / (cfg.forwardMeters || 0.62)));
    out.arms[side] = { elbow: { x: 0, y: 0 }, wrist: { x: 0, y: 0 }, reach, target: t };
  }
  return out;
}

/** 共通インターフェース: start() / stop() / onFrame(cb) / label。 */
class BaseSource {
  constructor() { this._cbs = new Set(); this.label = ""; this.error = ""; }
  onFrame(cb) { this._cbs.add(cb); return () => this._cbs.delete(cb); }
  _emit(frame) { for (const cb of this._cbs) { try { cb(frame); } catch { /* 1 つの購読者の失敗で止めない */ } } }
}

/** 現行の Web カメラ + MediaPipe を包む（奥行きは 2D からの推定のまま）。 */
export class LocalMediaPipeSource extends BaseSource {
  /** @param {import("./pose.js").PoseTracker} pose */
  constructor(pose) { super(); this.pose = pose; this.label = "Web カメラ"; }
  async start(video, opts) {
    const ok = await this.pose.start(video, opts);
    this.error = this.pose.error;
    return ok;
  }
  /** ゲームのループから毎フレーム呼ぶ（pull 型。push も onFrame で受けられる）。 */
  poll(nowMs) {
    const frame = {
      t: nowMs, source: "local",
      landmarks: this.pose.detect(nowMs)?.landmarks ?? null,
      worldLandmarks: this.pose._last?.worldLandmarks ?? null,
      hands: this.pose.detectHands(nowMs),
      xyz: null,
    };
    this._emit(frame);
    return frame;
  }
  stop() { this.pose.stop(); }
}

/**
 * 外部トラッカー（深度カメラ）。1 行 1 JSON の WebSocket。
 * 接続できない / 切れた場合は `onLost` を呼ぶ（呼び出し側が Web カメラへ切り替える）。
 */
export class WebSocketTrackerSource extends BaseSource {
  constructor(url = "ws://localhost:8770", { onLost } = {}) {
    super();
    this.url = url;
    this.onLost = onLost;
    this.label = "深度トラッカー";
    this.last = null;
    this.ws = null;
  }
  /** @param {number} timeoutMs 接続を諦めるまで */
  start(_video, { timeoutMs = 1200 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try { this.ws = new WebSocket(this.url); } catch (e) { this.error = String(e?.message ?? e); return done(false); }
      const timer = setTimeout(() => { this.error = "接続タイムアウト"; try { this.ws.close(); } catch { /* noop */ } done(false); }, timeoutMs);
      this.ws.onopen = () => { clearTimeout(timer); done(true); };
      this.ws.onerror = () => { clearTimeout(timer); this.error = "接続できません"; done(false); };
      this.ws.onclose = () => { if (settled) this.onLost?.(); else { clearTimeout(timer); done(false); } };
      this.ws.onmessage = (ev) => {
        const frame = parseTrackerMessage(ev.data);
        if (frame) { this.last = frame; this._emit(frame); }
      };
    });
  }
  /** push 型なので、poll は直近フレームを返すだけ。 */
  poll() { return this.last; }
  stop() { try { this.ws?.close(); } catch { /* noop */ } }
}

/**
 * 外部トラッカーを試し、駄目なら Web カメラにフォールバックする。
 * @returns {Promise<{source:BaseSource, ok:boolean}>}
 */
export async function createTrackerSource({ pose, video, url, startOpts, onLost }) {
  const ws = new WebSocketTrackerSource(url, { onLost });
  if (await ws.start(video, {})) return { source: ws, ok: true };
  const local = new LocalMediaPipeSource(pose);
  const ok = await local.start(video, startOpts);
  return { source: local, ok };
}
