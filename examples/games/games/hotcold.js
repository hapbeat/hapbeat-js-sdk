/**
 * Hot & Cold — 宝探し.
 *
 * A treasure is hidden on a blank field. Sweep the cursor: the closer you get,
 * the stronger and faster the Hapbeat pulses — a haptic Geiger counter. Click
 * to dig. Pure haptic guidance by default; flip "ヒートを表示" to reveal the
 * warmth as a visual aid for comparison.
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../shared/scores.js";

const DIFF = {
  normal: { catch: 30, range: 360, targets: 3, time: 60, label: "Normal" },
  hard: { catch: 20, range: 280, targets: 5, time: 45, label: "Hard" },
  expert: { catch: 13, range: 210, targets: 7, time: 30, label: "Expert" },
};

const lerp = (a, b, t) => a + (b - a) * t;

export const game = {
  id: "hotcold",
  emoji: "💎",
  title: "宝探し",
  en: "Hot & Cold",
  tag: "触覚＝近接（連続）",
  desc: "見えない宝に近づくほど触覚が強く・速くなる（ガイガーカウンタ式）。純触覚で位置を探り当ててクリック。ヒート表示で見比べも可能。",
  formatScore: (v) => `${Math.round(v)} 個`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let diffKey = "normal";
    let showHeat = false;

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">難易度</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="heat" aria-pressed="false">ヒートを表示</button>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="480"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>発見 <b id="found">0</b>/<b id="total">3</b></span>
        <span>残り <b id="time">60</b>s</span>
        <span>発見ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: マウスで探索 → 当たりと感じたら<kbd>クリック</kbd>。近いほど触覚が強く・速くなる。
      音・触覚はヘッダーの 🔊 / 📳 で ON/OFF。「ヒートを表示」OFF が本来の純触覚モード。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elFound = container.querySelector("#found");
    const elTotal = container.querySelector("#total");
    const elTime = container.querySelector("#time");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const elBest = container.querySelector("#best");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");
    const heatBtn = container.querySelector("#heat");

    function refreshBest() {
      const b = bestScore("hotcold", diffKey);
      elBest.textContent = b == null ? "—" : String(Math.round(b));
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
    heatBtn.onclick = () => {
      showHeat = !showHeat;
      heatBtn.setAttribute("aria-pressed", String(showHeat));
    };

    // ── state ────────────────────────────────────────────────
    let target = null,
      found = 0,
      timeLeft = 0,
      running = false,
      lastPulse = 0,
      reveal = 0;
    const mouse = { x: cv.width / 2, y: cv.height / 2, inside: false };

    function placeTarget() {
      const m = 60;
      target = {
        x: m + Math.random() * (cv.width - 2 * m),
        y: m + Math.random() * (cv.height - 2 * m),
      };
    }

    function start() {
      const D = DIFF[diffKey];
      found = 0;
      timeLeft = D.time;
      running = true;
      reveal = 0;
      elTotal.textContent = String(D.targets);
      elMsg.textContent = "";
      elState.textContent = DIFF[diffKey].label;
      placeTarget();
      clearResult(stagebox);
      container.querySelector("#start").textContent = "リスタート";
      tPrev = performance.now();
    }
    function stop() {
      running = false;
      elMsg.textContent = "";
      elTotal.textContent = String(DIFF[diffKey].targets);
      elTime.textContent = String(DIFF[diffKey].time);
      elFound.textContent = "0";
      clearResult(stagebox);
      refreshBest();
      container.querySelector("#start").textContent = "スタート";
    }

    function endGame(title, badgeable) {
      running = false;
      const res = submitScore("hotcold", diffKey, found, false);
      refreshBest();
      showResult(stagebox, {
        title,
        badge: badgeable && res.isBest ? "★ 自己ベスト更新" : "",
        sub: `${found}/${DIFF[diffKey].targets} 個発見 ・ 残り ${timeLeft.toFixed(0)}s`,
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
      if (!running) return;
      bridge.unlockAudio();
      const p = toCanvas(e);
      const d = Math.hypot(p.x - target.x, p.y - target.y);
      if (d <= DIFF[diffKey].catch) {
        found++;
        elFound.textContent = String(found);
        bridge.fire("hot_found", { gain: 0.65 });
        fx.burst(target.x, target.y, "#d4a017", 30, 260);
        fx.shake(7);
        reveal = 1;
        if (found >= DIFF[diffKey].targets) {
          endGame("🏆 CLEAR", true);
        } else {
          placeTarget();
        }
      } else {
        // cold dig — faint low feedback, no penalty
        bridge.fire("hot_pulse", { gain: 0.12, audio: true });
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
        timeLeft -= dt;
        if (timeLeft <= 0) {
          timeLeft = 0;
          bridge.fire("hot_timeout", { gain: 0.7 });
          fx.shake(11);
          endGame("⏱ TIME UP", false);
        }
        elTime.textContent = timeLeft.toFixed(0);

        // geiger pulse scheduling
        if (mouse.inside && target) {
          const D = DIFF[diffKey];
          const d = Math.hypot(mouse.x - target.x, mouse.y - target.y);
          const warmth = Math.max(0, Math.min(1, 1 - d / D.range));
          if (warmth > 0.02) {
            const interval = lerp(0.6, 0.09, Math.pow(warmth, 1.3)); // s
            if (ts / 1000 - lastPulse >= interval) {
              lastPulse = ts / 1000;
              const gain = lerp(0.15, 1.0, Math.pow(warmth, 1.1));
              const pan = Math.max(-1, Math.min(1, (mouse.x - cv.width / 2) / (cv.width / 2)));
              bridge.fire("hot_pulse", { gain, pan });
              pulseFx = 1;
            }
          }
        }
      }
      reveal = Math.max(0, reveal - dt * 1.2);
      pulseFx = Math.max(0, pulseFx - dt * 6); // ~0.1/frame @60fps, but frame-rate independent
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }
    let pulseFx = 0;

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      // heat aid (optional)
      if (showHeat && target && running) {
        const D = DIFF[diffKey];
        const grd = g.createRadialGradient(target.x, target.y, 4, target.x, target.y, D.range);
        grd.addColorStop(0, "rgba(248,81,73,0.42)");
        grd.addColorStop(0.5, "rgba(210,153,34,0.16)");
        grd.addColorStop(1, "rgba(45,212,191,0)");
        g.fillStyle = grd;
        g.fillRect(0, 0, cv.width, cv.height);
      }

      // revealed target (briefly on find)
      if (reveal > 0 && target) {
        g.globalAlpha = reveal;
        g.fillStyle = "#d4a017";
        g.beginPath();
        g.arc(target.x, target.y, 10 + (1 - reveal) * 26, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }

      // cursor crosshair + pulse ring
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
        g.fillText("スタートを押して、マウスで宝を探す", cv.width / 2, cv.height / 2);
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
