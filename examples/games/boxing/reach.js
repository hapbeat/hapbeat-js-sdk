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
   * @param {{visible?:boolean, guardLocked?:boolean, inHome?:boolean}} opts
   *   visible=false … 推定を更新せず直前値を保持（ランドマークが見えていないフレーム）
   *   guardLocked=true … 顔の前で静止＝ガード中とみなし、上限でクランプ（腕を伸ばさせない）
   *   inHome=true … 手が構え領域（胸〜顔の前）に戻っている。0 へ**積極的に**引き戻す。
   *     推定が何らかの理由で高いまま張り付いても腕が戻るようにするための保険で、
   *     「拳を戻したのに腕が伸びっぱなし」を防ぐ最後の砦。
   */
  update(raw, dt, { visible = true, guardLocked = false, inHome = false } = {}) {
    if (!visible) return this.value;
    this.raw = raw;
    const c = this.cfg;
    if (inHome) {
      // 構えに戻っている間は**推定値を見ない**で 0 へ指数的に引く。
      // 推定が高いまま張り付いていても（手を見失った等）確実に腕が戻るようにするため。
      // 拳を出した瞬間は手首速度が上がって home 判定が外れるので、パンチは妨げない。
      const k = 1 - Math.exp(-Math.max(dt, 0) / c.home.pullTauSec);
      this.value = clamp(this.value * (1 - k), 0, 1);
      this.euro.x = this.value; // 次フレームで跳ね返らないようフィルタ内部も揃える
      return this.value;
    }
    let target = deadband(this.value, raw, c.deadband);
    target = slew(this.value, target, dt, c.slewUp, c.slewDown);
    let v = this.euro.filter(target, dt);
    if (guardLocked) v = Math.min(v, c.guardLock.maxReach);
    this.value = clamp(v, 0, 1);
    return this.value;
  }

  /** スタック時の強制復帰（基準を取り直した瞬間に呼ぶ）。 */
  forceHome() {
    this.value = 0;
    this.raw = 0;
    this.euro.reset();
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
 * 手が「構え領域」に戻っているか（胸〜顔の前で、ゆっくりしか動いていない）。
 * すべて肩幅で正規化した 2D 量。中心は鼻と肩中点の間＝胸の前あたり。
 * @param {{x:number,y:number}|null} wrist 鼻を原点とした肩幅正規化座標
 */
export function isHome(wrist, speed, cfg) {
  if (!wrist) return false;
  // 胸の前（鼻より少し下）を中心にした円で見る
  const dx = wrist.x;
  const dy = wrist.y - 0.35;
  return Math.hypot(dx, dy) <= cfg.radius && speed < cfg.maxSpeed;
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

/**
 * 体幹ヨー（ひねり）の推定 [rad]。
 *
 * **符号の決め方（実データで確認した規約）**
 * MediaPipe の正規化ランドマークは「z が小さいほどカメラに近い」。ここに渡すのは
 * gestures.js のミラー等方空間（x は 1-x して aspect 倍、z は符号反転済み ＝ **大きいほど手前**）。
 * 右肩が手前に出た状態（＝敵の方へ右肩を入れた「右ひねり」）では zR > zL になるので、
 *     yaw = atan2(zR - zL, (xR - xL)/aspect)   → 正
 * となる。つまり **+ = 右ひねり（右肩が前）**。実写真（MediaPipe 公式 pose.jpg）では
 * 左肩 z_raw=-0.091 / 右肩 z_raw=+0.051、すなわち左肩が手前なので負（左ひねり）と出る。
 *
 * 肩幅の短縮（cos θ ≒ w/w0）からも角度が出るので、両者のメディアンを取って外れ値を弾く。
 * @param {{xL:number,xR:number,zL:number,zR:number}} p ミラー等方空間の肩 2 点
 * @param {number} widthRatio 現在の肩幅 / 構え時の肩幅
 * @param {number} aspect x だけ aspect 倍されているので戻すのに使う
 * @returns {number|null} rad（推定できなければ null）
 */
export function estimateYaw(p, widthRatio, aspect, maxRad) {
  const dx = (p.xR - p.xL) / (aspect || 1);
  const dz = p.zR - p.zL;
  if (!Number.isFinite(dx) || Math.abs(dx) < 1e-6) return null;
  const fromZ = Math.atan2(dz, Math.abs(dx));
  const cands = [[fromZ, 1]];
  // 肩幅の短縮からも角度が出る（cos θ = w/w0）。向きは z 差から借りる。
  if (Number.isFinite(widthRatio) && widthRatio > 0.2 && widthRatio <= 1.05) {
    const mag = Math.acos(clamp(widthRatio, 0, 1));
    cands.push([Math.sign(fromZ || 1) * mag, 1]);
  }
  const yaw = cands.length > 1 ? (cands[0][0] + cands[1][0]) / 2 : fromZ;
  return clamp(yaw, -maxRad, maxRad);
}
