/**
 * Eyes-Up Walk Nav — 顔を上げて歩くナビ.
 *
 * Walk a scripted route without looking at the screen. The device tells you
 * which way to turn: a STEREO haptic buzz to the LEFT (pan -1) means turn left,
 * to the RIGHT (pan +1) means turn right. Going straight = an occasional gentle
 * center tick. Arrival = a double both-sides buzz.
 *
 * The pitch: flip 👁 映像 OFF (screen-in-pocket) and the map goes BLANK — you
 * navigate the turns by feel alone, the way a real walking-nav would work with
 * the phone in your pocket. Turn it on for the with-screen comparison.
 *
 * 100% browser, no extra device, and it can ride on top of any web map.
 */

import { Fx } from "../shared/fx.js";
import { directionCue, bothSides } from "../shared/synth.js";
import { showResult, clearResult } from "../shared/ui.js";

const DIFF = {
  normal: { segMs: 2600, label: "Normal" }, // seconds per segment (slow stroll)
  hard: { segMs: 1900, label: "Hard" },
  expert: { segMs: 1300, label: "Expert" },
};

// A scripted route on a 720×460 top-down map: a few turns then arrival.
// `turn` is the cue emitted when the walker REACHES this waypoint heading on.
//   "L" = turn left, "R" = turn right, "S" = straight (gentle center tick),
//   "GOAL" = arrival. The first point is the start (no cue).
const ROUTE = [
  { x: 90, y: 380, turn: null },
  { x: 90, y: 150, turn: "R" },
  { x: 330, y: 150, turn: "S" },
  { x: 470, y: 150, turn: "R" },
  { x: 470, y: 300, turn: "L" },
  { x: 640, y: 300, turn: "L" }, // east→north = 左折（geometry と一致させる）
  { x: 640, y: 90, turn: "GOAL" },
];

const lerp = (a, b, t) => a + (b - a) * t;

export const game = {
  id: "walknav",
  emoji: "🚶",
  title: "顔を上げて歩くナビ",
  en: "Eyes-Up Walk Nav",
  tag: "方向(L/R)で曲がる側を提示",
  desc: "ルートを画面を見ずに歩く——曲がる側を左右の触覚で教えてくれる。👁 映像 OFF で地図は真っ白（ポケットの中）になり、振動だけで道を辿る。スマホナビを触覚化するデモ。",

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let diffKey = "normal";

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">歩く速さ</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="start" class="primary">歩く</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="460"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>区間 <b id="seg">0</b>/<b id="segs">0</b></span>
        <span>次の合図 <b id="next">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: <kbd>歩く</kbd> を押すと一定ペースで自動で進む。曲がり角で <b>左に振動＝左折 / 右に振動＝右折</b>、まっすぐは中央の軽いコツン、到着は両側ダブル。
      ヘッダー <b>👁 映像 / 👂 音 / ✋ 触覚</b> で切替。<b>👁 映像 OFF</b>＝地図が真っ白になり<b>振動だけ</b>で道を辿る本番モード。
      ブラウザだけ・追加デバイス不要・Web 地図に載せられる（ashirase は靴）。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elSeg = container.querySelector("#seg");
    const elSegs = container.querySelector("#segs");
    const elNext = container.querySelector("#next");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");

    const TURNS = ROUTE.length - 1;
    elSegs.textContent = String(TURNS);

    for (const k of Object.keys(DIFF)) {
      const b = document.createElement("button");
      b.textContent = DIFF[k].label;
      b.setAttribute("aria-pressed", String(k === diffKey));
      b.onclick = () => {
        diffKey = k;
        for (const c of diffBox.children) c.setAttribute("aria-pressed", String(c === b));
        stop();
      };
      diffBox.appendChild(b);
    }

    const cueLabel = (t) =>
      t === "L" ? "← 左折" : t === "R" ? "右折 →" : t === "S" ? "↑ 直進" : t === "GOAL" ? "● 到着" : "—";

    // ── state ────────────────────────────────────────────────
    let running = false,
      legIdx = 0, // index of the leg the walker is traversing (from ROUTE[legIdx] → [legIdx+1])
      legT = 0, // 0..1 progress along current leg
      cuePulse = 0, // visual flash on a turn
      cuePan = 0, // -1 / 0 / +1 of the last cue (for the on-screen caption)
      lastCue = null;

    function emitCue(turn) {
      if (turn === "L") {
        directionCue(bridge, -1, { gain: 0.9, durMs: 130, freq: 150 });
        cuePan = -1;
      } else if (turn === "R") {
        directionCue(bridge, 1, { gain: 0.9, durMs: 130, freq: 150 });
        cuePan = 1;
      } else if (turn === "S") {
        directionCue(bridge, 0, { gain: 0.32, durMs: 70, freq: 200 });
        cuePan = 0;
      } else if (turn === "GOAL") {
        // arrival = double both-sides buzz via the raw stereo stream
        bridge.streamPcm(bothSides(0.95), { channels: 2, sampleRate: 16000, gain: 1 });
        setTimeout(() => bridge.streamPcm(bothSides(0.95), { channels: 2, sampleRate: 16000, gain: 1 }), 170);
        bridge.fire("maze_goal", { haptic: false, audio: true, gain: 0.6 });
        cuePan = 0;
      }
      lastCue = turn;
      cuePulse = 1;
      const wp = ROUTE[legIdx + 1];
      if (wp) fx.burst(wp.x, wp.y, turn === "GOAL" ? "#3fb950" : "#7c5cff", turn === "GOAL" ? 34 : 18, 220);
      fx.shake(turn === "GOAL" ? 8 : turn === "S" ? 2 : 5);
    }

    function nextLabel() {
      const wp = ROUTE[legIdx + 1];
      elNext.textContent = wp ? cueLabel(wp.turn) : "—";
    }

    function start() {
      running = true;
      legIdx = 0;
      legT = 0;
      lastCue = null;
      cuePan = 0;
      cuePulse = 0;
      elMsg.textContent = "";
      elState.textContent = DIFF[diffKey].label;
      elSeg.textContent = "0";
      nextLabel();
      clearResult(stagebox);
      container.querySelector("#start").textContent = "やり直す";
      tPrev = performance.now();
    }
    function stop() {
      running = false;
      legIdx = 0;
      legT = 0;
      lastCue = null;
      elMsg.textContent = "";
      elState.textContent = DIFF[diffKey].label;
      elSeg.textContent = "0";
      elNext.textContent = "—";
      clearResult(stagebox);
      container.querySelector("#start").textContent = "歩く";
    }

    function arrive() {
      running = false;
      emitCue("GOAL");
      showResult(stagebox, {
        title: "● 到着！",
        sub: `${TURNS} 区間を振動だけで歩き切れたら成功 ・ 速さ ${DIFF[diffKey].label}`,
        retryLabel: "もう一度歩く",
        onRetry: start,
        onMenu: toMenu,
      });
    }

    container.querySelector("#start").onclick = () => {
      bridge.unlockAudio();
      start();
    };

    // loop
    let raf = 0,
      tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;

      if (running) {
        legT += (dt * 1000) / DIFF[diffKey].segMs;
        while (legT >= 1 && running) {
          legT -= 1;
          legIdx++;
          elSeg.textContent = String(legIdx);
          const wp = ROUTE[legIdx];
          if (wp) emitCue(wp.turn); // emit the cue ON reaching the waypoint
          nextLabel();
          if (legIdx >= ROUTE.length - 1) {
            legT = 0;
            arrive();
            break;
          }
        }
      }

      cuePulse = Math.max(0, cuePulse - dt * 1.6);
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function walkerPos() {
      const a = ROUTE[Math.min(legIdx, ROUTE.length - 1)];
      const b = ROUTE[Math.min(legIdx + 1, ROUTE.length - 1)];
      return { x: lerp(a.x, b.x, legT), y: lerp(a.y, b.y, legT) };
    }

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      const showMap = bridge.master.visual;

      if (showMap) {
        // route polyline
        g.strokeStyle = "#2a313c";
        g.lineWidth = 22;
        g.lineCap = "round";
        g.lineJoin = "round";
        g.beginPath();
        g.moveTo(ROUTE[0].x, ROUTE[0].y);
        for (let i = 1; i < ROUTE.length; i++) g.lineTo(ROUTE[i].x, ROUTE[i].y);
        g.stroke();
        g.strokeStyle = "#1c2330";
        g.lineWidth = 14;
        g.stroke();

        // waypoints (turn markers)
        for (let i = 1; i < ROUTE.length - 1; i++) {
          const wp = ROUTE[i];
          g.fillStyle = wp.turn === "S" ? "#3a4250" : "#5a4bb0";
          g.beginPath();
          g.arc(wp.x, wp.y, 6, 0, Math.PI * 2);
          g.fill();
        }
        // start + goal
        g.fillStyle = "#2dd4bf";
        g.beginPath();
        g.arc(ROUTE[0].x, ROUTE[0].y, 9, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#3fb950";
        const goal = ROUTE[ROUTE.length - 1];
        g.beginPath();
        g.arc(goal.x, goal.y, 11, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#0a0d12";
        g.font = "bold 12px system-ui";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("S", ROUTE[0].x, ROUTE[0].y + 0.5);
        g.fillText("G", goal.x, goal.y + 0.5);
        g.textAlign = "left";
        g.textBaseline = "alphabetic";

        // walker dot
        if (running || legIdx > 0) {
          const p = walkerPos();
          if (cuePulse > 0) {
            g.strokeStyle = `rgba(124,92,255,${cuePulse})`;
            g.lineWidth = 3;
            g.beginPath();
            g.arc(p.x, p.y, 12 + (1 - cuePulse) * 24, 0, Math.PI * 2);
            g.stroke();
          }
          g.fillStyle = "#7c5cff";
          g.beginPath();
          g.arc(p.x, p.y, 9, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#cdd6e0";
          g.beginPath();
          g.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          g.fill();
        }

        // turn caption
        if (running && lastCue && cuePulse > 0.05) {
          g.globalAlpha = Math.min(1, cuePulse + 0.2);
          g.fillStyle = lastCue === "GOAL" ? "#3fb950" : lastCue === "S" ? "#9aa7b4" : "#7c5cff";
          g.font = "bold 30px system-ui";
          g.textAlign = "center";
          const cap = lastCue === "L" ? "← 左に曲がる" : lastCue === "R" ? "右に曲がる →" : lastCue === "S" ? "↑ まっすぐ" : "● 到着";
          g.fillText(cap, cv.width / 2, 44);
          g.textAlign = "left";
          g.globalAlpha = 1;
        }
      } else {
        // screen-in-pocket: blank map, feel-only
        g.fillStyle = "#4b5666";
        g.font = "14px system-ui";
        g.textAlign = "center";
        g.fillText(running ? "ポケットの中（👁 OFF）— 振動だけで道を辿る" : "👁 映像 OFF: 画面は真っ白。振動だけで歩く", cv.width / 2, cv.height / 2 - 8);
        if (running) {
          // liveness only — a CENTERED, neutral blip. Must NOT encode L/R
          // (position/color), else 映像 OFF would leak the answer on screen.
          g.globalAlpha = Math.max(0.1, cuePulse);
          g.fillStyle = "#4b5666";
          g.beginPath();
          g.arc(cv.width / 2, cv.height / 2 + 34, 10 + (1 - cuePulse) * 10, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 1;
        }
        g.textAlign = "left";
      }

      fx.restore(g);
      fx.draw(g);

      // legend (always)
      g.font = "12px system-ui";
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      const ly = cv.height - 16;
      g.fillStyle = "#7c5cff";
      g.fillText("◀ 左振動=左折", 16, ly);
      g.fillStyle = "#2dd4bf";
      g.fillText("右振動=右折 ▶", 150, ly);
      g.fillStyle = "#9aa7b4";
      g.fillText("中央コツン=直進 ・ 両側ダブル=到着", 300, ly);

      if (!running && legIdx === 0 && !elMsg.textContent) {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.textAlign = "center";
        g.fillText("「歩く」を押すと自動で進む。曲がり角で振動が左右の合図を出す", cv.width / 2, cv.height / 2 + (showMap ? 0 : 30));
        g.textAlign = "left";
      }
    }

    stop();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
      },
    };
  },
};