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

/**
 * 点群の凸包面積（Andrew's monotone chain）。手の 21 点の「広がり」を測るのに使う。
 * 面積は距離の 2 乗で効くので、長さ 1 本（手のひら長など）より S/N が良い。
 * 3 点未満や退化した場合は bbox 面積にフォールバックする。
 * @param {{x:number,y:number}[]} pts
 * @returns {number} 面積（入力座標系の 2 乗）
 */
export function convexHullArea(pts) {
  const p = (pts ?? []).filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  if (p.length < 3) return 0;
  const sorted = [...p].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (arr) => {
    const out = [];
    for (const q of arr) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  const hull = [...build(sorted), ...build([...sorted].reverse())];
  if (hull.length < 3) return bboxArea(p);
  let a2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const q = hull[i], r = hull[(i + 1) % hull.length];
    a2 += q.x * r.y - r.x * q.y;
  }
  const area = Math.abs(a2) / 2;
  return area > 1e-12 ? area : bboxArea(p);
}

/** 退化時のフォールバック（軸並行バウンディングボックスの面積）。 */
export function bboxArea(pts) {
  if (!pts?.length) return 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}
