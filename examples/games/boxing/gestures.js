/**
 * GestureTracker — ランドマーク列 → 「体基準の 2D フレーム」＋パンチ発火。
 *
 * 出すもの
 *   frame  : 頭・肘・手首の 2D オフセット（肩幅＝1 の体基準）と、腕ごとの前方リーチ 0..1
 *   punchL / punchR : パンチの立ち上がり（1 回だけ true）と、その速さ
 *   lean / duck     : 離散の補助検出（頭位置の裏取り・HUD 表示用。当たり判定そのものには使わない）
 *
 * ── 設計メモ ────────────────────────────────────────────────────────────────
 * - 座標は「ミラー表示の画面座標」に統一する（x を 1-x して持つ）。画面左＝プレイヤーの左。
 * - 縦横比で歪まないよう、位置系はすべて (x*aspect, y) の等方空間で扱い、量は肩幅で割る。
 *   カメラとの距離が変わっても同じ閾値・同じ体格で扱える。
 * - **奥行き（前方リーチ）は worldLandmarks の z を使わない**。単眼に本物の奥行きは無く、
 *   拳をカメラへ突き出しても z がほとんど動かないため（実機で「腕が前に出ない」の原因）。
 *   代わりに 2D から取れる 2 つの信号で推定する:
 *     ① 肘角度（伸びるほど前）        ② 前腕の 2D 長さの短縮（カメラを向くほど短く映る）
 * - ガード判定はここでは持たない。腕とグローブの 3D 位置で当たり判定する（combat.js）。
 * - 閾値は全部 ./tuning.js の TUNING。ここには数値を直書きしない。
 */

import { LM } from "./pose.js";
import { TUNING } from "./tuning.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = 180 / Math.PI;
const SIDES = [["left", { shoulder: LM.shoulderL, elbow: LM.elbowL, wrist: LM.wristL }],
               ["right", { shoulder: LM.shoulderR, elbow: LM.elbowR, wrist: LM.wristR }]];

/** 関節角[deg]（a-b-c）。z を渡せば 3D、渡さなければ 2D。 */
function jointAngle(a, b, c, use3d) {
  const z = (p) => (use3d ? (p.z ?? 0) : 0);
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: z(a) - z(b) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: z(c) - z(b) };
  const n1 = Math.hypot(v1.x, v1.y, v1.z);
  const n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  return Math.acos(clamp((v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2), -1, 1)) * DEG;
}

/** 片腕ぶんの状態。 */
class ArmState {
  constructor() {
    this.v = { x: 0, y: 0, z: 0 }; // EMA 済み手首速度 [m/s]（world 由来。パンチ検出のみに使う）
    this.prev = null;
    this.speed = 0;
    this.forward = 0;
    this.elbowDeg = 180;
    this.lastFlexMs = -1e9;
    this.lastPunchMs = -1e9;
    this.punchSpeed = 0;   // 直近のパンチの速さ（突き出しアニメーションの深さに使う）
    this.reach = 0;
    this.prevReach = 0;
    // 肘角度 3D / 2D のどちらが安定かを測るための、フレーム間ブレの EMA
    this.jitter3d = 0; this.jitter2d = 0;
    this.prev3d = null; this.prev2d = null;
    this.angleSource = "3d";
  }
}

export class GestureTracker {
  constructor(tuning = TUNING) {
    this.t = tuning;
    this.arms = { left: new ArmState(), right: new ArmState() };
    this.reset();
  }

  reset() {
    this.base = null;          // { shoulderWidth, noseY, midX, forearm:{left,right}, upperArm:{left,right} }
    this._acc = null;
    this._calibStartMs = -1;
    this.calibProgress = 0;
    this.lean = 0;             // -1 左 / 0 / +1 右（画面基準＝プレイヤー基準）
    this.duck = false;
    this.lostSinceMs = -1;
    for (const a of Object.values(this.arms)) {
      a.prev = null; a.v = { x: 0, y: 0, z: 0 };
      a.lastFlexMs = -1e9; a.lastPunchMs = -1e9;
      a.reach = a.prevReach = 0;
    }
  }

  /** 画面（ミラー）座標の等方空間に写した点。可視度が低い点は null。 */
  _points(landmarks, aspect) {
    const minV = this.t.minVisibility;
    const get = (i) => {
      const p = landmarks[i];
      if (!p || (p.visibility != null && p.visibility < minV)) return null;
      // ミラー: x を反転。z は正規化ランドマークのもの（3D 肘角度の計算にだけ使う）
      return { x: (1 - p.x) * aspect, y: p.y, z: -(p.z ?? 0) };
    };
    return {
      nose: get(LM.nose),
      shoulderL: get(LM.shoulderL), shoulderR: get(LM.shoulderR),
      elbowL: get(LM.elbowL), elbowR: get(LM.elbowR),
      wristL: get(LM.wristL), wristR: get(LM.wristR),
    };
  }

  /**
   * 1 フレーム更新。
   * @param {{landmarks:Array, worldLandmarks:Array}|null} pose
   * @param {{aspect:number, calibrating?:boolean}} opts
   * @returns {{visible:boolean, calibrated:boolean, punchL:boolean, punchR:boolean,
   *            punchSpeed:{left:number,right:number}, lean:number, duck:boolean,
   *            frame:{head:{x,y}, arms:{left:object,right:object}}|null, debug:object}}
   */
  update(pose, nowMs, dtSec, { aspect = 4 / 3, calibrating = false } = {}) {
    const out = {
      visible: false, calibrated: !!this.base && this.calibProgress >= 1,
      punchL: false, punchR: false, punchSpeed: { left: 0, right: 0 },
      lean: this.lean, duck: this.duck, frame: null, debug: {},
    };
    const lms = pose?.landmarks;
    if (!lms) {
      if (this.lostSinceMs < 0) this.lostSinceMs = nowMs;
      this.lean = 0; this.duck = false;
      out.lean = 0; out.duck = false;
      return out;
    }
    const p = this._points(lms, aspect);
    if (!p.shoulderL || !p.shoulderR || !p.nose) {
      if (this.lostSinceMs < 0) this.lostSinceMs = nowMs;
      return out;
    }
    this.lostSinceMs = -1;
    out.visible = true;

    const shoulderWidth = Math.hypot(p.shoulderL.x - p.shoulderR.x, p.shoulderL.y - p.shoulderR.y);
    const midX = (p.shoulderL.x + p.shoulderR.x) / 2;
    if (shoulderWidth < 1e-4) return out;

    // 腕の 2D 長さ（肩幅で正規化＝カメラ距離に依らない）
    const seg = {};
    for (const [side, ix] of SIDES) {
      const sh = side === "left" ? p.shoulderL : p.shoulderR;
      const el = side === "left" ? p.elbowL : p.elbowR;
      const wr = side === "left" ? p.wristL : p.wristR;
      seg[side] = (sh && el && wr)
        ? { upperArm: Math.hypot(el.x - sh.x, el.y - sh.y) / shoulderWidth,
            forearm: Math.hypot(wr.x - el.x, wr.y - el.y) / shoulderWidth, sh, el, wr, ix }
        : null;
    }

    if (calibrating || !this.base) this._calibrate(shoulderWidth, midX, p.nose.y, seg, nowMs);
    else this._follow(shoulderWidth, midX, p.nose.y, seg, dtSec);
    out.calibrated = !!this.base && this.calibProgress >= 1;
    if (!this.base) return out;
    const w = this.base.shoulderWidth;

    // ── リーン / ダック（補助検出。ヒステリシス付き） ─────────────────────────
    const leanOff = (midX - this.base.midX) / w;
    const enter = this.t.lean.enterRatio, exit = this.t.lean.exitRatio;
    if (this.lean === 0) this.lean = leanOff > enter ? 1 : leanOff < -enter ? -1 : 0;
    else if (Math.abs(leanOff) < exit || Math.sign(leanOff) !== this.lean) this.lean = 0;
    out.lean = this.lean;

    const duckOff = (p.nose.y - this.base.noseY) / w;
    this.duck = this.duck ? duckOff > this.t.duck.exitRatio : duckOff > this.t.duck.enterRatio;
    out.duck = this.duck;

    // ── 体基準 2D フレーム（3D の体を組む材料） ──────────────────────────────
    const frame = {
      head: { x: (p.nose.x - this.base.midX) / w, y: (p.nose.y - this.base.noseY) / w },
      arms: {},
    };
    for (const [side] of SIDES) {
      const s = seg[side];
      if (!s) { frame.arms[side] = null; continue; }
      const reach = this._reach(side, s, nowMs, dtSec);
      frame.arms[side] = {
        elbow: { x: (s.el.x - s.sh.x) / w, y: (s.el.y - s.sh.y) / w },
        wrist: { x: (s.wr.x - s.sh.x) / w, y: (s.wr.y - s.sh.y) / w },
        reach,
      };
    }
    out.frame = frame;

    // ── パンチ（world 速度 / 肘の伸展 / リーチの立ち上がり のいずれか） ───────
    const world = pose.worldLandmarks;
    for (const [side, ix] of SIDES) {
      const fired = this._detectPunch(side, world, ix, nowMs, dtSec);
      if (side === "left") out.punchL = fired; else out.punchR = fired;
      out.punchSpeed[side] = this.arms[side].speed;
    }
    out.debug = {
      reachL: this.arms.left.reach, reachR: this.arms.right.reach,
      angleSource: this.arms.right.angleSource,
      elbowL: this.arms.left.elbowDeg, elbowR: this.arms.right.elbowDeg,
    };
    return out;
  }

  /**
   * 前方リーチ 0..1 の推定。
   * 肘角度は 3D（正規化ランドマークの z 込み）と 2D の両方を出し、フレーム間のブレが
   * 小さい方をそのフレームで採用する（どちらが安定かは環境依存なので固定しない）。
   */
  _reach(side, s, nowMs, dtSec) {
    const a = this.arms[side];
    const cfg = this.t.reach;

    const ang3d = jointAngle(s.sh, s.el, s.wr, true);
    const ang2d = jointAngle(s.sh, s.el, s.wr, false);
    const k = 1 - Math.exp(-Math.max(dtSec, 0) / cfg.jitterTauSec);
    if (a.prev3d != null) a.jitter3d += k * (Math.abs(ang3d - a.prev3d) - a.jitter3d);
    if (a.prev2d != null) a.jitter2d += k * (Math.abs(ang2d - a.prev2d) - a.jitter2d);
    a.prev3d = ang3d; a.prev2d = ang2d;
    a.angleSource = a.jitter3d <= a.jitter2d ? "3d" : "2d";
    const angle = a.angleSource === "3d" ? ang3d : ang2d;
    a.elbowDeg = angle;

    const tAngle = clamp((angle - cfg.angle.minDeg) / (cfg.angle.maxDeg - cfg.angle.minDeg), 0, 1);

    // 前腕が構え時よりどれだけ短く映っているか（カメラを向くほど短い）
    const baseForearm = this.base.forearm[side] || s.forearm;
    const ratio = baseForearm > 1e-4 ? s.forearm / baseForearm : 1;
    const tShort = clamp((cfg.shorten.maxRatio - ratio) / (cfg.shorten.maxRatio - cfg.shorten.minRatio), 0, 1);

    const raw = cfg.combine === "weighted"
      ? clamp(cfg.weights.angle * tAngle + cfg.weights.shorten * tShort, 0, 1)
      : Math.max(tAngle, tShort);

    a.prevReach = a.reach;
    a.reach += cfg.ema * (raw - a.reach);

    // パンチ時の突き出しアニメーション（推定に重ねる）
    const snap = this._snapAmount(a, nowMs);
    return clamp(Math.max(a.reach, snap), 0, 1);
  }

  /** パンチ発火からの経過で 0 → 1 → 0 と動く突き出し量。速いパンチほど深い。 */
  _snapAmount(arm, nowMs) {
    const s = this.t.reach.snap;
    const dt = nowMs - arm.lastPunchMs;
    if (dt < 0 || dt > s.riseMs + s.holdMs + s.fallMs) return 0;
    const amount = clamp(Math.max(s.minAmount, arm.punchSpeed / s.speedRefMps), 0, 1);
    if (dt < s.riseMs) return amount * (dt / s.riseMs);
    if (dt < s.riseMs + s.holdMs) return amount;
    return amount * (1 - (dt - s.riseMs - s.holdMs) / s.fallMs);
  }

  _detectPunch(side, world, ix, nowMs, dtSec) {
    const a = this.arms[side];
    const cfg = this.t.punch;
    if (world) {
      const wrist = world[ix.wrist];
      if (wrist) {
        if (a.prev && dtSec > 0.001 && dtSec < 0.2) {
          const e = cfg.velocityEma;
          const raw = { x: (wrist.x - a.prev.x) / dtSec, y: (wrist.y - a.prev.y) / dtSec, z: (wrist.z - a.prev.z) / dtSec };
          a.v = { x: a.v.x + e * (raw.x - a.v.x), y: a.v.y + e * (raw.y - a.v.y), z: a.v.z + e * (raw.z - a.v.z) };
        }
        a.prev = { x: wrist.x, y: wrist.y, z: wrist.z };
        a.speed = Math.hypot(a.v.x, a.v.y, a.v.z);
        a.forward = -a.v.z; // world z はカメラに近いほど小さい
      }
    }
    if (a.elbowDeg < cfg.flexAngleDeg) a.lastFlexMs = nowMs;
    if (nowMs - a.lastPunchMs < cfg.cooldownMs) return false;

    const fast = a.speed > cfg.speedThreshMps && a.forward > 0 && a.forward / a.speed > cfg.forwardRatio;
    const extended = a.elbowDeg > cfg.extendAngleDeg && nowMs - a.lastFlexMs < cfg.extendWindowMs;
    // world z が当てにならないカメラ向けの保険: 推定リーチが一気に伸びた
    const rate = dtSec > 1e-4 ? (a.reach - a.prevReach) / dtSec : 0;
    const thrust = a.reach > cfg.reachTrigger.min && rate > cfg.reachTrigger.ratePerSec;
    if (!fast && !extended && !thrust) return false;
    a.lastPunchMs = nowMs;
    a.punchSpeed = a.speed;
    return true;
  }

  _calibrate(shoulderWidth, midX, noseY, seg, nowMs) {
    if (this._calibStartMs < 0) {
      this._calibStartMs = nowMs;
      this._acc = { sw: 0, mx: 0, ny: 0, n: 0, fa: { left: 0, right: 0 }, ua: { left: 0, right: 0 }, an: { left: 0, right: 0 } };
    }
    this._acc.sw += shoulderWidth; this._acc.mx += midX; this._acc.ny += noseY; this._acc.n++;
    for (const [side] of SIDES) {
      if (!seg[side]) continue;
      this._acc.fa[side] += seg[side].forearm;
      this._acc.ua[side] += seg[side].upperArm;
      this._acc.an[side]++;
    }
    this.calibProgress = clamp((nowMs - this._calibStartMs) / this.t.calibrationMs, 0, 1);
    const n = this._acc.n;
    const armAvg = (m, side) => (this._acc.an[side] ? m[side] / this._acc.an[side] : 0);
    // 進行中でも暫定基準を入れておく（HUD が即動くほうが構えを直しやすい）
    this.base = {
      shoulderWidth: this._acc.sw / n, midX: this._acc.mx / n, noseY: this._acc.ny / n,
      forearm: { left: armAvg(this._acc.fa, "left"), right: armAvg(this._acc.fa, "right") },
      upperArm: { left: armAvg(this._acc.ua, "left"), right: armAvg(this._acc.ua, "right") },
    };
  }

  /**
   * FIGHT 中のゆるやかな基準追従（体やカメラのじわじわしたズレを吸収）。
   * 腕の長さの基準は「伸ばしている最中に基準まで縮む」と困るので、
   * **今より長い時だけ**追従させる（構えの長さ＝最大長として扱う）。
   */
  _follow(shoulderWidth, midX, noseY, seg, dtSec) {
    const k = 1 - Math.exp(-Math.max(0, dtSec) / this.t.baselineTauSec);
    this.base.shoulderWidth += k * (shoulderWidth - this.base.shoulderWidth);
    this.base.midX += k * (midX - this.base.midX);
    this.base.noseY += k * (noseY - this.base.noseY);
    for (const [side] of SIDES) {
      if (!seg[side]) continue;
      if (seg[side].forearm > this.base.forearm[side]) this.base.forearm[side] += k * (seg[side].forearm - this.base.forearm[side]);
      if (seg[side].upperArm > this.base.upperArm[side]) this.base.upperArm[side] += k * (seg[side].upperArm - this.base.upperArm[side]);
    }
  }

  /** キャリブレーションをやり直す（再構え）。 */
  recalibrate() {
    this._calibStartMs = -1;
    this._acc = null;
    this.calibProgress = 0;
    this.base = null;
  }
}
