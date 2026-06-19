/**
 * Feel-the-Wait — 進捗をさわる.
 *
 * Feel an invisible wait/deadline through TEMPO alone. Two scenarios:
 *
 *   (A) PROGRESS — a simulated upload/submit runs 0→100% over ~8s. A haptic
 *       tick (rhythm_cue) fires on a schedule whose INTERVAL shrinks as
 *       progress climbs: a slow heartbeat early, an urgent flutter near done.
 *       Completion is a distinctive DOUBLE-TAP (rhythm_hit ×2) at 100%.
 *
 *   (B) TIMEOUT — a "session expires in N s" countdown. Tempo ramps up as the
 *       deadline nears, with an urgent fast flutter in the final ~5s, and a
 *       final fail BUZZ (hot_timeout) when it hits zero.
 *
 * The pitch: turn 👁 映像 OFF and the bar / number disappears — you anticipate
 * completion purely by feeling the accelerating tempo. Optional: arm "完了を当てる"
 * and press SPACE the instant you think it finishes; we score your guess.
 */

import { Fx } from "../shared/fx.js";
import { showResult, clearResult } from "../shared/ui.js";

const SCN = {
  progress: { label: "進捗 (アップロード)", dur: 8.0, slow: 0.62, fast: 0.085, curve: 1.4 },
  timeout: { label: "期限 (30s 切れ)", dur: 30.0, slow: 1.05, fast: 0.1, curve: 2.2, urgent: 5.0 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const game = {
  id: "progress",
  emoji: "⏳",
  title: "進捗をさわる",
  en: "Feel-the-Wait",
  tag: "タイミングで進捗/期限",
  desc: "見えない待ち時間や期限を「テンポ」で感じる。進捗が進む / 期限が迫るほど触覚の刻みが速くなり、完了は二連打、期限切れは強いブザー。映像 OFF で純触覚の予感を体感。",

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let scnKey = "progress";
    let guessMode = false; // "完了を当てる" — press to guess the finish moment

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">シナリオ</span>
        <div class="toggle-group" id="scn"></div>
        <button id="guess" class="ghost" aria-pressed="false">完了を当てる</button>
        <span class="spacer"></span>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="440"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>状態 <b id="phase">待機</b></span>
        <span>刻み間隔 <b id="ivl">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: <kbd>スタート</kbd>で進行。完了/期限切れを<b>テンポ</b>で感じる（速くなるほど近い）。
      「完了を当てる」ON で、終わると思った瞬間に <kbd>Space</kbd>（クリック可）。
      ヘッダーの <b>👁 映像 / 👂 音 / ✋ 触覚</b> で切替。<b>👁 映像 OFF</b>＝バー/数字が消え、<b>純触覚</b>で予感する本来モード。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elPhase = container.querySelector("#phase");
    const elIvl = container.querySelector("#ivl");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const stagebox = container.querySelector(".stagebox");
    const scnBox = container.querySelector("#scn");
    const guessBtn = container.querySelector("#guess");
    const startBtn = container.querySelector("#start");

    for (const k of Object.keys(SCN)) {
      const b = document.createElement("button");
      b.textContent = SCN[k].label;
      b.setAttribute("aria-pressed", String(k === scnKey));
      b.onclick = () => {
        scnKey = k;
        for (const c of scnBox.children) c.setAttribute("aria-pressed", String(c === b));
        idle();
      };
      scnBox.appendChild(b);
    }
    guessBtn.onclick = () => {
      guessMode = !guessMode;
      guessBtn.setAttribute("aria-pressed", String(guessMode));
    };

    // ── state ────────────────────────────────────────────────
    let phase = "idle"; // idle | run | done
    let t = 0, // elapsed seconds
      nextTick = 0, // seconds until next haptic tick
      pulseFx = 0, // 0..1 visual blip for the last tick
      guessed = null, // recorded guess fraction (when guessMode)
      doneTapTimer = null, // deferred 2nd done-tap (cancel on unmount)
      flash = 0;

    function fraction() {
      // 0 → 1 over the scenario duration (progress climbs, deadline elapses)
      return clamp01(t / SCN[scnKey].dur);
    }

    // tick interval as a function of how near completion we are (0 far .. 1 done)
    function tickInterval(near) {
      const S = SCN[scnKey];
      let n = near;
      // TIMEOUT: in the final urgent window, ramp urgency above the base curve
      // (lerp 0.85→1.0 across the window so the last seconds clearly accelerate).
      if (scnKey === "timeout") {
        const remain = S.dur - t;
        if (remain <= S.urgent) n = Math.max(n, lerp(0.85, 1.0, 1 - remain / S.urgent));
      }
      return lerp(S.slow, S.fast, Math.pow(clamp01(n), S.curve));
    }

    function idle() {
      clearResult(stagebox);
      phase = "idle";
      t = 0;
      pulseFx = 0;
      guessed = null;
      elPhase.textContent = "待機";
      elIvl.textContent = "—";
      elState.textContent = SCN[scnKey].label;
      elMsg.textContent = "";
      startBtn.textContent = "スタート";
    }

    function start() {
      clearResult(stagebox);
      phase = "run";
      t = 0;
      pulseFx = 0;
      guessed = null;
      nextTick = tickInterval(0); // first beat after the initial slow interval
      elPhase.textContent = scnKey === "progress" ? "アップロード中" : "セッション有効";
      elMsg.textContent = "";
      elState.textContent = SCN[scnKey].label;
      startBtn.textContent = "リスタート";
      tPrev = performance.now();
    }

    function finish() {
      phase = "done";
      const S = SCN[scnKey];
      if (scnKey === "progress") {
        // distinctive DONE pattern: double-tap (2nd tap tracked so unmount can cancel it)
        bridge.fire("rhythm_hit", { gain: 0.7 });
        clearTimeout(doneTapTimer);
        doneTapTimer = setTimeout(() => bridge.fire("rhythm_hit", { gain: 0.7 }), 130);
        fx.burst(cv.width / 2, cv.height / 2, "#3fb950", 36, 280);
        fx.shake(7);
        elPhase.textContent = "完了";
      } else {
        // deadline reached: fail buzz
        bridge.fire("hot_timeout", { gain: 0.8 });
        fx.burst(cv.width / 2, cv.height / 2, "#f85149", 40, 300);
        fx.shake(11);
        elPhase.textContent = "期限切れ";
      }
      flash = 1;

      let title = scnKey === "progress" ? "✅ 完了" : "⏱ 期限切れ";
      let sub = scnKey === "progress" ? `所要 ${S.dur.toFixed(1)}s（二連打＝完了）` : `${S.dur.toFixed(0)}s で失効（ブザー＝期限切れ）`;
      let badge = "";
      if (guessMode && guessed != null) {
        // a guess is always recorded before completion → report the lead time.
        const leadSec = (1 - guessed) * S.dur;
        badge = leadSec < 0.4 ? "★ ぴったり" : "";
        sub += ` ・ 完了 ${leadSec.toFixed(2)}s 前に予想`;
      } else if (guessMode) {
        sub += " ・ 予想なし";
      }

      showResult(stagebox, { title, badge, sub, onRetry: start, onMenu: toMenu });
    }

    function pressGuess() {
      bridge.unlockAudio();
      if (phase !== "run" || !guessMode || guessed != null) return;
      guessed = fraction();
      // light confirm tick (audio-forward so it doesn't masquerade as a progress beat)
      bridge.fire("rhythm_cue", { gain: 0.25, audio: true });
      fx.burst(cv.width / 2, cv.height * 0.62, "#7c5cff", 18, 200);
      elMsg.textContent = "";
    }

    startBtn.onclick = () => {
      bridge.unlockAudio();
      start();
    };

    // input — Space / click records a guess (only meaningful in guessMode)
    const kd = (e) => {
      if (e.code === "Space" || e.key === " ") {
        if (stagebox.querySelector(".result")) return; // let Space hit the result button
        e.preventDefault();
        pressGuess();
      }
    };
    window.addEventListener("keydown", kd);
    cv.addEventListener("pointerdown", pressGuess);

    // ── loop ─────────────────────────────────────────────────
    let raf = 0,
      tPrev = performance.now();
    function frame(ts) {
      const dt = Math.min(0.05, (ts - tPrev) / 1000);
      tPrev = ts;

      if (phase === "run") {
        t += dt;
        const S = SCN[scnKey];
        const near = scnKey === "progress" ? fraction() : 1 - (S.dur - t) / S.dur; // both → 1 near end
        elPhase.textContent = scnKey === "progress" ? "アップロード中" : "セッション有効";

        // schedule the accelerating haptic ticks
        nextTick -= dt;
        if (nextTick <= 0 && t < S.dur) {
          const gain = lerp(0.28, 0.95, Math.pow(clamp01(near), 1.2));
          bridge.fire("rhythm_cue", { gain });
          pulseFx = 1;
          nextTick = tickInterval(near);
        }
        // the ms number is an absolute progress proxy → hide it with 👁 映像 OFF
        // (the always-on pulse ring still conveys the haptic tempo, not the value).
        elIvl.textContent = bridge.master.visual ? `${(tickInterval(near) * 1000).toFixed(0)}ms` : "—";

        if (t >= S.dur) {
          t = S.dur;
          finish();
        }
      }

      pulseFx = Math.max(0, pulseFx - dt * 4);
      flash = Math.max(0, flash - dt * 2.2);
      fx.update(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, cv.width, cv.height);

      fx.apply(g);

      // completion flash
      if (flash > 0) {
        g.globalAlpha = flash * 0.4;
        g.fillStyle = scnKey === "progress" ? "#3fb950" : "#f85149";
        g.fillRect(0, 0, cv.width, cv.height);
        g.globalAlpha = 1;
      }

      const cx = cv.width / 2;
      const cy = cv.height / 2;
      const showVisual = bridge.master.visual;
      const frac = fraction();
      const accent = scnKey === "progress" ? "#2dd4bf" : "#d29922";

      // central tick pulse ring — ALWAYS shown (it is the haptic, not the answer):
      // it conveys tempo, not the absolute progress value.
      if (pulseFx > 0 && phase === "run") {
        g.strokeStyle = `rgba(124,92,255,${pulseFx})`;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(cx, cy - 30, 18 + (1 - pulseFx) * 40, 0, Math.PI * 2);
        g.stroke();
      }
      // a small steady core dot so the tempo is visible even at rest
      g.fillStyle = phase === "run" ? "#7c5cff" : "#3a4252";
      g.beginPath();
      g.arc(cx, cy - 30, 9, 0, Math.PI * 2);
      g.fill();

      // ── the progress bar / countdown number is the VISUAL AID (gated on 👁) ──
      if (showVisual) {
        if (scnKey === "progress") {
          const bw = 460,
            bh = 22,
            bx = cx - bw / 2,
            by = cy + 30;
          g.fillStyle = "#161b22";
          g.strokeStyle = "#2a313c";
          g.lineWidth = 1;
          roundRect(g, bx, by, bw, bh, 11);
          g.fill();
          g.stroke();
          g.fillStyle = accent;
          if (frac > 0) {
            roundRect(g, bx, by, Math.max(bh, bw * frac), bh, 11);
            g.fill();
          }
          g.fillStyle = "#e6edf3";
          g.font = "bold 20px system-ui";
          g.textAlign = "center";
          g.fillText(`${Math.round(frac * 100)}%`, cx, by + bh + 30);
          g.textAlign = "left";
        } else {
          const remain = Math.max(0, SCN[scnKey].dur - t);
          const urgent = remain <= SCN[scnKey].urgent && phase === "run";
          g.fillStyle = urgent ? "#f85149" : "#e6edf3";
          g.font = "bold 60px system-ui";
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillText(`${remain.toFixed(1)}s`, cx, cy + 56);
          g.textBaseline = "alphabetic";
          g.textAlign = "left";
        }
        // recorded guess marker
        if (guessMode && guessed != null) {
          g.fillStyle = "#7c5cff";
          g.font = "12px system-ui";
          g.textAlign = "center";
          g.fillText(`予想: ${Math.round(guessed * 100)}%`, cx, cy + 95);
          g.textAlign = "left";
        }
      } else {
        // 👁 OFF — the whole point: no bar, no number. Feel the tempo.
        g.fillStyle = "#3a4252";
        g.font = "13px system-ui";
        g.textAlign = "center";
        g.fillText("👁 映像 OFF：テンポだけで完了を予感する", cx, cy + 56);
        g.textAlign = "left";
      }

      fx.restore(g);
      fx.draw(g);

      // idle hint
      if (phase === "idle" && !elMsg.textContent) {
        g.fillStyle = "#4b5666";
        g.font = "13px system-ui";
        g.textAlign = "center";
        g.fillText("スタートを押す。刻みが速くなるほど完了が近い。", cx, 48);
        g.textAlign = "left";
      }
    }

    function roundRect(c, x, y, w, h, r) {
      r = Math.min(r, h / 2, w / 2);
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    idle();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        clearTimeout(doneTapTimer);
        window.removeEventListener("keydown", kd);
        cv.removeEventListener("pointerdown", pressGuess);
      },
    };
  },
};
