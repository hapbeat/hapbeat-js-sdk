/**
 * HeatCursor — ヒートカーソル.
 *
 * Guide an eyes-closed user to CLICK a named UI button purely by feel. Six fake
 * UI buttons sit at fixed spots; the HUD names the current TARGET (例: 目標:
 * 送信). Sweep the cursor — the closer it gets, the stronger and faster the
 * Hapbeat buzzes (Geiger pacing, copied from Hot & Cold), and each pulse is a
 * STEREO directionCue whose L/R balance pulls you toward the target (buzz on the
 * left = move left). Click inside the target rect to bank it and get a new one.
 *
 * The pitch: turn 👁 映像 OFF and the buttons vanish — you must find the named
 * control by touch + sound alone. Showing them is the training/compare mode.
 */

import { Fx } from "../shared/fx.js";
import { directionCue } from "../shared/synth.js";
import { showResult, clearResult } from "../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../shared/scores.js";

const DIFF = {
  normal: { w: 132, h: 52, range: 360, targets: 5, label: "Normal" },
  hard: { w: 104, h: 44, range: 300, targets: 5, label: "Hard" },
  expert: { w: 80, h: 36, range: 240, targets: 6, label: "Expert" },
};

// Fixed layout slots (center points) for the fake UI buttons.
const SLOTS = [
  { label: "送信", x: 150, y: 110 },
  { label: "キャンセル", x: 400, y: 110 },
  { label: "設定", x: 600, y: 150 },
  { label: "ヘルプ", x: 170, y: 280 },
  { label: "戻る", x: 420, y: 320 },
  { label: "共有", x: 600, y: 360 },
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const game = {
  id: "heatcursor",
  emoji: "🎯",
  title: "ヒートカーソル",
  en: "HeatCursor",
  tag: "近接＋方向で UI 誘導",
  desc: "名前のついた UI ボタンを、見ずに触覚だけで探し当ててクリック。近づくほど触覚が強く・速くなり、左右の振動が目標へ引っ張る（左で鳴れば左へ）。映像 OFF でボタンが消え、本来の純触覚モードに。",
  formatScore: (v) => `${(v / 1000).toFixed(1)} 秒`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let diffKey = "normal";

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">難易度</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="460"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>目標 <b id="target">—</b></span>
        <span>発見 <b id="found">0</b>/<b id="total">5</b></span>
        <span>経過 <b id="time">0.0</b>s</span>
        <span>ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: マウスで探索 → 目標ボタンの上で<kbd>クリック</kbd>。近いほど触覚が強く・速くなり、左右の振動が目標方向へ引っ張る。
      ヘッダーの <b>👁 映像 / 👂 音 / ✋ 触覚</b> で切替。<b>👁 映像 OFF</b> でボタンが消え、純触覚で探す本来のモード。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elTarget = container.querySelector("#target");
    const elFound = container.querySelector("#found");
    const elTotal = container.querySelector("#total");
    const elTime = container.querySelector("#time");
    const elBest = container.querySelector("#best");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");

    function refreshBest() {
      const b = bestScore("heatcursor", diffKey);
      elBest.textContent = b == null ? "—" : `${(b / 1000).toFixed(1)}s`;
    }

    for (const k of Object.keys(DIFF)) {
      const b = document.createElement("button");
      b.textContent = DIFF[k].label;
      b.setAttribute("aria-pressed", String(k === diffKey));
      b.onclick = () => {
        diffKey = k;
        for (const c of diffBox.children) c.setAttribute("aria-pressed", String(c === b));
        stop();
      };
      diffBox.appendChild(b);
    }

    // ── state ────────────────────────────────────────────────
    let targetIdx = -1,
      found = 0,
      elapsed = 0,
      running = false,
      lastPulse = 0,
      reveal = 0,
      revealSlot = null, // the just-banked button, snapshotted before pickTarget()
      pulseFx = 0;
    const mouse = { x: cv.width / 2, y: cv.height / 2, inside: false };

    const rectOf = (slot) => {
      const D = DIFF[diffKey];
      return { x: slot.x - D.w / 2, y: slot.y - D.h / 2, w: D.w, h: D.h };
    };
    const inRect = (px, py, r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

    function pickTarget() {
      let i;
      do {
        i = Math.floor(Math.random() * SLOTS.length);
      } while (i === targetIdx && SLOTS.length > 1);
      targetIdx = i;
      elTarget.textContent = SLOTS[targetIdx].label;
    }

    function start() {
      const D = DIFF[diffKey];
      found = 0;
      elapsed = 0;
      running = true;
      reveal = 0;
      targetIdx = -1;
      elTotal.textContent = String(D.targets);
      elFound.textContent = "0";
      elMsg.textContent = "";
      elState.textContent = D.label;
      pickTarget();
      clearResult(stagebox);
      container.querySelector("#start").textContent = "リスタート";
    }
    function stop() {
      running = false;
      targetIdx = -1;
      elMsg.textContent = "";
      elTarget.textContent = "—";
      elTotal.textContent = String(DIFF[diffKey].targets);
      elTime.textContent = "0.0";
      elFound.textContent = "0";
      clearResult(stagebox);
      refreshBest();
      container.querySelector("#start").textContent = "スタート";
    }

    function endGame() {
      running = false;
      const ms = elapsed * 1000;
      const res = submitScore("heatcursor", diffKey, ms, true);
      refreshBest();
      showResult(stagebox, {
        title: "🏆 CLEAR",
        badge: res.isBest ? "★ 自己ベスト更新" : "",
        sub: `${DIFF[diffKey].targets} 個発見 ・ ${elapsed.toFixed(1)} 秒`,
        onRetry: start,
        onMenu: toMenu,
      });
    }

    container.querySelector("#start").onclick = () => {
      bridge.unlockAudio();
      start();
    };

    function toCanvas(e) {
      const r = cv.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * cv.width,
        y: ((e.clientY - r.top) / r.height) * cv.height,
      };
    }
    const pm = (e) => {
      const p = toCanvas(e);
      mouse.x = p.x;
      mouse.y = p.y;
      mouse.inside = true;
    };
    const pl = () => (mouse.inside = false);
    const pd = (e) => {
      if (!running || targetIdx < 0) return;
      bridge.unlockAudio();
      const p = toCanvas(e);
      const r = rectOf(SLOTS[targetIdx]);
      if (inRect(p.x, p.y, r)) {
        found++;
        elFound.textContent = String(found);
        bridge.fire("hot_found", { gain: 0.65 });
        fx.burst(SLOTS[targetIdx].x, SLOTS[targetIdx].y, "#2dd4bf", 30, 260);
        fx.shake(7);
        revealSlot = SLOTS[targetIdx]; // snapshot the banked button before advancing
        reveal = 1;
        if (found >= DIFF[diffKey].targets) {
          endGame();
        } else {
          pickTarget();
        }
      } else {
        // wrong control — faint low feedback, no penalty
        bridge.fire("hot_pulse", { gain: 0.12, audio: true });
        fx.shake(3);
      }
    };
    cv.addEventListener("pointermove", pm);
    cv.addEventListener("pointerleave", pl);
    cv.addEventListener("pointerdown", pd);

    // loop
    let raf = 0,
      tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;
      if (running) {
        elapsed += dt;
        elTime.textContent = elapsed.toFixed(1);

        // geiger pulse scheduling toward the named target
        if (mouse.inside && targetIdx >= 0) {
          const D = DIFF[diffKey];
          const t = SLOTS[targetIdx];
          const r = rectOf(t);
          const inside = inRect(mouse.x, mouse.y, r);
          const d = Math.hypot(mouse.x - t.x, mouse.y - t.y);
          const warmth = inside ? 1 : Math.max(0, Math.min(1, 1 - d / D.range));
          if (warmth > 0.02) {
            // floor 0.18s (~5.5/s): each directional pulse opens a STEREO stream
            // session, so we must not churn the device/helper at geiger rates.
            const interval = lerp(0.6, 0.18, Math.pow(warmth, 1.3)); // s
            if (ts / 1000 - lastPulse >= interval) {
              lastPulse = ts / 1000;
              const gain = lerp(0.15, 1.0, Math.pow(warmth, 1.1));
              // pan = horizontal offset target→cursor, so the buzz pulls you
              // toward the target (target left of cursor ⇒ buzz left).
              const pan = clamp((t.x - mouse.x) / (cv.width / 2), -1, 1);
              directionCue(bridge, pan, { gain, durMs: inside ? 70 : 90, freq: 160, audioEvent: "hot_pulse" });
              pulseFx = 1;
            }
          }
        }
      }
      reveal = Math.max(0, reveal - dt * 1.2);
      pulseFx = Math.max(0, pulseFx - dt * 6);
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function drawButton(slot, isTarget) {
      const r = rectOf(slot);
      g.fillStyle = isTarget ? "#241f50" : "#161b22";
      g.strokeStyle = isTarget ? "#7c5cff" : "#2a313c";
      g.lineWidth = isTarget ? 2 : 1;
      g.beginPath();
      g.roundRect(r.x, r.y, r.w, r.h, 8);
      g.fill();
      g.stroke();
      g.fillStyle = isTarget ? "#fff" : "#9aa7b4";
      g.font = "14px system-ui";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(slot.label, slot.x, slot.y);
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
    }

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      const visual = bridge.master.visual;

      // faint heat ring near the target (visual aid / compare mode)
      if (visual && running && targetIdx >= 0) {
        const t = SLOTS[targetIdx];
        const D = DIFF[diffKey];
        const grd = g.createRadialGradient(t.x, t.y, 4, t.x, t.y, D.range);
        grd.addColorStop(0, "rgba(45,212,191,0.34)");
        grd.addColorStop(0.55, "rgba(124,92,255,0.12)");
        grd.addColorStop(1, "rgba(45,212,191,0)");
        g.fillStyle = grd;
        g.fillRect(0, 0, cv.width, cv.height);
      }

      // the fake UI buttons — only when 👁 映像 is on (else: find by feel)
      if (visual && running) {
        for (let i = 0; i < SLOTS.length; i++) drawButton(SLOTS[i], i === targetIdx);
      }

      // briefly flash the BANKED target on a successful click — visual-aid only
      // (gate on visual so 映像 OFF doesn't reveal a button's location; use the
      // snapshot so it marks the just-clicked button, not the next target).
      if (reveal > 0 && revealSlot && running && visual) {
        const t = revealSlot;
        g.globalAlpha = reveal;
        g.strokeStyle = "#2dd4bf";
        g.lineWidth = 3;
        g.beginPath();
        g.arc(t.x, t.y, 14 + (1 - reveal) * 30, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }

      // cursor crosshair + pulse ring (always drawn)
      if (mouse.inside) {
        if (pulseFx > 0) {
          g.strokeStyle = `rgba(124,92,255,${pulseFx})`;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(mouse.x, mouse.y, 10 + (1 - pulseFx) * 26, 0, Math.PI * 2);
          g.stroke();
        }
        g.strokeStyle = "#7c5cff";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(mouse.x - 9, mouse.y);
        g.lineTo(mouse.x + 9, mouse.y);
        g.moveTo(mouse.x, mouse.y - 9);
        g.lineTo(mouse.x, mouse.y + 9);
        g.stroke();
      }

      fx.restore(g);
      fx.draw(g);

      if (!running && !elMsg.textContent) {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.textAlign = "center";
        g.fillText("スタートを押して、名前のボタンを触覚で探す", cv.width / 2, cv.height / 2);
        g.textAlign = "left";
      } else if (running && !bridge.master.visual) {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.textAlign = "center";
        g.fillText(`（映像 OFF：「${elTarget.textContent}」を触覚で探してクリック）`, cv.width / 2, cv.height - 16);
        g.textAlign = "left";
      }
    }

    stop();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        cv.removeEventListener("pointermove", pm);
        cv.removeEventListener("pointerleave", pl);
        cv.removeEventListener("pointerdown", pd);
      },
    };
  },
};