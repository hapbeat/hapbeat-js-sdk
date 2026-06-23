/**
 * Hot & Cold — 宝探し.
 *
 * A treasure is hidden on a blank field. Sweep the cursor: the closer you get,
 * the stronger and faster the Hapbeat pulses — a haptic Geiger counter. Click
 * to dig. Pure haptic guidance by default; flip "ヒートを表示" to reveal the
 * warmth as a visual aid for comparison.
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../shared/scores.js";
import { Pad, BTN } from "../shared/gamepad.js";
import { modalityControls, padModality, playerNameField, activeMods } from "../shared/controls.js";
import { createRanking } from "../shared/ranking.js";

const DIG_COOLDOWN = 3.0; // s — penalty after a cold (failed) dig, to stop brute-force spam

const DIFF = {
  normal: { catch: 30, range: 360, targets: 3, time: 60, label: "Normal" },
  hard: { catch: 20, range: 280, targets: 5, time: 45, label: "Hard" },
  expert: { catch: 13, range: 210, targets: 7, time: 30, label: "Expert" },
};

const lerp = (a, b, t) => a + (b - a) * t;

export const game = {
  id: "hotcold",
  emoji: "💎",
  title: "宝探し",
  en: "Hot & Cold",
  tag: "触覚＝近接（連続）",
  desc: "見えない宝に近づくほど触覚が強く・速くなる（ガイガーカウンタ式）。純触覚で位置を探り当ててクリック。ヒート表示で見比べも可能。",
  formatScore: (v) => `${Math.round(v)} 個`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    const pad = new Pad();
    const diffKey = "hard"; // 宝探しは Hard 固定（難易度選択なし）

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">宝探し</span>
        <span class="spacer"></span>
        <span id="modslot"></span>
        <button id="start" class="primary"><span id="startlbl">スタート</span> <span class="padkey k-a">A</span></button>
        <button id="stop" class="danger">ストップ <span class="padkey k-menu">☰</span></button>
        <span id="nameslot"></span>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="480"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>発見 <b id="found">0</b>/<b id="total">3</b></span>
        <span>残り <b id="time">60</b>s</span>
        <span>発見ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: マウスで探索 → 当たりと感じたら<kbd>クリック</kbd>。近いほど触覚が強く・速くなる。外すと <b>${DIG_COOLDOWN}秒クールダウン</b>（連打防止）。
      パッド: <b>左スティック/十字</b>=移動 / <b>Ⓐ</b>=掘る・スタート / <b>RB</b>=リスタート / <b>☰</b>=ストップ / <b>Ⓥ(View)</b>=メニュー。開始前は <b>Ⓧ/Ⓨ/Ⓑ</b>=映像/音/触覚 切替。
      <b>👁映像/👂音/✋触覚</b>（上のボタン or パッド）で切替。<b>👁 映像 OFF</b> が本来の純触覚モード（ヒート・脈動・発見演出すべて非表示）。</p>
      <div class="rankpanel" id="rankpanel"></div>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elFound = container.querySelector("#found");
    const elTotal = container.querySelector("#total");
    const elTime = container.querySelector("#time");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const elBest = container.querySelector("#best");
    const stagebox = container.querySelector(".stagebox");
    const startBtn = container.querySelector("#start");
    const startLbl = container.querySelector("#startlbl");
    const stopBtn = container.querySelector("#stop");

    // modality toggles (between label and start) + persisted player name + ranking
    const mods = modalityControls(bridge);
    container.querySelector("#modslot").appendChild(mods.el);
    const nameField = playerNameField();
    container.querySelector("#nameslot").appendChild(nameField.el);
    const rank = createRanking("hotcold", {
      title: "宝探し",
      columns: [
        { key: "found", label: "発見", unit: "個", decimals: 0, lowerIsBetter: false, primary: true },
        { key: "time", label: "タイム", unit: "s", decimals: 1, lowerIsBetter: true },
      ],
    });
    const rankPanel = container.querySelector("#rankpanel");
    const disposeRank = rank.mountPanel(rankPanel);
    function updateButtons() {
      startLbl.textContent = running ? "リスタート" : "スタート";
      stopBtn.disabled = !running;
      mods.setLocked(running);
    }

    function refreshBest() {
      const b = bestScore("hotcold", diffKey);
      elBest.textContent = b == null ? "—" : String(Math.round(b));
    }

    // ── state ────────────────────────────────────────────────
    let target = null,
      found = 0,
      timeLeft = 0,
      running = false,
      lastPulse = 0,
      reveal = 0,
      revealPos = null, // where the found treasure WAS (so reveal never leaks the NEXT one)
      cooldownUntil = 0; // performance.now() until which digging is locked after a cold miss
    const mouse = { x: cv.width / 2, y: cv.height / 2, inside: false };

    function placeTarget() {
      const m = 60;
      target = {
        x: m + Math.random() * (cv.width - 2 * m),
        y: m + Math.random() * (cv.height - 2 * m),
      };
    }

    function start() {
      const D = DIFF[diffKey];
      nameField.roll(); // fresh random name suggestion for this play
      found = 0;
      timeLeft = D.time;
      running = true;
      reveal = 0;
      revealPos = null;
      cooldownUntil = 0;
      elTotal.textContent = String(D.targets);
      elMsg.textContent = "";
      elState.textContent = DIFF[diffKey].label;
      placeTarget();
      clearResult(stagebox);
      updateButtons();
      tPrev = performance.now();
    }
    function stop() {
      running = false;
      elMsg.textContent = "";
      elTotal.textContent = String(DIFF[diffKey].targets);
      elTime.textContent = String(DIFF[diffKey].time);
      elFound.textContent = "0";
      clearResult(stagebox);
      refreshBest();
      updateButtons();
    }

    function endGame(title, badgeable) {
      running = false;
      updateButtons();
      const res = submitScore("hotcold", diffKey, found, false);
      refreshBest();
      if (found > 0) {
        const used = DIFF[diffKey].time - timeLeft; // seconds spent (lower = faster)
        rank.record({
          name: nameField.get(),
          metrics: { found, time: used },
          mods: activeMods(bridge),
          detail: `${found}/${DIFF[diffKey].targets}個 ・ ${title.replace(/^[^\w\s]+\s*/, "")}`,
        });
      }
      showResult(stagebox, {
        title,
        badge: badgeable && res.isBest ? "★ 自己ベスト更新" : "",
        sub: `${found}/${DIFF[diffKey].targets} 個発見 ・ 残り ${timeLeft.toFixed(0)}s`,
        onRetry: start,
        onMenu: toMenu,
      });
    }

    startBtn.onclick = () => {
      bridge.unlockAudio();
      start();
    };
    stopBtn.onclick = () => stop(); // end the run and return to the pre-start state

    function toCanvas(e) {
      const r = cv.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * cv.width,
        y: ((e.clientY - r.top) / r.height) * cv.height,
      };
    }
    const pm = (e) => {
      const p = toCanvas(e);
      mouse.x = p.x;
      mouse.y = p.y;
      mouse.inside = true;
    };
    const pl = () => (mouse.inside = false);

    function digAt(x, y) {
      if (!running) return;
      const now = performance.now();
      if (now < cooldownUntil) return; // locked after a cold miss (anti-spam)
      bridge.unlockAudio();
      const d = Math.hypot(x - target.x, y - target.y);
      if (d <= DIFF[diffKey].catch) {
        found++;
        elFound.textContent = String(found);
        bridge.fire("hot_found", { gain: 0.85 }); // distinct "double-thump" haptic + audio (event-content)
        if (bridge.master.visual) { fx.burst(target.x, target.y, "#d4a017", 30, 260); fx.shake(7); }
        revealPos = { x: target.x, y: target.y };
        reveal = 1;
        if (found >= DIFF[diffKey].targets) {
          endGame("🏆 CLEAR", true);
        } else {
          placeTarget();
        }
      } else {
        // cold dig — faint low feedback + a cooldown so you can't spam-find by luck
        bridge.fire("hot_pulse", { gain: 0.12, audio: true });
        if (bridge.master.visual) fx.shake(3);
        cooldownUntil = now + DIG_COOLDOWN * 1000;
      }
    }
    const pd = (e) => { const p = toCanvas(e); digAt(p.x, p.y); };
    cv.addEventListener("pointermove", pm);
    cv.addEventListener("pointerleave", pl);
    cv.addEventListener("pointerdown", pd);

    // loop
    let raf = 0,
      tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;

      // gamepad: stick/d-pad move the cursor, Ⓐ=dig (or start when idle),
      // RB=restart, ☰=stop, Ⓥ(View)=menu. Ⓧ/Ⓨ/Ⓑ toggle 映像/音/触覚 — idle-only.
      const G = pad.poll();
      if (G.connected) {
        padModality(G, bridge, running); // X/Y/B modality, idle-only
        let mx = G.lx, my = G.ly;
        if (G.isHeld(BTN.LEFT)) mx = -1; else if (G.isHeld(BTN.RIGHT)) mx = 1;
        if (G.isHeld(BTN.UP)) my = -1; else if (G.isHeld(BTN.DOWN)) my = 1;
        if (running && (mx || my)) {
          const spd = 540; // px/s
          mouse.x = Math.max(0, Math.min(cv.width, mouse.x + mx * spd * dt));
          mouse.y = Math.max(0, Math.min(cv.height, mouse.y + my * spd * dt));
          mouse.inside = true;
        }
        if (G.isDown(BTN.A) || G.isDown(BTN.RT)) { bridge.unlockAudio(); if (running) digAt(mouse.x, mouse.y); else start(); }
        if (G.isDown(BTN.RB)) { bridge.unlockAudio(); start(); } // restart (separate from dig)
        if (G.isDown(BTN.MENU) && running) stop(); // ☰ = stop
        if (G.isDown(BTN.VIEW)) toMenu(); // back to menu any time
      }

      if (running) {
        timeLeft -= dt;
        if (timeLeft <= 0) {
          timeLeft = 0;
          bridge.fire("hot_timeout", { gain: 0.7 });
          fx.shake(11);
          endGame("⏱ TIME UP", false);
        }
        elTime.textContent = timeLeft.toFixed(0);

        // geiger pulse scheduling
        if (mouse.inside && target) {
          const D = DIFF[diffKey];
          const d = Math.hypot(mouse.x - target.x, mouse.y - target.y);
          const warmth = Math.max(0, Math.min(1, 1 - d / D.range));
          if (warmth > 0.02) {
            const interval = lerp(0.6, 0.09, Math.pow(warmth, 1.3)); // s
            if (ts / 1000 - lastPulse >= interval) {
              lastPulse = ts / 1000;
              const gain = lerp(0.15, 1.0, Math.pow(warmth, 1.1));
              const pan = Math.max(-1, Math.min(1, (mouse.x - cv.width / 2) / (cv.width / 2)));
              bridge.fire("hot_pulse", { gain, pan });
              pulseFx = 1;
            }
          }
        }
      }
      reveal = Math.max(0, reveal - dt * 1.2);
      pulseFx = Math.max(0, pulseFx - dt * 6); // ~0.1/frame @60fps, but frame-rate independent
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }
    let pulseFx = 0;

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      // heat aid (optional)
      if (bridge.master.visual && target && running) {
        const D = DIFF[diffKey];
        const grd = g.createRadialGradient(target.x, target.y, 4, target.x, target.y, D.range);
        grd.addColorStop(0, "rgba(248,81,73,0.42)");
        grd.addColorStop(0.5, "rgba(210,153,34,0.16)");
        grd.addColorStop(1, "rgba(45,212,191,0)");
        g.fillStyle = grd;
        g.fillRect(0, 0, cv.width, cv.height);
      }

      // revealed target — drawn at where it WAS (revealPos), and only with 👁 ON.
      // (Old bug: it drew at `target`, which had already moved to the NEXT one →
      //  flashing the next treasure's location. Gated off too in pure-haptic mode.)
      if (reveal > 0 && revealPos && bridge.master.visual) {
        g.globalAlpha = reveal;
        g.fillStyle = "#d4a017";
        g.beginPath();
        g.arc(revealPos.x, revealPos.y, 10 + (1 - reveal) * 26, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }

      // cursor crosshair + pulse ring
      if (mouse.inside) {
        // proximity pulse ring is a VISUAL aid → 👁 OFF hides it (else it leaks closeness)
        if (pulseFx > 0 && bridge.master.visual) {
          g.strokeStyle = `rgba(124,92,255,${pulseFx})`;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(mouse.x, mouse.y, 10 + (1 - pulseFx) * 26, 0, Math.PI * 2);
          g.stroke();
        }
        g.strokeStyle = "#7c5cff";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(mouse.x - 9, mouse.y);
        g.lineTo(mouse.x + 9, mouse.y);
        g.moveTo(mouse.x, mouse.y - 9);
        g.lineTo(mouse.x, mouse.y + 9);
        g.stroke();
        // dig cooldown (anti-spam) — shown regardless of 👁 (it doesn't leak the target)
        const cdLeft = (cooldownUntil - performance.now()) / 1000;
        if (cdLeft > 0 && running) {
          g.strokeStyle = "rgba(248,81,73,0.85)";
          g.lineWidth = 3;
          g.beginPath();
          g.arc(mouse.x, mouse.y, 16, -Math.PI / 2, -Math.PI / 2 + (cdLeft / DIG_COOLDOWN) * Math.PI * 2);
          g.stroke();
          g.fillStyle = "#f85149";
          g.font = "bold 12px system-ui";
          g.textAlign = "center";
          g.fillText(`${cdLeft.toFixed(1)}s`, mouse.x, mouse.y - 22);
          g.textAlign = "left";
        }
      }

      fx.restore(g);
      fx.draw(g);

      if (!running && !elMsg.textContent) {
        g.fillStyle = "#aeb8c4";
        g.font = "14px system-ui";
        g.textAlign = "center";
        g.fillText("スタートを押して、マウス/パッドで宝を探す", cv.width / 2, cv.height / 2);
        g.textAlign = "left";
      }
    }

    stop();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        cv.removeEventListener("pointermove", pm);
        cv.removeEventListener("pointerleave", pl);
        cv.removeEventListener("pointerdown", pd);
        mods.dispose();
        disposeRank();
      },
    };
  },
};
