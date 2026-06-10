/**
 * Hapbeat Arcade shell — boots the bridge, renders the menu, and mounts games.
 * Each game module exports `game = { id, emoji, title, en, tag, desc, mount }`.
 * mount(container, { bridge }) returns `{ unmount() }`.
 */

import { ArcadeBridge } from "./hapbeat-bridge.js";
import { best as bestScore } from "./scores.js";
import { game as maze } from "../games/maze.js";
import { game as rhythm } from "../games/rhythm.js";
import { game as hotcold } from "../games/hotcold.js";
import { game as reflex } from "../games/reflex.js";

const GAMES = [maze, rhythm, hotcold, reflex];

const app = document.getElementById("app");
const bridge = new ArcadeBridge();
let active = null; // { unmount }
let lastPhase = ""; // connection phase, to re-render the menu banner on change

// ── header ──────────────────────────────────────────────────
const header = el("header", "bar");
header.innerHTML = `
  <h1>🎮 Hapbeat Arcade <span class="sub">触覚ミニゲーム集</span></h1>
  <span class="spacer"></span>
  <span class="pill" id="status"><span class="dot"></span><span id="statusText">接続中…</span></span>
  <button id="audioBtn" aria-pressed="true">🔊 音</button>
  <button id="hapticBtn" aria-pressed="true">📳 触覚</button>
  <button id="testBtn" class="ghost">触覚テスト</button>
  <button id="rescanBtn" class="ghost">再スキャン</button>
  <button id="fsBtn" class="ghost" title="全画面">⛶</button>
`;
app.appendChild(header);

const home = el("div");
app.appendChild(home);
const stage = el("div");
app.appendChild(stage);

const statusPill = header.querySelector("#status");
const statusText = header.querySelector("#statusText");
const audioBtn = header.querySelector("#audioBtn");
const hapticBtn = header.querySelector("#hapticBtn");

audioBtn.onclick = () => {
  bridge.unlockAudio();
  bridge.setMaster("audio", !bridge.master.audio);
};
hapticBtn.onclick = () => bridge.setMaster("haptic", !bridge.master.haptic);
header.querySelector("#testBtn").onclick = () => {
  bridge.unlockAudio();
  bridge.testHaptic();
};
// reconnect if dropped, otherwise re-probe for devices
header.querySelector("#rescanBtn").onclick = () =>
  bridge.connected ? bridge.rediscover() : bridge.connectHelper();
header.querySelector("#fsBtn").onclick = () => {
  const d = document;
  if (d.fullscreenElement) d.exitFullscreen?.();
  else d.documentElement.requestFullscreen?.().catch(() => {});
};

bridge.onChange((b) => {
  audioBtn.setAttribute("aria-pressed", String(b.master.audio));
  hapticBtn.setAttribute("aria-pressed", String(b.master.haptic));
  if (b.connecting) {
    statusPill.className = "pill off";
    statusText.textContent = "helper 接続中…";
  } else if (b.connected) {
    statusPill.className = "pill ok";
    const n = b.devices.length;
    statusText.textContent = n ? `helper 接続済 ・ device ${n}` : "helper 接続済 ・ device 未検出";
  } else {
    statusPill.className = "pill err";
    statusText.textContent = b.settled ? "helper 未接続（触覚OFF）" : "helper 接続中…";
  }
  // refresh the menu banner when the connection phase changes (not on every emit)
  const phase = b.connecting ? "connecting" : b.connected ? "connected" : b.settled ? "failed" : "init";
  if (phase !== lastPhase) {
    lastPhase = phase;
    if (!active) showHome();
  }
});

// ── routing ─────────────────────────────────────────────────
function showHome() {
  if (active) {
    active.unmount();
    active = null;
  }
  bridge.stopAll();
  stage.innerHTML = "";
  home.innerHTML = "";

  if (!bridge.connected) {
    if (bridge.connecting || !bridge.settled) {
      // still probing — don't flash the scary failure banner on a healthy booth
      const note = el("p", "note");
      note.textContent = "helper に接続中…（接続できなくても音と映像だけで試遊できます）";
      home.appendChild(note);
    } else {
      const banner = el("div", "banner");
      banner.innerHTML =
        `⚠️ hapbeat-helper に接続できません（<code>ws://localhost:7703</code>）。` +
        `音と映像だけで試遊できますが、触覚は出ません。` +
        `<br>helper を起動するには: <code>pipx install hapbeat-helper</code> → <code>hapbeat-helper</code>。起動後「再スキャン」。`;
      home.appendChild(banner);
    }
  }

  const intro = el("p", "note");
  intro.innerHTML =
    "ブラウザ + Hapbeat 無線版のデモ。各ゲームは 1〜2 分で遊べます。" +
    "右上の 🔊/📳 でモダリティを切り替えて、触覚の効きを体感してください。" +
    "<br><b>事前に</b> demo-kit（<code>hapbeat-arcade</code>）をデバイスに配備しておく必要があります（README 参照）。";
  home.appendChild(intro);

  const cards = el("div", "cards");
  for (const gm of GAMES) {
    const c = el("div", "card");
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.setAttribute("aria-label", `${gm.title} (${gm.en})`);
    c.innerHTML = `
      <div class="emoji">${gm.emoji}</div>
      <h3>${gm.title}<span class="en">${gm.en}</span></h3>
      <div class="tag">${gm.tag}</div>
      <p>${gm.desc}</p>
    `;
    // best-score badge (per difficulty that has a record)
    const parts = [
      ["normal", "N"],
      ["hard", "H"],
      ["expert", "E"],
    ]
      .map(([d, lbl]) => {
        const b = bestScore(gm.id, d);
        return b == null || !gm.formatScore ? null : `${lbl} <b>${gm.formatScore(b)}</b>`;
      })
      .filter(Boolean);
    if (parts.length) {
      const be = el("div", "card-best");
      be.innerHTML = "自己ベスト ・ " + parts.join(" / ");
      c.appendChild(be);
    }
    const open = () => {
      bridge.unlockAudio();
      openGame(gm);
    };
    c.onclick = open;
    c.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    };
    cards.appendChild(c);
  }
  home.appendChild(cards);
}

function openGame(gm) {
  if (active) {
    active.unmount();
    active = null;
  }
  bridge.stopAll();
  home.innerHTML = "";
  stage.innerHTML = "";

  const head = el("div", "stage-head");
  const back = el("button", "ghost");
  back.textContent = "← メニュー";
  back.onclick = showHome;
  head.appendChild(back);
  const title = el("h2");
  title.innerHTML = `${gm.emoji} ${gm.title} <span class="en">${gm.en}</span>`;
  head.appendChild(title);
  stage.appendChild(head);

  const wrap = el("div", "gamewrap");
  stage.appendChild(wrap);

  active = gm.mount(wrap, { bridge, toMenu: showHome });
}

// ── boot ────────────────────────────────────────────────────
showHome();
// Re-render the menu once the helper probe settles (updates the banner/pill),
// but don't yank the player out of a game they already opened.
bridge.init({ appName: "HapbeatArcade", audioBase: "" }).then(() => {
  if (!active) showHome();
});

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
