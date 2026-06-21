/**
 * Notice Test — 気づけるか (dual-task / divided-attention demo).
 *
 * Two input VERSIONS (pick in the toolbar; auto-switches to gamepad on connect):
 *   ⌨ キーボード — the TASK shows a digit; type that digit (number keys / numpad)
 *                  and press Enter. NOTICE response = Space.
 *   🎮 ゲームパッド — an Xbox controller is drawn; the TASK lights up ONE button
 *                  (ABXY / D-pad / View・Menu) — press it. NOTICE response = BOTH
 *                  triggers (LT+RT). Every button press lights live on the drawing,
 *                  so you can first confirm the controller is detected at all.
 *
 * Paradigm (kept): a self-paced primary TASK (press-to-advance, fixed total N →
 * clear-time) + a PVT-style NOTICE that fires at random intervals on every ENABLED
 * channel (👁 edge-flash / 👂 chime / ✋ buzz). React ASAP; no response within the
 * window is a MISS (lapse). Score = notice reaction-time mean/sum → shows that
 * haptic stays fast while eyes/hands are busy. Toggle 👁/👂/✋ to A/B the channels.
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";
import { stereoBlip } from "../shared/synth.js";

const N_TASKS = 24;
const ISI_MIN = 1400, ISI_MAX = 3000;
const NOTICE_WINDOW = 1300;
const GAP_MIN = 250, GAP_MAX = 550;

// standard Gamepad mapping: button index → { svg id, label }
const GP_BTN = {
  0: { id: "b-a", label: "A" }, 1: { id: "b-b", label: "B" }, 2: { id: "b-x", label: "X" }, 3: { id: "b-y", label: "Y" },
  4: { id: "bump-l", label: "LB" }, 5: { id: "bump-r", label: "RB" },
  6: { id: "t-l", label: "LT" }, 7: { id: "t-r", label: "RT" },
  8: { id: "c-view", label: "View" }, 9: { id: "c-menu", label: "Menu" },
  10: { id: "s-l", label: "L3" }, 11: { id: "s-r", label: "R3" },
  12: { id: "d-up", label: "↑" }, 13: { id: "d-down", label: "↓" }, 14: { id: "d-left", label: "←" }, 15: { id: "d-right", label: "→" },
  16: { id: "c-guide", label: "Xbox" },
};
const TASK_BTNS = [0, 1, 2, 3, 12, 13, 14, 15, 8, 9]; // task targets (Guide is OS-reserved → excluded)

const CONTROLLER_SVG = `
<svg class="gp-svg" viewBox="0 0 340 180" width="100%" height="160" xmlns="http://www.w3.org/2000/svg">
  <rect class="btn" id="t-l" x="66" y="2" width="48" height="15" rx="6"/>
  <rect class="btn" id="t-r" x="226" y="2" width="48" height="15" rx="6"/>
  <rect class="btn" id="bump-l" x="62" y="20" width="58" height="12" rx="6"/>
  <rect class="btn" id="bump-r" x="220" y="20" width="58" height="12" rx="6"/>
  <path d="M70 38 H270 a52 52 0 0 1 50 52 a40 40 0 0 1-78 12 q-72 22-144 0 a40 40 0 0 1-78-12 a52 52 0 0 1 50-52 Z" fill="#222a35" stroke="#11151b" stroke-width="2"/>
  <circle class="btn" id="s-l" cx="90" cy="74" r="17"/>
  <circle class="btn" id="s-r" cx="205" cy="118" r="17"/>
  <rect class="btn" id="d-up" x="122" y="100" width="15" height="15" rx="3"/>
  <rect class="btn" id="d-down" x="122" y="124" width="15" height="15" rx="3"/>
  <rect class="btn" id="d-left" x="106" y="116" width="15" height="15" rx="3"/>
  <rect class="btn" id="d-right" x="138" y="116" width="15" height="15" rx="3"/>
  <circle class="btn yc" id="b-y" cx="250" cy="58" r="12"/>
  <circle class="btn xc" id="b-x" cx="228" cy="78" r="12"/>
  <circle class="btn bc" id="b-b" cx="272" cy="78" r="12"/>
  <circle class="btn ac" id="b-a" cx="250" cy="98" r="12"/>
  <circle class="btn" id="c-view" cx="150" cy="72" r="7"/>
  <circle class="btn" id="c-guide" cx="170" cy="62" r="9"/>
  <circle class="btn" id="c-menu" cx="190" cy="72" r="7"/>
  <text x="250" y="58">Y</text><text x="228" y="78">X</text><text x="272" y="78">B</text><text x="250" y="98">A</text>
  <text x="129" y="107">↑</text><text x="129" y="131">↓</text><text x="113" y="123">←</text><text x="145" y="123">→</text>
</svg>`;

export const game = {
  id: "notice",
  emoji: "🔔",
  title: "気づけるか",
  en: "Notice Test",
  tag: "ながら作業中の気づき (効果体験)",
  desc: "課題(task)をこなしながら、上部 👁/👂/✋ で選んだ通知(notice)に気づけるか。通知の反応時間でモダリティ差を可視化（触覚は「ながら」でも速い）。キーボード版／ゲームパッド版。",
  formatScore: (v) => `${Math.round(v)} ms`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let version = "keyboard"; // "keyboard" | "gamepad"
    let userPicked = false;   // once the user picks a version, stop auto-switching

    container.innerHTML = `
      <style>
        .gp-wrap { margin: 8px 0 2px; padding: 8px; border-radius: 10px; background: #11151b; border: 1px solid #2a313c; }
        .gp-wrap.hidden { display: none; }
        .gp-svg .btn { fill: #3a414c; stroke: #11151b; stroke-width: 1.5; transition: fill .04s; }
        .gp-svg .btn.ac { fill: #2f6f4e; } .gp-svg .btn.bc { fill: #7a3030; }
        .gp-svg .btn.xc { fill: #2f4d7a; } .gp-svg .btn.yc { fill: #7a6a2f; }
        .gp-svg .btn.target { fill: #ffd23a !important; stroke: #fff; }
        .gp-svg .btn.pressed { fill: #3fb950 !important; }
        .gp-svg .btn.target.pressed { fill: #2dd4bf !important; }
        .gp-svg text { fill: #cdd6e0; font: bold 10px system-ui; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
        .gp-stat { text-align: center; font-size: 12px; color: #8b97a6; margin-top: 4px; }
        .gp-stat b { color: #e6edf3; }
      </style>
      <div class="gametoolbar">
        <span class="label">入力</span>
        <div class="toggle-group" id="ver"></div>
        <span class="spacer"></span>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="360"></canvas>
      </div>
      <div class="gp-wrap hidden" id="gpwrap">
        ${CONTROLLER_SVG}
        <div class="gp-stat">🎮 <b id="gpdet">未検出</b> ・ 入力確認: <b id="gplast">—</b> ／ 通知=<b>LT+RT 両押し</b></div>
      </div>
      <div class="hud">
        <span>課題 <b id="prog">0</b>/${N_TASKS}</span>
        <span>通知RT平均 <b id="mean">—</b></span>
        <span>見逃し <b id="miss">0</b></span>
        <span>前回 <b id="last">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note"><b>狙い</b>：目や手がふさがった「ながら」で通知に気づけるか、を反応時間で測る二重課題。
      <b>課題(task)</b>＝<span id="taskhelp"></span>（押さないと進まない・全${N_TASKS}問）。
      <b>通知(notice)</b>＝作業中ランダムに通知（👁画面端／👂チャイム／✋ブザー）。気づいたら最速で反応（キーボード=<b>Space</b>／パッド=<b>LT+RT</b>）。
      通知は<b>上部 👁/👂/✋ で ON の感覚すべて</b>から。<b>✋ だけ</b>にして比べると、目手がふさがっても触覚は速く確実。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const stagebox = container.querySelector(".stagebox");
    const elProg = container.querySelector("#prog");
    const elMean = container.querySelector("#mean");
    const elMiss = container.querySelector("#miss");
    const elLast = container.querySelector("#last");
    const elState = container.querySelector("#state");
    const verBox = container.querySelector("#ver");
    const gpwrap = container.querySelector("#gpwrap");
    const gpDet = container.querySelector("#gpdet");
    const gpLast = container.querySelector("#gplast");
    const taskHelp = container.querySelector("#taskhelp");
    // map svg button ids → elements (scoped to this container)
    const svgEls = {};
    for (const k of Object.keys(GP_BTN)) { const el = container.querySelector("#" + GP_BTN[k].id); if (el) svgEls[GP_BTN[k].id] = el; }

    for (const [k, lbl] of [["keyboard", "⌨ キーボード"], ["gamepad", "🎮 ゲームパッド"]]) {
      const b = document.createElement("button");
      b.textContent = lbl; b.dataset.ver = k;
      b.setAttribute("aria-pressed", String(k === version));
      b.onclick = () => { userPicked = true; setVersion(k); };
      verBox.appendChild(b);
    }
    function setVersion(v) {
      version = v;
      for (const c of verBox.children) c.setAttribute("aria-pressed", String(c.dataset.ver === v));
      gpwrap.classList.toggle("hidden", v !== "gamepad");
      taskHelp.innerHTML = v === "keyboard"
        ? "表示された<b>数字</b>を入力して <b>Enter</b>（テンキー想定）"
        : "光った<b>ボタン</b>（ABXY / 十字 / View・Menu）を押す";
      idle();
    }

    // ── WebAudio: task ping + notice CHIME (gated on 👂) ────────────────────────
    let ac = null;
    function actx() { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === "suspended") ac.resume(); return ac; }
    function chime() {
      try {
        const a = actx();
        [784, 1047, 1397].forEach((f, i) => {
          const o = a.createOscillator(), gn = a.createGain();
          o.type = "triangle"; o.frequency.value = f;
          const t = a.currentTime + i * 0.09;
          gn.gain.setValueAtTime(0.0001, t);
          gn.gain.exponentialRampToValueAtTime(0.24, t + 0.012);
          gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          o.connect(gn).connect(a.destination); o.start(t); o.stop(t + 0.18);
        });
      } catch { /* no audio */ }
    }

    // ── state ────────────────────────────────────────────────────────────────
    let phase = "idle"; // idle | run | done
    let taskDone, taskWrong, taskRTs, taskActive, taskShownAt, taskNextAt;
    let targetDigit, entry, targetBtn; // keyboard digit / typed entry / gamepad target index
    let noticeActive, noticeFiredAt, noticeNextAt, noticeRTs, noticeMiss, noticeCount;
    let runStart, lastMs, lastMissed, edgeFlash, taskFlash, wrongFlash, hintUntil;
    let gpPrev = [], gpBothPrev = false;

    const randDigit = () => 1 + Math.floor(Math.random() * 9);
    const rnd = (a, b) => a + Math.random() * (b - a);
    const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    function activeMods() {
      return ([bridge.master.visual && "👁", bridge.master.audio && "👂", bridge.master.haptic && "✋"].filter(Boolean).join("")) || "なし";
    }
    function setTargetHighlight(id) {
      for (const k of Object.keys(svgEls)) svgEls[k].classList.remove("target");
      if (id && svgEls[id]) svgEls[id].classList.add("target");
    }

    function idle() {
      clearResult(stagebox);
      phase = "idle";
      taskDone = 0; taskWrong = 0; taskRTs = [];
      taskActive = false; taskShownAt = 0; taskNextAt = 0;
      targetDigit = 0; entry = ""; targetBtn = -1;
      noticeActive = false; noticeFiredAt = 0; noticeNextAt = 0; noticeRTs = []; noticeMiss = 0; noticeCount = 0;
      lastMs = 0; lastMissed = false; edgeFlash = 0; taskFlash = 0; wrongFlash = 0; hintUntil = 0;
      elProg.textContent = "0"; elMean.textContent = "—"; elMiss.textContent = "0"; elLast.textContent = "—";
      elState.textContent = version === "keyboard" ? "キーボード版" : "ゲームパッド版";
      setTargetHighlight(null);
      container.querySelector("#start").textContent = "スタート";
    }

    function startRun() {
      idle();
      phase = "run";
      runStart = performance.now();
      taskNextAt = runStart + 500;
      noticeNextAt = runStart + rnd(ISI_MIN, ISI_MAX);
      container.querySelector("#start").textContent = "リスタート";
      bridge.unlockAudio(); actx();
    }

    function showTask(now) {
      if (version === "keyboard") { targetDigit = randDigit(); entry = ""; }
      else { targetBtn = TASK_BTNS[Math.floor(Math.random() * TASK_BTNS.length)]; setTargetHighlight(GP_BTN[targetBtn].id); }
      taskActive = true; taskShownAt = now;
    }
    function advanceTask(now) {
      taskRTs.push(now - taskShownAt);
      taskActive = false; entry = ""; setTargetHighlight(null);
      taskDone++; elProg.textContent = String(taskDone);
      taskFlash = 0.5;
      if (taskDone >= N_TASKS) return finish();
      taskNextAt = now + rnd(GAP_MIN, GAP_MAX);
    }
    function wrongTask() { wrongFlash = 0.5; taskWrong++; entry = ""; }

    function fireNotice(now) {
      noticeCount++;
      if (bridge.master.visual) edgeFlash = 1;
      if (bridge.master.audio) chime();
      if (bridge.master.haptic) {
        bridge.streamPcm(stereoBlip(0, { gain: 0.95, durMs: 110, freq: 180 }), { channels: 2, sampleRate: 16000, gain: 1 });
        bridge.fire("reflex_go", { audio: false, gain: 0.85 });
      }
      noticeActive = true; noticeFiredAt = now;
    }
    function scheduleNotice(now) { noticeNextAt = now + rnd(ISI_MIN, ISI_MAX); }
    function pressNotice() {
      if (phase !== "run") return;
      bridge.unlockAudio();
      const now = performance.now();
      if (!noticeActive) { hintUntil = now + 700; return; } // false start (no notice yet)
      const ms = now - noticeFiredAt;
      noticeRTs.push(ms); lastMs = ms; lastMissed = false;
      elLast.textContent = `${Math.round(ms)}ms`;
      const m = meanOf(noticeRTs); elMean.textContent = m == null ? "—" : `${Math.round(m)}ms`;
      fx.burst(cv.width / 2, cv.height / 2, ms < 500 ? "#2dd4bf" : ms < 1000 ? "#3fb950" : "#d29922", 24, 240);
      fx.shake(5);
      noticeActive = false; scheduleNotice(now);
    }
    function noticeMissNow(now) {
      noticeMiss++; elMiss.textContent = String(noticeMiss);
      lastMissed = true; lastMs = NOTICE_WINDOW; elLast.textContent = "見逃し";
      noticeActive = false; scheduleNotice(now);
    }

    function finish() {
      phase = "done";
      if (noticeActive) { noticeCount--; noticeActive = false; }
      setTargetHighlight(null);
      bridge.fire("reflex_win", { gain: 0.55 });
      fx.burst(cv.width / 2, cv.height / 2, "#7c5cff", 36, 300);
      const mean = meanOf(noticeRTs);
      const sum = noticeRTs.reduce((a, b) => a + b, 0);
      const clearS = ((performance.now() - runStart) / 1000).toFixed(1);
      const sub =
        `入力:${version === "keyboard" ? "キーボード" : "ゲームパッド"} ／ 通知ch:${activeMods()}\n` +
        `通知 反応 平均 ${mean == null ? "—" : Math.round(mean) + "ms"} ・ 合計 ${Math.round(sum)}ms ・ ` +
        `気づき ${noticeRTs.length}/${noticeCount} (見逃し ${noticeMiss}) ／ 課題クリア ${clearS}s` +
        (taskWrong ? ` ・ 誤入力 ${taskWrong}` : "");
      showResult(stagebox, { title: "🔔 結果", badge: "通知を ✋ だけにして比べてみよう", sub, onRetry: startRun, onMenu: toMenu });
    }

    // ── keyboard input ─────────────────────────────────────────────────────────
    container.querySelector("#start").onclick = () => { bridge.unlockAudio(); startRun(); };
    const kd = (e) => {
      if (stagebox.querySelector(".result")) {
        if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); startRun(); }
        return;
      }
      if (e.code === "Space") { e.preventDefault(); pressNotice(); return; }
      if (version !== "keyboard") return;
      if (phase !== "run") { if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); startRun(); } return; }
      const d = e.key >= "0" && e.key <= "9" ? e.key : null;
      if (d) { e.preventDefault(); if (taskActive) entry = d; }
      else if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        if (!taskActive) return;
        if (entry && entry === String(targetDigit)) advanceTask(performance.now()); else wrongTask();
      } else if (e.code === "Backspace") { e.preventDefault(); entry = ""; }
    };
    window.addEventListener("keydown", kd);

    // ── gamepad input + live detection ──────────────────────────────────────────
    function pollGamepad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const p of pads) if (p) { gp = p; break; }
      if (!gp) { gpDet.textContent = "未検出"; gpPrev = []; gpBothPrev = false; return; }
      gpDet.textContent = "接続OK";
      // default to the gamepad UI when a pad appears, but never override a manual
      // pick, and only while idle (don't yank the version mid-run)
      if (version !== "gamepad" && !userPicked && phase === "idle") setVersion("gamepad");
      let down = -1;
      for (let i = 0; i < gp.buttons.length; i++) {
        const pressed = !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
        const prev = !!gpPrev[i];
        gpPrev[i] = pressed;
        const m = GP_BTN[i];
        if (m && svgEls[m.id]) svgEls[m.id].classList.toggle("pressed", pressed); // LIVE highlight (detection)
        if (pressed && !prev) { down = i; onGpDown(i); }
      }
      if (down >= 0) gpLast.textContent = `btn${down}${GP_BTN[down] ? " (" + GP_BTN[down].label + ")" : ""}`;
      // NOTICE = both triggers held
      const both = !!(gp.buttons[6] && (gp.buttons[6].pressed || gp.buttons[6].value > 0.5)) &&
                   !!(gp.buttons[7] && (gp.buttons[7].pressed || gp.buttons[7].value > 0.5));
      if (version === "gamepad" && both && !gpBothPrev) pressNotice();
      gpBothPrev = both;
    }
    function onGpDown(i) {
      if (version !== "gamepad") return;
      if (i === 6 || i === 7) return; // triggers → notice (handled as a pair)
      if (phase !== "run") { if (i === 0) startRun(); return; } // A starts
      if (i === targetBtn) advanceTask(performance.now());
      else if (TASK_BTNS.includes(i)) wrongTask();
    }

    // ── loop ───────────────────────────────────────────────────────────────────
    let raf = 0, tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000); tPrev = ts;
      const now = performance.now();
      pollGamepad();
      if (phase === "run") {
        if (!taskActive && taskDone < N_TASKS && now >= taskNextAt) showTask(now);
        if (!noticeActive && now >= noticeNextAt) fireNotice(now);
        if (noticeActive && now - noticeFiredAt > NOTICE_WINDOW) noticeMissNow(now);
      }
      fx.update(dt);
      edgeFlash = Math.max(0, edgeFlash - dt * 1.6);
      taskFlash = Math.max(0, taskFlash - dt * 3);
      wrongFlash = Math.max(0, wrongFlash - dt * 3);
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    function draw(now) {
      g.fillStyle = "#0a0d12"; g.fillRect(0, 0, cv.width, cv.height);
      if (edgeFlash > 0) {
        g.fillStyle = `rgba(248,81,73,${edgeFlash})`; const t = 24;
        g.fillRect(0, 0, cv.width, t); g.fillRect(0, cv.height - t, cv.width, t);
        g.fillRect(0, 0, t, cv.height); g.fillRect(cv.width - t, 0, t, cv.height);
      }
      fx.apply(g);
      g.textAlign = "center"; g.textBaseline = "middle";
      if (phase === "run") {
        if (taskActive && version === "keyboard") {
          g.fillStyle = "#7c5cff"; g.font = "16px system-ui"; g.fillText("この数字を入力 → Enter", cv.width / 2, 40);
          g.fillStyle = "#e6edf3"; g.font = "bold 120px system-ui"; g.fillText(String(targetDigit), cv.width / 2, cv.height / 2 - 6);
          g.fillStyle = entry ? "#2dd4bf" : "#39424f"; g.font = "34px system-ui"; g.fillText(`入力: ${entry || "_"}`, cv.width / 2, cv.height / 2 + 86);
        } else if (taskActive && version === "gamepad") {
          g.fillStyle = "#7c5cff"; g.font = "16px system-ui"; g.fillText("光ったボタンを押す（下のコントローラ）", cv.width / 2, 40);
          g.fillStyle = "#ffd23a"; g.font = "bold 96px system-ui"; g.fillText(GP_BTN[targetBtn].label, cv.width / 2, cv.height / 2);
        } else {
          g.fillStyle = "#39424f"; g.font = "100px system-ui"; g.fillText("·", cv.width / 2, cv.height / 2);
        }
        if (taskFlash > 0) { g.globalAlpha = Math.min(1, taskFlash * 1.6); g.fillStyle = "#3fb950"; g.font = "22px system-ui"; g.fillText("課題 ✓", 90, 30); g.globalAlpha = 1; }
        if (wrongFlash > 0) { g.globalAlpha = Math.min(1, wrongFlash * 1.6); g.fillStyle = "#f85149"; g.font = "22px system-ui"; g.fillText("✗", cv.width - 60, 30); g.globalAlpha = 1; }
        if (now < hintUntil) { g.fillStyle = "#6f7c8c"; g.font = "15px system-ui"; g.fillText("まだ通知は出ていません", cv.width / 2, cv.height - 40); }
      } else if (phase === "idle") {
        g.fillStyle = "#4b5666"; g.font = "16px system-ui";
        g.fillText(version === "keyboard" ? "スタート → 出た数字を入力+Enter ／ 通知は Space" : "スタート → 光ったボタンを押す ／ 通知は LT+RT 両押し", cv.width / 2, cv.height / 2 - 10);
        g.fillStyle = "#3a414c"; g.font = "13px system-ui"; g.fillText("通知のチャンネルは上部 👁/👂/✋ で ON/OFF", cv.width / 2, cv.height / 2 + 16);
      }
      fx.restore(g); fx.draw(g);
      g.textAlign = "left"; g.textBaseline = "alphabetic";
      const m = meanOf(noticeRTs);
      g.fillStyle = "#5a6677"; g.font = "13px system-ui";
      const lastTxt = lastMissed ? "見逃し" : (lastMs ? Math.round(lastMs) + "ms" : "—");
      g.fillText(`通知ch ${activeMods()}　平均 ${m == null ? "—" : Math.round(m) + "ms"}　見逃し ${noticeMiss}　前回 ${lastTxt}`, 30, cv.height - 8);
    }

    const onConn = () => { if (!userPicked && phase === "idle") setVersion("gamepad"); };
    window.addEventListener("gamepadconnected", onConn);

    setVersion("keyboard");
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
        window.removeEventListener("gamepadconnected", onConn);
        try { if (ac) ac.close(); } catch { /* ignore */ }
      },
    };
  },
};
