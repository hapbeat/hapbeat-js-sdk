/**
 * Spatial Alert — どっちで鳴った.
 *
 * A grid of dashboard tiles. Every beat a random tile "fires": a STEREO haptic
 * cue (directionCue) whose left/right balance maps to the tile's horizontal
 * position — left column buzzes the left actuator, right column the right.
 * You then CLICK the tile you think fired, within a short window.
 *
 * The pitch: turn the screen aid off (👁 映像 OFF) and the tiles do NOT light.
 * You must locate the source purely by the L/R buzz on your neck/chest, then
 * click — proving Hapbeat can carry *where* something happened, not just *that*.
 */

import { Fx } from "../shared/fx.js";
import { directionCue } from "../shared/synth.js";
import { showResult, clearResult } from "../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../shared/scores.js";

const DIFF = {
  normal: { cols: 3, rows: 2, rounds: 10, window: 2.6, gap: 1.4, gain: 0.85, label: "Normal" },
  hard: { cols: 4, rows: 2, rounds: 10, window: 2.0, gap: 1.2, gain: 0.8, label: "Hard" },
  expert: { cols: 5, rows: 2, rounds: 12, window: 1.5, gap: 1.0, gain: 0.78, label: "Expert" },
};

export const game = {
  id: "spatialalert",
  emoji: "🧭",
  title: "どっちで鳴った",
  en: "Spatial Alert",
  tag: "方向(L/R)で位置提示",
  desc: "ダッシュボードのタイルがランダムに「鳴る」。左右どちらで鳴ったかを触覚(L/R)で感じ取り、そのタイルをクリック。映像 OFF にすればタイルは光らず、純触覚で位置を当てる勝負に。",
  formatScore: (v) => `${Math.round(v)} %`,

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
        <canvas id="cv" width="720" height="440"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>ラウンド <b id="round">0</b>/<b id="rounds">10</b></span>
        <span>正解 <b id="hits">0</b></span>
        <span>正答率 <b id="acc">—</b></span>
        <span>ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: タイルが「鳴ったら」左右どちらで感じたかで位置を判断し、そのタイルを<kbd>クリック</kbd>。
      ヘッダーの <b>👁 映像 / 👂 音 / ✋ 触覚</b> で切替。<b>👁 映像 OFF</b>＝タイルは光らず<b>触覚の L/R だけ</b>で位置を当てる勝負。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elRound = container.querySelector("#round");
    const elRounds = container.querySelector("#rounds");
    const elHits = container.querySelector("#hits");
    const elAcc = container.querySelector("#acc");
    const elBest = container.querySelector("#best");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");

    function refreshBest() {
      const b = bestScore("spatialalert", diffKey);
      elBest.textContent = b == null ? "—" : `${Math.round(b)}%`;
    }

    for (const k of Object.keys(DIFF)) {
      const b = document.createElement("button");
      b.textContent = DIFF[k].label;
      b.setAttribute("aria-pressed", String(k === diffKey));
      b.onclick = () => {
        diffKey = k;
        for (const c of diffBox.children) c.setAttribute("aria-pressed", String(c === b));
        idle();
      };
      diffBox.appendChild(b);
    }

    // ── grid geometry ────────────────────────────────────────
    const PAD = 24, GAPpx = 14;
    function tileRect(i) {
      const D = DIFF[diffKey];
      const col = i % D.cols, row = (i / D.cols) | 0;
      const tw = (cv.width - PAD * 2 - GAPpx * (D.cols - 1)) / D.cols;
      const th = (cv.height - PAD * 2 - GAPpx * (D.rows - 1)) / D.rows;
      return { x: PAD + col * (tw + GAPpx), y: PAD + row * (th + GAPpx), w: tw, h: th, col, row };
    }
    function tileCenterPan(i) {
      const r = tileRect(i);
      const cx = r.x + r.w / 2;
      // left column => -1, right column => +1
      return Math.max(-1, Math.min(1, (cx - cv.width / 2) / (cv.width / 2)));
    }

    // ── state ────────────────────────────────────────────────
    let phase = "idle"; // idle | gap | listen | done
    let round = 0, hits = 0, fired = -1, nextAt = 0, windowUntil = 0;
    const flash = []; // per-tile flash amount [0..1]
    const mark = []; // per-tile click feedback: {kind:'good'|'bad', t}

    const nowS = () => performance.now() / 1000;

    function idle() {
      clearResult(stagebox);
      phase = "idle";
      round = 0; hits = 0; fired = -1;
      flash.length = 0; mark.length = 0;
      elRound.textContent = "0";
      elHits.textContent = "0";
      elAcc.textContent = "—";
      elRounds.textContent = String(DIFF[diffKey].rounds);
      elState.textContent = DIFF[diffKey].label;
      elMsg.textContent = "";
      refreshBest();
      container.querySelector("#start").textContent = "スタート";
    }

    function start() {
      clearResult(stagebox);
      round = 0; hits = 0; fired = -1;
      flash.length = 0; mark.length = 0;
      elHits.textContent = "0";
      elAcc.textContent = "—";
      elRounds.textContent = String(DIFF[diffKey].rounds);
      elState.textContent = DIFF[diffKey].label;
      container.querySelector("#start").textContent = "リスタート";
      tPrev = performance.now();
      scheduleGap();
    }

    function scheduleGap() {
      phase = "gap";
      fired = -1;
      nextAt = nowS() + DIFF[diffKey].gap;
      elMsg.textContent = "";
    }

    function fireTile() {
      const D = DIFF[diffKey];
      round++;
      elRound.textContent = String(round);
      const n = D.cols * D.rows;
      fired = (Math.random() * n) | 0;
      const pan = tileCenterPan(fired);
      directionCue(bridge, pan, { gain: D.gain, durMs: 110, freq: 170 });
      if (bridge.master.visual) flash[fired] = 1; // see + feel
      phase = "listen";
      windowUntil = nowS() + D.window;
    }

    function resolve(correct, tile) {
      if (correct) {
        hits++;
        elHits.textContent = String(hits);
        const r = tileRect(tile);
        bridge.fire("hot_found", { gain: 0.6 });
        fx.burst(r.x + r.w / 2, r.y + r.h / 2, "#3fb950", 24, 240);
        mark[tile] = { kind: "good", t: 1 };
      } else {
        bridge.fire("hot_timeout", { gain: 0.5 });
        fx.shake(6);
        if (tile >= 0) mark[tile] = { kind: "bad", t: 1 };
        // reveal the true source ONLY with 👁 映像 ON — else it leaks the L/R→tile
        // answer on screen and defeats the touch-only premise.
        if (fired >= 0 && bridge.master.visual) mark[fired] = { kind: "show", t: 1 };
      }
      elAcc.textContent = `${Math.round((hits / round) * 100)}%`;
      if (round >= DIFF[diffKey].rounds) endGame();
      else scheduleGap();
    }

    function endGame() {
      phase = "done";
      const total = DIFF[diffKey].rounds;
      const acc = Math.round((hits / total) * 100);
      const res = submitScore("spatialalert", diffKey, acc, false);
      refreshBest();
      bridge.fire("reflex_win", { gain: 0.55 });
      fx.burst(cv.width / 2, cv.height / 2, "#2dd4bf", 38, 300);
      fx.shake(7);
      showResult(stagebox, {
        title: "🧭 Spatial Alert RESULT",
        badge: res.isBest ? "★ 自己ベスト更新" : "",
        sub: `${hits}/${total} 正解 ・ 正答率 ${acc}%`,
        onRetry: start,
        onMenu: toMenu,
      });
    }

    container.querySelector("#start").onclick = () => {
      bridge.unlockAudio();
      start();
    };

    // ── input ────────────────────────────────────────────────
    function toCanvas(e) {
      const r = cv.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * cv.width,
        y: ((e.clientY - r.top) / r.height) * cv.height,
      };
    }
    function hitTile(p) {
      const n = DIFF[diffKey].cols * DIFF[diffKey].rows;
      for (let i = 0; i < n; i++) {
        const r = tileRect(i);
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i;
      }
      return -1;
    }
    const pd = (e) => {
      bridge.unlockAudio();
      if (phase !== "listen") return;
      const i = hitTile(toCanvas(e));
      if (i < 0) return;
      resolve(i === fired, i);
    };
    cv.addEventListener("pointerdown", pd);

    // ── loop ─────────────────────────────────────────────────
    let raf = 0, tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;

      if (phase === "gap" && nowS() >= nextAt) fireTile();
      else if (phase === "listen" && nowS() >= windowUntil) resolve(false, -1); // timed out

      for (let i = 0; i < flash.length; i++) if (flash[i] > 0) flash[i] = Math.max(0, flash[i] - dt * 2.2);
      for (let i = 0; i < mark.length; i++) if (mark[i] && mark[i].t > 0) {
        mark[i].t = Math.max(0, mark[i].t - dt * 1.3);
        if (mark[i].t <= 0) mark[i] = null;
      }
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      const n = DIFF[diffKey].cols * DIFF[diffKey].rows;
      const listening = phase === "listen";
      for (let i = 0; i < n; i++) {
        const r = tileRect(i);
        // base tile
        g.fillStyle = "#161b22";
        g.strokeStyle = listening ? "#3a4452" : "#2a313c";
        g.lineWidth = 1.5;
        roundRect(g, r.x, r.y, r.w, r.h, 10);
        g.fill();
        g.stroke();

        // visual aid: firing flash (only when 👁 映像 ON)
        const f = flash[i] || 0;
        if (f > 0) {
          g.globalAlpha = f;
          g.fillStyle = "#7c5cff";
          roundRect(g, r.x, r.y, r.w, r.h, 10);
          g.fill();
          g.globalAlpha = 1;
        }

        // click feedback marks
        const m = mark[i];
        if (m && m.t > 0) {
          g.globalAlpha = Math.min(1, m.t);
          g.fillStyle = m.kind === "good" ? "rgba(63,185,80,0.35)" : m.kind === "bad" ? "rgba(248,81,73,0.32)" : "rgba(212,153,34,0.30)";
          roundRect(g, r.x, r.y, r.w, r.h, 10);
          g.fill();
          g.globalAlpha = 1;
        }

        // L / R hint label per column extreme (always — it's a static legend, not the answer)
        const pan = tileCenterPan(i);
        if (Math.abs(pan) > 0.55) {
          g.fillStyle = "#384150";
          g.font = "bold 22px system-ui";
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText(pan < 0 ? "L" : "R", r.x + r.w / 2, r.y + r.h / 2);
        }
      }
      g.textAlign = "left";
      g.textBaseline = "alphabetic";

      fx.restore(g);
      fx.draw(g);

      // status overlays
      g.textAlign = "center";
      if (listening) {
        const left = Math.max(0, windowUntil - nowS());
        g.fillStyle = "#9aa7b4";
        g.font = "13px system-ui";
        g.fillText(
          bridge.master.visual ? "鳴ったタイルをクリック" : "L / R を感じて鳴ったタイルをクリック",
          cv.width / 2,
          16
        );
        // shrinking time bar
        const frac = left / DIFF[diffKey].window;
        g.fillStyle = "#7c5cff";
        g.fillRect(cv.width / 2 - 80, cv.height - 12, 160 * frac, 4);
      } else if (phase === "gap" && round > 0) {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.fillText("…", cv.width / 2, 16);
      }
      if (phase === "idle") {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.fillText("スタートを押す → タイルが鳴ったら、左右どちらで鳴ったかでクリック", cv.width / 2, cv.height / 2);
      }
      g.textAlign = "left";
    }

    function roundRect(c, x, y, w, h, rad) {
      c.beginPath();
      c.moveTo(x + rad, y);
      c.arcTo(x + w, y, x + w, y + h, rad);
      c.arcTo(x + w, y + h, x, y + h, rad);
      c.arcTo(x, y + h, x, y, rad);
      c.arcTo(x, y, x + w, y, rad);
      c.closePath();
    }

    idle();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        cv.removeEventListener("pointerdown", pd);
      },
    };
  },
};