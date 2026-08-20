/**
 * 触覚ボクシング — カメラ（MediaPipe Pose）で全身を使って戦う Hapbeat デモ。
 *
 * コントローラを持たない＝手はふさがっていない。だから「当たった / 受けた / かわした」の
 * 区別は画面ではなく体で返す必要がある、という触覚が主役になる題材。
 *
 *   パンチ  … 手首を前（カメラ方向）へ突く（左右それぞれ独立）
 *   ガード  … 両手を顔の前に上げる（継続）
 *   回避    … 左右に上体を倒す（リーン）／しゃがむ（ダック）
 *
 * 敵は idle → 予告(telegraph) → 打撃(strike) → 硬直(recover) のステートマシンで、
 * 予告と硬直が「差し込みどころ」。打撃の瞬間に ガード / 正しい回避 / 被弾 を判定する。
 *
 * 触覚・音は shared/hapbeat-bridge.js + shared/content-router.js 経由（fps デモと同じ）。
 * helper 未起動でも音と映像だけで最後まで遊べる。
 *
 * HTTP 配信で開く: http://localhost:8170/examples/games/boxing/
 */

import { ArcadeBridge } from "../shared/hapbeat-bridge.js";
import { ContentRouter } from "../shared/content-router.js";
import { Fx } from "../shared/fx.js";
import { PoseTracker, SKELETON } from "./pose.js";
import { GestureTracker } from "./gestures.js";
import { TUNING, GAME } from "./tuning.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ── bridge / router（触覚と音） ───────────────────────────────────────────────
const bridge = new ArcadeBridge();
let bridgeReady = false;
const actx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = actx.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(actx.destination);

const router = new ContentRouter(bridge);
bridge.attachRouter(router); // bridge.fire() が Kit クリップ / 音声ファイルを優先し、無ければ合成にフォールバック
router.attachAudio(actx, masterGain);
router.load({
  eventmapUrl: "eventmap.json",
  manifestUrl: "../demo-kit/fps-kit/fps-kit-manifest.json", // ボクシング専用 Kit は未作成 → fps-kit を流用
  clipBase: "../demo-kit/fps-kit/stream-clips/",
});
router.loadAudioFiles("../"); // event-content の audio.file は shell root（examples/games/）基準
bridge.init({ appName: "HapbeatBoxing", audioBase: "../" }).then(() => { bridgeReady = true; syncConn(); });

// ── DOM ──────────────────────────────────────────────────────────────────────
const root = document.createElement("div");
root.id = "hbbox";
root.innerHTML = `
  <style>
    #hbbox { position: fixed; inset: 0; font-family: system-ui, sans-serif; color: #e6edf3;
      background: #070a10; display: flex; overflow: hidden; }
    #hbbox .stage { position: relative; flex: 1 1 auto; min-width: 0; background: #05070a; }
    #hbbox video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
      transform: scaleX(-1); /* ミラー表示（鏡と同じ左右） */ background: #05070a; }
    #hbbox canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    #hbbox .panel { flex: 0 0 300px; background: rgba(10,13,18,0.94); border-left: 1px solid #2a313c;
      padding: 12px 14px; overflow-y: auto; }
    #hbbox h2 { margin: 0 0 8px; font-size: 15px; }
    #hbbox .group-title { font-size: 11px; color: #8b97a6; text-transform: uppercase;
      letter-spacing: .06em; margin: 12px 0 4px; }
    #hbbox .row { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 13px; }
    #hbbox input[type=checkbox] { width: 16px; height: 16px; accent-color: #7c5cff; }
    #hbbox button.primary { margin-top: 12px; width: 100%; padding: 10px; font-size: 14px;
      font-weight: 600; color: #fff; background: #7c5cff; border: 0; border-radius: 8px; cursor: pointer; }
    #hbbox button.primary:disabled { background: #3a3550; color: #9a94b5; cursor: not-allowed; }
    #hbbox button.ghost { width: 100%; margin-top: 6px; padding: 7px; font-size: 12px; color: #cdd6e0;
      background: #222a35; border: 1px solid #39424f; border-radius: 7px; cursor: pointer; }
    #hbbox .badge { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 11px;
      border: 1px solid #39424f; background: #222a35; }
    #hbbox .badge.on { background: #1f5f43; border-color: #2f8f66; color: #d9ffee; }
    #hbbox .badge.off { background: #5a2a2a; border-color: #8f4444; color: #ffe4e4; }
    #hbbox ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: #b6c0cd; line-height: 1.7; }
    /* 状態表示は常に 1 行ぶんの高さを確保する（出現でレイアウトが動かないように） */
    #hbbox .statusline { min-height: 34px; display: flex; align-items: center; justify-content: center;
      padding: 0 14px; font-size: 13px; background: rgba(6,9,14,0.72); border-bottom: 1px solid #1c2330;
      position: absolute; top: 0; left: 0; right: 0; z-index: 4; text-align: center; }
    #hbbox .statusline.info { color: #9fb0c4; }
    #hbbox .statusline.warn { color: #ffd479; }
    #hbbox .statusline.err  { color: #ff9a9a; }
    #hbbox .overlay { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center;
      justify-content: center; background: rgba(5,7,10,0.72); backdrop-filter: blur(3px); }
    #hbbox .overlay.hidden { display: none; }
    #hbbox .card { background: rgba(14,18,26,0.96); border: 1px solid #2a313c; border-radius: 14px;
      padding: 22px 26px; text-align: center; max-width: 460px; }
    #hbbox .card h1 { margin: 0 0 6px; font-size: 26px; }
    #hbbox .card p { margin: 6px 0; font-size: 13px; color: #b6c0cd; line-height: 1.7; }
    #hbbox .card .actions { display: flex; gap: 8px; justify-content: center; margin-top: 14px; }
    #hbbox .card button { padding: 9px 18px; font-size: 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid #39424f; background: #222a35; color: #cdd6e0; }
    #hbbox .card button.primary { width: auto; margin: 0; border: 0; background: #7c5cff; color: #fff; }
    #hbbox .gestures { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; gap: 6px; }
    #hbbox .gi { min-width: 44px; text-align: center; padding: 5px 7px; border-radius: 8px; font-size: 15px;
      background: rgba(10,13,18,0.7); border: 1px solid #2a313c; color: #55606e; }
    #hbbox .gi.on { background: #7c5cff; border-color: #a893ff; color: #fff; }
  </style>
  <div class="stage" id="stage">
    <video id="cam" playsinline muted></video>
    <canvas id="cv"></canvas>
    <div class="statusline info" id="status">初期化中…</div>
    <div class="gestures">
      <div class="gi" id="gi_l" title="左パンチ">🥊L</div>
      <div class="gi" id="gi_r" title="右パンチ">R🥊</div>
      <div class="gi" id="gi_b" title="ガード">🛡</div>
      <div class="gi" id="gi_lean" title="リーン">↔</div>
      <div class="gi" id="gi_duck" title="ダック">⬇</div>
    </div>
    <div class="overlay" id="overlay">
      <div class="card" id="card"></div>
    </div>
  </div>
  <div class="panel">
    <h2>🥊 触覚ボクシング</h2>
    <div class="group-title">モダリティ</div>
    <label class="row"><input type="checkbox" id="m_audio" checked> 👂 音</label>
    <label class="row"><input type="checkbox" id="m_haptic" checked> ✋ 触覚</label>

    <div class="group-title">表示</div>
    <label class="row"><input type="checkbox" id="m_skel"> 🦴 骨格デバッグ表示</label>

    <div class="group-title">状態</div>
    <div class="row">Helper: <span id="conn" class="badge off">未接続</span></div>
    <div class="row">推論: <span id="delegate" class="badge off">未初期化</span></div>

    <button class="primary" id="startBtn" disabled>準備中…</button>
    <button class="ghost" id="recalBtn">構えを取り直す</button>
    <button class="ghost" id="testBtn">触覚テスト</button>
    <button class="ghost" id="menuBtn">← デモ一覧へ</button>

    <div class="group-title">操作</div>
    <ul>
      <li><b>パンチ</b>: 手をカメラへ突き出す（左右別）</li>
      <li><b>ガード</b>: 両手を顔の前に上げる</li>
      <li><b>回避</b>: 上体を左右に倒す／しゃがむ</li>
      <li>敵のグローブが<b>光ったら予告</b>。フック＝逆側へリーン、ストレート＝ダック。ガードは全部止まる</li>
      <li>予告中・硬直中の敵は<b>隙</b>。そこに打つと大ダメージ</li>
    </ul>
  </div>
`;
document.body.style.margin = "0";
document.body.appendChild(root);

const stage = root.querySelector("#stage");
const video = root.querySelector("#cam");
const canvas = root.querySelector("#cv");
const ctx = canvas.getContext("2d");
const statusEl = root.querySelector("#status");
const overlay = root.querySelector("#overlay");
const card = root.querySelector("#card");
const connEl = root.querySelector("#conn");
const delegateEl = root.querySelector("#delegate");
const startBtn = root.querySelector("#startBtn");
const gi = {
  l: root.querySelector("#gi_l"), r: root.querySelector("#gi_r"), b: root.querySelector("#gi_b"),
  lean: root.querySelector("#gi_lean"), duck: root.querySelector("#gi_duck"),
};

let showSkeleton = false;
root.querySelector("#m_skel").onchange = (e) => { showSkeleton = e.target.checked; };
root.querySelector("#m_audio").onchange = (e) => bridge.setMaster("audio", e.target.checked);
root.querySelector("#m_haptic").onchange = (e) => bridge.setMaster("haptic", e.target.checked);
root.querySelector("#testBtn").onclick = () => { unlockAudio(); bridge.testHaptic(); };
root.querySelector("#menuBtn").onclick = () => { location.href = "../"; };
root.querySelector("#recalBtn").onclick = () => { gestures.recalibrate(); if (state === "FIGHT") setState("CALIB"); };
startBtn.onclick = () => startFight();

function syncConn() {
  const ok = bridgeReady && bridge.connected;
  connEl.className = "badge " + (ok ? "on" : "off");
  connEl.textContent = ok ? "接続" : "未接続(音/映像のみ)";
}
bridge.onChange(syncConn);

/** 状態行。常に 1 行ぶんの高さがあるので、書き換えてもレイアウトは動かない。 */
function setStatus(text, kind = "info") {
  statusEl.className = `statusline ${kind}`;
  statusEl.textContent = text;
}

function unlockAudio() {
  bridge.unlockAudio();
  if (actx.state === "suspended") actx.resume();
}

// ── pose / gesture ───────────────────────────────────────────────────────────
const pose = new PoseTracker();
const gestures = new GestureTracker(TUNING);
const fx = new Fx();

// ── ゲーム状態 ────────────────────────────────────────────────────────────────
let state = "LOADING"; // LOADING | TITLE | CALIB | FIGHT | RESULT
let playerHp = GAME.playerHp, enemyHp = GAME.enemyHp;
let timeLeft = GAME.roundSec, score = 0, combo = 0, bestCombo = 0;
let elapsed = 0;             // FIGHT 経過秒（難易度ランプに使う）
let hitstopUntil = 0;        // ヒットストップ終了時刻[ms]
let slowMoUntil = 0;         // KO スローモー終了時刻[ms]
let flash = 0;               // 被弾フラッシュ 0..1
let lastGesture = { punchL: false, punchR: false, block: false, lean: 0, duck: false, visible: false, calibrated: false };

/** 敵。position は画面幅比（0..1）で持ち、描画時に px へ。 */
const enemy = { phase: "idle", until: 0, attack: null, guard: true, hurt: 0 };

function pickAttack() {
  const w = GAME.attackWeights;
  const total = w.hookLeft + w.hookRight + w.straight;
  let r = Math.random() * total;
  if ((r -= w.hookLeft) < 0) return { kind: "hook", side: -1 };   // 画面左から来る＝プレイヤーの左
  if ((r -= w.hookRight) < 0) return { kind: "hook", side: 1 };
  return { kind: "straight", side: 0 };
}

/** 難易度ランプ 0..1（時間経過で 1 に近づく）。 */
function ramp() { return clamp(elapsed / GAME.rampSec, 0, 1); }
function telegraphMs() { return lerp(GAME.telegraphMs[0], GAME.telegraphMs[1], ramp()); }
function idleGapMs() { return lerp(GAME.idleGapMs[0], GAME.idleGapMs[1], ramp()); }

function setEnemyPhase(phase, durMs, nowMs) {
  enemy.phase = phase;
  enemy.until = nowMs + durMs;
}

function updateEnemy(nowMs) {
  if (nowMs < enemy.until) return;
  switch (enemy.phase) {
    case "idle":
      enemy.attack = pickAttack();
      setEnemyPhase("telegraph", telegraphMs(), nowMs);
      break;
    case "telegraph":
      setEnemyPhase("strike", GAME.strikeMs, nowMs);
      resolveStrike(enemy.attack);
      break;
    case "strike":
      setEnemyPhase("recover", GAME.recoverMs, nowMs);
      break;
    default:
      enemy.attack = null;
      setEnemyPhase("idle", idleGapMs(), nowMs);
  }
}

/** 敵の打撃が出た瞬間の判定: ガード → 正しい回避 → 被弾。 */
function resolveStrike(atk) {
  const g = lastGesture;
  const pan = clamp(atk.side * 0.7, -1, 1);
  if (g.block) {
    bridge.fire("boxing_block", { pan });
    score += GAME.score.block;
    fx.shake(5);
    setStatus("ガード成功", "info");
    return;
  }
  // フックは「来た側の逆」へリーンで回避、ストレートはダックで回避
  const dodged = atk.kind === "hook" ? g.lean === -atk.side : g.duck;
  if (dodged) {
    bridge.fire("boxing_dodge", { pan });
    score += GAME.score.dodge;
    setStatus(atk.kind === "hook" ? "回避成功（リーン）" : "回避成功（ダック）", "info");
    return;
  }
  playerHp = Math.max(0, playerHp - GAME.damage.playerHit);
  combo = 0;
  flash = 1;
  fx.shake(16);
  fx.burst(canvas.width / 2, canvas.height * 0.45, "#ff5f6d", 26);
  bridge.fire("boxing_player_hit", { pan });
  setStatus("被弾！", "warn");
  if (playerHp <= 0) endRound("lose");
}

/** プレイヤーのパンチ。敵が予告中／硬直中なら隙＝ヒット、そうでなければガードされる。 */
function onPlayerPunch(side) {
  const pan = side === "left" ? -0.6 : 0.6;
  const open = enemy.phase === "telegraph" || enemy.phase === "recover";
  const x = canvas.width * (0.5 + (side === "left" ? -0.1 : 0.1));
  if (open) {
    enemyHp = Math.max(0, enemyHp - GAME.damage.punchHit);
    combo++;
    bestCombo = Math.max(bestCombo, combo);
    score += GAME.score.punchHit + (combo > 1 ? combo * GAME.score.comboBonus : 0);
    enemy.hurt = 1;
    hitstopUntil = performance.now() + GAME.hitstopMs;
    fx.shake(10);
    fx.burst(x, canvas.height * 0.4, "#ffd479", 22);
    bridge.fire("boxing_punch_hit", { pan });
    setStatus(combo > 1 ? `ヒット！ ${combo} コンボ` : "ヒット！", "info");
    if (enemyHp <= 0) endRound("ko");
  } else {
    enemyHp = Math.max(0, enemyHp - GAME.damage.punchBlocked);
    bridge.fire("boxing_punch_blocked", { pan });
    score += GAME.score.punchBlocked;
    fx.burst(x, canvas.height * 0.4, "#8b97a6", 8, 120);
    setStatus("ガードされた", "info");
  }
}

// ── ラウンド進行 ─────────────────────────────────────────────────────────────
function setState(next) {
  state = next;
  if (next === "TITLE") {
    showCard(`
      <h1>🥊 触覚ボクシング</h1>
      <p>カメラの前に立って、パンチ・ガード・回避で戦う。<br>
      当たった／受けた／かわしたの違いは <b>触覚</b> で返る。</p>
      <p style="color:#8b97a6">全身が映るように、1.5〜2m ほど離れて立ってください。</p>
      <div class="actions"><button class="primary" id="cardStart">スタート（Space）</button></div>`);
    card.querySelector("#cardStart").onclick = () => startFight();
    setStatus("スタートを押すと構えの計測（約 1.5 秒）が始まります", "info");
  } else if (next === "CALIB") {
    hideCard();
    gestures.recalibrate();
    setStatus("フレーム内に立って構えてください…", "info");
  } else if (next === "FIGHT") {
    hideCard();
    // 計測にかかった時間ぶん敵を待たせる（開始と同時にいきなり殴られないように）
    enemy.phase = "idle"; enemy.attack = null;
    enemy.until = performance.now() + GAME.idleGapMs[0];
    bridge.fire("boxing_bell");
    setStatus("ラウンド開始！", "info");
  }
}

function startFight() {
  if (!pose.ready) return;
  unlockAudio();
  playerHp = GAME.playerHp; enemyHp = GAME.enemyHp;
  timeLeft = GAME.roundSec; score = 0; combo = 0; bestCombo = 0; elapsed = 0;
  flash = 0; hitstopUntil = 0; slowMoUntil = 0;
  enemy.phase = "idle"; enemy.until = performance.now() + GAME.idleGapMs[0]; enemy.attack = null; enemy.hurt = 0;
  setState("CALIB");
}

function endRound(result) {
  if (state === "RESULT") return;
  state = "RESULT";
  const ko = result === "ko";
  if (ko) {
    bridge.fire("boxing_ko");
    slowMoUntil = performance.now() + GAME.koSlowMo.durationMs;
    fx.shake(24);
    fx.burst(canvas.width / 2, canvas.height * 0.4, "#7c5cff", 48, 320);
  } else {
    bridge.fire("boxing_bell");
  }
  const title = ko ? "KO 勝ち！" : result === "lose" ? "ダウン…" : playerHp >= enemyHp ? "判定勝ち" : "判定負け";
  setStatus("ラウンド終了", "info");
  setTimeout(() => {
    showCard(`
      <h1>${title}</h1>
      <p>スコア <b>${score}</b> ・ 最大コンボ <b>${bestCombo}</b><br>
      自分 HP ${Math.round(playerHp)} ／ 相手 HP ${Math.round(enemyHp)}</p>
      <div class="actions">
        <button class="primary" id="again">もう一度（Enter）</button>
        <button id="toMenu">メニュー（Esc）</button>
      </div>`);
    card.querySelector("#again").onclick = () => startFight();
    card.querySelector("#toMenu").onclick = () => { location.href = "../"; };
  }, ko ? GAME.koSlowMo.durationMs : 300);
}

function showCard(html) { card.innerHTML = html; overlay.classList.remove("hidden"); }
function hideCard() { overlay.classList.add("hidden"); }

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && (state === "TITLE" || state === "RESULT")) { e.preventDefault(); startFight(); }
  else if (e.code === "Enter" && state === "RESULT") { e.preventDefault(); startFight(); }
  else if (e.code === "Escape" && state === "RESULT") { e.preventDefault(); location.href = "../"; }
});

// ── 描画 ─────────────────────────────────────────────────────────────────────
function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}
window.addEventListener("resize", resize);

/** 敵（頭 + 胴 + グローブ 2 つ）のスタイライズ描画。状態で色と位置が変わる。 */
function drawEnemy(nowMs) {
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H * 0.42;
  const s = Math.min(W, H) / 620; // 画面サイズに対するスケール
  const phase = enemy.phase;
  const atk = enemy.attack;
  const tel = phase === "telegraph";
  const strike = phase === "strike";
  const recover = phase === "recover";
  const prog = tel ? clamp(1 - (enemy.until - nowMs) / telegraphMs(), 0, 1) : 0;

  ctx.save();
  ctx.globalAlpha = 0.9;
  // 胴
  ctx.fillStyle = recover ? "#3a2f4a" : "#2b3444";
  ctx.beginPath();
  ctx.roundRect(cx - 110 * s, cy + 40 * s, 220 * s, 210 * s, 40 * s);
  ctx.fill();
  // 頭
  ctx.fillStyle = enemy.hurt > 0 ? "#a35b5b" : "#38445a";
  ctx.beginPath();
  ctx.arc(cx, cy - 20 * s, 62 * s, 0, Math.PI * 2);
  ctx.fill();
  // 隙（予告中・硬直中）を輪郭で示す
  if (tel || recover) {
    ctx.strokeStyle = recover ? "rgba(255,212,121,0.85)" : "rgba(124,92,255,0.7)";
    ctx.lineWidth = 4 * s;
    ctx.stroke();
  }

  // グローブ。予告中は攻撃側を引いて光らせ、打撃でこちらへ伸びる。
  const gloveR = 34 * s;
  for (const side of [-1, 1]) {
    const active = atk && (atk.kind === "straight" || atk.side === side);
    let gx = cx + side * 92 * s;
    let gy = cy + 74 * s;
    let r = gloveR;
    if (active && tel) { gx += side * 26 * s * prog; gy -= 26 * s * prog; }
    if (active && strike) {
      gx = cx + (atk.kind === "hook" ? atk.side * 150 * s : side * 40 * s);
      gy = cy + (atk.kind === "straight" ? 10 * s : 30 * s);
      r = gloveR * 1.5; // こちらへ迫る＝大きく見える
    }
    ctx.fillStyle = active && (tel || strike) ? (strike ? "#ff5f6d" : `rgba(255,${Math.round(190 - 90 * prog)},80,${0.55 + 0.45 * prog})`) : "#d24a4a";
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
    if (active && tel) { // 予告のリング
      ctx.strokeStyle = "rgba(255,212,121,0.9)";
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.arc(gx, gy, r + (10 + 14 * (1 - prog)) * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // 予告テキスト（何が来るか分かる＝反応ゲームとして成立させる）
  if (tel && atk) {
    ctx.save();
    ctx.font = `bold ${Math.round(26 * s * 1.4)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,212,121,0.95)";
    const label = atk.kind === "straight" ? "ストレート → ダック / ガード"
      : atk.side === -1 ? "左フック → 右へリーン / ガード" : "右フック → 左へリーン / ガード";
    ctx.fillText(label, cx, cy - 110 * s);
    ctx.restore();
  }
}

function drawHud() {
  const W = canvas.width, H = canvas.height;
  const s = Math.min(W, H) / 620;
  const barW = W * 0.32, barH = 16 * s, y = 46 * s;
  const bar = (x, ratio, color, label) => {
    ctx.fillStyle = "rgba(10,13,18,0.72)";
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, barW * clamp(ratio, 0, 1), barH);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1.5 * s;
    ctx.strokeRect(x, y, barW, barH);
    ctx.fillStyle = "#e6edf3";
    ctx.font = `bold ${Math.round(13 * s * 1.3)}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(label, x, y - 6 * s);
  };
  bar(W * 0.06, playerHp / GAME.playerHp, "#4cc38a", "YOU");
  bar(W - W * 0.06 - barW, enemyHp / GAME.enemyHp, "#ff5f6d", "ENEMY");

  ctx.textAlign = "center";
  ctx.fillStyle = "#e6edf3";
  ctx.font = `bold ${Math.round(30 * s * 1.2)}px system-ui, sans-serif`;
  ctx.fillText(String(Math.ceil(Math.max(0, timeLeft))), W / 2, y + barH);
  ctx.font = `${Math.round(14 * s * 1.2)}px system-ui, sans-serif`;
  ctx.fillStyle = "#b6c0cd";
  ctx.fillText(`SCORE ${score}${combo > 1 ? `   ${combo} COMBO` : ""}`, W / 2, y + barH + 26 * s);
}

function drawSkeleton(landmarks) {
  if (!landmarks) return;
  const W = canvas.width, H = canvas.height;
  const px = (lm) => ({ x: (1 - lm.x) * W, y: lm.y * H }); // ミラー
  ctx.save();
  ctx.strokeStyle = "rgba(124,92,255,0.85)";
  ctx.lineWidth = Math.max(2, W / 400);
  for (const [a, b] of SKELETON) {
    const p1 = landmarks[a], p2 = landmarks[b];
    if (!p1 || !p2) continue;
    const q1 = px(p1), q2 = px(p2);
    ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
  }
  ctx.fillStyle = "#ffd479";
  for (const lm of landmarks) {
    const q = px(lm);
    ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(2.5, W / 320), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function syncGestureIcons(g) {
  gi.l.classList.toggle("on", g.punchL);
  gi.r.classList.toggle("on", g.punchR);
  gi.b.classList.toggle("on", g.block);
  gi.lean.classList.toggle("on", g.lean !== 0);
  gi.lean.textContent = g.lean === -1 ? "◀" : g.lean === 1 ? "▶" : "↔";
  gi.duck.classList.toggle("on", g.duck);
}

// ── メインループ ─────────────────────────────────────────────────────────────
let lastMs = performance.now();
let punchIconUntil = { l: 0, r: 0 };

function frame(nowMs) {
  requestAnimationFrame(frame);
  const rawDt = clamp((nowMs - lastMs) / 1000, 0, 0.1);
  lastMs = nowMs;
  const slow = nowMs < slowMoUntil ? GAME.koSlowMo.timeScale : 1;
  const stopped = nowMs < hitstopUntil;
  const dt = stopped ? 0 : rawDt * slow;

  if (canvas.width !== Math.round(stage.clientWidth * Math.min(window.devicePixelRatio || 1, 2))) resize();

  // ── 姿勢推定 → ジェスチャー ──
  const result = pose.ready ? pose.detect(nowMs) : null;
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  const g = gestures.update(result, nowMs, rawDt, { aspect, calibrating: state === "CALIB" });
  lastGesture = g;
  if (g.punchL) punchIconUntil.l = nowMs + 180;
  if (g.punchR) punchIconUntil.r = nowMs + 180;
  syncGestureIcons({ ...g, punchL: nowMs < punchIconUntil.l, punchR: nowMs < punchIconUntil.r });

  // ── 状態遷移 ──
  if (state === "CALIB") {
    if (!g.visible) setStatus("全身がフレームに入るように立ってください", "warn");
    else {
      setStatus(`構えを計測中… ${Math.round(gestures.calibProgress * 100)}%`, "info");
      if (gestures.calibProgress >= 1) setState("FIGHT");
    }
  } else if (state === "FIGHT") {
    elapsed += dt;
    timeLeft -= dt;
    if (!g.visible && pose.ready) setStatus("姿勢を見失いました — フレーム内に戻ってください", "warn");
    if (g.punchL) onPlayerPunch("left");
    if (g.punchR) onPlayerPunch("right");
    if (state === "FIGHT") updateEnemy(nowMs);   // KO/ダウンで RESULT に移っていたら回さない
    if (state === "FIGHT" && timeLeft <= 0) endRound("time");
  }

  // ── 描画 ──
  fx.update(rawDt);
  enemy.hurt = Math.max(0, enemy.hurt - rawDt * 4);
  flash = Math.max(0, flash - rawDt * 3);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  fx.apply(ctx);
  if (state === "FIGHT" || state === "RESULT") drawEnemy(nowMs);
  fx.restore(ctx);
  fx.draw(ctx);
  if (showSkeleton) drawSkeleton(result?.landmarks);
  if (state === "FIGHT" || state === "RESULT") drawHud();
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,60,72,${0.35 * flash})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ── 起動 ─────────────────────────────────────────────────────────────────────
(async function boot() {
  resize();
  requestAnimationFrame(frame);
  setStatus("カメラと姿勢推定モデルを準備中…", "info");
  const ok = await pose.start(video, { width: 640, height: 480 });
  if (!ok) {
    setStatus(pose.error, "err");
    delegateEl.className = "badge off";
    delegateEl.textContent = "失敗";
    startBtn.textContent = "開始できません";
    showCard(`
      <h1>🥊 触覚ボクシング</h1>
      <p style="color:#ff9a9a">${pose.error}</p>
      <p>カメラを許可して再読み込みするか、別のブラウザ（Chrome / Edge 推奨）で開いてください。</p>
      <div class="actions"><button id="toMenu">メニュー</button></div>`);
    card.querySelector("#toMenu").onclick = () => { location.href = "../"; };
    return;
  }
  delegateEl.className = "badge on";
  delegateEl.textContent = pose.delegate;
  startBtn.disabled = false;
  startBtn.textContent = "スタート / リスタート";
  setState("TITLE");
})();
