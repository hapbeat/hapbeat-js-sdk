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
import { Pad, BTN } from "../shared/gamepad.js";
import { modalityControls, padModality, playerNameField, activeMods } from "../shared/controls.js";
import { createRanking } from "../shared/ranking.js";

// Single fixed config — 5 rounds, no difficulty selector (kept simple per request).
const CFG = { rounds: 5, waitMin: 1.4, waitMax: 4.0, target: 300 };

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
    // GO の画面表示はヘッダーの 👁 映像 マスターに連動（OFF＝触覚だけで反応）。
    const visualOn = () => bridge.master.visual;

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">反応速度（5回固定）</span>
        <span class="spacer"></span>
        <span id="modslot"></span>
        <button id="start" class="primary"><span id="startlbl">スタート</span> <span class="padkey k-a">A</span></button>
        <button id="stop" class="danger">ストップ <span class="padkey k-menu">☰</span></button>
        <span id="nameslot"></span>
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
      <p class="note">操作: GO を感じたら最速で <kbd>Space</kbd>（クリック / パッド <b>Ⓐ</b> でも可）。待っている間に押すと <b>お手つき</b>。
      パッド: <b>Ⓐ</b>=反応 / <b>☰</b>=スタート・ストップ / <b>Ⓥ(View)</b>=メニュー。開始前は <b>Ⓧ/Ⓨ/Ⓑ</b>=映像/音/触覚 切替。
      <b>👁映像/👂音/✋触覚</b>（上のボタン or パッド）で切替。<b>👁 映像 OFF</b>＝<b>触覚だけ</b>で反応する勝負。
      映像と触覚は<b>同じ瞬間</b>に発火します（どちらが速く“感じる”かは人による）。</p>
      <div class="rankpanel" id="rankpanel"></div>
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
    const startBtn = container.querySelector("#start");
    const startLbl = container.querySelector("#startlbl");
    const stopBtn = container.querySelector("#stop");
    const isRunning = () => phase === "wait" || phase === "go" || phase === "between";
    function updateButtons() {
      startLbl.textContent = phase === "idle" ? "スタート" : "リスタート";
      stopBtn.disabled = !isRunning();
      mods.setLocked(isRunning());
    }

    // modality toggles (between 難易度 and start) + persisted player name + ranking
    const mods = modalityControls(bridge);
    container.querySelector("#modslot").appendChild(mods.el);
    const nameField = playerNameField();
    container.querySelector("#nameslot").appendChild(nameField.el);
    const rank = createRanking("reflex", {
      title: "反応速度",
      columns: [{ key: "ms", label: "平均", unit: "ms", decimals: 0, lowerIsBetter: true, primary: true }],
    });
    const rankPanel = container.querySelector("#rankpanel");
    const disposeRank = rank.mountPanel(rankPanel);

    function refreshBest() {
      const b = bestScore("reflex", "fixed");
      elBest.textContent = b == null ? "—" : `${Math.round(b)}ms`;
    }

    // ── state ────────────────────────────────────────────────
    const fx = new Fx();
    const pad = new Pad();
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
      elState.textContent = "";
      updateButtons();
    }

    function startGame() {
      clearResult(stagebox);
      nameField.roll(); // fresh random name suggestion for this play
      round = 0;
      times = [];
      fouls = 0;
      misses = 0;
      beginRound();
      updateButtons();
    }

    function armRound() {
      phase = "wait";
      const d = CFG.waitMin + Math.random() * (CFG.waitMax - CFG.waitMin);
      waitUntil = nowMs() + d * 1000;
      statusText = "構えて…";
    }

    function beginRound() {
      round++;
      elRound.textContent = String(round);
      if (round > CFG.rounds) {
        finish();
        return;
      }
      armRound();
    }

    function fireGo() {
      phase = "go";
      goAt = nowMs();
      bridge.fire("reflex_go", { gain: 0.75 });
      // shake is a VISUAL cue — gate it on visualOn(), else it leaks the GO timing
      // and defeats the "react to the buzz alone" point on Hard/Expert.
      if (visualOn()) {
        fx.shake(5);
        flash = 1;
        statusText = "！";
      }
      // if visualOn() is off, the screen does NOT change — you must feel/hear GO.
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
      updateButtons();
      const rounds = CFG.rounds;
      let sub,
        badge = "";
      if (times.length) {
        const avg = times.reduce((s, x) => s + x, 0) / times.length;
        // only a fully-clean run (every round reacted to) sets a best / posts to
        // the ranking, so a single lucky round among fouls/timeouts can't post a
        // bogus record
        let res = { isBest: false };
        const clean = times.length === rounds;
        if (clean) {
          res = submitScore("reflex", "fixed", avg, true);
          refreshBest();
          rank.record({
            name: nameField.get(),
            metrics: { ms: avg },
            mods: activeMods(bridge),
            detail: `最速 ${Math.round(Math.min(...times))}ms ・ お手つき ${fouls}`,
          });
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

    startBtn.onclick = () => {
      bridge.unlockAudio();
      startGame();
    };
    stopBtn.onclick = () => idle(); // end the run and return to the pre-start state

    function ratingColor(ms) {
      return ms < CFG.target ? "#2dd4bf" : ms < CFG.target + 150 ? "#3fb950" : "#d29922";
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

      // gamepad: A/RT=react or start, ☰=start/stop, Ⓥ(View)=menu.
      // Ⓧ/Ⓨ/Ⓑ toggle 映像/音/触覚 but only while NOT running (locked mid-game).
      const G = pad.poll();
      if (G.connected) {
        const running = isRunning();
        padModality(G, bridge, running); // X/Y/B modality, idle-only
        if (G.isDown(BTN.A) || G.isDown(BTN.RT)) {
          if (running) press();
          else startGame();
        }
        if (G.isDown(BTN.MENU)) running ? idle() : startGame(); // ☰ = start / stop
        if (G.isDown(BTN.VIEW)) toMenu(); // back to menu any time
      }

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
      if (phase === "go" && visualOn()) bg = "#241f50";
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
      g.fillStyle = phase === "go" && visualOn() ? "#ffffff" : "#cdd6e0";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = phase === "go" && visualOn() ? "bold 64px system-ui" : "28px system-ui";
      g.fillText(statusText, cv.width / 2, cv.height / 2 - 10);
      // ALWAYS-on operation legend — constant text AND position so its appearance
      // never cues the GO timing (the old GO-only hint leaked it on Hard/Expert).
      g.font = "15px system-ui";
      g.fillStyle = "#8b97a6";
      g.fillText("通知が来たら クリック / Space / Ⓐ で反応", cv.width / 2, cv.height / 2 + 44);
      if (!visualOn()) {
        // a master-switch state (locked mid-run), so it doesn't change on GO either
        g.font = "12px system-ui";
        g.fillStyle = "#5a6677";
        g.fillText("（👁 映像 OFF：触覚 / 音だけで反応）", cv.width / 2, cv.height / 2 + 70);
      }
      fx.restore(g);
      fx.draw(g);

      // reaction history strip
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      const n = CFG.rounds;
      const w = cv.width - 80;
      const x0 = 40,
        y0 = cv.height - 26;
      for (let i = 0; i < n; i++) {
        const cx = x0 + (w * (i + 0.5)) / n;
        g.strokeStyle = "#4a5564";
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

    elRounds.textContent = String(CFG.rounds);
    refreshBest();
    idle();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
        mods.dispose();
        disposeRank();
      },
    };
  },
};
