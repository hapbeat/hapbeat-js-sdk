/**
 * Notice Test — 気づけるか (dual-task / divided-attention demo).
 *
 * Two input VERSIONS (pick in the toolbar; auto-switches to gamepad on connect):
 *   ⌨ キーボード — the TASK shows a letter; press that key. Layout is WASD (left
 *                  hand) + IJKL (right hand) = 8 targets. NOTICE response = Space.
 *   🎮 ゲームパッド — an Xbox controller is drawn with ONLY ABXY + D-pad (the 8 task
 *                  targets); the TASK lights one — press it. NOTICE response = BOTH
 *                  triggers (LT+RT). Every press lights live on the drawing.
 *
 * Paradigm: a self-paced primary TASK (press-to-advance, fixed total N → clear
 * time) + a PVT-style NOTICE that fires at random intervals on every ENABLED
 * channel (👁 edge-flash / 👂 chime / ✋ buzz). React ASAP; no response within the
 * window is a MISS. The ranking scores notice reaction-time, catch-rate and
 * clear-time, with a notice-heavy 総合 points column — showing haptic stays fast
 * while eyes/hands are busy. Toggle 👁/👂/✋ to A/B the channels.
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";
import { modalityControls, playerNameField, activeMods } from "../shared/controls.js";
import { createRanking } from "../shared/ranking.js";

const N_TASKS = 14; // shorter run (was 24) — ~½–⅔ length per request
const ISI_MIN = 1400, ISI_MAX = 3000;
const NOTICE_WINDOW = 1300;
const GAP_MIN = 250, GAP_MAX = 550;

// The 8 task targets. Each maps a keyboard key (WASD left / IJKL right) ⇄ a pad
// button (D-pad ⇄ WASD, face buttons ⇄ IJKL by diamond position: Y↑I, X←J, B→L, A↓K).
const TASKS = [
  { pad: 12, id: "d-up", padLabel: "↑", code: "KeyW", keyLabel: "W" },
  { pad: 14, id: "d-left", padLabel: "←", code: "KeyA", keyLabel: "A" },
  { pad: 13, id: "d-down", padLabel: "↓", code: "KeyS", keyLabel: "S" },
  { pad: 15, id: "d-right", padLabel: "→", code: "KeyD", keyLabel: "D" },
  { pad: 3, id: "b-y", padLabel: "Y", code: "KeyI", keyLabel: "I" },
  { pad: 2, id: "b-x", padLabel: "X", code: "KeyJ", keyLabel: "J" },
  { pad: 0, id: "b-a", padLabel: "A", code: "KeyK", keyLabel: "K" },
  { pad: 1, id: "b-b", padLabel: "B", code: "KeyL", keyLabel: "L" },
];
const byCode = Object.fromEntries(TASKS.map((t) => [t.code, t]));
const byPad = Object.fromEntries(TASKS.map((t) => [t.pad, t]));

// Xbox-style controller, decluttered to ONLY the 8 task buttons: ABXY (right) +
// D-pad (left). Triggers/bumpers/sticks/View/Menu are intentionally omitted.
const CONTROLLER_SVG = `
<svg class="gp-svg" viewBox="0 0 360 210" xmlns="http://www.w3.org/2000/svg">
  <path d="M92 26 H268 C305 26 327 46 333 82 C339 110 331 130 315 142 C300 154 295 184 278 200 C264 212 240 214 226 200 C212 186 200 158 180 158 C160 158 148 186 134 200 C120 214 96 212 82 200 C65 184 60 154 45 142 C29 130 21 110 27 82 C33 46 55 26 92 26 Z"
        fill="#232b37" stroke="#0c0f14" stroke-width="2.5"/>
  <rect class="btn" id="d-up" x="104" y="74" width="22" height="24" rx="5"/>
  <rect class="btn" id="d-down" x="104" y="108" width="22" height="24" rx="5"/>
  <rect class="btn" id="d-left" x="80" y="98" width="24" height="22" rx="5"/>
  <rect class="btn" id="d-right" x="126" y="98" width="24" height="22" rx="5"/>
  <circle class="btn yc" id="b-y" cx="268" cy="74" r="17"/>
  <circle class="btn xc" id="b-x" cx="240" cy="102" r="17"/>
  <circle class="btn bc" id="b-b" cx="296" cy="102" r="17"/>
  <circle class="btn ac" id="b-a" cx="268" cy="130" r="17"/>
  <text x="268" y="74">Y</text><text x="240" y="102">X</text><text x="296" y="102">B</text><text x="268" y="130">A</text>
  <text class="dp" x="115" y="86">↑</text><text class="dp" x="115" y="120">↓</text><text class="dp" x="92" y="109">←</text><text class="dp" x="138" y="109">→</text>
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
        .stagebox { position: relative; }
        .gp-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 6px; pointer-events: none; padding: 6px; }
        .gp-overlay.hidden { display: none; }
        .gp-svg { width: 100%; max-width: 320px; height: auto; }
        .gp-svg .btn { fill: #3a414c; stroke: #0c0f14; stroke-width: 1.5; transition: fill .04s; }
        .gp-svg .btn.ac { fill: #2f7d56; } .gp-svg .btn.bc { fill: #9b3d3d; }
        .gp-svg .btn.xc { fill: #3a64a0; } .gp-svg .btn.yc { fill: #9b8636; }
        .gp-svg .btn.target { fill: #ffd23a !important; stroke: #fff; stroke-width: 3; }
        .gp-svg .btn.pressed { fill: #3fb950 !important; }
        .gp-svg .btn.target.pressed { fill: #2dd4bf !important; }
        .gp-svg text { fill: #f0f4f8; font: bold 15px system-ui; text-anchor: middle; dominant-baseline: middle;
          pointer-events: none; paint-order: stroke; stroke: #0c0f14; stroke-width: 0.8px; }
        .gp-svg text.dp { font-size: 15px; }
        .gp-stat { text-align: center; font-size: 12px; color: #cdd6e0;
          background: rgba(10,13,18,0.72); padding: 2px 9px; border-radius: 6px; }
        .gp-stat b { color: #fff; }
        /* keyboard illustration (keyboard version) — mirror of the controller */
        .kb-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 10px; pointer-events: none; padding: 6px; }
        .kb-overlay.hidden { display: none; }
        .kb-clusters { display: flex; gap: 48px; }
        .kb-cluster { display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .kb-row { display: flex; gap: 6px; }
        .kbkey { width: 46px; height: 46px; border-radius: 8px; background: #2b333f; color: #e7edf4;
          border: 1px solid #0c0f14; border-bottom-width: 3px; display: flex; align-items: center;
          justify-content: center; font: 800 20px system-ui; transition: background .04s, transform .04s; }
        .kbkey.wide { width: auto; padding: 0 16px; font-size: 14px; font-weight: 700; }
        .kbkey.target { background: #ffd23a; color: #1a1300; border-color: #fff; }
        .kbkey.pressed { background: #3fb950; transform: translateY(1px); }
        .kbkey.target.pressed { background: #2dd4bf; }
        /* flashy NOTICE feedback, rendered ON TOP of the controller (not behind it) */
        .notice-flash { position: absolute; inset: 0; z-index: 8; pointer-events: none; opacity: 0;
          display: flex; align-items: center; justify-content: center; }
        .notice-flash::before { content: ""; position: absolute; inset: 0;
          background: radial-gradient(circle at center, rgba(45,212,191,0.5), rgba(45,212,191,0) 60%); }
        .notice-flash.bad::before { background: radial-gradient(circle at center, rgba(248,81,73,0.5), rgba(248,81,73,0) 60%); }
        .notice-flash .nf-ring { position: absolute; width: 48px; height: 48px; border-radius: 50%;
          border: 9px solid #2dd4bf; box-shadow: 0 0 44px #2dd4bf; }
        .notice-flash.bad .nf-ring { border-color: #f85149; box-shadow: 0 0 44px #f85149; }
        .notice-flash .nf-text { position: relative; font: 800 46px system-ui; color: #eafff7;
          text-shadow: 0 2px 16px rgba(0,0,0,0.65); }
        .notice-flash.go { animation: nf-fade 0.6s ease-out forwards; }
        .notice-flash.go .nf-ring { animation: nf-ring 0.6s ease-out forwards; }
        .notice-flash.go .nf-text { animation: nf-pop 0.6s ease-out forwards; }
        @keyframes nf-fade { 0%{opacity:1;} 72%{opacity:1;} 100%{opacity:0;} }
        @keyframes nf-ring { 0%{transform:scale(.22);opacity:1;} 100%{transform:scale(7);opacity:0;} }
        @keyframes nf-pop { 0%{transform:scale(.55);opacity:0;} 22%{transform:scale(1.12);opacity:1;} 80%{opacity:1;} 100%{transform:scale(1);opacity:0;} }
      </style>
      <div class="gametoolbar">
        <span class="label">入力</span>
        <div class="toggle-group" id="ver"></div>
        <span class="spacer"></span>
        <span id="modslot"></span>
        <button id="start" class="primary"><span id="startlbl">スタート</span> <span class="padkey k-a">A</span></button>
        <button id="stop" class="danger">ストップ <span class="padkey k-menu">☰</span></button>
        <span id="nameslot"></span>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="360"></canvas>
        <div class="gp-overlay hidden" id="gpwrap">
          ${CONTROLLER_SVG}
          <div class="gp-stat">🎮 <b id="gpdet">未検出</b> ・ 入力: <b id="gplast">—</b> ／ 通知=<b>LT+RT 両押し</b></div>
        </div>
        <div class="kb-overlay hidden" id="kbwrap">
          <div class="kb-clusters">
            <div class="kb-cluster">
              <div class="kb-row"><div class="kbkey" data-code="KeyW">W</div></div>
              <div class="kb-row"><div class="kbkey" data-code="KeyA">A</div><div class="kbkey" data-code="KeyS">S</div><div class="kbkey" data-code="KeyD">D</div></div>
            </div>
            <div class="kb-cluster">
              <div class="kb-row"><div class="kbkey" data-code="KeyI">I</div></div>
              <div class="kb-row"><div class="kbkey" data-code="KeyJ">J</div><div class="kbkey" data-code="KeyK">K</div><div class="kbkey" data-code="KeyL">L</div></div>
            </div>
          </div>
          <div class="kb-row"><div class="kbkey wide" data-code="Space">Space ＝ 通知</div></div>
        </div>
        <div class="notice-flash" id="nflash"><span class="nf-ring"></span><span class="nf-text"></span></div>
      </div>
      <div class="hud">
        <span>課題 <b id="prog">0</b>/${N_TASKS}</span>
        <span>通知RT平均 <b id="mean">—</b></span>
        <span>気付き <b id="rate">—</b></span>
        <span>見逃し <b id="miss">0</b></span>
        <span id="state"></span>
      </div>
      <p class="note"><b>狙い</b>：目や手がふさがった「ながら」で通知に気づけるか、を反応時間で測る二重課題。
      <b>課題(task)</b>＝<span id="taskhelp"></span>（押さないと進まない・全${N_TASKS}問）。
      <b>通知(notice)</b>＝作業中ランダムに通知（👁画面端／👂チャイム／✋ブザー）。気づいたら最速で反応（キーボード=<b>Space</b>／パッド=<b>LT+RT 両押し</b>）。
      パッド: <b>Ⓐ</b>=スタート / <b>RB</b>=リスタート / <b>☰</b>=ストップ / <b>Ⓥ(View)</b>=メニュー。開始前は <b>Ⓧ/Ⓨ/Ⓑ</b>=映像/音/触覚。
      通知は<b>上の 👁/👂/✋ で ON の感覚すべて</b>から。<b>✋ だけ</b>にして比べると、目手がふさがっても触覚は速く確実。</p>
      <div class="rankpanel" id="rankpanel"></div>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const stagebox = container.querySelector(".stagebox");
    const elProg = container.querySelector("#prog");
    const elMean = container.querySelector("#mean");
    const elRate = container.querySelector("#rate");
    const elMiss = container.querySelector("#miss");
    const elState = container.querySelector("#state");
    const verBox = container.querySelector("#ver");
    const gpwrap = container.querySelector("#gpwrap");
    const kbwrap = container.querySelector("#kbwrap");
    const gpDet = container.querySelector("#gpdet");
    const gpLast = container.querySelector("#gplast");
    const taskHelp = container.querySelector("#taskhelp");
    const flashEl = container.querySelector("#nflash");
    const startBtn = container.querySelector("#start");
    const startLbl = container.querySelector("#startlbl");
    const stopBtn = container.querySelector("#stop");
    // map task svg button ids + keyboard key codes → elements (scoped to this container)
    const svgEls = {};
    for (const t of TASKS) { const el = container.querySelector("#" + t.id); if (el) svgEls[t.id] = el; }
    const kbEls = {};
    for (const el of container.querySelectorAll(".kbkey")) kbEls[el.dataset.code] = el;

    // modality toggles + persisted player name + ranking (notice-heavy composite)
    const mods = modalityControls(bridge);
    container.querySelector("#modslot").appendChild(mods.el);
    const nameField = playerNameField();
    container.querySelector("#nameslot").appendChild(nameField.el);
    const rank = createRanking("notice", {
      title: "気づけるか",
      columns: [
        { key: "points", label: "総合", unit: "pt", decimals: 0, lowerIsBetter: false, primary: true },
        { key: "rt", label: "通知平均", unit: "ms", decimals: 0, lowerIsBetter: true },
        { key: "rate", label: "気付き率", unit: "%", decimals: 0, lowerIsBetter: false },
        { key: "clear", label: "時間", unit: "s", decimals: 1, lowerIsBetter: true },
      ],
    });
    const rankPanel = container.querySelector("#rankpanel");
    const disposeRank = rank.mountPanel(rankPanel);
    function updateButtons() {
      startLbl.textContent = phase === "run" ? "リスタート" : "スタート";
      stopBtn.disabled = phase !== "run";
      mods.setLocked(phase === "run");
    }

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
      kbwrap.classList.toggle("hidden", v !== "keyboard");
      taskHelp.innerHTML = v === "keyboard"
        ? "表示された<b>文字キー</b>（WASD / IJKL）を押す"
        : "光った<b>ボタン</b>（ABXY / 十字）を押す（<b>Ⓐ</b>=開始・<b>Ⓥ</b>=メニュー）";
      idle();
    }

    // Highlight the active task target on BOTH the controller and the keyboard
    // illustration (only the visible overlay is shown). slot = index into TASKS, or -1.
    function setTargetHighlight(slot) {
      for (const t of TASKS) { svgEls[t.id]?.classList.remove("target"); kbEls[t.code]?.classList.remove("target"); }
      if (slot >= 0 && slot < TASKS.length) {
        svgEls[TASKS[slot].id]?.classList.add("target");
        kbEls[TASKS[slot].code]?.classList.add("target");
      }
    }

    // big flashy notice feedback ON TOP (restart the CSS animation via reflow)
    function noticeFlash(text, ok) {
      flashEl.querySelector(".nf-text").textContent = text;
      flashEl.classList.toggle("bad", !ok);
      flashEl.classList.remove("go");
      void flashEl.offsetWidth; // force reflow so the animation replays
      flashEl.classList.add("go");
    }

    // (notice's haptic + audio — the buzz and the rising chime — now live in the
    //  central event-content map as "notice_alert"; fired via bridge.fire below.)

    // ── state ────────────────────────────────────────────────────────────────
    let phase = "idle"; // idle | run | done
    let taskDone, taskWrong, taskRTs, taskActive, taskShownAt, taskNextAt, taskSlot;
    let noticeActive, noticeFiredAt, noticeNextAt, noticeRTs, noticeMiss, noticeCount;
    let runStart, lastMs, lastMissed, edgeFlash, taskFlash, wrongFlash, hintUntil;
    let gpPrev = [], gpBothPrev = false;
    let gpAprev = false, gpRBprev = false, gpMenuPrev = false, gpViewPrev = false, gpXprev = false, gpYprev = false, gpBprev = false;

    const rnd = (a, b) => a + Math.random() * (b - a);
    const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    function activeModsText() {
      return ([bridge.master.visual && "👁", bridge.master.audio && "👂", bridge.master.haptic && "✋"].filter(Boolean).join("")) || "なし";
    }

    function idle() {
      clearResult(stagebox);
      phase = "idle";
      taskDone = 0; taskWrong = 0; taskRTs = [];
      taskActive = false; taskShownAt = 0; taskNextAt = 0; taskSlot = -1;
      noticeActive = false; noticeFiredAt = 0; noticeNextAt = 0; noticeRTs = []; noticeMiss = 0; noticeCount = 0;
      lastMs = 0; lastMissed = false; edgeFlash = 0; taskFlash = 0; wrongFlash = 0; hintUntil = 0;
      elProg.textContent = "0"; elMean.textContent = "—"; elRate.textContent = "—"; elMiss.textContent = "0";
      elState.textContent = version === "keyboard" ? "キーボード版" : "ゲームパッド版";
      setTargetHighlight(-1);
      updateButtons();
    }

    function startRun() {
      idle();
      nameField.roll(); // fresh random name suggestion for this play
      phase = "run";
      runStart = performance.now();
      taskNextAt = runStart + 500;
      noticeNextAt = runStart + rnd(ISI_MIN, ISI_MAX);
      updateButtons();
      bridge.unlockAudio();
    }

    function showTask(now) {
      taskSlot = Math.floor(Math.random() * TASKS.length);
      setTargetHighlight(taskSlot); // lights the controller button AND the keyboard key
      taskActive = true; taskShownAt = now;
    }
    function advanceTask(now) {
      taskRTs.push(now - taskShownAt);
      taskActive = false; setTargetHighlight(-1);
      taskDone++; elProg.textContent = String(taskDone);
      taskFlash = 0.5;
      if (taskDone >= N_TASKS) return finish();
      taskNextAt = now + rnd(GAP_MIN, GAP_MAX);
    }
    function wrongTask() { wrongFlash = 0.5; taskWrong++; }

    function fireNotice(now) {
      noticeCount++;
      if (bridge.master.visual) edgeFlash = 1;
      bridge.fire("notice_alert"); // haptic buzz + rising chime (gated by 👂/✋ masters)
      noticeActive = true; noticeFiredAt = now;
    }
    function scheduleNotice(now) { noticeNextAt = now + rnd(ISI_MIN, ISI_MAX); }
    function updateRate() {
      elRate.textContent = noticeCount ? `${Math.round((noticeRTs.length / noticeCount) * 100)}%` : "—";
    }
    function pressNotice() {
      if (phase !== "run") return;
      bridge.unlockAudio();
      const now = performance.now();
      if (!noticeActive) { hintUntil = now + 700; noticeFlash("まだ", false); return; } // false start
      const ms = now - noticeFiredAt;
      noticeRTs.push(ms); lastMs = ms; lastMissed = false;
      const m = meanOf(noticeRTs); elMean.textContent = m == null ? "—" : `${Math.round(m)}ms`;
      updateRate();
      noticeFlash(`✓ ${Math.round(ms)}ms`, true);
      fx.shake(5);
      noticeActive = false; scheduleNotice(now);
    }
    function noticeMissNow(now) {
      noticeMiss++; elMiss.textContent = String(noticeMiss);
      lastMissed = true; lastMs = NOTICE_WINDOW;
      updateRate();
      noticeFlash("見逃し", false);
      noticeActive = false; scheduleNotice(now);
    }

    function finish() {
      phase = "done";
      if (noticeActive) { noticeCount--; noticeActive = false; }
      setTargetHighlight(-1);
      updateButtons();
      bridge.fire("notice_win", { gain: 0.55 });
      fx.burst(cv.width / 2, cv.height / 2, "#7c5cff", 36, 300);
      const mean = meanOf(noticeRTs);
      const sum = noticeRTs.reduce((a, b) => a + b, 0);
      const clearS = (performance.now() - runStart) / 1000;
      const rate = noticeCount ? noticeRTs.length / noticeCount : 0;
      if (mean != null) {
        // notice-heavy composite: speed (0.5) + catch-rate (0.35) dominate, clear time (0.15).
        const rtPts = Math.max(0, Math.min(1, 1 - mean / 1500));
        const timePts = Math.max(0, Math.min(1, 1 - clearS / 120));
        const points = Math.round(1000 * (0.5 * rtPts + 0.35 * rate + 0.15 * timePts));
        rank.record({
          name: nameField.get(),
          metrics: { points, rt: mean, rate: rate * 100, clear: clearS },
          mods: activeMods(bridge),
          detail: `気づき ${noticeRTs.length}/${noticeCount} ・ ${version === "keyboard" ? "KB" : "Pad"}`,
        });
      }
      const sub =
        `入力:${version === "keyboard" ? "キーボード" : "ゲームパッド"} ／ 通知ch:${activeModsText()}\n` +
        `通知 反応 平均 ${mean == null ? "—" : Math.round(mean) + "ms"} ・ 合計 ${Math.round(sum)}ms ・ ` +
        `気づき ${noticeRTs.length}/${noticeCount} (${Math.round(rate * 100)}% ・ 見逃し ${noticeMiss}) ／ 課題クリア ${clearS.toFixed(1)}s` +
        (taskWrong ? ` ・ 誤入力 ${taskWrong}` : "");
      showResult(stagebox, { title: "🔔 結果", badge: "通知を ✋ だけにして比べてみよう", sub, onRetry: startRun, onMenu: toMenu });
    }

    // ── keyboard input ─────────────────────────────────────────────────────────
    startBtn.onclick = () => { bridge.unlockAudio(); startRun(); };
    stopBtn.onclick = () => idle(); // end the run and return to the pre-start state
    const kd = (e) => {
      kbEls[e.code]?.classList.add("pressed"); // live key-light (detection feedback)
      if (stagebox.querySelector(".result")) {
        if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); startRun(); }
        return;
      }
      if (e.code === "Space") { e.preventDefault(); pressNotice(); return; }
      if (version !== "keyboard") return;
      if (phase !== "run") { if (e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); startRun(); } return; }
      const t = byCode[e.code];
      if (!t) return; // not a task key
      e.preventDefault();
      if (!taskActive) return;
      if (taskSlot >= 0 && t === TASKS[taskSlot]) advanceTask(performance.now());
      else wrongTask();
    };
    const kup = (e) => { kbEls[e.code]?.classList.remove("pressed"); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", kup);

    // ── gamepad input + live detection ──────────────────────────────────────────
    function pollGamepad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      // prefer a STANDARD-mapping pad (skip HID devices like USB speakerphones that
      // are mis-enumerated as non-standard "gamepads" and would be picked first).
      let gp = null;
      for (const p of pads) { if (!p) continue; if (!gp) gp = p; if (p.mapping === "standard") { gp = p; break; } }
      if (!gp) {
        gpDet.textContent = "未検出"; gpPrev = [];
        gpBothPrev = gpAprev = gpRBprev = gpMenuPrev = gpViewPrev = gpXprev = gpYprev = gpBprev = false;
        return;
      }
      gpDet.textContent = gp.mapping === "standard" ? "接続OK" : "接続OK(非標準)";
      if (version !== "gamepad" && !userPicked && phase === "idle") setVersion("gamepad");
      const pressed = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
      // live highlight of the 8 task buttons (detection feedback)
      let lastDown = -1;
      for (const t of TASKS) {
        const pr = pressed(t.pad), prev = !!gpPrev[t.pad];
        gpPrev[t.pad] = pr;
        svgEls[t.id]?.classList.toggle("pressed", pr);
        if (pr && !prev) { lastDown = t.pad; onTaskButton(t.pad); }
      }
      if (lastDown >= 0) gpLast.textContent = `btn${lastDown}${byPad[lastDown] ? " (" + byPad[lastDown].padLabel + ")" : ""}`;

      // system buttons (only act while gamepad version is active)
      const sys = version === "gamepad";
      const a = pressed(0), rb = pressed(5), menu = pressed(9), view = pressed(8);
      const x = pressed(2), y = pressed(3), b = pressed(1);
      if (sys) {
        if (a && !gpAprev && phase !== "run") startRun();      // Ⓐ = start (idle only; in-run Ⓐ is a task button)
        if (rb && !gpRBprev) startRun();                       // RB = (re)start any time
        if (menu && !gpMenuPrev && phase === "run") idle();    // ☰ = stop
        if (view && !gpViewPrev) toMenu();                     // Ⓥ = menu
        if (phase !== "run") {                                 // idle: Ⓧ/Ⓨ/Ⓑ = modality
          if (x && !gpXprev) bridge.setMaster("visual", !bridge.master.visual);
          if (y && !gpYprev) { bridge.unlockAudio(); bridge.setMaster("audio", !bridge.master.audio); }
          if (b && !gpBprev) bridge.setMaster("haptic", !bridge.master.haptic);
        }
      }
      gpAprev = a; gpRBprev = rb; gpMenuPrev = menu; gpViewPrev = view; gpXprev = x; gpYprev = y; gpBprev = b;

      // NOTICE = both triggers held
      const both = pressed(6) && pressed(7);
      if (sys && both && !gpBothPrev) pressNotice();
      gpBothPrev = both;
    }
    function onTaskButton(i) {
      if (version !== "gamepad" || phase !== "run") return; // idle Ⓐ/Ⓧ/Ⓨ/Ⓑ handled as system
      if (!taskActive) return;
      const t = byPad[i];
      if (!t) return;
      if (taskSlot >= 0 && t === TASKS[taskSlot]) advanceTask(performance.now());
      else wrongTask();
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
        // both versions show a centred illustration (keyboard / controller) — so the
        // prompt + the lit target go at the TOP, not over the illustration.
        if (taskActive && version === "keyboard") {
          g.fillStyle = "#b3a6ff"; g.font = "bold 16px system-ui"; g.fillText("光った文字キーを押す（WASD / IJKL） ／ 通知は Space", cv.width / 2, 28);
          g.fillStyle = "#ffd23a"; g.font = "bold 54px system-ui"; g.fillText(TASKS[taskSlot].keyLabel, cv.width / 2, 74);
        } else if (taskActive && version === "gamepad") {
          g.fillStyle = "#b3a6ff"; g.font = "bold 16px system-ui"; g.fillText("光ったボタンを押す ／ 通知は LT+RT 両押し", cv.width / 2, 28);
          g.fillStyle = "#ffd23a"; g.font = "bold 54px system-ui"; g.fillText(TASKS[taskSlot].padLabel, cv.width / 2, 74);
        }
        if (taskFlash > 0) { g.globalAlpha = Math.min(1, taskFlash * 1.6); g.fillStyle = "#3fb950"; g.font = "bold 22px system-ui"; g.fillText("課題 ✓", 92, 30); g.globalAlpha = 1; }
        if (wrongFlash > 0) { g.globalAlpha = Math.min(1, wrongFlash * 1.6); g.fillStyle = "#ff6b62"; g.font = "bold 22px system-ui"; g.fillText("✗", cv.width - 60, 30); g.globalAlpha = 1; }
        if (now < hintUntil) { g.fillStyle = "#aab4c0"; g.font = "15px system-ui"; g.fillText("まだ通知は出ていません", cv.width / 2, cv.height - 40); }
      } else if (phase === "idle") {
        g.fillStyle = "#f4f7fa"; g.font = "bold 17px system-ui"; // both overlays cover the centre → prompt at top
        g.fillText(version === "keyboard" ? "スタート → 光った文字キー（WASD / IJKL）を押す ／ 通知は Space" : "スタート → 光ったボタンを押す ／ 通知は LT+RT 両押し", cv.width / 2, 30);
        g.fillStyle = "#b6c0cc"; g.font = "13px system-ui"; g.fillText("通知のチャンネルは上部 👁/👂/✋ で ON/OFF", cv.width / 2, 54);
      }
      fx.restore(g); fx.draw(g);
      g.textAlign = "left"; g.textBaseline = "alphabetic";
      const m = meanOf(noticeRTs);
      g.fillStyle = "#8b97a6"; g.font = "13px system-ui";
      const lastTxt = lastMissed ? "見逃し" : (lastMs ? Math.round(lastMs) + "ms" : "—");
      g.fillText(`通知ch ${activeModsText()}　平均 ${m == null ? "—" : Math.round(m) + "ms"}　見逃し ${noticeMiss}　前回 ${lastTxt}`, 30, cv.height - 8);
    }

    const onConn = () => { if (!userPicked && phase === "idle") setVersion("gamepad"); };
    window.addEventListener("gamepadconnected", onConn);

    setVersion("keyboard");
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
        window.removeEventListener("keyup", kup);
        window.removeEventListener("gamepadconnected", onConn);
        mods.dispose();
        disposeRank();
      },
    };
  },
};
