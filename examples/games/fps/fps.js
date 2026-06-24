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
import { stereoBlip, stereoTone, phaseAdvance } from "../shared/synth.js";
import { playerNameField, activeMods } from "../shared/controls.js";
import { createRanking } from "../shared/ranking.js";
import { CONTENT } from "../shared/event-content.js"; // central haptic/audio tuning
import { ContentRouter } from "../shared/content-router.js"; // file-first / synth-fallback router (つなぎ)
import { DEFAULTS, PRESETS, CONTINUOUS, WALK, ENEMY, PLAYER_BULLET, DASH } from "./tuning.js"; // single gameplay-tuning file

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ARENA = 30;            // arena radius (circular)
const SHOT_DODGE_R = 1.6;    // (move) you "dodge" if you moved clear of the impact
const HAPTIC_MIN_GAP = 0.15;
const DEG = Math.PI / 180;
const jit = (w) => (Math.random() * 2 - 1) * w; // ±w uniform random

// ── persistent settings (defaults + presets live in ./tuning.js) ─────────────
const settings = { ...DEFAULTS };
// runtime-mutable deep tuning (walk / continuous / enemy / player-bullet). Factory
// values come from tuning.js; Save/Load JSON and localStorage round-trip these too,
// so a saved file applies the WHOLE config — no hand-editing the source needed.
const tune = { walk: { ...WALK }, continuous: { ...CONTINUOUS }, enemy: { ...ENEMY }, playerBullet: { ...PLAYER_BULLET }, dash: { ...DASH } };
const LS_KEY = "hbfps.settings.v2", LS_TUNE = "hbfps.tune.v1";
function applyTuneFrom(obj) { // copy known deep-tuning groups out of a parsed object
  let any = false;
  for (const g of Object.keys(tune)) if (obj && obj[g] && typeof obj[g] === "object") { Object.assign(tune[g], obj[g]); any = true; }
  return any;
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (s && typeof s === "object") for (const k of Object.keys(DEFAULTS)) if (k in s) settings[k] = s[k];
  } catch { /* ignore */ }
  try { applyTuneFrom(JSON.parse(localStorage.getItem(LS_TUNE) || "null")); } catch { /* ignore */ }
}
function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); localStorage.setItem(LS_TUNE, JSON.stringify(tune)); } catch { /* ignore */ }
}
loadSettings();

const SLIDER_META = {
  killGoal: { label: "目標撃破", min: 1, max: 20, step: 1 },
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
  mouseSens: { label: "感度(マウス)", min: 0.5, max: 3.5, step: 0.1 },
  stickSens: { label: "感度(スティック)", min: 0.5, max: 3.5, step: 0.1 },
};
const ALL_IDS = Object.keys(SLIDER_META);
// grouped layout; `jitter` pairs a random-width slider BESIDE its base setting,
// `hp` appends the ♾ HP-infinite checkbox right under that row.
const SETTING_GROUPS = [
  { title: "ゲーム", rows: [{ id: "killGoal" }, { id: "maxHp", hp: true }, { id: "playerSpeed" }, { id: "mouseSens" }, { id: "stickSens" }] },
  { title: "敵", rows: [{ id: "enemyCount" }, { id: "enemySpeed" }, { id: "enemyRange", jitter: "rangeJitter" }] },
  { title: "弾・発砲", rows: [{ id: "bulletSpeed", jitter: "speedJitter" }, { id: "fireGap", jitter: "fireJitter" }, { id: "minShotGap" }] },
  { title: "固定モード（盾）", rows: [{ id: "shieldArc" }] },
];
function nextFireDelay() { return Math.max(0.2, settings.fireGap + jit(settings.fireJitter)); }

// ── bridge ───────────────────────────────────────────────────────────────────
const bridge = new ArcadeBridge();
let bridgeReady = false;
bridge.init({ appName: "HapbeatFPS", audioBase: "../" }).then(() => { bridgeReady = true; syncConnBadge(); });
const events = { enemyFire: true, playerHit: true, ownShot: true };

// ── AudioContext (HRTF spatial audio) ────────────────────────────────────────
const actx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = actx.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(actx.destination);
const listener = actx.listener;

// ── content router (つなぎ): file-first playback, synth fallback ───────────────
// Reads fps/eventmap.json (bindings) + fps/kit/manifest.json (Studio Kit, haptic
// clips) + event-content.js (audio). With no assets it always hits the synth
// fallback below, so behaviour is unchanged until WAVs are dropped in.
const router = new ContentRouter(bridge);
router.attachAudio(actx, masterGain); // audio FILES play HRTF-spatialized through our ctx
router.load({ eventmapUrl: "eventmap.json", manifestUrl: "../demo-kit/fps-kit/fps-kit-manifest.json", clipBase: "../demo-kit/fps-kit/stream-clips/" });
router.loadAudioFiles("../"); // event-content audio.file paths resolve against the shell root (examples/games/)
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
      backdrop-filter: blur(4px); overflow: hidden; max-height: calc(100vh - 24px); }
    #hbfps .pscroll { display: flex; align-items: flex-start;        /* the two columns scroll together… */
      max-height: calc(100vh - 24px); overflow-y: auto; scrollbar-width: none; } /* …scrollbar hidden (no width shift) */
    #hbfps .pscroll::-webkit-scrollbar { width: 0; height: 0; }
    #hbfps .menu-pin { position: absolute; top: 7px; right: 7px; z-index: 11; display: flex; align-items: center; gap: 4px; } /* ‹ toggle + ☰ gamepad-mapping hint, pinned top-right (right of 詳細設定); stays put when the panel scrolls */
    #hbfps .pcol { padding: 10px 12px; }
    #hbfps .pcol-main { width: 300px; flex: 0 0 auto; }
    #hbfps .pcol-adv { width: 0; max-height: 0; flex: 0 0 auto; overflow: hidden; padding: 0; } /* collapsed: no width AND no height (no empty margin). instant toggle — animating width while max-height popped looked like a vertical-then-horizontal jump */
    #hbfps .panel.adv-open .pcol-adv { width: 292px; max-height: none; padding: 10px 12px; border-left: 1px solid #2a313c; } /* 詳細設定 = 2nd column */
    #hbfps .panel.collapsed { display: none; }
    #hbfps .panel h2 { margin: 0; font-size: 15px; }
    #hbfps .phead { display: flex; align-items: center; gap: 8px; padding-right: 30px; } /* room for the pinned ☰ */
    #hbfps .iconbtn { background: #222a35; color: #cdd6e0; border: 1px solid #39424f;
      border-radius: 7px; width: 28px; height: 26px; cursor: pointer; font-size: 16px; line-height: 1; }
    #hbfps .iconbtn:hover { background: #2c3543; }
    #hbfps .textbtn { background: #222a35; color: #cdd6e0; border: 1px solid #39424f; border-radius: 7px;
      padding: 4px 11px; height: 25px; line-height: 1; font-size: 12px; cursor: pointer; white-space: nowrap; }
    #hbfps .textbtn:hover { background: #2c3543; }
    #hbfps .drawer-open { position: absolute; top: 12px; left: 12px; z-index: 9; display: none; align-items: center; gap: 4px;
      background: rgba(10,13,18,0.84); color: #cdd6e0; border: 1px solid #39424f;
      border-radius: 8px; padding: 3px 8px 3px 7px; height: 30px; cursor: pointer; font-size: 16px; } /* shown as flex via JS (☰ hint + › toggle) */
    #hbfps .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 13px; }
    #hbfps .group-title { font-size: 11px; color: #8b97a6; text-transform: uppercase;
      letter-spacing: .06em; margin: 10px 0 2px; }
    #hbfps .kb { display: inline-block; min-width: 17px; padding: 0 5px; margin-left: 5px; font-size: 11px;
      font-weight: 800; line-height: 16px; text-align: center; border-radius: 5px; background: #2f3a48;
      color: #dbe2ea; border: 1px solid #45515f; vertical-align: middle; text-transform: none; letter-spacing: 0; }
    #hbfps .kb.a { background: #2f7d56; border-color: #45b07e; color: #eafff2; }
    #hbfps .kb.b { background: #9b3d3d; border-color: #cc5f5f; color: #ffecec; }
    #hbfps .kb.x { background: #3a64a0; border-color: #5e8acd; color: #eaf2ff; }
    #hbfps .kb.y { background: #9b8636; border-color: #cdb255; color: #fff9e8; }
    #hbfps .kb.a, #hbfps .kb.b, #hbfps .kb.x, #hbfps .kb.y { border-radius: 50%; width: 19px; min-width: 19px; height: 19px; padding: 0; line-height: 17px; }
    #hbfps .row .kb { margin-left: auto; }
    #hbfps input[type=checkbox] { width: 16px; height: 16px; accent-color: #7c5cff; }
    #hbfps .modes { display: flex; gap: 6px; margin: 4px 0; }
    #hbfps .modes button { flex: 1; padding: 7px; font-size: 12px; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps .modes button[aria-pressed=true] { background: #7c5cff; color: #fff; border-color: #7c5cff; }
    #hbfps .settings-head { cursor: pointer; user-select: none; display: flex; justify-content: space-between; align-items: center; }
    #hbfps .settings-head .tg { color: #c2b6ff; font-size: 11px; } /* lighter lavender — readable on dark */
    #hbfps #advanced { padding: 0; } /* no inner scroll — the whole panel scrolls */
    #hbfps .srow-group { font-size: 11px; color: #8b97a6; font-weight: 600; margin: 9px 0 1px; }
    #hbfps .srow.pair { grid-template-columns: 58px 1fr 24px 14px 0.85fr 20px; }
    #hbfps .srow .pm { text-align: center; color: #6f7c8c; font-size: 12px; }
    #hbfps button.primary { margin-top: 10px; width: 100%; padding: 9px; font-size: 14px;
      font-weight: 600; color: #fff; background: #7c5cff; border: 0; border-radius: 8px; cursor: pointer; }
    #hbfps button.primary:hover { background: #8f72ff; }
    #hbfps .srow { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center;
      gap: 8px; font-size: 12px; margin: 6px 0; }
    #hbfps .srow input[type=range] { width: 100%; accent-color: #7c5cff; }
    #hbfps .srow b { text-align: right; color: #cdd6e0; font-variant-numeric: tabular-nums; }
    #hbfps .iorow { display: flex; gap: 6px; margin-top: 6px; }
    #hbfps .iorow button { flex: 1; padding: 6px; font-size: 11px; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps .rankrow { justify-content: space-between; margin-top: 8px; }
    #hbfps .namefield { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #8b97a6; }
    #hbfps .namefield input { font: inherit; font-size: 13px; color: #e6edf3; background: #1b222c;
      border: 1px solid #39424f; border-radius: 7px; padding: 5px 8px; width: 88px; }
    #hbfps .namefield input:focus { outline: none; border-color: #7c5cff; }
    #hbfps .namefield .namedice { font-size: 12px; padding: 4px 6px; line-height: 1; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps #rankbtn { padding: 6px 10px; font-size: 12px; border: 1px solid #39424f;
      background: #1b222c; color: #cdd6e0; border-radius: 7px; cursor: pointer; }
    #hbfps #rankbtn:hover { background: #2c3543; }
    #hbfps .wide-stop { width: 100%; margin-top: 6px; padding: 8px; font-size: 12px;
      border: 1px solid #6f3a4a; background: #3a2330; color: #ffd9e4; border-radius: 8px; cursor: pointer; }
    #hbfps .wide-stop:hover { background: #4a2c3d; }
    #hbfps .wide-stop:disabled { opacity: .45; cursor: default; }
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
    #hbfps .help-modal { position: absolute; inset: 0; z-index: 12; display: flex; align-items: center;
      justify-content: center; background: rgba(4,6,10,0.6); }
    #hbfps .help-modal.hidden { display: none; }
    #hbfps .help-card { max-width: 460px; max-height: 86vh; overflow-y: auto; background: #161b22;
      border: 1px solid #2a313c; border-radius: 12px; padding: 18px 22px; color: #e6edf3; }
    #hbfps .help-card h2 { margin: 0 0 8px; font-size: 19px; }
    #hbfps .help-card h3 { margin: 14px 0 4px; font-size: 13px; color: #9fb0c8; }
    #hbfps .help-card p { font-size: 14px; line-height: 1.6; color: #cdd6e0; margin: 4px 0; }
    #hbfps .help-card ul { margin: 4px 0; padding-left: 18px; }
    #hbfps .help-card li { font-size: 14px; line-height: 1.7; color: #dbe2ea; }
    #hbfps .help-card b { color: #fff; }
    #hbfps .help-card .primary { margin-top: 14px; }
  </style>
  <div class="panel adv-open" id="panel">
   <div class="menu-pin"><span class="kb">☰</span><button class="iconbtn" id="drawerTab" title="HUD を隠す（パッドは ☰ Menu）">‹</button></div>
   <div class="pscroll">
   <div class="pcol pcol-main">
    <div class="phead">
      <h2>触覚 FPS</h2>
      <button class="textbtn" id="helpBtn" title="操作説明を開く">？ 操作説明</button>
    </div>

    <div class="group-title">モード <span class="kb">⧉</span></div>
    <div class="modes" id="modes">
      <button data-mode="move" title="WASD+マウスで動いて撃つ">移動</button>
      <button data-mode="fixed" title="その場で向くだけ・盾で防ぐ">固定（盾）</button>
    </div>

    <div class="group-title">難易度 <span class="kb">LB / RB</span></div>
    <div class="modes" id="presets">
      <button data-preset="easy">Easy</button>
      <button data-preset="normal">Normal</button>
      <button data-preset="hard">Hard</button>
    </div>

    <div class="group-title">モダリティ <span style="text-transform:none;font-size:9px;color:#6f7c8c;letter-spacing:0;">（パッドは開始前のみ）</span></div>
    <label class="row"><input type="checkbox" id="m_visual" checked> 👁 映像（敵）<span class="kb x">X</span></label>
    <label class="row"><input type="checkbox" id="m_audio" checked> 👂 音<span class="kb y">Y</span></label>
    <label class="row"><input type="checkbox" id="m_haptic" checked> ✋ 触覚<span class="kb b">B</span></label>

    <div class="group-title">フィードバック対象</div>
    <label class="row"><input type="checkbox" id="e_fire" checked> ① 敵の発砲（方向）</label>
    <label class="row"><input type="checkbox" id="e_hit" checked> ② 被弾</label>
    <label class="row"><input type="checkbox" id="e_own" checked> ③ 自分の発砲</label>
    <label class="row" title="最接近の敵弾の方向と距離を ~100Hz の連続振動で提示（左右バランス＋接近で増大）。映像OFF時の索敵に。発射時の定位はそのまま。"><input type="checkbox" id="contHaptic"> 〜 連続モード（弾の方向を触覚で）</label>
    <label class="row" title="移動中に画面が上下し、足音の振動が出る。歩くと敵の銃撃の触覚が分かりにくくなる（止まると気づきやすい / 動くと避けやすい）。"><input type="checkbox" id="walkFb"> 🚶 歩行フィードバック（移動）</label>

    <div class="group-title settings-head" id="advHead"><span>⚙ 詳細設定</span><span class="tg" id="advTg">▾ 閉じる</span></div>
    <input type="file" id="fileInput" accept="application/json,.json" style="display:none">

    <div class="row" style="margin-top:10px; font-size:11px; color:#8b97a6;">
      Helper: <span id="conn" class="badge off">未接続</span>
      ・ 🎮 <span id="gpstat" class="badge off">未検出</span>
    </div>
    <div class="row rankrow">
      <span id="nameslot"></span>
      <button id="rankbtn" title="ランキングを別ウィンドウで開く（展示用）">🏆 ランキング</button>
    </div>
    <button class="primary" id="startbtn">スタート / リスタート <span class="kb a">A</span></button>
    <button id="stopbtn" class="wide-stop">ストップ（タイトルに戻る）</button>
   </div>
   <div class="pcol pcol-adv" id="advCol">
    <div id="advanced">
      <div class="group-title">⚙ 詳細設定（±幅は 0 でランダムなし）</div>
      <div id="settings"></div>
      <div class="iorow">
        <button id="saveJson">Save</button>
        <button id="loadJson">Load</button>
      </div>
    </div>
   </div>
   </div>
  </div>
  <button class="drawer-open" id="drawerOpen" title="HUD を表示（パッドは ☰ Menu）"><span class="kb">☰</span>›</button>
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
  <div class="help-modal hidden" id="helpModal">
    <div class="help-card">
      <h2>操作説明</h2>
      <p>敵の銃声を <b>音(HRTF)</b> と <b>触覚(L/R)</b> で方向化。<b>👁 OFF</b> でも弾は見え、耳と触覚で対処できる。</p>
      <h3>キーボード / マウス</h3>
      <ul>
        <li><b>移動モード</b>: <b>WASD</b> 移動 / マウスで水平回転 / <b>クリック</b> 射撃 / <b>Shift</b> ダッシュ / <b>Esc</b> 一時停止</li>
        <li><b>固定モード</b>: その場で回転して銃声の方向へ正面を向け、<b>正面の盾</b>で受けて跳ね返す（動かない）</li>
      </ul>
      <h3>ゲームパッド</h3>
      <ul>
        <li><b>Ⓐ</b> 開始 / 射撃　<b>スティック</b> 移動・視点　<b>LB</b> ダッシュ（タイトルでは <b>LB·RB</b> 難易度）</li>
        <li><b>☰</b> HUD 表示・一時停止　<b>⧉(View)</b> モード切替（開始前）　<b>Ⓧ/Ⓨ/Ⓑ</b> 映像/音/触覚（開始前）</li>
      </ul>
      <button id="helpClose" class="primary">とじる</button>
    </div>
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
const elGpStat = root.querySelector("#gpstat");
// help modal (replaces the old faint in-panel control hints)
const helpModal = root.querySelector("#helpModal");
root.querySelector("#helpBtn").onclick = () => helpModal.classList.remove("hidden");
root.querySelector("#helpClose").onclick = () => helpModal.classList.add("hidden");
helpModal.onclick = (e) => { if (e.target === helpModal) helpModal.classList.add("hidden"); };
let infhpEl; // built dynamically inside the grouped settings (assigned after build)

// ── ranking board (booth: pop out to a second monitor, accumulates until reset) ─
const rank = createRanking("fps", {
  title: "触覚 FPS",
  columns: [
    { key: "score", label: "スコア", unit: "pt", decimals: 0, lowerIsBetter: false, primary: true },
    { key: "kills", label: "撃破", unit: "", decimals: 0, lowerIsBetter: false },
  ],
});
const nameField = playerNameField(); // empty input + random placeholder, re-rolled each play
root.querySelector("#nameslot").appendChild(nameField.el);
root.querySelector("#rankbtn").onclick = () => rank.openPopout();
function recordRun(result) {
  if (score <= 0) return; // skip an instant 0-kill death (keeps the booth board clean)
  rank.record({
    name: nameField.get(),
    metrics: { score, kills },
    mods: activeMods(bridge),
    detail: `${settings.mode === "fixed" ? "固定" : "移動"} ・ ${result}`,
  });
}

function syncConnBadge() {
  const ok = bridgeReady && bridge.connected;
  elConn.className = "badge " + (ok ? "on" : "off");
  elConn.textContent = ok ? "接続" : "未接続(音/映像のみ)";
}
bridge.onChange(syncConnBadge);

function setDrawer(open) { // collapse/expand the HUD panel; the › button shows when collapsed
  panelEl.classList.toggle("collapsed", !open);
  drawerOpen.style.display = open ? "none" : "flex"; // flex: ☰ hint + › glyph sit on one line
}
// HUD ⟺ pause: opening the panel pauses the game, closing it resumes — you don't
// play with the HUD open. While not playing, it just toggles visibility.
function toggleDrawer() {
  const willOpen = panelEl.classList.contains("collapsed");
  if (playing) setPaused(willOpen);
  else setDrawer(willOpen);
}
root.querySelector("#drawerTab").onclick = toggleDrawer;
drawerOpen.onclick = toggleDrawer;

const mVisual = root.querySelector("#m_visual"), mAudio = root.querySelector("#m_audio"), mHaptic = root.querySelector("#m_haptic");
mVisual.onchange = (e) => bridge.setMaster("visual", e.target.checked);
mAudio.onchange = (e) => bridge.setMaster("audio", e.target.checked);
mHaptic.onchange = (e) => bridge.setMaster("haptic", e.target.checked);
function toggleMaster(key, el) { const v = !bridge.master[key]; bridge.setMaster(key, v); el.checked = v; } // for gamepad Ⓧ/Ⓨ/Ⓑ
root.querySelector("#e_fire").onchange = (e) => (events.enemyFire = e.target.checked);
root.querySelector("#e_hit").onchange = (e) => (events.playerHit = e.target.checked);
root.querySelector("#e_own").onchange = (e) => (events.ownShot = e.target.checked);
const contHapticEl = root.querySelector("#contHaptic");
contHapticEl.checked = settings.continuousHaptic;
contHapticEl.onchange = (e) => { settings.continuousHaptic = e.target.checked; saveSettings(); if (!e.target.checked) stopContinuousHaptic(); };
const walkFbEl = root.querySelector("#walkFb");
walkFbEl.checked = settings.walkFeedback;
walkFbEl.onchange = (e) => { settings.walkFeedback = e.target.checked; saveSettings(); if (!e.target.checked) { walkBob = 0; walkSway = 0; camera.position.set(0, 1.6, 0); } };

// mode toggle (移動 / 固定)
const modeBtns = [...root.querySelectorAll("#modes button")];
function refreshModeButtons() {
  for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === settings.mode));
}
function setMode(m) {
  settings.mode = m; saveSettings();
  refreshModeButtons(); applyModeVisibility();
  if (playing) startGame();
}
for (const b of modeBtns) b.onclick = () => setMode(b.dataset.mode);

// difficulty presets — PRESETS imported from ./tuning.js (single tuning file)
const presetBtns = [...root.querySelectorAll("#presets button")];
if (!PRESETS[settings.preset]) settings.preset = "normal"; // never leave it unselected
// The selected preset is STICKY (settings.preset) so a difficulty is ALWAYS lit —
// tweaking a slider keeps "based on Normal" highlighted instead of clearing it.
function refreshPresetButtons() {
  for (const b of presetBtns) b.setAttribute("aria-pressed", String(b.dataset.preset === settings.preset));
}
function applyPreset(name) {
  Object.assign(settings, PRESETS[name]);
  settings.preset = name;
  saveSettings(); syncSliderUI(); refreshPresetButtons();
  if (playing) { hp = settings.infiniteHp ? Infinity : settings.maxHp; topUpEnemies(); updateHud(); }
}
for (const b of presetBtns) b.onclick = () => applyPreset(b.dataset.preset);
const PRESET_ORDER = ["easy", "normal", "hard"];
function cyclePreset(dir) { // LB/RB on the gamepad
  let i = PRESET_ORDER.indexOf(settings.preset);
  if (i < 0) i = 1;
  applyPreset(PRESET_ORDER[(i + dir + PRESET_ORDER.length) % PRESET_ORDER.length]);
}

// 詳細設定 = a 2nd column that flies out to the right (closed by default — the
// sliders only matter to tuners; opening doesn't change the base panel width).
root.querySelector("#advHead").onclick = () => {
  const open = panelEl.classList.toggle("adv-open");
  root.querySelector("#advTg").textContent = open ? "▾ 閉じる" : "▸ 開く";
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
    // (the selected preset stays lit even after a manual tweak — see refreshPresetButtons)
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
  // download in the SAME schema as fps/tuning.json → drop this file onto fps/tuning.json
  // to apply the whole config as the new default (or use Load to apply it live + persist).
  const full = { defaults: { ...settings }, presets: PRESETS, continuous: tune.continuous, walk: tune.walk, enemy: tune.enemy, playerBullet: tune.playerBullet, dash: tune.dash };
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "tuning.json"; a.click();
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
      // accept the tuning.json schema ({defaults, presets, walk, ...}) OR a flat object
      const dz = (obj.defaults && typeof obj.defaults === "object") ? obj.defaults : obj;
      for (const id of ALL_IDS) if (id in dz) settings[id] = clamp(parseFloat(dz[id]), SLIDER_META[id].min, SLIDER_META[id].max);
      if (dz.mode === "move" || dz.mode === "fixed") settings.mode = dz.mode;
      if (typeof dz.infiniteHp === "boolean") settings.infiniteHp = dz.infiniteHp;
      if (typeof dz.continuousHaptic === "boolean") { settings.continuousHaptic = dz.continuousHaptic; contHapticEl.checked = dz.continuousHaptic; }
      if (typeof dz.walkFeedback === "boolean") { settings.walkFeedback = dz.walkFeedback; walkFbEl.checked = dz.walkFeedback; }
      if (obj.presets && typeof obj.presets === "object") for (const k of Object.keys(PRESETS)) if (obj.presets[k]) Object.assign(PRESETS[k], obj.presets[k]);
      settings.preset = PRESETS[dz.preset] ? dz.preset : "normal"; // keep a difficulty selected
      applyTuneFrom(obj); // deep groups: walk / continuous / enemy / playerBullet (top-level keys)
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
let gunKick = 0;
let walkPhase = 0, walkStepMark = 0, walkBob = 0, walkSway = 0; // walking head-bob + footstep cadence (move mode)
let lastWalkX = 0, lastWalkZ = 0; // rig position last frame → measure real movement (keyboard OR stick)

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
  hitbox: new THREE.BoxGeometry(0.95, 1.5, 0.7), // body-covering; the whole enemy is scaled up (tune.enemy.scale)
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
  const hitbox = add(EGEO.hitbox, hbMat, 0, 1.15, 0); // covers the body (local)
  g.scale.setScalar(tune.enemy.scale); // scale the WHOLE enemy up → torso ≈ eye level (1.05·1.5≈1.6). applies to NEW spawns (restart after changing)
  return { group: g, eyeMat, hitbox };
}

let enemies = [];

function spawnOneEnemy() {
  const ang = Math.random() * Math.PI * 2;
  const r = clamp(settings.enemyRange + jit(settings.rangeJitter), 6, ARENA - 3);
  const { group, eyeMat, hitbox } = makeEnemyMesh();
  group.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
  group.visible = bridge.master.visual;
  group.scale.setScalar(0.001); // grow in (spawnT) so a kill-respawn doesn't hard-POP elsewhere
  worldGroup.add(group);
  enemies.push({
    mesh: group, eyeMat, hitbox, angle: ang, radius: r,
    orbitDir: Math.random() < 0.5 ? 1 : -1,
    nextFire: 0.8 + nextFireDelay(), flash: 0, alive: true, spawnT: 0,
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
  // enemy BULLETS stay visible even with 👁 OFF — only the enemies themselves hide
  // (so "映像オフ" still lets you see incoming fire). See applyVisualMode().
  head.visible = true; trail.visible = true;
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
        // reflect back toward the enemy BODY (hitbox centre), not p.src which is the
        // mesh origin at the FEET (y=0) — aiming at the feet made the bolt drift DOWN.
        const back = p.enemy && p.enemy.alive
          ? p.enemy.hitbox.getWorldPosition(new THREE.Vector3())
          : p.src.clone().setY(1.25);
        spawnPlayerTracer(playerPos.clone(), back.sub(playerPos), 0x4dffa0, false); // visual only; kill is explicit below
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

// ── player tracers (your own / reflected shots) — slower + streak, ALWAYS visible ─
const ptHeadGeo = new THREE.SphereGeometry(0.13, 10, 10);
const ptTrailGeo = new THREE.CylinderGeometry(0.06, 0.015, 1, 8); // unit along +Y
let playerTracers = [];
function clearPlayerTracers() {
  for (const t of playerTracers) {
    worldGroup.remove(t.head); worldGroup.remove(t.trail);
    t.head.material.dispose(); t.trail.material.dispose();
  }
  playerTracers = [];
}
const _seg = new THREE.Vector3(), _toC = new THREE.Vector3(), _closest = new THREE.Vector3(), _ec = new THREE.Vector3();
const PLAYER_BULLET_RANGE = 70; // m a bullet travels before it despawns
// shortest distance from point c to the segment a→b (swept test → no tunneling at speed)
function segPointDist(a, b, c) {
  _seg.copy(b).sub(a);
  const L2 = _seg.lengthSq();
  let s = L2 > 0 ? _toC.copy(c).sub(a).dot(_seg) / L2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  _closest.copy(a).addScaledVector(_seg, s);
  return _closest.distanceTo(c);
}
// A real projectile: origin + direction are LOCKED at fire time and never change.
// With collides=true its own swept flight decides what it hits — so aiming AFTER the
// shot can't change the outcome, and what the tracer visibly crosses is what dies.
function spawnPlayerTracer(from, dir, color = 0xffd23a, collides = true) {
  const d = dir.clone().normalize();
  const head = new THREE.Mesh(ptHeadGeo, new THREE.MeshBasicMaterial({ color }));
  head.position.copy(from);
  const trail = new THREE.Mesh(ptTrailGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
  trail.quaternion.setFromUnitVectors(Y_AXIS, d); // fixed orientation (straight flight)
  worldGroup.add(head); worldGroup.add(trail);
  playerTracers.push({ head, trail, dir: d, pos: from.clone(), prev: from.clone(), dist: 0, collides });
}
function updatePlayerTracers(dt) {
  const R = tune.enemy.hitRadius, speed = tune.playerBullet.speed;
  for (let i = playerTracers.length - 1; i >= 0; i--) {
    const t = playerTracers[i];
    t.prev.copy(t.pos);
    const step = speed * dt;
    t.pos.addScaledVector(t.dir, step);
    t.dist += step;
    // swept collision: did THIS bullet's path this frame pass within R of an enemy body?
    let hit = null, bestD = Infinity;
    if (t.collides) {
      for (const e of enemies) {
        if (!e.alive) continue;
        e.hitbox.getWorldPosition(_ec);                 // refreshes matrices → never stale
        if (segPointDist(t.prev, t.pos, _ec) <= R) {
          const d = _ec.distanceTo(t.prev);             // nearest one met along the path
          if (d < bestD) { bestD = d; hit = e; }
        }
      }
    }
    t.head.position.copy(t.pos);
    const len = Math.max(tune.playerBullet.streak, step * 1.3); // streak ≥ this frame's travel
    t.trail.scale.y = len;
    t.trail.position.copy(t.pos).addScaledVector(t.dir, -len / 2);
    if (hit || t.dist >= PLAYER_BULLET_RANGE) {
      if (hit) killEnemy(hit, false); // the bullet itself registers the hit, on contact
      worldGroup.remove(t.head); worldGroup.remove(t.trail);
      t.head.material.dispose(); t.trail.material.dispose();
      playerTracers.splice(i, 1);
    }
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
let gpFirePrev = false, gpStartPrev = false, gpStatText = "", gpLbPrev = false, gpRbPrev = false;
let dashing = false, gpLbHeld = false; // sprint: Shift (keyboard) / LB (gamepad). 2× speed + feedback
let gpXPrev = false, gpYPrev = false, gpBPrev = false, gpVwPrev = false; // Ⓧ/Ⓨ/Ⓑ modality, View=mode
const keys = Object.create(null);
const playerPos = new THREE.Vector3(0, 1.6, 0);

function setPaused(b) {
  paused = b && playing;
  pauseEl.style.display = paused ? "flex" : "none";
  setDrawer(paused || !playing); // HUD open while paused or on the title; collapsed while actively playing
  // release the OS cursor when the HUD opens so the revealed panel is clickable
  // (e.g. pausing via the gamepad ☰, where the browser hasn't freed pointer-lock for us)
  if (paused && document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function startGame() {
  nameField.roll(); // fresh random name suggestion for this play
  hp = settings.infiniteHp ? Infinity : settings.maxHp;
  score = 0; kills = 0; playing = true; paused = false; pauseEl.style.display = "none";
  yaw = 0;
  rig.position.set(0, 0, 0);
  playerPos.set(0, 1.6, 0);
  walkPhase = 0; walkStepMark = 0; walkBob = 0; walkSway = 0; lastWalkX = 0; lastWalkZ = 0; camera.position.set(0, 1.6, 0); // reset head-bob/sway
  lastShotT = 0;
  clearProjectiles(); clearPlayerTracers(); clearDeathFx();
  for (const e of enemies) { worldGroup.remove(e.mesh); e.eyeMat.dispose(); }
  enemies = [];
  applyModeVisibility();
  topUpEnemies();
  updateHud();
  overlay.classList.add("hidden");
  setDrawer(false); // HUD auto-hidden during play (pause / ☰ to show)
  if (actx.state === "suspended") actx.resume();
  bridge.unlockAudio();
}

function endGame(title, text) {
  playing = false; paused = false; pauseEl.style.display = "none";
  stopContinuousHaptic();
  clearProjectiles(); clearPlayerTracers();
  setDrawer(true); // bring the HUD back so settings are editable on the title screen
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  overlay.querySelector("h1").textContent = title;
  overlayText.textContent = text;
  overlay.querySelector("button").textContent = "もう一度";
  overlay.classList.remove("hidden");
}
function gameOver() { recordRun("敗北"); endGame(score > 0 ? "💥 GAME OVER" : "GAME OVER", `撃破 ${kills}/${settings.killGoal}・スコア ${score}。クリックで再挑戦。`); }
function win() { recordRun("CLEAR"); endGame("🎉 CLEAR!", `${settings.killGoal} 体撃破！スコア ${score}。クリックでもう一度。`); }
// Stop = abandon the current match WITHOUT recording, back to the title overlay.
function stopGame() {
  playing = false; paused = false; pauseEl.style.display = "none";
  stopContinuousHaptic();
  clearProjectiles(); clearPlayerTracers();
  setDrawer(true);
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  overlay.querySelector("h1").textContent = "触覚 FPS";
  overlayText.textContent = "停止しました。クリック / Ⓐ で開始。";
  overlay.querySelector("button").textContent = "クリックして開始";
  overlay.classList.remove("hidden");
}
root.querySelector("#stopbtn").onclick = stopGame;

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
  const ev = CONTENT.fps_kill;
  router.audio("fps_kill", { worldPos: pos, gain: 1 }, () =>
    playShot(pos, { gain: ev.audio.vol, freq: reflected ? ev.audio.freq * 0.75 : ev.audio.freq, durMs: ev.audio.durMs, noise: false }));
  const tk = performance.now() / 1000;
  if (bridge.master.haptic && tk - lastHapticT >= HAPTIC_MIN_GAP) {
    lastHapticT = tk;
    router.haptic("fps_kill", { gain: 1 }, () =>
      bridge.streamPcm(stereoBlip(0, { gain: ev.haptic.gain, durMs: ev.haptic.durMs, freq: ev.haptic.freq }), { channels: 2, sampleRate: 16000, gain: 1 }));
  }
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
  const name = strong ? "fps_player_hit" : "fps_enemy_shot";
  const ev = CONTENT[name]; // central tuning (synth-fallback values)
  const { pan, dist } = lateralPan(worldPos);
  const closeness = clamp(1 - dist / (settings.enemyRange * 1.6), 0.12, 1);
  // audio: kit/event-content file (HRTF) → synth gun burst
  router.audio(name, { worldPos, gain: 1 }, () =>
    playShot(worldPos, { gain: ev.audio.vol, freq: ev.audio.freq, durMs: ev.audio.durMs }));
  // haptic: manifest clip (panned) → synth blip, throttled. `cl` (closeness) scales BOTH.
  const t = performance.now() / 1000;
  if (t - lastHapticT >= HAPTIC_MIN_GAP) {
    lastHapticT = t;
    const cl = 0.45 + 0.55 * closeness;
    router.haptic(name, { pan, gain: cl }, () =>
      bridge.streamPcm(stereoBlip(pan, { gain: clamp(ev.haptic.gain * cl, 0.1, 1), durMs: ev.haptic.durMs, freq: ev.haptic.freq }), { channels: 2, sampleRate: 16000, gain: 1 }));
  }
}
// 固定モード: shield BLOCK (success) — deliberately a clean low "pokon", distinct
// from the body-HIT cue (fps_player_hit, via directionalCue) so the two are obvious.
function blockFeedback(srcPos) {
  const ev = CONTENT.fps_block;
  router.audio("fps_block", { worldPos: playerPos, gain: 1 }, () =>
    playShot(playerPos, { gain: ev.audio.vol, freq: ev.audio.freq, durMs: ev.audio.durMs, noise: false }));
  const t = performance.now() / 1000;
  if (t - lastHapticT >= HAPTIC_MIN_GAP) {
    lastHapticT = t;
    router.haptic("fps_block", { gain: 1 }, () =>
      bridge.streamPcm(stereoBlip(0, { gain: ev.haptic.gain, durMs: ev.haptic.durMs, freq: ev.haptic.freq }), { channels: 2, sampleRate: 16000, gain: 1 }));
  }
}

// ── continuous directional haptic (opt-in 連続モード) ─────────────────────────
// Modulate a ~100Hz tone by the NEAREST incoming bullet: stereo L/R balance by
// azimuth + total amplitude by distance (closer = stronger), per the ToH2022
// "musical-vibration navigation" algorithm (Eqs. 1–4). Independent of, and on top
// of, the per-shot localization — a continuous "radar" you can feel with 👁 OFF.
let lastContT = 0, contPhase = 0, contStream = null;
// One PERSISTENT stream (LiveStream): STREAM_BEGIN once, then chunks pushed every
// ~real-time period — no per-chunk teardown, so the device ring stays fed and the
// tone is continuous (root-fix for the "gata-gata"). The sine PHASE is carried
// across chunks (contPhase) so there's no boundary click. A discrete fire/footstep
// ends the live stream (1 session = 1 stream); we transparently re-open it.
// all continuous-mode tunables live in ./tuning.js (CONTINUOUS) → tune.continuous (runtime)
function closeContStream() {
  if (contStream && !contStream.closed) contStream.close();
  contStream = null;
}
function nearestBullet() {
  let best = null, bestD = Infinity;
  for (const p of projectiles) {
    if (p.t >= p.dur) continue;
    const d = p.head.position.distanceTo(playerPos);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}
function updateContinuousHaptic() {
  if (!settings.continuousHaptic || !playing || paused || !bridge.master.haptic) { closeContStream(); return; }
  const t = performance.now() / 1000;
  if (t - lastContT < tune.continuous.periodS) return;
  const p = nearestBullet();
  if (!p) { closeContStream(); contPhase = 0; return; } // no threat → drop the stream
  lastContT = t;
  const { theta, dist } = lateralPan(p.head.position);
  const deg = (theta * 180) / Math.PI;                      // +deg = bullet to the right
  const AR = clamp((90 + deg) / 180, 0, 1);                 // right-stronger when on the right (Eqs. 2–3,
  const AL = clamp((90 - deg) / 180, 0, 1);                 //   sign-matched to our forward frame)
  const Rmax = settings.enemyRange * tune.continuous.rmaxK;
  const closeness = clamp(1 - dist / Rmax, 0, 1);
  const Ar = (tune.continuous.floor + (1 - tune.continuous.floor) * Math.pow(closeness, tune.continuous.curve)) * tune.continuous.gain; // distance→amplitude (Eq. 4); floor/curve in tuning.js
  // (re)open the persistent stream — a discrete fire/footstep may have ended it
  if (!contStream || contStream.closed) {
    contStream = bridge.openStream({ channels: 2, sampleRate: 16000, gain: 1 });
    contPhase = 0;
  }
  if (contStream) {
    contStream.write(stereoTone(AL * Ar, AR * Ar, { freq: tune.continuous.freq, durMs: tune.continuous.durMs, edgeMs: 0, startPhase: contPhase }));
    contPhase = (contPhase + phaseAdvance(tune.continuous.freq, tune.continuous.durMs)) % (2 * Math.PI); // carry phase → seamless
  }
}
function stopContinuousHaptic() { lastContT = 0; contPhase = 0; closeContStream(); }

// Footstep buzz (move mode). Each step streams a short low pulse — which (by the
// SDK's 1-stream rule) interrupts any in-flight enemy-fire haptic, so WALKING
// MASKS the gunfire cue. Stand still to feel threats clearly; move to dodge.
function footstepHaptic() {
  if (!bridge.master.haptic) return;
  const h = CONTENT.fps_walk.haptic;
  const dashK = dashing ? tune.dash.multiplier : 1; // dash → stronger footstep buzz
  router.haptic("fps_walk", { gain: dashK }, () =>
    bridge.streamPcm(stereoBlip(0, { gain: h.gain * dashK, durMs: h.durMs, freq: h.freq }), { channels: 2, sampleRate: 16000, gain: 1 }));
}
// Footstep SOUND (move mode) — a short low thud through the local AudioContext
// (non-spatial, centred). Like the buzz, it masks the gunfire cue while you walk.
function footstepSound() {
  if (!bridge.master.audio) return;
  const a = CONTENT.fps_walk.audio;
  if (!a) return;
  const dashK = dashing ? tune.dash.multiplier : 1; // dash → louder steps
  router.audio("fps_walk", { gain: dashK }, () => {
    if (actx.state === "suspended") actx.resume();
    const t0 = actx.currentTime, end = t0 + a.durMs / 1000;
    const o = actx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(a.freq, t0);
    o.frequency.exponentialRampToValueAtTime(a.freq * 0.6, end);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(a.vol * dashK, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g).connect(masterGain);
    o.start(t0); o.stop(end + 0.02);
  });
}

function enemyShoot(e) {
  e.flash = 1;
  if (events.enemyFire) directionalCue(e.mesh.position.clone(), { strong: false });
  spawnProjectile(e);
}

// ── shooting back (move mode) — fire a real projectile; its flight decides the hit ──
function playerFire() {
  if (!playing || paused || settings.mode !== "move") return;
  gunKick = 1; // recoil only — muzzle FLASH removed per request
  camera.getWorldDirection(fwd); // aim direction — LOCKED into the bullet right now
  const muzzleWorld = new THREE.Vector3();
  muzzle.getWorldPosition(muzzleWorld);
  if (events.ownShot) {
    const a = CONTENT.fps_player_shot;
    router.audio("fps_player_shot", { worldPos: muzzleWorld, gain: 1 }, () =>
      playShot(muzzleWorld, { gain: a.audio.vol, freq: a.audio.freq, durMs: a.audio.durMs }));
    const t = performance.now() / 1000;
    if (t - lastHapticT >= HAPTIC_MIN_GAP) {
      lastHapticT = t;
      router.haptic("fps_player_shot", { gain: 1 }, () =>
        bridge.streamPcm(stereoBlip(0, { gain: a.haptic.gain, durMs: a.haptic.durMs, freq: a.haptic.freq }), { channels: 2, sampleRate: 16000, gain: 1 }));
    }
  }
  // No aim-line hitscan, no homing: the bullet flies straight from the muzzle along the
  // fire direction and its OWN swept path (updatePlayerTracers) decides what it hits.
  // Moving the aim after the shot has no effect; what the tracer crosses is what dies.
  spawnPlayerTracer(muzzleWorld, fwd, 0xffd23a);
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
  // Chrome's pointer-lock can report a spurious huge movementX (hundreds–thousands of
  // px) in a single event — esp. right after (re)locking — which SNAPS the whole view,
  // making enemies/bullets look like they teleport. Cap one event to a fast-but-sane flick.
  const mx = Math.max(-160, Math.min(160, e.movementX));
  yaw -= mx * 0.0024 * settings.mouseSens; // horizontal only (no pitch/roll), frozen while paused
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
  // prefer a STANDARD-mapping pad: some HID devices (e.g. USB speakerphones) are
  // mis-enumerated as non-standard "gamepads" and would otherwise be picked first.
  let gp = null;
  for (const p of pads) { if (!p) continue; if (!gp) gp = p; if (p.mapping === "standard") { gp = p; break; } }
  if (!gp) { gpFirePrev = false; gpStartPrev = false; gpLbPrev = false; gpRbPrev = false; gpLbHeld = false; gpXPrev = gpYPrev = gpBPrev = gpVwPrev = false; setGpStat("未検出", false); return; }
  let pressedBtn = -1;
  for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i]?.pressed) { pressedBtn = i; break; }
  const tag = gp.mapping === "standard" ? "接続" : "接続(非標準)";
  setGpStat(pressedBtn >= 0 ? `${tag} btn${pressedBtn}` : tag, true);
  const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
  const fire = !!(gp.buttons[7]?.pressed || gp.buttons[0]?.pressed); // RT or A
  const fireEdge = fire && !gpFirePrev; gpFirePrev = fire;
  const startBtn = !!gp.buttons[9]?.pressed; // Start/Menu
  const startEdge = startBtn && !gpStartPrev; gpStartPrev = startBtn;
  const lb = !!gp.buttons[4]?.pressed, rb = !!gp.buttons[5]?.pressed; // LB = dash (in game) / LB·RB = 難易度 (title)
  const lbEdge = lb && !gpLbPrev, rbEdge = rb && !gpRbPrev; gpLbPrev = lb; gpRbPrev = rb;
  gpLbHeld = lb; // held state → dash while playing (cyclePreset moved to the !playing block below)
  // Ⓧ/Ⓨ/Ⓑ toggle 映像/音/触覚 and View=モード切替 — only while NOT playing (locked
  // mid-game). ☰ Menu = HUD/パネルの表示非表示 (any time). Pause stays on Esc.
  const gx = !!gp.buttons[2]?.pressed, gy = !!gp.buttons[3]?.pressed, gbb = !!gp.buttons[1]?.pressed, gvw = !!gp.buttons[8]?.pressed;
  const xEdge = gx && !gpXPrev, yEdge = gy && !gpYPrev, bEdge = gbb && !gpBPrev, vwEdge = gvw && !gpVwPrev;
  gpXPrev = gx; gpYPrev = gy; gpBPrev = gbb; gpVwPrev = gvw; // track edges every frame
  if (startEdge) toggleDrawer(); // ☰ = HUD 表示/非表示
  if (!playing) {
    if (xEdge) toggleMaster("visual", mVisual);
    if (yEdge) toggleMaster("audio", mAudio);
    if (bEdge) toggleMaster("haptic", mHaptic);
    if (vwEdge) setMode(settings.mode === "move" ? "fixed" : "move");
    if (lbEdge) cyclePreset(-1); // LB·RB pick difficulty on the title (LB = dash once playing)
    if (rbEdge) cyclePreset(1);
    if (fireEdge) startGame();
    return;
  }
  if (paused || renderer.xr.isPresenting) return;
  yaw -= dz(gp.axes[2] || 0) * 2.4 * dt * settings.stickSens; // right stick X → yaw
  if (settings.mode === "move") {
    const spd = settings.playerSpeed * ((lb || keys.ShiftLeft || keys.ShiftRight) ? tune.dash.multiplier : 1); // LB / Shift = dash
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0);
    if (lx || ly) {
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      rig.position.x += (lx * cos + ly * sin) * spd * dt;
      rig.position.z += (-lx * sin + ly * cos) * spd * dt;
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
  for (const e of enemies) e.mesh.visible = v; // 👁 OFF hides ONLY the enemies…
  for (const p of projectiles) { p.head.visible = true; p.trail.visible = true; } // …bullets stay visible
}

// ── main loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function update(dt) {
  applyVisualMode();
  pollGamepad(dt);

  gunKick = Math.max(0, gunKick - dt * 7);
  gun.position.z = GUN_REST.z + gunKick * 0.07;
  gun.rotation.x = gunKick * 0.18;
  shieldFlash = Math.max(0, shieldFlash - dt * 3);
  shieldMesh.material.opacity = 0.24 + shieldFlash * 0.5;
  shieldMesh.scale.x = settings.shieldArc / 26;

  const active = playing && !paused && !renderer.xr.isPresenting;
  if (active) {
    // dash: Shift (keyboard) or LB (gamepad, tracked in pollGamepad). Scales speed AND
    // all walk feedback below by tune.dash.multiplier (default 2×). move mode only.
    dashing = settings.mode === "move" && (keys.ShiftLeft || keys.ShiftRight || gpLbHeld);
    const dashK = dashing ? tune.dash.multiplier : 1;
    if (settings.mode === "move") {
      let mx = 0, mz = 0;
      if (keys.KeyW) mz -= 1;
      if (keys.KeyS) mz += 1;
      if (keys.KeyA) mx -= 1;
      if (keys.KeyD) mx += 1;
      if (mx || mz) {
        const len = Math.hypot(mx, mz); mx /= len; mz /= len;
        const sin = Math.sin(yaw), cos = Math.cos(yaw);
        rig.position.x += (mx * cos + mz * sin) * settings.playerSpeed * dashK * dt;
        rig.position.z += (-mx * sin + mz * cos) * settings.playerSpeed * dashK * dt;
        clampToArena();
      }
    }
    // walking head-bob + sway + footstep (move mode, opt-in). Detect motion from the
    // rig's ACTUAL displacement this frame so BOTH keyboard (WASD) and gamepad stick
    // (moved earlier in pollGamepad) drive it — the pad path used to never set the
    // old `moving` flag, so stick walkers felt/saw/heard nothing.
    const movedDist = Math.hypot(rig.position.x - lastWalkX, rig.position.z - lastWalkZ);
    lastWalkX = rig.position.x; lastWalkZ = rig.position.z;
    const walking = settings.walkFeedback && settings.mode === "move" && movedDist > 0.0015;
    if (walking) {
      walkPhase += tune.walk.rate * dashK * dt; // dash → cadence keeps pace with the 2× speed
      // ONE footstep per full up-down (every 2π) so 上下1回 = フィードバック1回.
      if (walkPhase - walkStepMark >= 2 * Math.PI) { walkStepMark += 2 * Math.PI; footstepHaptic(); footstepSound(); }
      // DRIVE the bob directly (full amplitude) — easing toward an oscillating
      // target just low-passes it away, which is why it looked like nothing moved.
      walkBob = Math.sin(walkPhase) * tune.walk.bobAmp * dashK;        // dash → bigger bob
      walkSway = Math.sin(walkPhase * 0.5) * tune.walk.swayAmp * dashK; // sway alternates each step (period = 2 strides)
    } else {
      walkStepMark = walkPhase;
      walkBob += (0 - walkBob) * Math.min(1, dt * 10); // ease back to level when stopped
      walkSway += (0 - walkSway) * Math.min(1, dt * 10);
    }
    camera.position.y = 1.6 + walkBob;
    camera.position.x = walkSway;
    rig.rotation.y = yaw;
    playerPos.set(rig.position.x, 1.6, rig.position.z);

    const nowS = performance.now() / 1000;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.spawnT < 1) { // ~0.2s grow-in (softens the kill-respawn pop, esp. in 固定 mode)
        e.spawnT = Math.min(1, e.spawnT + dt * 5);
        e.mesh.scale.setScalar(tune.enemy.scale * e.spawnT);
      }
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
    updateContinuousHaptic(); // 連続モード: feel the nearest incoming bullet
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
