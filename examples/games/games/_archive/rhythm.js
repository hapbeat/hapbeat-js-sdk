/**
 * Haptic Rhythm — 触覚リズム.
 *
 * A steady beat is delivered on up to three channels — falling notes (visual),
 * a metronome tick (audio), and a Hapbeat pulse (haptic). Toggle any of them to
 * compare modalities: turn the screen and sound off and try to keep time by
 * feel alone. Press SPACE on each beat; tight timing scores higher.
 *
 * The haptic/audio cue fires AT the beat (the device is the metronome). A short
 * count-in lets you lock onto the tempo before scoring starts.
 */

import { Fx } from "../../shared/fx.js";
import { showResult, clearResult } from "../../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../../shared/scores.js";

const DIFF = {
  normal: { bpm: 90, travel: 1.7, notes: 28, label: "Normal" },
  hard: { bpm: 130, travel: 1.35, notes: 36, label: "Hard" },
  expert: { bpm: 165, travel: 1.05, notes: 44, label: "Expert" },
};

const COUNT_IN = 4; // beats before scoring begins
const PERFECT = 0.06; // s
const GOOD = 0.13; // s

export const game = {
  id: "rhythm",
  emoji: "🥁",
  title: "触覚リズム",
  en: "Haptic Rhythm",
  tag: "触覚＝タイミング・モダリティA/B",
  desc: "拍ごとに 映像・音・触覚 のキューが出る。各チャンネルを個別に ON/OFF して比較。画面と音を切れば「触覚だけ」で叩ける。",
  formatScore: (v) => `${Math.round(v)} 点`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let diffKey = "normal";
    let showNotes = true;

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">難易度</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="notes" aria-pressed="true">映像（ノーツ表示）</button>
        <button id="start" class="primary">スタート</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="460"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>スコア <b id="score">0</b></span>
        <span>コンボ <b id="combo">0</b></span>
        <span>精度 <b id="acc">100</b>%</span>
        <span>自己ベスト <b id="best">—</b></span>
        <span id="judge"></span>
      </div>
      <p class="note">操作: 拍に合わせて <kbd>Space</kbd>。音・触覚はヘッダーの 🔊 / 📳 マスタースイッチで ON/OFF。
      映像（ノーツ）はこのボタンで OFF にできる → 3 つ全部の効きを聴き比べ・触り比べできる。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elScore = container.querySelector("#score");
    const elCombo = container.querySelector("#combo");
    const elAcc = container.querySelector("#acc");
    const elJudge = container.querySelector("#judge");
    const elMsg = container.querySelector("#msg");
    const elBest = container.querySelector("#best");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");
    const notesBtn = container.querySelector("#notes");

    function refreshBest() {
      const b = bestScore("rhythm", diffKey);
      elBest.textContent = b == null ? "—" : String(Math.round(b));
    }

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
    notesBtn.onclick = () => {
      showNotes = !showNotes;
      notesBtn.setAttribute("aria-pressed", String(showNotes));
    };

    // ── play state ───────────────────────────────────────────
    const hitLineY = cv.height - 90;
    let beats = []; // {t, hit:boolean, cued:boolean}
    let running = false,
      startAt = 0,
      beatDur = 0,
      travel = 0;
    let score = 0,
      combo = 0,
      maxCombo = 0,
      perfect = 0,
      good = 0,
      miss = 0;
    let flash = 0;

    function build() {
      const D = DIFF[diffKey];
      beatDur = 60 / D.bpm;
      travel = D.travel;
      beats = [];
      for (let i = 0; i < D.notes + COUNT_IN; i++) {
        beats.push({ t: i * beatDur, hit: false, expired: false, cued: false, scored: i >= COUNT_IN });
      }
      score = 0;
      combo = 0;
      maxCombo = 0;
      perfect = 0;
      good = 0;
      miss = 0;
      elJudge.innerHTML = ""; // clear the previous run's lingering judgement
      updateHud();
    }

    function start() {
      clearResult(stagebox);
      build();
      running = true;
      startAt = performance.now() / 1000 + 1.0; // 1s lead-in
      elMsg.textContent = "";
      container.querySelector("#start").textContent = "リスタート";
    }
    function stop() {
      running = false;
      elMsg.textContent = "";
      clearResult(stagebox);
      refreshBest();
      container.querySelector("#start").textContent = "スタート";
    }

    container.querySelector("#start").onclick = () => {
      bridge.unlockAudio();
      start();
    };

    function now() {
      return performance.now() / 1000 - startAt;
    }

    function press() {
      if (!running) return;
      bridge.unlockAudio();
      const t = now();
      // nearest scorable, unhit beat
      let best = null,
        bestErr = 1e9;
      for (const b of beats) {
        if (b.hit || b.expired || !b.scored) continue;
        const e = Math.abs(b.t - t);
        if (e < bestErr) {
          bestErr = e;
          best = b;
        }
      }
      flash = 1;
      if (!best || bestErr > GOOD) {
        // off-beat press — breaks combo (the pending beat is judged later)
        combo = 0;
        elJudge.innerHTML = `<span style="color:var(--bad)">MISS</span>`;
        updateHud();
        return;
      }
      best.hit = true;
      const isPerfect = bestErr <= PERFECT;
      if (isPerfect) perfect++;
      else good++;
      score += isPerfect ? 100 : 50;
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      bridge.fire("rhythm_hit", { gain: isPerfect ? 0.6 : 0.4 });
      fx.burst(cv.width / 2, hitLineY, isPerfect ? "#2dd4bf" : "#3fb950", isPerfect ? 18 : 10, 170);
      fx.shake(isPerfect ? 4 : 2);
      if (combo > 0 && combo % 10 === 0) {
        bridge.fire("rhythm_combo", { gain: 0.6 });
        fx.burst(cv.width / 2, hitLineY, "#7c5cff", 30, 240);
        fx.shake(7);
      }
      // signed offset: negative = early, positive = late
      const offMs = Math.round((t - best.t) * 1000);
      elJudge.innerHTML = `<span style="color:${isPerfect ? "var(--accent-2)" : "var(--good)"}">${isPerfect ? "PERFECT" : "GOOD"}</span> <span class="note">${offMs > 0 ? "+" : ""}${offMs}ms</span>`;
      updateHud();
    }

    // accuracy reflects both coverage (missed beats) and timing quality
    function updateHud() {
      elScore.textContent = String(score);
      elCombo.textContent = String(combo);
      const resolved = perfect + good + miss;
      const acc = resolved ? Math.round((100 * (perfect * 1.0 + good * 0.6)) / resolved) : 100;
      elAcc.textContent = String(acc);
    }

    const kd = (e) => {
      if (e.code === "Space" || e.key === " ") {
        // when the result overlay is up, let Space activate the focused button
        if (stagebox.querySelector(".result")) return;
        e.preventDefault();
        press();
      }
    };
    window.addEventListener("keydown", kd);
    cv.addEventListener("pointerdown", press);

    // loop
    let raf = 0,
      fxPrev = 0;
    function frame(ts) {
      const dt = fxPrev ? Math.min(0.05, (ts - fxPrev) / 1000) : 0;
      fxPrev = ts;
      const t = running ? now() : -999;
      // emit cues at each beat crossing
      if (running) {
        for (const b of beats) {
          if (!b.cued && t >= b.t) {
            b.cued = true;
            // audio metronome tick + haptic pulse (masters gate them)
            bridge.fire("rhythm_cue", { gain: 0.45 });
          }
          // a scored beat that passes the hit window unhit is a miss
          if (b.scored && !b.hit && !b.expired && t > b.t + GOOD) {
            b.expired = true;
            miss++;
            combo = 0;
            elJudge.innerHTML = `<span style="color:var(--bad)">MISS</span>`;
            updateHud();
          }
        }
        const last = beats[beats.length - 1];
        if (t > last.t + 1.2) {
          running = false;
          const acc = elAcc.textContent;
          const res = submitScore("rhythm", diffKey, score, false);
          refreshBest();
          if (res.isBest) {
            fx.burst(cv.width / 2, cv.height / 2, "#2dd4bf", 40, 280);
            fx.shake(8);
          }
          showResult(stagebox, {
            title: "🥁 RESULT",
            badge: res.isBest ? "★ 自己ベスト更新" : "",
            sub: `スコア ${score} ・ 最大コンボ ${maxCombo} ・ 精度 ${acc}%`,
            onRetry: start,
            onMenu: toMenu,
          });
        }
      }
      fx.update(dt);
      draw(t);
      flash = Math.max(0, flash - dt * 5);
      raf = requestAnimationFrame(frame);
    }

    function draw(t) {
      g.clearRect(0, 0, cv.width, cv.height);
      fx.apply(g);
      const laneX = cv.width / 2;
      const laneW = 120;
      // lane
      g.fillStyle = "#0a0d12";
      g.fillRect(laneX - laneW / 2, 0, laneW, cv.height);
      g.strokeStyle = "#1b2230";
      g.strokeRect(laneX - laneW / 2, 0, laneW, cv.height);
      // hit line
      g.strokeStyle = flash > 0 ? "#7c5cff" : "#3a4658";
      g.lineWidth = flash > 0 ? 4 : 2;
      g.beginPath();
      g.moveTo(laneX - laneW / 2 - 14, hitLineY);
      g.lineTo(laneX + laneW / 2 + 14, hitLineY);
      g.stroke();
      g.fillStyle = "#cdd6e0";
      g.font = "12px system-ui";
      g.textAlign = "center";
      g.fillText("▶ SPACE ◀", laneX, hitLineY + 26);

      // notes
      if (showNotes && running) {
        for (const b of beats) {
          if (b.hit) continue;
          const dy = (t - b.t) / travel; // -1 (spawn top) .. 0 (line)
          const y = hitLineY + dy * hitLineY;
          if (y < -30 || y > cv.height + 30) continue;
          if (!b.scored) {
            g.fillStyle = "#4b5666"; // count-in note
          } else {
            g.fillStyle = b.t - t < -GOOD ? "#5a2a2a" : "#7c5cff";
          }
          const w = laneW - 20;
          g.fillRect(laneX - w / 2, y - 9, w, 18);
        }
      } else if (running) {
        g.fillStyle = "#4b5666";
        g.fillText("（映像 OFF：音 / 触覚 を頼りに）", laneX, 40);
      } else {
        g.fillStyle = "#4b5666";
        g.fillText("スタートを押して開始", laneX, 40);
      }
      g.textAlign = "left";
      fx.restore(g);
      fx.draw(g);
    }

    refreshBest();
    build();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
      },
    };
  },
};
