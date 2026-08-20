/**
 * GestureTracker — ランドマーク列 → ボクシングの操作（パンチ / ガード / リーン / ダック）。
 *
 * 設計メモ
 * - 座標は「ミラー表示の画面座標」に統一する（x を 1-x して持つ）。画面左＝プレイヤーの左。
 * - 縦横比で歪まないよう、位置系はすべて (x*aspect, y) の等方空間で扱い、閾値は肩幅比で持つ。
 *   カメラとの距離が変わっても同じ閾値で効く。
 * - パンチだけは worldLandmarks（メートル）の 3D 速度で見る。画面上の見かけの動きだと
 *   「カメラへ突く」動きがほとんど動かないため。
 * - 閾値は全部 ./tuning.js の TUNING。ここには数値を直書きしない。
 */

import { LM } from "./pose.js";
import { TUNING } from "./tuning.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = 180 / Math.PI;

/** 肘の角度[deg]（shoulder-elbow-wrist）。3D 点（world）でも 2D 点でも同じ式で通る。 */
function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const n1 = Math.hypot(v1.x, v1.y, v1.z);
  const n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  const d = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2);
  return Math.acos(clamp(d, -1, 1)) * DEG;
}

/** 片手ぶんのパンチ検出状態。 */
class HandState {
  constructor() {
    this.v = { x: 0, y: 0, z: 0 }; // EMA 済み手首速度 [m/s]
    this.prev = null;              // 前フレームの world 座標
    this.lastFlexMs = -1e9;        // 直近で肘が曲がっていた時刻
    this.lastPunchMs = -1e9;
    this.speed = 0;
    this.forward = 0;              // カメラ方向（-z）成分 [m/s]
    this.elbowDeg = 180;
  }
}

export class GestureTracker {
  constructor(tuning = TUNING) {
    this.t = tuning;
    this.hands = { left: new HandState(), right: new HandState() };
    this.reset();
  }

  reset() {
    this.base = null;          // { shoulderWidth, noseY, midX }
    this._acc = null;          // キャリブレーション中の積算
    this._calibStartMs = -1;
    this.calibProgress = 0;    // 0..1
    this.lean = 0;             // -1 左 / 0 / +1 右（画面基準＝プレイヤー基準）
    this.duck = false;
    this.block = false;
    this.lostSinceMs = -1;
    for (const h of Object.values(this.hands)) {
      h.prev = null;
      h.v = { x: 0, y: 0, z: 0 };
      h.lastFlexMs = -1e9;
      h.lastPunchMs = -1e9;
    }
  }

  /** 画面（ミラー）座標の等方空間に写した主要点。可視度が低い点は null。 */
  _points(landmarks, aspect) {
    const minV = this.t.minVisibility;
    const get = (i) => {
      const p = landmarks[i];
      if (!p || (p.visibility != null && p.visibility < minV)) return null;
      return { x: (1 - p.x) * aspect, y: p.y, raw: { x: 1 - p.x, y: p.y } };
    };
    return {
      nose: get(LM.nose),
      // ミラー座標に写しても「プレイヤーの左手」は LM.wristL のまま（画面左に映る）。
      shoulderL: get(LM.shoulderL), shoulderR: get(LM.shoulderR),
      elbowL: get(LM.elbowL), elbowR: get(LM.elbowR),
      wristL: get(LM.wristL), wristR: get(LM.wristR),
    };
  }

  /**
   * 1 フレーム更新。
   * @param {{landmarks:Array, worldLandmarks:Array}|null} pose
   * @param {number} nowMs  performance.now()
   * @param {number} dtSec
   * @param {{aspect:number, calibrating?:boolean}} opts
   * @returns {{visible:boolean, calibrated:boolean, punchL:boolean, punchR:boolean,
   *            block:boolean, lean:number, duck:boolean, points:object|null}}
   */
  update(pose, nowMs, dtSec, { aspect = 4 / 3, calibrating = false } = {}) {
    const out = { visible: false, calibrated: !!this.base, punchL: false, punchR: false, block: this.block, lean: this.lean, duck: this.duck, points: null };
    const lms = pose?.landmarks;
    if (!lms) {
      if (this.lostSinceMs < 0) this.lostSinceMs = nowMs;
      // 姿勢を見失っている間は継続系（ガード/リーン/ダック）を解除する。押しっぱなし扱いは危険。
      this.block = false;
      this.lean = 0;
      this.duck = false;
      out.block = false; out.lean = 0; out.duck = false;
      return out;
    }
    const p = this._points(lms, aspect);
    if (!p.shoulderL || !p.shoulderR || !p.nose) {
      if (this.lostSinceMs < 0) this.lostSinceMs = nowMs;
      return out;
    }
    this.lostSinceMs = -1;
    out.visible = true;
    out.points = p;

    const shoulderWidth = Math.hypot(p.shoulderL.x - p.shoulderR.x, p.shoulderL.y - p.shoulderR.y);
    const midX = (p.shoulderL.x + p.shoulderR.x) / 2;
    if (shoulderWidth < 1e-4) return out;

    if (calibrating || !this.base) this._calibrate(shoulderWidth, midX, p.nose.y, nowMs);
    else this._follow(shoulderWidth, midX, p.nose.y, dtSec);
    out.calibrated = !!this.base && this.calibProgress >= 1;
    if (!this.base) return out;

    // ── ガード（両手が顔の前・手首が肘より上） ────────────────────────────────
    const w = this.base.shoulderWidth;
    this.block = this._detectBlock(p, w);
    out.block = this.block;

    // ── リーン / ダック（ヒステリシス付き） ────────────────────────────────────
    const leanOff = (midX - this.base.midX) / w;
    const enter = this.t.lean.enterRatio, exit = this.t.lean.exitRatio;
    if (this.lean === 0) this.lean = leanOff > enter ? 1 : leanOff < -enter ? -1 : 0;
    else if (Math.abs(leanOff) < exit || Math.sign(leanOff) !== this.lean) this.lean = 0;
    out.lean = this.lean;

    const duckOff = (p.nose.y - this.base.noseY) / w;
    this.duck = this.duck ? duckOff > this.t.duck.exitRatio : duckOff > this.t.duck.enterRatio;
    out.duck = this.duck;

    // ── パンチ（world 3D 速度 + 肘の伸展） ────────────────────────────────────
    const world = pose.worldLandmarks;
    if (world) {
      out.punchL = this._detectPunch("left", world, LM.shoulderL, LM.elbowL, LM.wristL, nowMs, dtSec);
      out.punchR = this._detectPunch("right", world, LM.shoulderR, LM.elbowR, LM.wristR, nowMs, dtSec);
    }
    return out;
  }

  _detectBlock(p, shoulderWidth) {
    if (!p.wristL || !p.wristR || !p.elbowL || !p.elbowR || !p.nose) return false;
    const r = this.t.block.faceRadiusRatio * shoulderWidth;
    const near = (wr) => Math.hypot(wr.x - p.nose.x, wr.y - p.nose.y) <= r;
    if (!near(p.wristL) || !near(p.wristR)) return false;
    // y は下向きが正なので「上にある」＝ y が小さい。
    const m = this.t.block.wristAboveElbowRatio * shoulderWidth;
    return p.wristL.y < p.elbowL.y - m && p.wristR.y < p.elbowR.y - m;
  }

  _detectPunch(side, world, si, ei, wi, nowMs, dtSec) {
    const h = this.hands[side];
    const wrist = world[wi], elbow = world[ei], shoulder = world[si];
    if (!wrist || !elbow || !shoulder) { h.prev = null; return false; }

    // 速度（EMA）。dt が飛んだフレームは捨てる（タブ復帰などで巨大な速度が出るため）。
    if (h.prev && dtSec > 0.001 && dtSec < 0.2) {
      const a = this.t.punch.velocityEma;
      const raw = { x: (wrist.x - h.prev.x) / dtSec, y: (wrist.y - h.prev.y) / dtSec, z: (wrist.z - h.prev.z) / dtSec };
      h.v = { x: h.v.x + a * (raw.x - h.v.x), y: h.v.y + a * (raw.y - h.v.y), z: h.v.z + a * (raw.z - h.v.z) };
    }
    h.prev = { x: wrist.x, y: wrist.y, z: wrist.z };
    h.speed = Math.hypot(h.v.x, h.v.y, h.v.z);
    h.forward = -h.v.z; // world z はカメラに近いほど小さい → 突きは -z 方向

    h.elbowDeg = jointAngle(shoulder, elbow, wrist);
    if (h.elbowDeg < this.t.punch.flexAngleDeg) h.lastFlexMs = nowMs;

    if (this.block) return false;                       // ガード中はパンチを取らない
    if (nowMs - h.lastPunchMs < this.t.punch.cooldownMs) return false;

    const fast = h.speed > this.t.punch.speedThreshMps && h.forward > 0 && h.forward / h.speed > this.t.punch.forwardRatio;
    const extended = h.elbowDeg > this.t.punch.extendAngleDeg && nowMs - h.lastFlexMs < this.t.punch.extendWindowMs;
    if (!fast && !extended) return false;
    h.lastPunchMs = nowMs;
    return true;
  }

  _calibrate(shoulderWidth, midX, noseY, nowMs) {
    if (this._calibStartMs < 0) { this._calibStartMs = nowMs; this._acc = { sw: 0, mx: 0, ny: 0, n: 0 }; }
    this._acc.sw += shoulderWidth; this._acc.mx += midX; this._acc.ny += noseY; this._acc.n++;
    this.calibProgress = clamp((nowMs - this._calibStartMs) / this.t.calibrationMs, 0, 1);
    const n = this._acc.n;
    // 進行中でも暫定基準を入れておく（HUD のアイコンが即動くほうが構えを直しやすい）。
    this.base = { shoulderWidth: this._acc.sw / n, midX: this._acc.mx / n, noseY: this._acc.ny / n };
  }

  /** FIGHT 中のゆるやかな基準追従（体がじわじわ動く / カメラがずれるのを吸収）。 */
  _follow(shoulderWidth, midX, noseY, dtSec) {
    const k = 1 - Math.exp(-Math.max(0, dtSec) / this.t.baselineTauSec);
    this.base.shoulderWidth += k * (shoulderWidth - this.base.shoulderWidth);
    this.base.midX += k * (midX - this.base.midX);
    this.base.noseY += k * (noseY - this.base.noseY);
  }

  /** キャリブレーションをやり直す（再構え）。 */
  recalibrate() {
    this._calibStartMs = -1;
    this._acc = null;
    this.calibProgress = 0;
    this.base = null;
  }
}
