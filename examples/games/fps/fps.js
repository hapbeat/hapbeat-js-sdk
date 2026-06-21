/**
 * 触覚 FPS — a standalone Hapbeat demo (NOT a shell game module).
 *
 * Two modes:
 *   • 移動 (move): WASD/stick + mouse-yaw, hold a gun, click/RT to shoot. Enemies
 *     orbit and fire visible tracers localized in audio (HRTF) + haptic (L/R).
 *   • 固定 (fixed): you stand still and only TURN. A frontal shield blocks +
 *     reflects incoming shots — hear/feel the gunshot, face it, block it. Enemies
 *     are stationary; a global minimum shot-gap keeps shots one-at-a-time-ish.
 *
 * Circular arena. Enemies ramp up (1/3 → 1/2 → 2/3 → full of the cap) toward the
 * kill goal; reach it to CLEAR. 1 hit = 1 damage, with a settable max-HP or ∞.
 * Bullets use real speed (m/s) so distance matters, plus a streak trail so fast
 * shots stay visible. Distance / fire-gap / bullet-speed each have an adjustable
 * random width (0 = deterministic). Settings persist (localStorage + JSON). 👁 OFF
 * hides ONLY enemies. Esc pauses. Xbox/gamepad works via the native Gamepad API.
 */

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { ArcadeBridge } from "../shared/hapbeat-bridge.js";
import { stereoBlip } from "../shared/synth.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ARENA = 30;            // arena radius (circular)
const SHOT_DODGE_R = 1.6;    // (move) you "dodge" if you moved clear of the impact
const HAPTIC_MIN_GAP = 0.15;
const DEG = Math.PI / 180;
const jit = (w) => (Math.random() * 2 - 1) * w; // ±w uniform random

// ── persistent, in-page-tunable settings ─────────────────────────────────────
const DEFAULTS = {
  mode: "move",       // "move" | "fixed"
  killGoal: 20,
  enemyCount: 4,      // simultaneous CAP (ramps up to this)
  enemySpeed: 2.2,    // 敵の周回速度 m/s (move only)
  enemyRange: 18,     // 敵の距離(基準) m
  rangeJitter: 3,     // 敵の距離ランダム幅 ±m (0=固定)
  bulletSpeed: 20,    // 弾速 m/s (距離で到達時間が変わる)
  speedJitter: 4,     // 弾速ランダム幅 ±m/s (0=固定)
  fireGap: 3.0,       // 発射間隔(平均) s
  fireJitter: 1.0,    // 発射間隔ランダム幅 ±s (0=固定)
  minShotGap: 0.8,    // 固定モードの全体最低発射間隔 s (0=同時許可)
  playerSpeed: 7,     // 移動速度 m/s
  maxHp: 5,           // 最大HP (1ヒット1ダメージ)
  infiniteHp: false,  // HP無限 (デモ用)
  shieldArc: 26,      // 盾の半角° (固定モード)
};
const settings = { ...DEFAULTS };
const LS_KEY = "hbfps.settings.v2";
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (s && typeof s === "object") for (const k of Object.keys(DEFAULTS)) if (k in s) settings[k] = s[k];
  } catch { /* ignore */ }
}
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } }
loadSettings();

const SLIDER_META = {
  killGoal: { label: "目標撃破", min: 5, max: 50, step: 5 },
  enemyCount: { label: "同時上限", min: 1, max: 8, step: 1 },
  enemySpeed: { label: "敵の速さ", min: 0, max: 5, step: 0.2 },
  enemyRange: { label: "敵の距離", min: 8, max: 26, step: 1 },
  rangeJitter: { label: "距離ばらつき", min: 0, max: 10, step: 0.5 },
  bulletSpeed: { label: "弾速", min: 8, max: 45, step: 1 },
  speedJitter: { label: "弾速ばらつき", min: 0, max: 20, step: 1 },
  fireGap: { label: "発射間隔", min: 0.5, max: 6, step: 0.5 },
  fireJitter: { label: "間隔ばらつき", min: 0, max: 3, step: 0.1 },
  minShotGap: { label: "全体最低間隔", min: 0, max: 2.5, step: 0.1 },
  playerSpeed: { label: "移動速度", min: 3, max: 12, step: 0.5 },
  maxHp: { label: "最大HP", min: 1, max: 30, step: 1 },
  shieldArc: { label: "盾の幅°", min: 10, max: 45, step: 1 },
};
const ALL_IDS = Object.keys(SLIDER_META);
// grouped layout; `jitter` pairs a random-width slider BESIDE its base setting,
// `hp` appends the ♾ HP-infinite checkbox right under that row.
const SETTING_GROUPS = [
  { title: "ゲーム", rows: [{ id: "killGoal" }, { id: "maxHp", hp: true }, { id: "playerSpeed" }] },
  { title: "敵", rows: [{ id: "enemyCount" }, { id: "enemySpeed" }, { id: "enemyRange", jitter: "rangeJitter" }] },
  { title: "弾・発砲", rows: [{ id: "bulletSpeed", jitter: "speedJitter" }, { id: "fireGap", jitter: "fireJitter" }, { id: "minShotGap" }] },
  { title: "固定モード（盾）", rows: [{ id: "shieldArc" }] },
];
function nextFireDelay() { return Math.max(0.2, settings.fireGap + jit(settings.fireJitter)); }

// ── bridge ───────────────────────────────────────────────────────────────────
const bridge = new ArcadeBridge();
let bridgeReady = false;
bridge.init({ appName: "HapbeatFPS", audioBase: "../" }).then(() => { bridgeReady = true; syncConnBadge(); });
const events = { enemyFire: true, playerHit: true, ownShot: false };

// ── AudioContext (HRTF spatial audio) ────────────────────────────────────────
const actx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = actx.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(actx.destination);
const listener = actx.listener;
function playShot(worldPos, { gain = 1, freq = 220, durMs = 150, noise = true } = {}) {
  if (!bridge.master.audio) return;
  if (actx.state === "suspended") actx.resume();
  const t0 = actx.currentTime;
  const panner = actx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 2; panner.maxDistance = 60; panner.rolloffFactor = 1.1;
  if (panner.positionX) {
    panner.positionX.setValueAtTime(worldPos.x, t0);
    panner.positionY.setValueAtTime(worldPos.y, t0);
    panner.positionZ.setValueAtTime(worldPos.z, t0);
  } else { panner.setPosition(worldPos.x, worldPos.y, worldPos.z); }
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(clamp(gain, 0.02, 1), t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  const osc = actx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t0 + durMs / 1000);
  osc.connect(g); osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
  if (noise) {
    const len = Math.floor((durMs / 1000) * actx.sampleRate);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-i / len) * 6);
    const src = actx.createBufferSource();
    src.buffer = buf;
    const ng = actx.createGain();
    ng.gain.value = clamp(gain, 0.02, 1) * 0.6;
    src.connect(ng).connect(g); src.start(t0);
  }
  g.connect(panner).connect(masterGain);
}

// ── DOM overlay UI ───────────────────────────────────────────────────────────
const root = document.createElement("div");
root.id = "hbfps";
root.innerHTML = `
  <style>
    #hbfps { position: fixed; inset: 0; margin: 0; font-family: system-ui, sans-serif;
      background: #9cc2e8; color: #e6edf3; overflow: hidden; }
    #hbfps canvas { display: block; position: absolute; inset: 0; }
    #hbfps .panel { position: absolute; top: 12px; left: 12px; z-index: 9; /* above the start/gameover overlay so settings stay editable */
      background: rgba(10,13,18,0.88); border: 1px solid #2a313c; border-radius: 10px;
      padding: 10px 12px; width: 300px; backdrop-filter: blur(4px); }
    #hbfps .panel.collapsed { display: none; }
    #hbfps .panel h2 { margin: 0; font-size: 15px; }
    #hbfps .phead { display: flex; align-items: center; justify-content: space-between; }
    #hbfps .iconbtn { background: #222a35; color: #cdd6e0; border: 1px solid #39424f;
      border-radius: 7px; width: 26px; height: 24px; cursor: pointer; font-size: 14px; line-height: 1; }
    #hbfps .iconbtn:hover { background: #2c3543; }
    #hbfps .drawer-open { position: absolute; top: 12px; left: 12px; z-index: 9; display: none;
      background: rgba(10,13,18,0.84); color: #cdd6e0; border: 1px solid #39424f;
      border-radius: 8px; width: 34px; height: 30px; cursor: pointer; font-size: 16px; }
    #hbfps .sub { font-size: 11px; color: #8b97a6; margin: 6px 0 8px; line-height: 1.45; }
    #hbfps .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 13px; }
    #hbfps .group-title { font-size: 11px; color: #6f7c8c; text-transform: uppercase;
      letter-spacing: .06em; margin: 10px 0 2px; }
    #hbfps input[type=checkbox] { width: 16px; height: 16px; accent-color: #7c5cff; }
    #hbfps .modes { display: flex; gap: 6px; margin: 4px 0; }
    #hbfps .modes button { flex: 1; padding: 7px; font-size: 12px; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps .modes button[aria-pressed=true] { background: #7c5cff; color: #fff; border-color: #7c5cff; }
    #hbfps .settings-head { cursor: pointer; user-select: none; display: flex; justify-content: space-between; align-items: center; }
    #hbfps .settings-head .tg { color: #7c5cff; font-size: 11px; }
    #hbfps #advanced { max-height: 46vh; overflow-y: auto; } /* scrollbar lives ONLY here */
    #hbfps #advanced.collapsed { display: none; }
    #hbfps .srow-group { font-size: 11px; color: #8b97a6; font-weight: 600; margin: 9px 0 1px; }
    #hbfps .srow.pair { grid-template-columns: 58px 1fr 24px 14px 0.85fr 20px; }
    #hbfps .srow .pm { text-align: center; color: #6f7c8c; font-size: 12px; }
    #hbfps button.primary { margin-top: 10px; width: 100%; padding: 9px; font-size: 14px;
      font-weight: 600; color: #fff; background: #7c5cff; border: 0; border-radius: 8px; cursor: pointer; }
    #hbfps button.primary:hover { background: #8f72ff; }
    #hbfps .srow { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center;
      gap: 6px; font-size: 12px; margin: 3px 0; }
    #hbfps .srow input[type=range] { width: 100%; accent-color: #7c5cff; }
    #hbfps .srow b { text-align: right; color: #cdd6e0; font-variant-numeric: tabular-nums; }
    #hbfps .iorow { display: flex; gap: 6px; margin-top: 6px; }
    #hbfps .iorow button { flex: 1; padding: 6px; font-size: 11px; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps .hud { position: absolute; top: 12px; right: 12px; z-index: 5; text-align: right;
      background: rgba(10,13,18,0.66); border: 1px solid #2a313c; border-radius: 10px;
      padding: 10px 14px; font-size: 13px; line-height: 1.7; }
    #hbfps .hud b { font-size: 17px; }
    #hbfps .badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; }
    #hbfps .on { background: #1d3a2e; color: #3fb950; } #hbfps .off { background: #3a1d1d; color: #f85149; }
    #hbfps .crosshair { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px;
      transform: translate(-50%,-50%); z-index: 4; pointer-events: none; transition: transform .06s; }
    #hbfps .crosshair::before, #hbfps .crosshair::after { content: ""; position: absolute;
      background: #0b1220; opacity: .8; transition: background .06s; }
    #hbfps .crosshair::before { left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%); }
    #hbfps .crosshair::after { top: 50%; left: 0; height: 2px; width: 100%; transform: translateY(-50%); }
    #hbfps .crosshair.hit { transform: translate(-50%,-50%) scale(1.5) rotate(45deg); }
    #hbfps .crosshair.hit::before, #hbfps .crosshair.hit::after { background: #ff3b30; opacity: 1; }
    #hbfps .dmg { position: absolute; inset: 0; z-index: 3; pointer-events: none;
      box-shadow: inset 0 0 120px 30px rgba(248,81,73,0); transition: box-shadow .09s ease-out; }
    #hbfps .dmg.flash { box-shadow: inset 0 0 180px 70px rgba(248,81,73,0.62); transition: none; }
    #hbfps .pausebox { position: absolute; inset: 0; z-index: 4; display: none; align-items: center;
      justify-content: center; flex-direction: column; text-align: center; color: #fff;
      pointer-events: none; /* let clicks reach the canvas (resume) and the panel (tweak) */
      background: rgba(4,6,10,0.4); font-size: 30px; font-weight: 700; }
    #hbfps .pausebox span { font-size: 14px; font-weight: 400; color: #cdd6e0; margin-top: 6px; }
    #hbfps .center-msg { position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; flex-direction: column; z-index: 7; text-align: center;
      background: rgba(4,6,10,0.5); }
    #hbfps .center-msg.hidden { display: none; }
    #hbfps .center-msg h1 { font-size: 30px; margin: 0 0 4px; }
    #hbfps .center-msg p { color: #cdd6e0; font-size: 13px; max-width: 440px; line-height: 1.6; }
    #hbfps .center-msg button { margin-top: 14px; padding: 11px 26px; font-size: 15px;
      font-weight: 600; color: #fff; background: #7c5cff; border: 0; border-radius: 8px; cursor: pointer; }
  </style>
  <div class="panel" id="panel">
    <div class="phead">
      <h2>触覚 FPS</h2>
      <button class="iconbtn" id="drawerTab" title="HUD を隠す">‹</button>
    </div>
    <p class="sub">敵の銃声を <b>音(HRTF)</b> と <b>触覚(L/R)</b> で方向化。<b>👁 OFF</b> は敵だけ消え、耳と触覚で対処。</p>

    <div class="group-title">モード</div>
    <div class="modes" id="modes">
      <button data-mode="move" title="WASD+マウスで動いて撃つ">移動</button>
      <button data-mode="fixed" title="その場で向くだけ・盾で防ぐ">固定（盾）</button>
    </div>

    <div class="group-title">難易度</div>
    <div class="modes" id="presets">
      <button data-preset="easy">Easy</button>
      <button data-preset="normal">Normal</button>
      <button data-preset="hard">Hard</button>
    </div>

    <div class="group-title">モダリティ</div>
    <label class="row"><input type="checkbox" id="m_visual" checked> 👁 映像（敵）</label>
    <label class="row"><input type="checkbox" id="m_audio" checked> 👂 音</label>
    <label class="row"><input type="checkbox" id="m_haptic" checked> ✋ 触覚</label>

    <div class="group-title">フィードバック対象</div>
    <label class="row"><input type="checkbox" id="e_fire" checked> ① 敵の発砲（方向）</label>
    <label class="row"><input type="checkbox" id="e_hit" checked> ② 被弾</label>
    <label class="row"><input type="checkbox" id="e_own"> ③ 自分の発砲</label>

    <div class="group-title settings-head" id="advHead"><span>⚙ 詳細設定</span><span class="tg" id="advTg">▸ 開く</span></div>
    <div id="advanced" class="collapsed">
      <p class="sub" style="margin:2px 0 6px;">プリセットで大まかに、ここで細かく。±幅は 0 でランダムなし。</p>
      <div id="settings"></div>
      <div class="iorow">
        <button id="saveJson">設定をJSON保存</button>
        <button id="loadJson">JSON読込</button>
      </div>
    </div>
    <input type="file" id="fileInput" accept="application/json,.json" style="display:none">

    <div class="row" style="margin-top:10px; font-size:11px; color:#8b97a6;">
      Helper: <span id="conn" class="badge off">未接続</span>
      ・ 🎮 <span id="gpstat" class="badge off">未検出</span>
    </div>
    <button class="primary" id="startbtn">スタート / リスタート</button>
    <p class="sub" style="margin-top:8px;" id="ctrlhint"></p>
  </div>
  <button class="drawer-open" id="drawerOpen" title="HUD を表示">›</button>
  <div class="hud">
    HP <b id="hp">5</b><br>撃破 <b id="kills">0/20</b><br>敵 <b id="left">0</b>
  </div>
  <div class="dmg" id="dmg"></div>
  <div class="crosshair" id="crosshair"></div>
  <div class="pausebox" id="pause">⏸ PAUSED<br><span>クリック / コントローラのボタンで再開</span></div>
  <div class="center-msg" id="overlay">
    <h1>触覚 FPS</h1>
    <p id="overlaytext"></p>
    <button id="overlaybtn">クリックして開始</button>
  </div>
`;
document.body.style.margin = "0";
document.body.appendChild(root);

const elHp = root.querySelector("#hp");
const elKills = root.querySelector("#kills");
const elLeft = root.querySelector("#left");
const elConn = root.querySelector("#conn");
const overlay = root.querySelector("#overlay");
const overlayText = root.querySelector("#overlaytext");
const crosshairEl = root.querySelector("#crosshair");
const dmgEl = root.querySelector("#dmg");
const pauseEl = root.querySelector("#pause");
const panelEl = root.querySelector("#panel");
const drawerOpen = root.querySelector("#drawerOpen");
const ctrlHint = root.querySelector("#ctrlhint");
const elGpStat = root.querySelector("#gpstat");
let infhpEl; // built dynamically inside the grouped settings (assigned after build)

function syncConnBadge() {
  const ok = bridgeReady && bridge.connected;
  elConn.className = "badge " + (ok ? "on" : "off");
  elConn.textContent = ok ? "接続" : "未接続(音/映像のみ)";
}
bridge.onChange(syncConnBadge);

root.querySelector("#drawerTab").onclick = () => { panelEl.classList.add("collapsed"); drawerOpen.style.display = "block"; };
drawerOpen.onclick = () => { panelEl.classList.remove("collapsed"); drawerOpen.style.display = "none"; };

root.querySelector("#m_visual").onchange = (e) => bridge.setMaster("visual", e.target.checked);
root.querySelector("#m_audio").onchange = (e) => bridge.setMaster("audio", e.target.checked);
root.querySelector("#m_haptic").onchange = (e) => bridge.setMaster("haptic", e.target.checked);
root.querySelector("#e_fire").onchange = (e) => (events.enemyFire = e.target.checked);
root.querySelector("#e_hit").onchange = (e) => (events.playerHit = e.target.checked);
root.querySelector("#e_own").onchange = (e) => (events.ownShot = e.target.checked);

// mode toggle (移動 / 固定)
const modeBtns = [...root.querySelectorAll("#modes button")];
function refreshModeButtons() {
  for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === settings.mode));
  ctrlHint.innerHTML =
    settings.mode === "move"
      ? "WASD 移動 ・ マウス/右スティックで水平回転 ・ <b>クリック/RTで射撃</b> ・ Esc で一時停止"
      : "マウス/スティックで<b>その場で回転</b>し、銃声の方向へ正面を向け、<b>正面の盾</b>で弾を受けて跳ね返す（動けません）・ Esc で一時停止";
}
function setMode(m) {
  settings.mode = m; saveSettings();
  refreshModeButtons(); applyModeVisibility();
  if (playing) startGame();
}
for (const b of modeBtns) b.onclick = () => setMode(b.dataset.mode);

// difficulty presets — set many params at once so casual users don't touch sliders
const PRESETS = {
  easy:   { killGoal: 12, enemyCount: 2, enemySpeed: 1.6, enemyRange: 16, rangeJitter: 2, bulletSpeed: 14, speedJitter: 2, fireGap: 4.0, fireJitter: 1.0, minShotGap: 1.2, maxHp: 10, shieldArc: 34 },
  normal: { killGoal: 20, enemyCount: 4, enemySpeed: 2.2, enemyRange: 18, rangeJitter: 3, bulletSpeed: 20, speedJitter: 4, fireGap: 3.0, fireJitter: 1.0, minShotGap: 0.8, maxHp: 5,  shieldArc: 26 },
  hard:   { killGoal: 30, enemyCount: 6, enemySpeed: 3.2, enemyRange: 20, rangeJitter: 5, bulletSpeed: 30, speedJitter: 8, fireGap: 1.8, fireJitter: 1.4, minShotGap: 0.5, maxHp: 3,  shieldArc: 18 },
};
const presetBtns = [...root.querySelectorAll("#presets button")];
function matchPreset() {
  for (const name of Object.keys(PRESETS)) {
    const p = PRESETS[name];
    if (Object.keys(p).every((k) => settings[k] === p[k])) return name;
  }
  return "custom"; // user hand-tuned a slider
}
function refreshPresetButtons() {
  const cur = matchPreset();
  for (const b of presetBtns) b.setAttribute("aria-pressed", String(b.dataset.preset === cur));
}
function applyPreset(name) {
  Object.assign(settings, PRESETS[name]);
  saveSettings(); syncSliderUI(); refreshPresetButtons();
  if (playing) { hp = settings.infiniteHp ? Infinity : settings.maxHp; topUpEnemies(); updateHud(); }
}
for (const b of presetBtns) b.onclick = () => applyPreset(b.dataset.preset);

// 詳細設定 collapse (closed by default — the sliders only matter to tuners)
const advanced = root.querySelector("#advanced");
root.querySelector("#advHead").onclick = () => {
  const hidden = advanced.classList.toggle("collapsed");
  root.querySelector("#advTg").textContent = hidden ? "▸ 開く" : "▾ 閉じる";
};

// ⚙ sliders — built grouped, with each random "ばらつき" beside its base setting
const settingsBox = root.querySelector("#settings");
const sliderHtml = (id) => {
  const m = SLIDER_META[id];
  return `<label>${m.label}</label><input type="range" id="s_${id}" min="${m.min}" max="${m.max}" step="${m.step}"><b id="v_${id}"></b>`;
};
for (const grp of SETTING_GROUPS) {
  const gt = document.createElement("div"); gt.className = "srow-group"; gt.textContent = grp.title;
  settingsBox.appendChild(gt);
  for (const row of grp.rows) {
    const r = document.createElement("div");
    if (row.jitter) {
      const j = SLIDER_META[row.jitter];
      r.className = "srow pair";
      r.innerHTML = sliderHtml(row.id) +
        `<span class="pm" title="ばらつき(±)・0でランダムなし">±</span>` +
        `<input type="range" id="s_${row.jitter}" min="${j.min}" max="${j.max}" step="${j.step}" title="${j.label}"><b id="v_${row.jitter}"></b>`;
    } else {
      r.className = "srow";
      r.innerHTML = sliderHtml(row.id);
    }
    settingsBox.appendChild(r);
    if (row.hp) {
      const hr = document.createElement("label"); hr.className = "row"; hr.style.fontSize = "12px";
      hr.innerHTML = `<input type="checkbox" id="infhp"> ♾ HP無限（デモ用・死なない）`;
      settingsBox.appendChild(hr);
    }
  }
}
infhpEl = root.querySelector("#infhp");

function syncSliderUI() {
  for (const id of ALL_IDS) {
    root.querySelector("#s_" + id).value = settings[id];
    root.querySelector("#v_" + id).textContent = settings[id];
  }
  infhpEl.checked = !!settings.infiniteHp;
}
for (const id of ALL_IDS) {
  const el = root.querySelector("#s_" + id);
  el.oninput = () => {
    settings[id] = parseFloat(el.value);
    root.querySelector("#v_" + id).textContent = el.value;
    saveSettings();
    refreshPresetButtons(); // hand-tuning a slider clears the preset highlight (→ custom)
    if ((id === "enemyCount" || id === "enemyRange" || id === "rangeJitter" || id === "killGoal") && playing) topUpEnemies();
    if (id === "maxHp" && playing && !settings.infiniteHp) { hp = Math.min(hp, settings.maxHp); updateHud(); }
  };
}
infhpEl.onchange = () => {
  settings.infiniteHp = infhpEl.checked; saveSettings();
  if (playing) { hp = settings.infiniteHp ? Infinity : settings.maxHp; updateHud(); }
};
syncSliderUI();
refreshPresetButtons();

root.querySelector("#saveJson").onclick = () => {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "hapbeat-fps-settings.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const fileInput = root.querySelector("#fileInput");
root.querySelector("#loadJson").onclick = () => fileInput.click();
fileInput.onchange = () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const obj = JSON.parse(String(r.result));
      for (const id of ALL_IDS) if (id in obj) settings[id] = clamp(parseFloat(obj[id]), SLIDER_META[id].min, SLIDER_META[id].max);
      if (obj.mode === "move" || obj.mode === "fixed") settings.mode = obj.mode;
      if (typeof obj.infiniteHp === "boolean") settings.infiniteHp = obj.infiniteHp;
      saveSettings(); syncSliderUI(); refreshModeButtons(); refreshPresetButtons(); applyModeVisibility();
      if (playing) topUpEnemies();
    } catch { /* bad file → ignore */ }
    fileInput.value = "";
  };
  r.readAsText(f);
};

// ── three.js scene ───────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
root.appendChild(renderer.domElement);
if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported("immersive-vr")
    .then((ok) => { if (ok) document.body.appendChild(VRButton.createButton(renderer)); })
    .catch(() => {});
}

const scene = new THREE.Scene();
const SKY = 0x9cc2e8;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 45, 110);

const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 240);
camera.position.set(0, 1.6, 0);
rig.add(camera);
let yaw = 0; // pitch/roll fixed (horizontal look only)

// first-person gun (move mode)
const gun = new THREE.Group();
const gunMat = new THREE.MeshStandardMaterial({ color: 0x3a414c, metalness: 0.7, roughness: 0.35 });
const gunDark = new THREE.MeshStandardMaterial({ color: 0x14181f, metalness: 0.6, roughness: 0.5 });
const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.34), gunMat);
gunBody.position.set(0, 0, -0.16); gun.add(gunBody);
const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.32, 10), gunDark);
gunBarrel.rotation.x = Math.PI / 2; gunBarrel.position.set(0, 0.025, -0.4); gun.add(gunBarrel);
const gunGrip = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.17, 0.1), gunDark);
gunGrip.position.set(0, -0.13, -0.02); gunGrip.rotation.x = 0.25; gun.add(gunGrip);
const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd27f }));
muzzle.position.set(0, 0.025, -0.58); muzzle.visible = false; gun.add(muzzle);
const GUN_REST = new THREE.Vector3(0.2, -0.18, -0.32);
gun.position.copy(GUN_REST);
camera.add(gun);
let gunKick = 0, muzzleT = 0;

// frontal shield (fixed mode) — green so it stands out from the blue sky
const shieldMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(2.4, 1.5),
  new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })
);
shieldMesh.position.set(0, -0.05, -1.7);
shieldMesh.visible = false;
camera.add(shieldMesh);
let shieldFlash = 0;

const hemi = new THREE.HemisphereLight(0xffffff, 0x6b7665, 1.05);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xfff3df, 1.0);
dir.position.set(12, 22, 8);
scene.add(dir);

// circular world (floor + polar grid) — always visible (👁 OFF only hides enemies)
const worldGroup = new THREE.Group();
scene.add(worldGroup);
const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA, 64), new THREE.MeshStandardMaterial({ color: 0x6b7665 }));
floor.rotation.x = -Math.PI / 2;
worldGroup.add(floor);
const polar = new THREE.PolarGridHelper(ARENA, 16, 8, 64, 0x9aa890, 0x59634f);
polar.position.y = 0.02;
worldGroup.add(polar);

// ── enemy model: bright orange "sentry" robot + wide invisible hit volume ─────
const EGEO = {
  torso: new THREE.BoxGeometry(0.7, 0.8, 0.45),
  hips: new THREE.BoxGeometry(0.55, 0.35, 0.4),
  leg: new THREE.BoxGeometry(0.18, 0.6, 0.22),
  shoulder: new THREE.BoxGeometry(0.22, 0.3, 0.3),
  arm: new THREE.BoxGeometry(0.16, 0.55, 0.18),
  egun: new THREE.BoxGeometry(0.12, 0.12, 0.5),
  head: new THREE.BoxGeometry(0.42, 0.38, 0.4),
  eye: new THREE.BoxGeometry(0.34, 0.1, 0.06),
  hitbox: new THREE.BoxGeometry(0.95, 1.5, 0.7), // generous torso-height target
};
const enemyBodyMat = new THREE.MeshStandardMaterial({ color: 0xe8553a, metalness: 0.35, roughness: 0.5 });
const enemyDarkMat = new THREE.MeshStandardMaterial({ color: 0x2b2320, metalness: 0.4, roughness: 0.6 });
const hbMat = new THREE.MeshBasicMaterial({ visible: false }); // never rendered, still raycastable

function makeEnemyMesh() {
  const g = new THREE.Group();
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffe14a, emissive: 0xffd000, emissiveIntensity: 1.6 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(EGEO.torso, enemyBodyMat, 0, 1.05, 0);
  add(EGEO.hips, enemyDarkMat, 0, 0.55, 0);
  add(EGEO.leg, enemyDarkMat, -0.18, 0.2, 0);
  add(EGEO.leg, enemyDarkMat, 0.18, 0.2, 0);
  for (const sx of [-0.48, 0.48]) {
    add(EGEO.shoulder, enemyBodyMat, sx, 1.2, 0);
    add(EGEO.arm, enemyDarkMat, sx, 0.85, 0.02);
  }
  add(EGEO.egun, enemyDarkMat, 0.48, 0.95, 0.3);
  add(EGEO.head, enemyBodyMat, 0, 1.62, 0);
  add(EGEO.eye, eyeMat, 0, 1.64, 0.21);
  const hitbox = add(EGEO.hitbox, hbMat, 0, 1.15, 0); // wide aim target (spans ~0.4..1.9)
  return { group: g, eyeMat, hitbox };
}

let enemies = [];

function spawnOneEnemy() {
  const ang = Math.random() * Math.PI * 2;
  const r = clamp(settings.enemyRange + jit(settings.rangeJitter), 6, ARENA - 3);
  const { group, eyeMat, hitbox } = makeEnemyMesh();
  group.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
  group.visible = bridge.master.visual;
  worldGroup.add(group);
  enemies.push({
    mesh: group, eyeMat, hitbox, angle: ang, radius: r,
    orbitDir: Math.random() < 0.5 ? 1 : -1,
    nextFire: 0.8 + nextFireDelay(), flash: 0, alive: true,
  });
}

function rampFactor() {
  const p = kills / Math.max(1, settings.killGoal);
  if (p < 0.25) return 1 / 3;
  if (p < 0.5) return 1 / 2;
  if (p < 0.75) return 2 / 3;
  return 1;
}
function desiredAlive() {
  const remaining = settings.killGoal - kills;
  if (remaining <= 0) return 0;
  return Math.min(remaining, Math.max(1, Math.round(settings.enemyCount * rampFactor())));
}
function topUpEnemies() {
  enemies = enemies.filter((e) => e.alive);
  let need = desiredAlive() - enemies.length;
  while (need-- > 0) spawnOneEnemy();
  updateHud();
}

// ── enemy tracers: magenta head + a streak trail (visible, no inter-frame gaps) ─
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const projHeadGeo = new THREE.SphereGeometry(0.18, 12, 12);
const projHeadMat = new THREE.MeshBasicMaterial({ color: 0xff3df0 });            // hot magenta — high contrast
const projTrailGeo = new THREE.CylinderGeometry(0.08, 0.02, 1, 8);               // unit along +Y (tapers to tail)
const projTrailMat = new THREE.MeshBasicMaterial({ color: 0xff7af2, transparent: true, opacity: 0.5 });
const STREAK = 2.6; // trail length (units): > per-frame travel so fast bullets read as a streak
let projectiles = [];
function clearProjectiles() { for (const p of projectiles) { worldGroup.remove(p.head); worldGroup.remove(p.trail); } projectiles = []; }
function spawnProjectile(e) {
  const from = e.mesh.position.clone(); from.y = 1.25;
  const to = playerPos.clone();
  const dist = Math.max(0.5, from.distanceTo(to));
  const speed = Math.max(4, settings.bulletSpeed + jit(settings.speedJitter));
  const dur = Math.max(0.12, dist / speed); // real speed → distance matters
  const dir = to.clone().sub(from); dir.y = 0; dir.normalize();
  const head = new THREE.Mesh(projHeadGeo, projHeadMat);
  head.position.copy(from);
  const trail = new THREE.Mesh(projTrailGeo, projTrailMat);
  trail.quaternion.setFromUnitVectors(Y_AXIS, dir); // orient along travel
  trail.scale.y = STREAK;
  const vis = bridge.master.visual;
  head.visible = vis; trail.visible = vis;
  worldGroup.add(head); worldGroup.add(trail);
  projectiles.push({ head, trail, dir, from, to, src: e.mesh.position.clone(), enemy: e, t: 0, dur, speed });
}
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.t += dt;
    const k = Math.min(1, p.t / p.dur);
    p.head.position.lerpVectors(p.from, p.to, k);
    p.head.position.y += Math.sin(k * Math.PI) * 0.25;
    // size the streak to at least this frame's head travel (speed*dt) so it bridges
    // the inter-frame gap even at low fps / high bullet speed.
    const len = Math.max(STREAK, p.speed * dt * 1.3);
    p.trail.scale.y = len;
    p.trail.position.copy(p.head.position).addScaledVector(p.dir, -len / 2);
    if (k < 1) continue;
    worldGroup.remove(p.head); worldGroup.remove(p.trail);
    projectiles.splice(i, 1);
    if (!playing) continue;
    if (settings.mode === "fixed") {
      const { theta } = lateralPan(p.src);
      if (Math.abs(theta) <= settings.shieldArc * DEG) {
        shieldFlash = 1;
        blockFeedback(p.src);
        spawnPlayerTracer(playerPos.clone(), p.src.clone(), 0x4dffa0); // reflect back
        if (p.enemy && p.enemy.alive) killEnemy(p.enemy, true);
      } else {
        takeHit(p.src);
      }
    } else if (playerPos.distanceTo(p.to) < SHOT_DODGE_R) {
      takeHit(p.src);
    }
  }
}
function takeHit(srcPos) {
  if (events.playerHit) directionalCue(srcPos, { strong: true });
  if (bridge.master.visual) flashDamage();
  if (!settings.infiniteHp) {
    hp -= 1;
    if (hp <= 0) { updateHud(); gameOver(); return; }
  }
  updateHud();
}

// ── player tracers (your own / reflected shots) — ALWAYS visible ─────────────
const ptGeo = new THREE.SphereGeometry(0.12, 10, 10);
let playerTracers = [];
function clearPlayerTracers() { for (const t of playerTracers) { worldGroup.remove(t.mesh); t.mesh.material.dispose(); } playerTracers = []; }
function spawnPlayerTracer(from, to, color = 0x9af0ff) {
  const mesh = new THREE.Mesh(ptGeo, new THREE.MeshBasicMaterial({ color }));
  mesh.position.copy(from);
  worldGroup.add(mesh);
  playerTracers.push({ mesh, from: from.clone(), to: to.clone(), t: 0, dur: 0.12 });
}
function updatePlayerTracers(dt) {
  for (let i = playerTracers.length - 1; i >= 0; i--) {
    const t = playerTracers[i];
    t.t += dt;
    const k = Math.min(1, t.t / t.dur);
    t.mesh.position.lerpVectors(t.from, t.to, k);
    if (k >= 1) { worldGroup.remove(t.mesh); t.mesh.material.dispose(); playerTracers.splice(i, 1); }
  }
}

// ── kill puffs ───────────────────────────────────────────────────────────────
const deathGeo = new THREE.SphereGeometry(0.4, 12, 12);
let deathFx = [];
function spawnDeathFx(pos) {
  const m = new THREE.Mesh(deathGeo, new THREE.MeshBasicMaterial({ color: 0xffb15c, transparent: true, opacity: 0.9 }));
  m.position.set(pos.x, 1.1, pos.z);
  worldGroup.add(m);
  deathFx.push({ mesh: m, t: 0 });
}
function clearDeathFx() { for (const f of deathFx) { worldGroup.remove(f.mesh); f.mesh.material.dispose(); } deathFx = []; }
function updateDeathFx(dt) {
  for (let i = deathFx.length - 1; i >= 0; i--) {
    const f = deathFx[i]; f.t += dt;
    const k = f.t / 0.35;
    f.mesh.scale.setScalar(1 + k * 2.4);
    f.mesh.material.opacity = Math.max(0, 0.9 * (1 - k));
    if (k >= 1) { worldGroup.remove(f.mesh); f.mesh.material.dispose(); deathFx.splice(i, 1); }
  }
}

// ── game state ─────────────────────────────────────────────────────────────
let hp = 5, score = 0, kills = 0, playing = false, paused = false;
let lastHapticT = 0, lastShotT = 0;
let gpFirePrev = false, gpStartPrev = false, gpStatText = "";
const keys = Object.create(null);
const playerPos = new THREE.Vector3(0, 1.6, 0);

function setPaused(b) { paused = b && playing; pauseEl.style.display = paused ? "flex" : "none"; }

function startGame() {
  hp = settings.infiniteHp ? Infinity : settings.maxHp;
  score = 0; kills = 0; playing = true; paused = false; pauseEl.style.display = "none";
  yaw = 0;
  rig.position.set(0, 0, 0);
  playerPos.set(0, 1.6, 0);
  lastShotT = 0;
  clearProjectiles(); clearPlayerTracers(); clearDeathFx();
  for (const e of enemies) { worldGroup.remove(e.mesh); e.eyeMat.dispose(); }
  enemies = [];
  applyModeVisibility();
  topUpEnemies();
  updateHud();
  overlay.classList.add("hidden");
  if (actx.state === "suspended") actx.resume();
  bridge.unlockAudio();
}

function endGame(title, text) {
  playing = false; paused = false; pauseEl.style.display = "none";
  clearProjectiles(); clearPlayerTracers();
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  overlay.querySelector("h1").textContent = title;
  overlayText.textContent = text;
  overlay.querySelector("button").textContent = "もう一度";
  overlay.classList.remove("hidden");
}
function gameOver() { endGame(score > 0 ? "💥 GAME OVER" : "GAME OVER", `撃破 ${kills}/${settings.killGoal}・スコア ${score}。クリックで再挑戦。`); }
function win() { endGame("🎉 CLEAR!", `${settings.killGoal} 体撃破！スコア ${score}。クリックでもう一度。`); }

function updateHud() {
  elHp.textContent = settings.infiniteHp ? "∞" : String(Math.max(0, hp));
  elKills.textContent = `${kills}/${settings.killGoal}`;
  elLeft.textContent = String(enemies.filter((e) => e.alive).length);
}

function killEnemy(e, reflected) {
  if (!e.alive) return;
  e.alive = false;
  const pos = e.mesh.position.clone();
  worldGroup.remove(e.mesh);
  e.eyeMat.dispose();
  kills += 1; score += 100;
  spawnDeathFx(pos);
  playShot(pos, { gain: 0.6, freq: reflected ? 360 : 480, durMs: 90, noise: false });
  hitmarker();
  updateHud();
  if (kills >= settings.killGoal) { win(); return; }
  topUpEnemies();
}

// ── directional feedback ─────────────────────────────────────────────────────
const fwd = new THREE.Vector3();
const toEnemy = new THREE.Vector3();
function lateralPan(enemyWorldPos) {
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  toEnemy.copy(enemyWorldPos).sub(playerPos);
  toEnemy.y = 0;
  const dist = toEnemy.length();
  if (dist < 1e-4) return { pan: 0, dist: 0, theta: 0 };
  toEnemy.normalize();
  const dot = clamp(fwd.dot(toEnemy), -1, 1);
  const cross = fwd.x * toEnemy.z - fwd.z * toEnemy.x;
  const theta = Math.atan2(cross, dot);
  return { pan: clamp(Math.sin(theta), -1, 1), dist, theta };
}
function directionalCue(worldPos, { strong = false } = {}) {
  const { pan, dist } = lateralPan(worldPos);
  const closeness = clamp(1 - dist / (settings.enemyRange * 1.6), 0.12, 1);
  const gain = (strong ? 1.0 : 0.55) * (0.45 + 0.55 * closeness);
  playShot(worldPos, { gain: strong ? 1.0 : 0.8, freq: strong ? 150 : 230, durMs: strong ? 220 : 150 });
  const t = performance.now() / 1000;
  if (t - lastHapticT >= HAPTIC_MIN_GAP) {
    lastHapticT = t;
    bridge.streamPcm(
      stereoBlip(pan, { gain: clamp(gain, 0.1, 1), durMs: strong ? 150 : 95, freq: strong ? 120 : 170 }),
      { channels: 2, sampleRate: 16000, gain: 1 }
    );
  }
}
function blockFeedback(srcPos) {
  playShot(playerPos, { gain: 0.75, freq: 520, durMs: 120, noise: false });
  const t = performance.now() / 1000;
  if (t - lastHapticT >= HAPTIC_MIN_GAP) {
    lastHapticT = t;
    bridge.streamPcm(stereoBlip(0, { gain: 0.95, durMs: 120, freq: 90 }), { channels: 2, sampleRate: 16000, gain: 1 });
  }
}

function enemyShoot(e) {
  e.flash = 1;
  if (events.enemyFire) directionalCue(e.mesh.position.clone(), { strong: false });
  spawnProjectile(e);
}

// ── shooting back (move mode) — raycast against the wide hitboxes ────────────
const raycaster = new THREE.Raycaster();
function playerFire() {
  if (!playing || paused || settings.mode !== "move") return;
  gunKick = 1; muzzleT = 0.05;
  camera.getWorldDirection(fwd);
  const muzzleWorld = new THREE.Vector3();
  muzzle.getWorldPosition(muzzleWorld);
  if (events.ownShot) {
    playShot(muzzleWorld, { gain: 0.7, freq: 320, durMs: 110 });
    const t = performance.now() / 1000;
    if (t - lastHapticT >= HAPTIC_MIN_GAP) {
      lastHapticT = t;
      bridge.streamPcm(stereoBlip(0, { gain: 0.7, durMs: 70, freq: 220 }), { channels: 2, sampleRate: 16000, gain: 1 });
    }
  }
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const targets = enemies.filter((e) => e.alive).map((e) => e.hitbox);
  const hits = raycaster.intersectObjects(targets, false);
  let hitPoint = playerPos.clone().add(fwd.clone().multiplyScalar(60));
  if (hits.length) {
    hitPoint = hits[0].point.clone();
    const box = hits[0].object;
    const e = enemies.find((en) => en.hitbox === box);
    if (e && e.alive) killEnemy(e, false);
  }
  spawnPlayerTracer(muzzleWorld, hitPoint, 0x9af0ff);
}

let hitmarkerT = null;
function hitmarker() {
  crosshairEl.classList.add("hit");
  clearTimeout(hitmarkerT);
  hitmarkerT = setTimeout(() => crosshairEl.classList.remove("hit"), 110);
}
let dmgT = null;
function flashDamage() {
  dmgEl.classList.add("flash");
  clearTimeout(dmgT);
  dmgT = setTimeout(() => dmgEl.classList.remove("flash"), 120);
}

// ── pointer lock + mouse look (yaw only) + Esc pause ─────────────────────────
function onMouseMove(e) {
  if (paused || document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0024; // horizontal only (no pitch/roll), frozen while paused
}
document.addEventListener("mousemove", onMouseMove);
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (playing) setPaused(!locked); // Esc releases the lock → pause; re-lock → resume
});
renderer.domElement.addEventListener("click", () => {
  if (renderer.xr.isPresenting) return;
  if (document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
    if (!playing) startGame(); // (if playing && paused, re-locking just resumes)
  } else {
    playerFire();
  }
});
overlay.querySelector("#overlaybtn").onclick = () => { renderer.domElement.requestPointerLock(); startGame(); };
root.querySelector("#startbtn").onclick = () => startGame();
window.addEventListener("keydown", (e) => { keys[e.code] = true; });
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

// ── gamepad (Xbox etc.) via the native Gamepad API ───────────────────────────
// Live status badge in the panel helps debug "no reaction": it reads 未検出 until
// getGamepads() sees a pad (Bluetooth pads usually appear only AFTER you press a
// button with the page focused), then 接続 / 接続 btN as you press buttons.
function setGpStat(text, ok) {
  if (text === gpStatText) return;
  gpStatText = text;
  elGpStat.textContent = text;
  elGpStat.className = "badge " + (ok ? "on" : "off");
}
window.addEventListener("gamepadconnected", () => setGpStat("接続", true));
window.addEventListener("gamepaddisconnected", () => setGpStat("未検出", false));
function pollGamepad(dt) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const p of pads) if (p) { gp = p; break; }
  if (!gp) { gpFirePrev = false; gpStartPrev = false; setGpStat("未検出", false); return; }
  let pressedBtn = -1;
  for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i]?.pressed) { pressedBtn = i; break; }
  setGpStat(pressedBtn >= 0 ? `接続 btn${pressedBtn}` : "接続", true);
  const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
  const fire = !!(gp.buttons[7]?.pressed || gp.buttons[0]?.pressed); // RT or A
  const fireEdge = fire && !gpFirePrev; gpFirePrev = fire;
  const startBtn = !!gp.buttons[9]?.pressed; // Start/Menu
  const startEdge = startBtn && !gpStartPrev; gpStartPrev = startBtn;
  if (!playing) { if (fireEdge) startGame(); return; } // a button can start the game
  if (startEdge) {
    // keep pause in lock-step with pointer lock so mouse-look is live exactly when
    // unpaused (pause → release lock; resume → best-effort re-lock for mouse users).
    const willPause = !paused;
    setPaused(willPause);
    if (willPause) { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); }
    else if (!renderer.xr.isPresenting) { try { renderer.domElement.requestPointerLock(); } catch { /* gamepad may lack user-activation */ } }
  }
  if (paused || renderer.xr.isPresenting) return;
  yaw -= dz(gp.axes[2] || 0) * 2.4 * dt; // right stick X → yaw
  if (settings.mode === "move") {
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0);
    if (lx || ly) {
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      rig.position.x += (lx * cos + ly * sin) * settings.playerSpeed * dt;
      rig.position.z += (-lx * sin + ly * cos) * settings.playerSpeed * dt;
      clampToArena();
    }
    if (fireEdge) playerFire();
  }
}

function clampToArena() {
  const maxR = ARENA - 1.5;
  const r = Math.hypot(rig.position.x, rig.position.z);
  if (r > maxR) { rig.position.x *= maxR / r; rig.position.z *= maxR / r; }
}

// ── visibility: mode (gun/shield) + 👁 (enemies only) ─────────────────────────
function applyModeVisibility() {
  gun.visible = settings.mode === "move";
  shieldMesh.visible = settings.mode === "fixed";
}
function applyVisualMode() {
  const v = bridge.master.visual;
  for (const e of enemies) e.mesh.visible = v;
  for (const p of projectiles) { p.head.visible = v; p.trail.visible = v; }
}

// ── main loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function update(dt) {
  applyVisualMode();
  pollGamepad(dt);

  gunKick = Math.max(0, gunKick - dt * 7);
  gun.position.z = GUN_REST.z + gunKick * 0.07;
  gun.rotation.x = gunKick * 0.18;
  muzzleT -= dt;
  muzzle.visible = muzzleT > 0;
  shieldFlash = Math.max(0, shieldFlash - dt * 3);
  shieldMesh.material.opacity = 0.24 + shieldFlash * 0.5;
  shieldMesh.scale.x = settings.shieldArc / 26;

  const active = playing && !paused && !renderer.xr.isPresenting;
  if (active) {
    if (settings.mode === "move") {
      let mx = 0, mz = 0;
      if (keys.KeyW) mz -= 1;
      if (keys.KeyS) mz += 1;
      if (keys.KeyA) mx -= 1;
      if (keys.KeyD) mx += 1;
      if (mx || mz) {
        const len = Math.hypot(mx, mz); mx /= len; mz /= len;
        const sin = Math.sin(yaw), cos = Math.cos(yaw);
        rig.position.x += (mx * cos + mz * sin) * settings.playerSpeed * dt;
        rig.position.z += (-mx * sin + mz * cos) * settings.playerSpeed * dt;
        clampToArena();
      }
    }
    rig.rotation.y = yaw;
    playerPos.set(rig.position.x, 1.6, rig.position.z);

    const nowS = performance.now() / 1000;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (settings.mode === "move") {
        e.angle += (settings.enemySpeed / e.radius) * e.orbitDir * dt;
        e.mesh.position.x = Math.cos(e.angle) * e.radius;
        e.mesh.position.z = Math.sin(e.angle) * e.radius;
      }
      e.mesh.lookAt(playerPos.x, e.mesh.position.y, playerPos.z);
      e.flash = Math.max(0, e.flash - dt * 4);
      e.eyeMat.emissiveIntensity = 1.4 + e.flash * 3.5;
      e.nextFire -= dt;
      if (e.nextFire <= 0) {
        // fixed mode: enforce a global minimum gap so shots aren't simultaneous
        if (settings.mode === "fixed" && settings.minShotGap > 0 && nowS - lastShotT < settings.minShotGap) {
          e.nextFire = 0.06; // retry shortly without resetting the full gap
        } else {
          enemyShoot(e); lastShotT = nowS; e.nextFire = nextFireDelay();
        }
      }
    }
    updateProjectiles(dt);
  }
  updatePlayerTracers(dt);
  updateDeathFx(dt);

  // AudioListener pose → camera (HRTF)
  const camPos = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  camera.getWorldPosition(camPos);
  camera.getWorldQuaternion(camQuat);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat);
  if (listener.positionX) {
    const t = actx.currentTime;
    listener.positionX.setValueAtTime(camPos.x, t);
    listener.positionY.setValueAtTime(camPos.y, t);
    listener.positionZ.setValueAtTime(camPos.z, t);
    listener.forwardX.setValueAtTime(f.x, t);
    listener.forwardY.setValueAtTime(f.y, t);
    listener.forwardZ.setValueAtTime(f.z, t);
    listener.upX.setValueAtTime(u.x, t);
    listener.upY.setValueAtTime(u.y, t);
    listener.upZ.setValueAtTime(u.z, t);
  } else {
    listener.setPosition(camPos.x, camPos.y, camPos.z);
    listener.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
  }
  if (renderer.xr.isPresenting) playerPos.copy(camPos);
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  update(dt);
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

refreshModeButtons();
applyModeVisibility();
overlayText.textContent =
  "画面をクリックすると視点がロックされ開始。敵の銃声の方向を音と触覚で聴き取って対処してください。" +
  "👁 映像 OFF で敵だけ消え、耳と触覚だけの勝負に。モード/弾速/敵数や各ランダム幅は ⚙ で調整（自動保存）。Esc で一時停止。";
updateHud();
