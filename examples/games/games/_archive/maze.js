/**
 * Invisible Maze — 見えない壁の迷路.
 *
 * Move the dot with the arrow keys / WASD. The walls are invisible: when you
 * brush one, the Hapbeat buzzes (harder = faster impact). Feel your way to the
 * gold goal. Toggle "壁を表示" to peek, or play Expert where a wall = restart.
 */

import { Fx } from "../../shared/fx.js";
import { showResult, clearResult } from "../../shared/ui.js";
import { best as bestScore, submit as submitScore } from "../../shared/scores.js";

const DIFF = {
  normal: { cols: 8, rows: 6, speed: 150, showWalls: true, deadly: false, label: "Normal" },
  hard: { cols: 12, rows: 9, speed: 165, showWalls: false, deadly: false, label: "Hard" },
  expert: { cols: 16, rows: 12, speed: 185, showWalls: false, deadly: true, label: "Expert" },
};

export const game = {
  id: "maze",
  emoji: "🧭",
  title: "見えない壁の迷路",
  en: "Invisible Maze",
  tag: "触覚＝衝突（二値）",
  desc: "壁は見えない。触覚だけを頼りに、ゴールまで手探りで進む。壁の表示は ON/OFF 切替可。",
  formatScore: (v) => `${v.toFixed(1)}s`,

  mount(container, ctx) {
    const bridge = ctx.bridge;
    const toMenu = ctx.toMenu || (() => {});
    const fx = new Fx();
    let diffKey = "normal";
    let showWalls = DIFF[diffKey].showWalls;

    container.innerHTML = `
      <div class="gametoolbar">
        <span class="label">難易度</span>
        <div class="toggle-group" id="diff"></div>
        <span class="spacer"></span>
        <button id="walls" aria-pressed="${showWalls}">壁を表示</button>
        <button id="restart">新しい迷路</button>
      </div>
      <div class="stagebox">
        <canvas id="cv" width="720" height="540"></canvas>
        <div class="center-msg" id="msg"></div>
      </div>
      <div class="hud">
        <span>時間 <b id="t">0.0</b>s</span>
        <span>接触 <b id="bumps">0</b></span>
        <span>自己ベスト <b id="best">—</b></span>
        <span id="state"></span>
      </div>
      <p class="note">操作: <kbd>←↑↓→</kbd> または <kbd>WASD</kbd>。壁に当たると触覚（速いほど強い）。
      金色のゴールに触れるとクリア。Expert は壁に当たるとスタートに戻る。</p>
    `;

    const cv = container.querySelector("#cv");
    const g = cv.getContext("2d");
    const elT = container.querySelector("#t");
    const elBumps = container.querySelector("#bumps");
    const elState = container.querySelector("#state");
    const elMsg = container.querySelector("#msg");
    const elBest = container.querySelector("#best");
    const stagebox = container.querySelector(".stagebox");
    const diffBox = container.querySelector("#diff");
    const wallsBtn = container.querySelector("#walls");

    function refreshBest() {
      const b = bestScore("maze", diffKey);
      elBest.textContent = b == null ? "—" : `${b.toFixed(1)}s`;
    }

    for (const k of Object.keys(DIFF)) {
      const b = document.createElement("button");
      b.textContent = DIFF[k].label;
      b.setAttribute("aria-pressed", String(k === diffKey));
      b.onclick = () => {
        diffKey = k;
        for (const c of diffBox.children) c.setAttribute("aria-pressed", String(c === b));
        showWalls = DIFF[k].showWalls;
        wallsBtn.setAttribute("aria-pressed", String(showWalls));
        reset();
      };
      diffBox.appendChild(b);
    }
    wallsBtn.onclick = () => {
      showWalls = !showWalls;
      wallsBtn.setAttribute("aria-pressed", String(showWalls));
    };
    container.querySelector("#restart").onclick = () => reset();

    // ── maze state ───────────────────────────────────────────
    let grid, gw, gh, tile, player, goal, startPos;
    let bumps = 0,
      time = 0,
      finished = false,
      lastBump = 0;
    const keys = new Set();

    function genMaze(C, R) {
      // tile grid: (2C+1) x (2R+1); odd = cell, even = wall lattice
      const W = 2 * C + 1,
        H = 2 * R + 1;
      const wall = Array.from({ length: H }, () => Array(W).fill(true));
      const visited = Array.from({ length: R }, () => Array(C).fill(false));
      // iterative recursive backtracker
      const rnd = Math.random;
      const stack = [[0, 0]];
      visited[0][0] = true;
      wall[1][1] = false;
      while (stack.length) {
        const [cx, cy] = stack[stack.length - 1];
        const nbrs = [];
        if (cy > 0 && !visited[cy - 1][cx]) nbrs.push([cx, cy - 1, 0, -1]);
        if (cy < R - 1 && !visited[cy + 1][cx]) nbrs.push([cx, cy + 1, 0, 1]);
        if (cx > 0 && !visited[cy][cx - 1]) nbrs.push([cx - 1, cy, -1, 0]);
        if (cx < C - 1 && !visited[cy][cx + 1]) nbrs.push([cx + 1, cy, 1, 0]);
        if (!nbrs.length) {
          stack.pop();
          continue;
        }
        const [nx, ny, dx, dy] = nbrs[Math.floor(rnd() * nbrs.length)];
        wall[2 * cy + 1 + dy][2 * cx + 1 + dx] = false; // knock down wall between
        wall[2 * ny + 1][2 * nx + 1] = false;
        visited[ny][nx] = true;
        stack.push([nx, ny]);
      }
      return { wall, W, H };
    }

    function reset() {
      const D = DIFF[diffKey];
      const m = genMaze(D.cols, D.rows);
      grid = m.wall;
      gw = m.W;
      gh = m.H;
      tile = Math.floor(Math.min(cv.width / gw, cv.height / gh));
      // center the maze
      offX = Math.floor((cv.width - gw * tile) / 2);
      offY = Math.floor((cv.height - gh * tile) / 2);
      startPos = { x: 1 * tile + tile / 2, y: 1 * tile + tile / 2 };
      goal = { tx: gw - 2, ty: gh - 2 };
      player = { x: startPos.x, y: startPos.y, r: Math.max(4, tile * 0.32) };
      bumps = 0;
      time = 0;
      lastBump = -1; // else a replay suppresses bumps until time passes the old value
      finished = false;
      elMsg.textContent = "";
      elState.textContent = `${DIFF[diffKey].label}`;
      clearResult(stagebox);
      refreshBest();
    }

    let offX = 0,
      offY = 0;

    function isWall(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= gw || ty >= gh) return true;
      return grid[ty][tx];
    }

    // circle-vs-tilegrid axis-separated resolution; returns blocked speed
    function moveAxis(dx, dy) {
      const r = player.r;
      let nx = player.x + dx,
        ny = player.y + dy;
      let blocked = 0;
      // x
      if (dx !== 0) {
        const probe = nx + Math.sign(dx) * r;
        const tx = Math.floor(probe / tile);
        const ty0 = Math.floor((player.y - r + 1) / tile);
        const ty1 = Math.floor((player.y + r - 1) / tile);
        let hit = false;
        for (let ty = ty0; ty <= ty1; ty++) if (isWall(tx, ty)) hit = true;
        if (hit) {
          // snap to the wall face
          nx = dx > 0 ? tx * tile - r - 0.01 : (tx + 1) * tile + r + 0.01;
          blocked = Math.max(blocked, Math.abs(dx));
        }
        player.x = nx;
      }
      // y
      if (dy !== 0) {
        const probe = ny + Math.sign(dy) * r;
        const ty = Math.floor(probe / tile);
        const tx0 = Math.floor((player.x - r + 1) / tile);
        const tx1 = Math.floor((player.x + r - 1) / tile);
        let hit = false;
        for (let tx = tx0; tx <= tx1; tx++) if (isWall(tx, ty)) hit = true;
        if (hit) {
          ny = dy > 0 ? ty * tile - r - 0.01 : (ty + 1) * tile + r + 0.01;
          blocked = Math.max(blocked, Math.abs(dy));
        }
        player.y = ny;
      }
      return blocked;
    }

    function onBump(blockedPx, dt) {
      const now = time;
      const speed = blockedPx / dt; // px/s into the wall
      // straight-on impact (~full move speed) ≈ 0.85; glancing/diagonal lower.
      const gain = Math.max(0.3, Math.min(0.9, 0.3 + Math.min(1, speed / 200) * 0.6));
      if (now - lastBump > 0.07) {
        lastBump = now;
        bumps++;
        if (DIFF[diffKey].deadly) {
          bridge.fire("maze_fail", { gain: 0.8 });
          fx.shake(13);
          player.x = startPos.x;
          player.y = startPos.y;
          elState.textContent = `${DIFF[diffKey].label} — 壁に接触！スタートへ`;
        } else {
          bridge.fire("maze_bump", { gain });
          fx.shake(2 + gain * 6);
        }
      }
    }

    // input
    const kd = (e) => {
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(k)) {
        keys.add(k);
        e.preventDefault();
      }
    };
    const ku = (e) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    // loop
    let raf = 0,
      prev = 0;
    function frame(ts) {
      if (!prev) prev = ts;
      const dt = Math.min(0.05, (ts - prev) / 1000);
      prev = ts;
      if (!finished) {
        time += dt;
        const sp = DIFF[diffKey].speed;
        let vx = 0,
          vy = 0;
        if (keys.has("arrowleft") || keys.has("a")) vx -= 1;
        if (keys.has("arrowright") || keys.has("d")) vx += 1;
        if (keys.has("arrowup") || keys.has("w")) vy -= 1;
        if (keys.has("arrowdown") || keys.has("s")) vy += 1;
        if (vx && vy) {
          vx *= 0.7071;
          vy *= 0.7071;
        }
        let blocked = 0;
        if (vx) blocked = Math.max(blocked, moveAxis(vx * sp * dt, 0));
        if (vy) blocked = Math.max(blocked, moveAxis(0, vy * sp * dt));
        if (blocked > 0.5) onBump(blocked, dt);

        // goal check
        const gx = goal.tx * tile + tile / 2,
          gy = goal.ty * tile + tile / 2;
        if (Math.hypot(player.x - gx, player.y - gy) < player.r + tile * 0.3) {
          finished = true;
          bridge.fire("maze_goal", { gain: 0.65 });
          fx.burst(gx + offX, gy + offY, "#d4a017", 36, 280);
          fx.shake(9);
          const res = submitScore("maze", diffKey, time, true);
          refreshBest();
          showResult(stagebox, {
            title: "🎉 CLEAR",
            badge: res.isBest ? "★ 自己ベスト更新" : "",
            sub: `${time.toFixed(1)}s ・ 接触 ${bumps} 回`,
            retryLabel: "新しい迷路",
            onRetry: reset,
            onMenu: toMenu,
          });
        }
      }
      fx.update(dt);
      draw();
      elT.textContent = time.toFixed(1);
      elBumps.textContent = String(bumps);
      raf = requestAnimationFrame(frame);
    }

    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      fx.apply(g);
      g.save();
      g.translate(offX, offY);
      // floor
      g.fillStyle = "#0a0d12";
      g.fillRect(0, 0, gw * tile, gh * tile);
      // walls (optional)
      if (showWalls) {
        g.fillStyle = "#3a4658";
        for (let y = 0; y < gh; y++)
          for (let x = 0; x < gw; x++) if (grid[y][x]) g.fillRect(x * tile, y * tile, tile, tile);
      } else {
        // subtle border so the play-field is visible
        g.strokeStyle = "#1b2230";
        g.lineWidth = 2;
        g.strokeRect(1, 1, gw * tile - 2, gh * tile - 2);
      }
      // start + goal
      g.fillStyle = "rgba(63,185,80,0.25)";
      g.fillRect(1 * tile, 1 * tile, tile, tile);
      const gx = goal.tx * tile,
        gy = goal.ty * tile;
      g.fillStyle = "#d4a017";
      g.beginPath();
      g.arc(gx + tile / 2, gy + tile / 2, tile * 0.34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(212,160,23,0.18)";
      g.fillRect(gx, gy, tile, tile);
      // player
      g.fillStyle = "#7c5cff";
      g.shadowColor = "#7c5cff";
      g.shadowBlur = 12;
      g.beginPath();
      g.arc(player.x, player.y, player.r, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.restore();
      fx.restore(g);
      fx.draw(g);
    }

    reset();
    raf = requestAnimationFrame(frame);

    return {
      unmount() {
        cancelAnimationFrame(raf);
        window.removeEventListener("keydown", kd);
        window.removeEventListener("keyup", ku);
      },
    };
  },
};
