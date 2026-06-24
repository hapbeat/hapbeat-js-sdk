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

const RUN_SEC = 20;          // fixed run length (s) — everyone gets the same notices
const N_NOTICES = 8;         // FIXED notices per run, fired at random well-spaced times
const NOTICE_WINDOW = 1300;  // ms to react before a notice counts as a miss
const NOTICE_MIN_GAP = 1800; // ms minimum spacing between scheduled notices (> window)
const GAP_MIN = 250, GAP_MAX = 550; // ms gap between consecutive tasks

/** Pick N sorted notice times (ms from run start) within [lo, hi], spaced ≥ minGap. */
function scheduleNoticeTimes(n, lo, hi, minGap) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ts = Array.from({ length: n }, () => lo + Math.random() * (hi - lo)).sort((a, b) => a - b);
    let ok = true;
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < minGap) { ok = false; break; }
    if (ok) return ts;
  }
  // fallback: evenly spaced
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / n);
}

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

// Xbox-style controller: ABXY (right) + D-pad (left) = the 8 task buttons, plus
// the LT/RT triggers (the NOTICE response — pressed together). The LB/RB bumpers
// are drawn just below them for reference, so the triggers aren't mistaken for
// the bumpers (only LT/RT light up / are pressed). Sticks/View/Menu are omitted.
const CONTROLLER_SVG = `
<svg class="gp-svg" viewBox="0 0 360 214" xmlns="http://www.w3.org/2000/svg">
  <rect class="btn trig" id="t-l" x="84" y="1" width="48" height="12" rx="5"/>
  <rect class="btn trig" id="t-r" x="228" y="1" width="48" height="12" rx="5"/>
  <rect class="btn bump" id="bump-l" x="78" y="15" width="58" height="12" rx="5"/>
  <rect class="btn bump" id="bump-r" x="224" y="15" width="58" height="12" rx="5"/>
  <text class="cap" x="108" y="7">LT</text><text class="cap" x="252" y="7">RT</text>
  <text class="cap dim" x="107" y="21">LB</text><text class="cap dim" x="253" y="21">RB</text>
  <path d="M92 28 H268 C305 28 327 48 333 84 C339 112 331 132 315 144 C300 156 295 186 278 202 C264 214 240 216 226 202 C212 188 200 160 180 160 C160 160 148 188 134 202 C120 216 96 214 82 202 C65 186 60 156 45 144 C29 132 21 112 27 84 C33 48 55 28 92 28 Z"
        fill="#232b37" stroke="#0c0f14" stroke-width="2.5"/>
  <rect class="btn" id="d-up" x="104" y="90" width="22" height="24" rx="5"/>
  <rect class="btn" id="d-down" x="104" y="124" width="22" height="24" rx="5"/>
  <rect class="btn" id="d-left" x="80" y="114" width="24" height="22" rx="5"/>
  <rect class="btn" id="d-right" x="126" y="114" width="24" height="22" rx="5"/>
  <circle class="btn yc" id="b-y" cx="268" cy="76" r="17"/>
  <circle class="btn xc" id="b-x" cx="240" cy="104" r="17"/>
  <circle class="btn bc" id="b-b" cx="296" cy="104" r="17"/>
  <circle class="btn ac" id="b-a" cx="268" cy="132" r="17"/>
  <text x="268" y="76">Y</text><text x="240" y="104">X</text><text x="296" y="104">B</text><text x="268" y="132">A</text>
  <text class="dp" x="115" y="102">↑</text><text class="dp" x="115" y="136">↓</text><text class="dp" x="92" y="125">←</text><text class="dp" x="138" y="125">→</text>
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
        .gp-svg .btn.trig { fill: #2b3340; }
        .gp-svg .btn.bump { fill: #20262f; } /* LB/RB bumpers — reference only, never lit */
        .gp-svg .btn.target { fill: #ffd23a !important; stroke: #fff; stroke-width: 3; }
        .gp-svg .btn.pressed { fill: #3fb950 !important; }
        .gp-svg .btn.target.pressed { fill: #2dd4bf !important; }
        /* notice fired → light the LT/RT triggers (part of the 👁 visual cue) */
        .gp-svg .btn.gp-notice { fill: #ff5147 !important; stroke: #fff; stroke-width: 2.5; filter: drop-shadow(0 0 5px #ff5147); }
        .gp-svg text { fill: #f0f4f8; font: bold 15px system-ui; text-anchor: middle; dominant-baseline: middle;
          pointer-events: none; paint-order: stroke; stroke: #0c0f14; stroke-width: 0.8px; }
        .gp-svg text.dp { font-size: 15px; }
        .gp-svg text.cap { font-size: 11px; fill: #c4cdd8; }
        .gp-svg text.cap.dim { fill: #828d9a; } /* LB/RB labels recede vs the active LT/RT */
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
      <div class="gametoolbar compact">
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
        <span>残り <b id="time">${RUN_SEC}</b>s</span>
        <span>こなした課題 <b id="prog">0</b></span>
        <span>通知RT平均 <b id="mean">—</b></span>
        <span>気付き <b id="rate">—</b>/${N_NOTICES}</span>
        <span>見逃し <b id="miss">0</b></span>
        <span id="state"></span>
      </div>
      <p class="note"><b>狙い</b>：ながら作業中に通知へ気づけるか（二重課題）。<b>${RUN_SEC}秒</b>で<span id="taskhelp"></span>をこなしつつ、ランダムに鳴る<b>${N_NOTICES}回</b>の通知へ即反応（キーボード=<b>Space</b>／パッド=<b>LT+RT</b>）。<b>✋ だけ</b>にして比べると、目手がふさがっても触覚は速い。</p>
      <div class="rankpanel" id="rankpanel"></div>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const stagebox = container.querySelector(".stagebox");
    const elProg = container.querySelector("#prog");
    const elTime = container.querySelector("#time");
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
    // map task svg button ids + the LT/RT triggers + keyboard key codes → elements
    const svgEls = {};
    for (const t of TASKS) { const el = container.querySelector("#" + t.id); if (el) svgEls[t.id] = el; }
    for (const id of ["t-l", "t-r"]) { const el = container.querySelector("#" + id); if (el) svgEls[id] = el; }
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
        { key: "tasks", label: "課題数", unit: "個", decimals: 0, lowerIsBetter: false },
      ],
    });
    const rankPanel = container.querySelector("#rankpanel");
    const disposeRank = rank.mountPanel(rankPanel);
    function updateButtons() {
      startLbl.textContent = phase === "run" ? "リスタート" : "スタート";
      stopBtn.disabled = phase !== "run";
      mods.setLocked(phase === "run");
    }

    for (const [k, icon, name] of [["keyboard", "⌨", "キーボード"], ["gamepad", "🎮", "ゲームパッド"]]) {
      const b = document.createElement("button");
      b.textContent = icon; b.dataset.ver = k; b.title = name; // icon-only to keep the toolbar on one line
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
    // light the LT/RT triggers on the controller while a notice is pending (part of
    // the 👁 visual cue → off in haptic-only mode so it doesn't leak the timing)
    function setTriggerNotice(on) {
      svgEls["t-l"]?.classList.toggle("gp-notice", on);
      svgEls["t-r"]?.classList.toggle("gp-notice", on);
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
    let noticeActive, noticeFiredAt, noticeTimes, noticeIdx, noticeRTs, noticeMiss, noticeCount;
    let runStart, runEndAt, lastMs, lastMissed, edgeFlash, taskFlash, wrongFlash, hintUntil;
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
      noticeActive = false; noticeFiredAt = 0; noticeTimes = []; noticeIdx = 0; noticeRTs = []; noticeMiss = 0; noticeCount = 0;
      runEndAt = 0; lastMs = 0; lastMissed = false; edgeFlash = 0; taskFlash = 0; wrongFlash = 0; hintUntil = 0;
      elProg.textContent = "0"; elTime.textContent = String(RUN_SEC); elMean.textContent = "—"; elRate.textContent = "—"; elMiss.textContent = "0";
      elState.textContent = version === "keyboard" ? "キーボード版" : "ゲームパッド版";
      setTargetHighlight(-1);
      setTriggerNotice(false);
      updateButtons();
    }

    function startRun() {
      idle();
      nameField.roll(); // fresh random name suggestion for this play
      phase = "run";
      runStart = performance.now();
      runEndAt = runStart + RUN_SEC * 1000;
      taskNextAt = runStart + 500;
      // FIXED notices at random times — same count for everyone; keep the last
      // notice's full reaction window inside the run so it's never an unfair miss.
      noticeTimes = scheduleNoticeTimes(N_NOTICES, 1500, RUN_SEC * 1000 - NOTICE_WINDOW - 300, NOTICE_MIN_GAP)
        .map((t) => runStart + t);
      noticeIdx = 0;
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
      taskNextAt = now + rnd(GAP_MIN, GAP_MAX); // tasks run continuously for the full RUN_SEC
    }
    function wrongTask() { wrongFlash = 0.5; taskWrong++; }

    function fireNotice(now) {
      noticeCount++;
      if (bridge.master.visual) { edgeFlash = 1; setTriggerNotice(true); } // LT/RT light = visual cue
      bridge.fire("notice_alert"); // haptic buzz + rising chime (gated by 👂/✋ masters)
      noticeActive = true; noticeFiredAt = now;
    }
    function updateRate() { elRate.textContent = String(noticeRTs.length); } // caught count (HUD shows /N_NOTICES)
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
      noticeActive = false; setTriggerNotice(false);
    }
    function noticeMissNow() {
      noticeMiss++; elMiss.textContent = String(noticeMiss);
      lastMissed = true; lastMs = NOTICE_WINDOW;
      noticeActive = false; setTriggerNotice(false);
      noticeFlash("見逃し", false);
    }

    function finish() {
      phase = "done";
      if (noticeActive) { noticeActive = false; } // a notice still pending at time-up is left unresolved (rare; it's already in noticeCount so the catch-rate denominator stays correct)
      setTargetHighlight(-1);
      setTriggerNotice(false);
      updateButtons();
      elTime.textContent = "0";
      bridge.fire("notice_win", { gain: 0.55 });
      fx.burst(cv.width / 2, cv.height / 2, "#7c5cff", 36, 300);
      const mean = meanOf(noticeRTs);
      const sum = noticeRTs.reduce((a, b) => a + b, 0);
      const rate = noticeCount ? noticeRTs.length / noticeCount : 0;
      // tasks-done is the headline; notice speed + catch rate dominate the composite.
      const rtPts = mean == null ? 0 : Math.max(0, Math.min(1, 1 - mean / 1500));
      const taskPts = Math.max(0, Math.min(1, taskDone / 35));
      const points = Math.round(1000 * (0.45 * rtPts + 0.35 * rate + 0.2 * taskPts));
      rank.record({
        name: nameField.get(),
        metrics: { points, rt: mean == null ? NaN : mean, rate: rate * 100, tasks: taskDone },
        mods: activeMods(bridge),
        detail: `課題 ${taskDone} ・ 気づき ${noticeRTs.length}/${noticeCount} ・ ${version === "keyboard" ? "KB" : "Pad"}`,
      });
      const sub =
        `入力:${version === "keyboard" ? "キーボード" : "ゲームパッド"} ／ 通知ch:${activeModsText()}\n` +
        `こなした課題 ${taskDone} 個 ・ 通知 反応 平均 ${mean == null ? "—" : Math.round(mean) + "ms"} ・ ` +
        `気づき ${noticeRTs.length}/${noticeCount} (${Math.round(rate * 100)}% ・ 見逃し ${noticeMiss})` +
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

      // live highlight of the LT/RT triggers (the notice-response buttons)
      svgEls["t-l"]?.classList.toggle("pressed", pressed(6));
      svgEls["t-r"]?.classList.toggle("pressed", pressed(7));
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
        if (!taskActive && now >= taskNextAt) showTask(now); // tasks run for the whole RUN_SEC
        if (!noticeActive && noticeIdx < N_NOTICES && now >= noticeTimes[noticeIdx]) { fireNotice(now); noticeIdx++; }
        if (noticeActive && now - noticeFiredAt > NOTICE_WINDOW) noticeMissNow();
        elTime.textContent = String(Math.max(0, Math.ceil((runEndAt - now) / 1000)));
        if (now >= runEndAt) finish();
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
