/**
 * filters.js — 1€ (One-Euro) フィルタと補助（すべて純関数 / 小さなクラス）。
 *
 * 姿勢推定の値は「止めるとプルプルし、速く動かすと遅れる」。単純な EMA だと
 * どちらか片方しか直せない（強く平滑化するとパンチが遅れ、弱くすると震える）。
 * 1€ フィルタは **信号の速度に応じてカットオフ周波数を上げる**ので、
 * 静止時はしっかり止まり、速い動き（パンチの立ち上がり）はほぼ素通りする。
 *
 *   cutoff = minCutoff + beta * |x'|        （x' は微分の平滑値）
 *   alpha  = 1 / (1 + tau/dt),  tau = 1/(2*pi*cutoff)
 *
 * 出典: Casiez, Roussel, Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter
 * for Noisy Input in Interactive Systems", CHI 2012.
 */

const alphaOf = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-6));
  return 1 / (1 + tau / Math.max(dt, 1e-6));
};

export class OneEuro {
  /** @param {{minCutoff?:number, beta?:number, dCutoff?:number}} cfg */
  constructor({ minCutoff = 1.2, beta = 0.03, dCutoff = 1.0 } = {}) {
    this.cfg = { minCutoff, beta, dCutoff };
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; }
  /** @returns {number} 平滑化した値 */
  filter(x, dt) {
    if (!Number.isFinite(x)) return this.x ?? 0;
    if (this.x === null) { this.x = x; return x; }
    const { minCutoff, beta, dCutoff } = this.cfg;
    const dxRaw = (x - this.x) / Math.max(dt, 1e-6);
    this.dx = this.dx + alphaOf(dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x = this.x + alphaOf(cutoff, dt) * (x - this.x);
    return this.x;
  }
  /** 可視性が落ちたフレームなど、更新せず直前値を保持したい時。 */
  hold() { return this.x ?? 0; }
}

/** 3 成分をまとめて 1€ するだけのラッパ（landmark 用）。 */
export class OneEuroVec3 {
  constructor(cfg) { this.f = [new OneEuro(cfg), new OneEuro(cfg), new OneEuro(cfg)]; }
  reset() { for (const f of this.f) f.reset(); }
  filter(p, dt) {
    return { x: this.f[0].filter(p.x, dt), y: this.f[1].filter(p.y, dt), z: this.f[2].filter(p.z ?? 0, dt) };
  }
  hold() { return { x: this.f[0].hold(), y: this.f[1].hold(), z: this.f[2].hold() }; }
}

/** 変化率の上限を、伸び方向 / 戻り方向で別々に掛ける。 */
export function slew(prev, target, dt, upRate, downRate) {
  const d = target - prev;
  const max = (d >= 0 ? upRate : downRate) * Math.max(dt, 0);
  return prev + (Math.abs(d) <= max ? d : Math.sign(d) * max);
}

/** 変化が band 未満なら動かさない（微小な揺らぎを完全に無視する）。 */
export function deadband(prev, target, band) {
  return Math.abs(target - prev) < band ? prev : target;
}

/** 重み付きメディアン（重みの累積が半分を超える最初の値）。外れ値 1 つに引っ張られない。 */
export function weightedMedian(pairs) {
  const items = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (!items.length) return 0;
  const total = items.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of items) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return items[items.length - 1][0];
}
