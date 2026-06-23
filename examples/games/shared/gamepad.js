/**
 * Shared gamepad helper for the arcade demos.
 *
 * - Prefers a STANDARD-mapping pad (HID devices like USB speakerphones get
 *   mis-enumerated as non-standard "gamepads" and would otherwise be picked first).
 * - Per-frame edge detection: call poll() once per frame; it returns down/held
 *   plus isDown()/isHeld() and deadzoned stick axes.
 *
 * Common button convention across demos (Xbox layout):
 *   A / RT     — 決定・スタート・反応 (react / dig / advance / fire)
 *   B / View   — メニューへ戻る (back to menu)
 *   ☰ Menu     — スタート / リスタート（fps では pause）
 *   LB / RB    — 難易度 − / +
 *   左スティック/十字 — カーソル/移動、右スティック — 視点 (fps)
 */

// W3C "standard" gamepad button indices (Xbox layout)
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, GUIDE: 16,
};

export class Pad {
  constructor() { this._prev = []; }

  /** Read the active pad this frame. Returns a snapshot with edges + axes. */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (!p) continue; if (!gp) gp = p; if (p.mapping === "standard") { gp = p; break; } }
    const down = [], held = [];
    if (gp) {
      for (let i = 0; i < gp.buttons.length; i++) {
        const pr = !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
        if (pr) held.push(i);
        if (pr && !this._prev[i]) down.push(i);
        this._prev[i] = pr;
      }
    } else {
      this._prev = [];
    }
    const ax = (i) => (gp && Math.abs(gp.axes[i] || 0) > 0.18 ? gp.axes[i] : 0);
    return {
      connected: !!gp,
      standard: !!(gp && gp.mapping === "standard"),
      down, held,
      isDown: (b) => down.includes(b),
      isHeld: (b) => held.includes(b),
      lx: ax(0), ly: ax(1), rx: ax(2), ry: ax(3),
    };
  }
}
