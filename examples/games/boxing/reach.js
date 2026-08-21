/**
 * reach.js — 前方リーチ（0=引いている / 1=伸び切り）の合成・安定化・「突いた」判定。純関数。
 *
 * 単眼カメラに本物の奥行きは無いので、2D から取れる 3 つの手がかりを合成する:
 *   angle     肘角度（伸びるほど 1）
 *   shorten   前腕の 2D 長さ / 構え時の長さ（カメラを向くほど短く映る）
 *   handSize  手の 2D スパン / 構え時（pose の 4 点版）
 *   handModel HandLandmarker の手のひら長 / 構え時（取れる時はこれが主信号）
 *   depthZ    pose の画像空間 z（肩→手首の手前方向の差 / 肩幅）
 *
 * そのままだと関節のプルプルがそのままリーチの揺れになり、ガード中に静止していても
 * 「伸びた」と誤判定する。そこで 4 段で殺す:
 *   ① デッドバンド（微小変化を無視）② スルーレート制限（伸び / 戻りで別レート）
 *   ③ 1€ フィルタ（静止で止まり、速い動きは通す）④ ガードロック（顔の前で静止＝伸びない）
 *
 * さらに「突いた」の判定は**リーチの値ではなく速度**で行う。短時間に大きく増えた時だけ
 * 発火し、その 1 スイングの間だけ当たり判定を有効にする（震えや、ゆっくり伸ばした腕では
 * 発火も命中もしない）。
 */

import { OneEuro, slew, deadband, weightedMedian } from "./filters.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const mapRange = (v, a, b) => clamp((v - a) / (b - a || 1e-6), 0, 1);

/**
 * 3 信号 → 生のリーチ 0..1。
 * @param {Object<string, number|null>} sig 各 0..1（取れない信号は null）
 * @param {{combine:"max"|"weighted"|"median", weights:Object<string, number>}} cfg
 */
export function combineSignals(sig, cfg) {
  const pairs = [];
  for (const k of Object.keys(cfg.weights)) {   // 信号の増減は tuning の weights だけで効く
    const v = sig[k];
    if (v == null || !Number.isFinite(v)) continue;
    pairs.push([clamp(v, 0, 1), cfg.weights[k] ?? 0]);
  }
  if (!pairs.length) return 0;
  if (cfg.combine === "max") return Math.max(...pairs.map(([v]) => v));
  if (cfg.combine === "median") return weightedMedian(pairs);
  const wsum = pairs.reduce((s, [, w]) => s + w, 0);
  return wsum > 0 ? pairs.reduce((s, [v, w]) => s + v * w, 0) / wsum : 0;
}

/** 片腕ぶんのリーチ安定化。 */
export class ReachFilter {
  constructor(cfg) {
    this.cfg = cfg;
    this.euro = new OneEuro(cfg.oneEuro);
    this.value = 0;
    this.raw = 0;
  }
  reset() { this.euro.reset(); this.value = 0; this.raw = 0; }

  /**
   * @param {number} raw combineSignals の出力
   * @param {number} dt 秒
   * @param {{visible?:boolean, guardLocked?:boolean}} opts
   *   visible=false … 推定を更新せず直前値を保持（ランドマークが見えていないフレーム）
   *   guardLocked=true … 顔の前で静止＝ガード中とみなし、上限でクランプ（腕を伸ばさせない）
   */
  update(raw, dt, { visible = true, guardLocked = false } = {}) {
    if (!visible) return this.value;
    this.raw = raw;
    const c = this.cfg;
    let target = deadband(this.value, raw, c.deadband);
    target = slew(this.value, target, dt, c.slewUp, c.slewDown);
    let v = this.euro.filter(target, dt);
    if (guardLocked) v = Math.min(v, c.guardLock.maxReach);
    this.value = clamp(v, 0, 1);
    return this.value;
  }
}

/**
 * 「突いた」の検出とスイング窓。
 * 直近 windowMs のリーチ履歴を持ち、その中の最小値から deltaMin 以上増えていて、
 * かつ現在値が reachMin 以上なら発火。発火から endReach を割り込むか maxMs 経過で窓を閉じる。
 */
export class SwingDetector {
  constructor(cfg) { this.cfg = cfg; this.samples = []; this.active = false; this.firedAtMs = -1e9; this.peak = 0; }
  reset() { this.samples.length = 0; this.active = false; this.firedAtMs = -1e9; this.peak = 0; }

  /** @returns {{fired:boolean, active:boolean, speed:number}} speed はリーチ/秒 */
  update(reach, nowMs) {
    const c = this.cfg;
    this.samples.push({ t: nowMs, v: reach });
    while (this.samples.length && nowMs - this.samples[0].t > c.windowMs) this.samples.shift();
    const min = this.samples.reduce((m, s) => Math.min(m, s.v), reach);
    const span = this.samples.length > 1 ? Math.max(1, nowMs - this.samples[0].t) : c.windowMs;
    const speed = ((reach - min) / span) * 1000;

    let fired = false;
    if (this.active) {
      this.peak = Math.max(this.peak, reach);
      if (reach < c.endReach || nowMs - this.firedAtMs > c.maxMs) this.active = false;
    } else if (reach - min >= c.deltaMin && reach >= c.reachMin && nowMs - this.firedAtMs > c.cooldownMs) {
      this.active = true;
      this.fired = true;
      this.firedAtMs = nowMs;
      this.peak = reach;
      fired = true;
    }
    return { fired, active: this.active, speed };
  }
}

/**
 * ガードロックの条件: 両手首が顔の近くにあり、かつ手首がほぼ動いていない。
 * すべて肩幅で正規化した 2D 量（カメラ距離に依らない）。
 * @param {{nose:object, wrists:{left:object,right:object}, speeds:{left:number,right:number}}} s
 */
export function isGuardLocked(s, cfg) {
  const near = (w) => w && Math.hypot(w.x - s.nose.x, w.y - s.nose.y) <= cfg.faceRadius;
  if (!near(s.wrists.left) || !near(s.wrists.right)) return false;
  return s.speeds.left < cfg.maxSpeed && s.speeds.right < cfg.maxSpeed;
}
