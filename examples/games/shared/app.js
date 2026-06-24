/**
 * Hapbeat Arcade shell — boots the bridge, renders the menu, and mounts games.
 * Each game module exports `game = { id, emoji, title, en, tag, desc, mount }`.
 * mount(container, { bridge }) returns `{ unmount() }`.
 */

import { ArcadeBridge } from "./hapbeat-bridge.js";
import { ContentRouter } from "./content-router.js";
import { best as bestScore } from "./scores.js";
// 効果体験ミニゲーム（触覚の効能を“測って”見せる）
import { game as notice } from "../games/notice.js";
import { game as hotcold } from "../games/hotcold.js";
import { game as reflex } from "../games/reflex.js";

// 非表示にしたデモは games/_archive/ に退避（メニュー非表示・import で復活可）:
//   maze(見えない壁) / rhythm(触覚リズム) … 存在意義不明で見送り
//   spatialalert(どっちで鳴った) / progress(進捗をさわる) / walknav(顔を上げて歩くナビ)
// heatcursor(ヒートカーソル) は hotcold(宝探し) と実質同じため削除（git で復元可）。
const GAMES = [notice, hotcold, reflex];

// 別ページのデモ（重い依存・XR・ポインタロックを隔離 → リンクで開く）
const LINK_DEMOS = [
  {
    id: "fps",
    emoji: "🎯",
    title: "触覚 FPS",
    en: "Spatial FPS",
    tag: "音像定位＋触覚で 360° 索敵（PC / WebXR）",
    desc: "平面フロアで 360° の敵が発砲。発砲音を音(HRTF)＋触覚(左右)で定位し、映像 OFF でも位置が分かる。敵の発砲/被弾/自分の発砲を個別 ON/OFF。",
    href: "fps/",
  },
  {
    id: "gamepad-test",
    emoji: "🎮",
    title: "入力確認",
    en: "Input Check",
    tag: "Gamepad / キーの検出・押下をライブ確認（診断）",
    desc: "コントローラやキーがブラウザに検出されるか、どのボタンが押下として取れるかをライブ表示。SDK・helper 不要。コントローラが反応しない時の切り分けに。",
    href: "gamepad-test/",
  },
];

const app = document.getElementById("app");
const bridge = new ArcadeBridge();
// One shared file-first router (the "つなぎ"): bridge.fire() prefers a kit haptic clip
// + an audio file when present, else the built-in synth. Wired (loaded) after init.
const router = new ContentRouter(bridge);
bridge.attachRouter(router);
let active = null; // { unmount }
let lastPhase = ""; // connection phase, to re-render the menu banner on change

// ── header ──────────────────────────────────────────────────
const header = el("header", "bar");
header.innerHTML = `
  <h1>🟣 Hapbeat 触覚デモ</h1>
  <span class="spacer"></span>
  <span class="statuswrap">
    <span class="pill" id="status" title="クリックで接続デバイスを表示"><span class="dot"></span><span id="statusText">接続中…</span></span>
    <div class="device-pop hidden" id="devicePop"></div>
  </span>
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
const devicePop = header.querySelector("#devicePop");

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function renderDevicePop() {
  const ds = bridge.devices || [];
  devicePop.innerHTML = ds.length
    ? `<div class="dp-title">接続デバイス ${ds.length}</div>` +
      ds.map((d) => `<div class="dp-item">${esc(d.name || "(名前なし)")}${d.address ? `<span class="dp-addr">${esc(d.address)}</span>` : ""}</div>`).join("")
    : `<div class="dp-empty">${bridge.connected ? "デバイス未検出" : "helper 未接続"}</div>`;
}
statusPill.onclick = () => { renderDevicePop(); devicePop.classList.toggle("hidden"); };
document.addEventListener("click", (e) => {
  if (e.target !== statusPill && !statusPill.contains(e.target) && !devicePop.contains(e.target)) devicePop.classList.add("hidden");
});

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
  if (!devicePop.classList.contains("hidden")) renderDevicePop(); // keep the open popover fresh
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
    "ブラウザ + Hapbeat（無線）の触覚デモ。各ゲーム内の <b>👁 映像 / 👂 音 / ✋ 触覚</b> を切り替え、触覚の効きを体感してください。";
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
  // 別ページのデモ（FPS 等）はリンクカードで開く（独自の重い依存を隔離）
  for (const ld of LINK_DEMOS) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = ld.href;
    a.target = "_blank"; // 重い依存・ポインタロックを別タブに隔離
    a.rel = "noopener";
    a.setAttribute("aria-label", `${ld.title} (${ld.en})`);
    a.style.textDecoration = "none";
    a.innerHTML = `
      <div class="emoji">${ld.emoji}</div>
      <h3>${ld.title}<span class="en">${ld.en}</span></h3>
      <div class="tag">${ld.tag}</div>
      <p>${ld.desc}</p>
      <div class="card-best">別タブで開く ↗</div>
    `;
    cards.appendChild(a);
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
bridge.init({ appName: "HapbeatArcade", audioBase: "" }).then(async () => {
  // Wire the file-first router: reuse the AudioBank's AudioContext so audio files and
  // synth share one context/master-gain (+ one unlock gesture). All paths are relative
  // to examples/games/ (the shell root) — no "../" prefix (the FPS page needs it, this
  // doesn't). Everything fails soft: missing kit/audio → synth fallback, no crash.
  router.attachAudio(bridge.audio.ctx, bridge.audio.master);
  await router.load({
    eventmapUrl: "shared/eventmap.json",
    manifestUrl: "demo-kit/shell-kit/shell-kit-manifest.json",
    clipBase: "demo-kit/shell-kit/stream-clips/",
  });
  await router.loadAudioFiles(""); // event-content audio.file paths resolve against examples/games/
  if (!active) showHome();
});

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
