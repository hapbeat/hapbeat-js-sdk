/**
 * Haptic Reflex — 反応速度 (Quick Draw).
 *
 * Hold still. After a random wait, a GO signal fires — as a Hapbeat pulse
 * (and audio/visual if those modalities are on). Press SPACE as fast as you
 * can; we measure your reaction time in milliseconds over several rounds.
 *
 * The pitch: turn the screen GO off (Hard/Expert default) and you must react
 * to the BUZZ alone — showing haptics as a faster-than-vision alert channel you
 * can feel even while looking away. Press during the wait = お手つき (foul).
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../shared/scores.js";

const DIFF = {
  normal: { rounds: 5, waitMin: 1.4, waitMax: 3.5, showGo: true, target: 350, label: "Normal" },
  hard: { rounds: 5, waitMin: 1.2, waitMax: 4.5, showGo: false, target: 300, label: "Hard" },
  expert: { rounds: 6, waitMin: 1.0, waitMax: 5.5, showGo: false, target: 250, label: "Expert" },
};

const GO_TIMEOUT = 1.5; // s — auto-advance if no press after GO (safety, counts as miss)

export const game = {
  id: "reflex",
  emoji: "⚡",
  title: "反応速度",
  en: "Haptic Reflex",
  tag: "触覚＝最速の合図",
  desc: "ランダムな間のあと、GO 合図に最速で反応。画面 GO を消せば「触覚だけ」で反応する勝負に。視覚より速い警告チャネルを体感。",
  formatScore: (v) => `${Math.round(v)} ms`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    let diffKey = "normal";
    let showGo = DIFF[diffKey].showGo;

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">難易度</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="showgo" aria-pressed="${showGo}">GO を画面表示</button>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="420"></canvas>
      </div>
      <div class="hud">
        <span>ラウンド <b id="round">0</b>/<b id="rounds">5</b></span>
        <span>前回 <b id="last">—</b></span>
        <span>平均 <b id="avg">—</b></span>
        <span>自己ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: GO を感じたら最速で <kbd>Space</kbd>（クリックでも可）。待っている間に押すと <b>お手つき</b>。
      音・触覚はヘッダーの 🔊 / 📳。Hard / Expert は GO 画面表示が既定 OFF＝<b>触覚だけ</b>で反応する勝負。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const stagebox = container.querySelector(".stagebox");
    const elRound = container.querySelector("#round");
    const elRounds = container.querySelector("#rounds");
    const elLast = container.querySelector("#last");
    const elAvg = container.querySelector("#avg");
    const elBest = container.querySelector("#best");
    const elState = container.querySelector("#state");
    const diffBox = container.querySelector("#diff");
    const showGoBtn = container.querySelector("#showgo");

    function refreshBest() {
      const b = bestScore("reflex", diffKey);
      elBest.textContent = b == null ? "—" : `${Math.round(b)}ms`;
    }

    for (const k of Object.keys(DIFF)) {
      const b = document.createElement("button");
      b.textContent = DIFF[k].label;
      b.setAttribute("aria-pressed", String(k === diffKey));
      b.onclick = () => {
        diffKey = k;
        for (const c of diffBox.children) c.setAttribute("aria-pressed", String(c === b));
        showGo = DIFF[k].showGo;
        showGoBtn.setAttribute("aria-pressed", String(showGo));
        elRounds.textContent = String(DIFF[k].rounds);
        refreshBest();
        idle();
      };
      diffBox.appendChild(b);
    }
    showGoBtn.onclick = () => {
      showGo = !showGo;
      showGoBtn.setAttribute("aria-pressed", String(showGo));
    };

    // ── state ────────────────────────────────────────────────
    const fx = new Fx();
    let phase = "idle"; // idle | wait | go | between | done
    let round = 0,
      times = [],
      fouls = 0, // false starts (pressed during the wait)
      misses = 0, // GO-timeouts (too slow / no reaction)
      goAt = 0,
      waitUntil = 0,
      nextAt = 0,
      lastMs = 0,
      flash = 0,
      statusText = "スタートを押して構える";

    const nowMs = () => performance.now();

    function idle() {
      clearResult(stagebox);
      phase = "idle";
      round = 0;
      times = [];
      fouls = 0;
      misses = 0;
      lastMs = 0;
      statusText = "スタートを押して構える";
      elRound.textContent = "0";
      elLast.textContent = "—";
      elAvg.textContent = "—";
      elState.textContent = DIFF[diffKey].label;
      container.querySelector("#start").textContent = "スタート";
    }

    function startGame() {
      clearResult(stagebox);
      round = 0;
      times = [];
      fouls = 0;
      misses = 0;
      container.querySelector("#start").textContent = "リスタート";
      beginRound();
    }

    function armRound() {
      phase = "wait";
      const D = DIFF[diffKey];
      const d = D.waitMin + Math.random() * (D.waitMax - D.waitMin);
      waitUntil = nowMs() + d * 1000;
      statusText = "構えて…";
    }

    function beginRound() {
      round++;
      elRound.textContent = String(round);
      if (round > DIFF[diffKey].rounds) {
        finish();
        return;
      }
      armRound();
    }

    function fireGo() {
      phase = "go";
      goAt = nowMs();
      bridge.fire("reflex_go", { gain: 0.75 });
      // shake is a VISUAL cue — gate it on showGo, else it leaks the GO timing
      // and defeats the "react to the buzz alone" point on Hard/Expert.
      if (showGo) {
        fx.shake(5);
        flash = 1;
        statusText = "！";
      }
      // if showGo is off, the screen does NOT change — you must feel/hear GO.
    }

    function press() {
      bridge.unlockAudio();
      if (phase === "wait") {
        // flying start
        fouls++;
        bridge.fire("reflex_foul", { gain: 0.6 });
        fx.shake(10);
        statusText = "お手つき！";
        phase = "between";
        nextAt = nowMs() + 1000;
        return;
      }
      if (phase === "go") {
        const ms = nowMs() - goAt;
        lastMs = ms;
        times.push(ms);
        elLast.textContent = `${Math.round(ms)}ms`;
        updateAvg();
        fx.burst(cv.width / 2, cv.height / 2, ratingColor(ms), 26, 260);
        fx.shake(6);
        statusText = `${Math.round(ms)} ms`;
        phase = "between";
        nextAt = nowMs() + 1100;
        return;
      }
      // idle / between / done → ignore (no penalty)
    }

    function updateAvg() {
      if (!times.length) {
        elAvg.textContent = "—";
        return;
      }
      const a = times.reduce((s, x) => s + x, 0) / times.length;
      elAvg.textContent = `${Math.round(a)}ms`;
    }

    function finish() {
      phase = "done";
      statusText = "";
      const rounds = DIFF[diffKey].rounds;
      let sub,
        badge = "";
      if (times.length) {
        const avg = times.reduce((s, x) => s + x, 0) / times.length;
        // only a fully-clean run (every round reacted to) sets a best,
        // so a single lucky round among fouls/timeouts can't post a bogus record
        let res = { isBest: false };
        const clean = times.length === rounds;
        if (clean) {
          res = submitScore("reflex", diffKey, avg, true);
          refreshBest();
        }
        bridge.fire("reflex_win", { gain: 0.6 });
        fx.burst(cv.width / 2, cv.height / 2, "#2dd4bf", 40, 300);
        fx.shake(8);
        badge = res.isBest ? "★ 自己ベスト更新" : "";
        const tail = clean ? "" : " ・ 記録は全周回クリアで成立";
        sub = `平均 ${Math.round(avg)}ms（最速 ${Math.round(Math.min(...times))}ms） ・ お手つき ${fouls} ・ 遅延 ${misses}${tail}`;
      } else {
        sub = `記録なし ・ お手つき ${fouls} ・ 遅延 ${misses}`;
      }
      showResult(stagebox, {
        title: "⚡ 反応速度 RESULT",
        badge,
        sub,
        onRetry: startGame,
        onMenu: toMenu,
      });
    }

    container.querySelector("#start").onclick = () => {
      bridge.unlockAudio();
      startGame();
    };

    function ratingColor(ms) {
      return ms < DIFF[diffKey].target ? "#2dd4bf" : ms < DIFF[diffKey].target + 150 ? "#3fb950" : "#d29922";
    }

    // input
    const kd = (e) => {
      if (e.code === "Space" || e.key === " ") {
        // when the result overlay is up, let Space activate the focused button
        if (stagebox.querySelector(".result")) return;
        e.preventDefault();
        press();
      }
    };
    window.addEventListener("keydown", kd);
    cv.addEventListener("pointerdown", press);

    // loop
    let raf = 0,
      tPrev = nowMs();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;

      if (phase === "wait" && nowMs() >= waitUntil) fireGo();
      else if (phase === "go" && nowMs() - goAt > GO_TIMEOUT * 1000) {
        // no reaction — a miss (NOT a false-start foul), advance
        misses++;
        statusText = "遅すぎ…";
        phase = "between";
        nextAt = nowMs() + 1000;
      } else if (phase === "between" && nowMs() >= nextAt) beginRound();

      fx.update(dt);
      flash = Math.max(0, flash - dt * 4);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function draw() {
      // background by phase
      let bg = "#0a0d12";
      if (phase === "go" && showGo) bg = "#241f50";
      g.fillStyle = bg;
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);
      // GO flash
      if (flash > 0) {
        g.globalAlpha = flash * 0.5;
        g.fillStyle = "#7c5cff";
        g.fillRect(0, 0, cv.width, cv.height);
        g.globalAlpha = 1;
      }
      // central status
      g.fillStyle = phase === "go" && showGo ? "#ffffff" : "#cdd6e0";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = phase === "go" && showGo ? "bold 64px system-ui" : "28px system-ui";
      g.fillText(statusText, cv.width / 2, cv.height / 2 - 10);
      if (phase === "go" && !showGo) {
        g.font = "13px system-ui";
        g.fillStyle = "#4b5666";
        g.fillText("（GO 表示 OFF：触覚 / 音で反応）", cv.width / 2, cv.height / 2 + 40);
      }
      fx.restore(g);
      fx.draw(g);

      // reaction history strip
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      const n = DIFF[diffKey].rounds;
      const w = cv.width - 80;
      const x0 = 40,
        y0 = cv.height - 26;
      for (let i = 0; i < n; i++) {
        const cx = x0 + (w * (i + 0.5)) / n;
        g.strokeStyle = "#2a313c";
        g.beginPath();
        g.arc(cx, y0, 10, 0, Math.PI * 2);
        g.stroke();
        if (i < times.length) {
          g.fillStyle = ratingColor(times[i]);
          g.beginPath();
          g.arc(cx, y0, 8, 0, Math.PI * 2);
          g.fill();
        }
      }
    }

    elRounds.textContent = String(DIFF[diffKey].rounds);
    refreshBest();
    idle();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
      },
    };
  },
};
