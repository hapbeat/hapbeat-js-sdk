/**
 * Fx — tiny canvas juice: screen shake + particle bursts, frame-rate
 * independent (dt-driven). Shared by all games so impactful moments (goal,
 * hit, found, GO) read well on an exhibition screen even when the gameplay
 * itself is haptic-first.
 *
 * Usage in a game's loop:
 *   const fx = new Fx();
 *   // on event:  fx.shake(8); fx.burst(x, y, "#7c5cff", 24);
 *   // each frame: fx.update(dt);
 *   // draw:       fx.apply(ctx);  ...world...  fx.restore(ctx);  fx.draw(ctx);
 */

export class Fx {
  constructor() {
    this.shakeMag = 0;
    this.shakeT = 0;
    this.ox = 0;
    this.oy = 0;
    this.parts = [];
  }

  /** Trigger a screen shake of magnitude `mag` px. */
  shake(mag) {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = Math.max(this.shakeT, 0.28);
  }

  /** Spawn `n` particles from (x,y) in `color`. */
  burst(x, y, color = "#7c5cff", n = 20, speed = 220) {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.parts.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.35,
        age: 0,
        color,
        r: 2 + Math.random() * 2.5,
      });
    }
    if (this.parts.length > 600) this.parts.splice(0, this.parts.length - 600);
  }

  update(dt) {
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / 0.28);
      const m = this.shakeMag * k;
      this.ox = (Math.random() * 2 - 1) * m;
      this.oy = (Math.random() * 2 - 1) * m;
      if (this.shakeT <= 0) {
        this.shakeMag = 0;
        this.ox = this.oy = 0;
      }
    }
    for (const p of this.parts) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt; // gravity
      p.vx *= 1 - 1.6 * dt; // drag
    }
    this.parts = this.parts.filter((p) => p.age < p.life);
  }

  /** Push the shake transform before drawing the world. */
  apply(ctx) {
    ctx.save();
    ctx.translate(this.ox, this.oy);
  }
  restore(ctx) {
    ctx.restore();
  }

  /** Draw particles (call after restore, in screen space). */
  draw(ctx) {
    for (const p of this.parts) {
      const a = 1 - p.age / p.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + this.ox, p.y + this.oy, p.r * (0.6 + a * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
