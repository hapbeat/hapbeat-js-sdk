/**
 * 触覚ボクシング — カメラ（MediaPipe Pose）で全身を使って戦う Hapbeat デモ。
 *
 * コントローラを持たない＝手はふさがっていない。だから「当たった / 受けた / かわした」の
 * 区別は画面ではなく体で返す必要がある、という触覚が主役になる題材。
 *
 * ── 攻防は全部「位置」で決まる（テキストの予告・指示は出さない） ──────────────
 *   ガード … 敵のグローブが自分のグローブ / 前腕に当たれば成立（ジェスチャー判定ではない）
 *   回避   … 上体を振ると頭の当たり判定球が動く。グローブが当たらなければ空振り
 *   攻撃   … 自分のグローブ球が敵の頭 / 胴に入ればヒット。敵のガードに当たれば弾かれる
 * 敵の攻撃はグローブが**ゆっくり近づいてくる**こと自体が予告。文字は出さない。
 *
 * 表示は背後やや上の 3D（scene3d.js）。実カメラ映像はトラッキング入力にだけ使い、
 * 確認用のデバッグ PIP でのみ小窓表示する。位置の算出は combat.js（純関数）に集約していて、
 * 判定と描画が同じ値を使うので「見えている位置＝当たる位置」になる。
 *
 * 触覚・音は shared/hapbeat-bridge.js + shared/content-router.js 経由（fps デモと同じ）。
 * helper 未起動でも音と映像だけで最後まで遊べる。
 *
 * HTTP 配信で開く: http://localhost:8170/examples/games/boxing/
 */

import { ArcadeBridge } from "../shared/hapbeat-bridge.js";
import { ContentRouter } from "../shared/content-router.js";
import { Fx } from "../shared/fx.js";
import { PoseTracker, SKELETON, HAND_CONNECTIONS } from "./pose.js";
import { GestureTracker } from "./gestures.js";
import { TUNING, COMBAT, GAME } from "./tuning.js";
import { buildPlayerPose, attackPathT, enemyGlovePos, resolveEnemyGlove, resolvePlayerGlove, v3, dist } from "./combat.js";

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
bridge.attachRouter(router);
router.attachAudio(actx, masterGain);
router.load({
  eventmapUrl: "eventmap.json",
  manifestUrl: "../demo-kit/fps-kit/fps-kit-manifest.json", // ボクシング専用 Kit は未作成 → fps-kit を流用
  clipBase: "../demo-kit/fps-kit/stream-clips/",
});
router.loadAudioFiles("../");
bridge.init({ appName: "HapbeatBoxing", audioBase: "../" }).then(() => { bridgeReady = true; syncConn(); });

// ── DOM（3D は全画面。設定は隅の歯車に畳む） ──────────────────────────────────
const root = document.createElement("div");
root.id = "hbbox";
root.innerHTML = `
  <style>
    #hbbox { position: fixed; inset: 0; font-family: system-ui, sans-serif; color: #e6edf3;
      background: #070a10; overflow: hidden; }
    /* 実カメラ映像はメイン表示しない。display:none だとフレームが更新されないブラウザがあるので
       極小・不可視でレイアウト外に置いて再生だけ維持する。 */
    #hbbox video { position: absolute; width: 2px; height: 2px; left: 0; bottom: 0; opacity: 0.01; pointer-events: none; }
    #hbbox canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    #hbbox canvas#hud { pointer-events: none; }
    #hbbox .vignette { position: absolute; inset: 0; z-index: 3; pointer-events: none; opacity: 0;
      background: radial-gradient(ellipse at center, rgba(255,40,52,0) 35%, rgba(255,40,52,0.85) 100%); }
    /* 歯車メニュー（右上）。開閉してもレイアウトは動かない（オーバーレイ） */
    #hbbox .gear { position: absolute; top: 12px; right: 12px; z-index: 7; width: 38px; height: 38px;
      border-radius: 10px; border: 1px solid #39424f; background: rgba(10,13,18,0.8); color: #cdd6e0;
      font-size: 18px; cursor: pointer; }
    #hbbox .gear:hover { background: rgba(28,34,44,0.9); }
    #hbbox .menu { position: absolute; top: 58px; right: 12px; z-index: 7; width: 232px; padding: 10px 12px;
      background: rgba(10,13,18,0.94); border: 1px solid #2a313c; border-radius: 12px; }
    #hbbox .menu.hidden { display: none; }
    #hbbox .menu .t { font-size: 10px; color: #8b97a6; text-transform: uppercase; letter-spacing: .06em; margin: 8px 0 3px; }
    #hbbox .menu label { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12.5px; cursor: pointer; }
    #hbbox .menu input[type=checkbox] { width: 15px; height: 15px; accent-color: #7c5cff; }
    #hbbox .menu button { width: 100%; margin-top: 5px; padding: 6px; font-size: 12px; color: #cdd6e0;
      background: #222a35; border: 1px solid #39424f; border-radius: 7px; cursor: pointer; }
    #hbbox .badge { display: inline-block; padding: 1px 6px; border-radius: 6px; font-size: 10.5px;
      border: 1px solid #39424f; background: #222a35; }
    #hbbox .badge.on { background: #1f5f43; border-color: #2f8f66; color: #d9ffee; }
    #hbbox .badge.off { background: #5a2a2a; border-color: #8f4444; color: #ffe4e4; }
    /* 状態行は常に 1 行ぶんの高さを確保（出し入れでレイアウトが動かない）。
       ラウンド中は姿勢ロスト警告以外は出さない＝ゲーム中の説明テキストは無し。 */
    #hbbox .statusline { position: absolute; top: 0; left: 0; right: 0; z-index: 4; min-height: 30px;
      display: flex; align-items: center; justify-content: center; font-size: 12.5px; text-align: center;
      padding: 0 60px; color: #9fb0c4; }
    #hbbox .statusline.warn { color: #ffd479; }
    #hbbox .statusline.err  { color: #ff9a9a; }
    #hbbox .overlay { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center;
      justify-content: center; background: rgba(5,7,10,0.72); backdrop-filter: blur(3px); }
    #hbbox .overlay.hidden { display: none; }
    #hbbox .card { background: rgba(14,18,26,0.96); border: 1px solid #2a313c; border-radius: 14px;
      padding: 24px 28px; text-align: center; max-width: 520px; }
    #hbbox .card h1 { margin: 0 0 8px; font-size: 28px; }
    #hbbox .card p { margin: 6px 0; font-size: 13.5px; color: #b6c0cd; line-height: 1.8; }
    #hbbox .card .actions { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
    #hbbox .card button { padding: 10px 20px; font-size: 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid #39424f; background: #222a35; color: #cdd6e0; }
    #hbbox .card button.primary { border: 0; background: #7c5cff; color: #fff; font-weight: 600; }
  </style>
  <video id="cam" playsinline muted></video>
  <canvas id="gl"></canvas>
  <canvas id="hud"></canvas>
  <div class="vignette" id="vignette"></div>
  <div class="statusline" id="status">初期化中…</div>
  <button class="gear" id="gear" title="設定">⚙</button>
  <div class="menu hidden" id="menu">
    <div class="t">モダリティ</div>
    <label><input type="checkbox" id="m_audio" checked> 👂 音</label>
    <label><input type="checkbox" id="m_haptic" checked> ✋ 触覚</label>
    <div class="t">表示</div>
    <label><input type="checkbox" id="m_third" checked> 🎥 背後視点（OFF＝一人称）</label>
    <label><input type="checkbox" id="m_pip" checked> 🦴 カメラ+骨格（PIP）</label>
    <label><input type="checkbox" id="m_dbg"> 🎯 当たり判定を表示</label>
    <div class="t">状態</div>
    <div style="font-size:12px;margin:4px 0">Helper: <span id="conn" class="badge off">未接続</span></div>
    <div style="font-size:12px;margin:4px 0">推論: <span id="delegate" class="badge off">未初期化</span></div>
    <button id="recalBtn">構えを取り直す</button>
    <button id="testBtn">触覚テスト</button>
    <button id="menuBtn">← デモ一覧へ</button>
  </div>
  <div class="overlay" id="overlay"><div class="card" id="card"></div></div>
`;
document.body.style.margin = "0";
document.body.appendChild(root);

const video = root.querySelector("#cam");
const glCanvas = root.querySelector("#gl");
const hudCanvas = root.querySelector("#hud");
const ctx = hudCanvas.getContext("2d");
const vignetteEl = root.querySelector("#vignette");
const statusEl = root.querySelector("#status");
const overlay = root.querySelector("#overlay");
const card = root.querySelector("#card");
const connEl = root.querySelector("#conn");
const delegateEl = root.querySelector("#delegate");
const menuEl = root.querySelector("#menu");

let pipOn = true, debugOn = false;
root.querySelector("#gear").onclick = () => menuEl.classList.toggle("hidden");
root.querySelector("#m_pip").onchange = (e) => { pipOn = e.target.checked; };
root.querySelector("#m_dbg").onchange = (e) => { debugOn = e.target.checked; scene?.setDebug(debugOn); };
root.querySelector("#m_third").onchange = (e) => scene?.setCameraMode(e.target.checked ? "third" : "first");
root.querySelector("#m_audio").onchange = (e) => bridge.setMaster("audio", e.target.checked);
root.querySelector("#m_haptic").onchange = (e) => bridge.setMaster("haptic", e.target.checked);
root.querySelector("#testBtn").onclick = () => { unlockAudio(); bridge.testHaptic(); };
root.querySelector("#menuBtn").onclick = () => { location.href = "../"; };
root.querySelector("#recalBtn").onclick = () => { gestures.recalibrate(); if (state === "FIGHT") setState("CALIB"); };

function syncConn() {
  const ok = bridgeReady && bridge.connected;
  connEl.className = "badge " + (ok ? "on" : "off");
  connEl.textContent = ok ? "接続" : "未接続(音/映像のみ)";
}
bridge.onChange(syncConn);

/** 状態行。ラウンド中は姿勢ロスト以外を出さない（ゲーム中の説明テキストは無し）。 */
function setStatus(text, kind = "") {
  statusEl.className = "statusline " + kind;
  statusEl.textContent = text;
}
/** 検証用: URL に ?mute=1 で音を完全に止める（触覚と映像だけで通し確認する時に使う）。 */
const MUTED = new URLSearchParams(location.search).get("mute") === "1";
function unlockAudio() {
  if (MUTED) return;
  bridge.unlockAudio();
  if (actx.state === "suspended") actx.resume();
}
if (MUTED) {
  bridge.setMaster("audio", false);
  root.querySelector("#m_audio").checked = false;
}

// ── pose / gesture / 3D ──────────────────────────────────────────────────────
const pose = new PoseTracker();
const gestures = new GestureTracker(TUNING);
const fx = new Fx();
let scene = null;

// ── ゲーム状態 ────────────────────────────────────────────────────────────────
let state = "LOADING"; // LOADING | TITLE | CALIB | FIGHT | RESULT
let playerHp = GAME.playerHp, enemyHp = GAME.enemyHp;
let timeLeft = GAME.roundSec, score = 0, combo = 0, bestCombo = 0;
let elapsed = 0, hitstopUntil = 0, slowMoUntil = 0, flash = 0, enemyHurt = 0;
let playerPose = null;      // combat.buildPlayerPose の結果（判定・描画で共用）
let gestureArms = null;     // gestures の arms（スイング中かの参照用）
let resetAtMs = 0;          // テストモードの自動回復時刻
let lastDebug = null;       // 判定デバッグのプロット用

/** 敵。idle → attack（接近→打撃→戻り）。攻撃中はガードが開く＝頭を狙える。 */
const enemy = {
  phase: "idle",       // "idle" | "approach" | "strike" | "retract"
  nextAtMs: 0,
  startedMs: 0,
  attack: null,        // { kind, side, hand }
  from: v3(), aim: v3(),
  glove: { left: v3(), right: v3() },
  resolved: false,
  minHeadDist: Infinity,
};
/** プレイヤーの手ごとの接触状態（1 スイング 1 回にするための立ち上がり検出）。 */
const punchContact = { left: { on: false, lastMs: -1e9 }, right: { on: false, lastMs: -1e9 } };

function ramp() { return clamp(elapsed / GAME.rampSec, 0, 1); }
function approachMs() { return lerp(COMBAT.attack.approachMs[0], COMBAT.attack.approachMs[1], ramp()); }
function idleGapMs() { return lerp(GAME.idleGapMs[0], GAME.idleGapMs[1], ramp()); }
function attackCfg() { return { ...COMBAT.attack, approachMs: approachMs() }; }

const enemyHeadPos = () => v3(0, COMBAT.enemy.headY, -COMBAT.enemyDist);
/** 敵グローブの構え位置（ガード時は頭の前、開いている時は下がる）。 */
function enemyGuardPos(side, open) {
  const h = enemyHeadPos();
  const g = open ? COMBAT.enemy.open : COMBAT.enemy.guard;
  const sign = side === "left" ? -1 : 1;
  return v3(h.x + sign * g.x, h.y + g.y, h.z + g.z);
}

/** 経路（フック/ストレート）・使う腕・狙う場所（頭/胴）をそれぞれランダムに決める。 */
function pickAttack() {
  const w = GAME.attackWeights;
  let r = Math.random() * (w.hookLeft + w.hookRight + w.straight);
  let path;
  if ((r -= w.hookLeft) < 0) path = { kind: "hook", side: -1, hand: "left" };
  else if ((r -= w.hookRight) < 0) path = { kind: "hook", side: 1, hand: "right" };
  else path = { kind: "straight", side: 0, hand: Math.random() < 0.5 ? "left" : "right" };
  const t = COMBAT.attack.aimTarget;
  path.target = Math.random() * (t.head + t.torso) < t.head ? "head" : "torso";
  return path;
}

/** 狙点（攻撃開始時に固定する）。胴狙いは胸〜腹あたり。 */
function aimPoint(atk) {
  const pose = playerPose;
  if (!pose) return v3();
  if (atk.target === "torso" && pose.torsoTop) {
    const f = COMBAT.attack.torsoAimFrac;
    return v3(pose.torsoTop.x, pose.torsoTop.y + (pose.torsoBottom.y - pose.torsoTop.y) * f, pose.torsoTop.z);
  }
  return pose.head;
}

function startAttack(nowMs) {
  const atk = pickAttack();
  const j = COMBAT.attack.aimJitter;
  enemy.attack = atk;
  enemy.startedMs = nowMs;
  enemy.from = enemyGuardPos(atk.hand, false);
  // 狙点は「攻撃を始めた瞬間」の頭 / 胴の位置に固定する＝あとから体を振れば避けられる
  const t = aimPoint(atk);
  enemy.aim = v3(t.x + (Math.random() * 2 - 1) * j, t.y + (Math.random() * 2 - 1) * j, t.z);
  enemy.resolved = false;
  enemy.minHeadDist = Infinity;
  enemy.phase = "approach";
}

/** 敵の攻撃を 1 フレーム進め、位置ベースで ガード / 被弾 / 空振り を判定する。 */
function updateEnemy(nowMs) {
  const cfg = attackCfg();
  if (enemy.phase === "idle") {
    for (const side of ["left", "right"]) enemy.glove[side] = enemyGuardPos(side, false);
    if (nowMs >= enemy.nextAtMs) startAttack(nowMs);
    return;
  }
  const { s, phase } = attackPathT(nowMs - enemy.startedMs, cfg);
  enemy.phase = phase === "done" ? "idle" : phase;
  if (phase === "done") {
    // 当たらずに終わった: 頭のすぐ横を通っていれば「かわした」
    if (!enemy.resolved && enemy.minHeadDist < cfg.dodgeNear) onDodge();
    enemy.attack = null;
    enemy.nextAtMs = nowMs + idleGapMs();
    return;
  }
  const hand = enemy.attack.hand;
  const other = hand === "left" ? "right" : "left";
  enemy.glove[hand] = enemyGlovePos(enemy.from, enemy.aim, s, enemy.attack, cfg);
  enemy.glove[other] = enemyGuardPos(other, true); // 攻撃中は反対の手も下がる＝隙

  if (!playerPose || enemy.resolved) return;
  enemy.minHeadDist = Math.min(enemy.minHeadDist, dist(enemy.glove[hand], playerPose.head));
  const hit = resolveEnemyGlove(enemy.glove[hand], COMBAT.enemy.gloveRadius, playerPose, COMBAT);
  if (hit === "block") { enemy.resolved = true; onBlock(); retractNow(nowMs, cfg); }
  else if (hit) { enemy.resolved = true; onPlayerHit(hit); retractNow(nowMs, cfg); }
}

/** 判定が付いたら残りの接近をやめて戻りに入る（当たった後も突き進むと不自然）。 */
function retractNow(nowMs, cfg) {
  enemy.startedMs = nowMs - (cfg.approachMs + cfg.strikeMs);
}

function onBlock() {
  const pan = clamp((enemy.glove[enemy.attack.hand].x - (playerPose?.head.x ?? 0)) * 2, -1, 1);
  bridge.fire("boxing_block", { pan });
  score += GAME.score.block;
  fx.shake(6);
}
function onDodge() {
  bridge.fire("boxing_dodge", { pan: clamp(enemy.attack ? enemy.attack.side * 0.7 : 0, -1, 1) });
  score += GAME.score.dodge;
}
function onPlayerHit(where = "head") {
  const head = where === "head";
  playerHp = Math.max(0, playerHp - (head ? GAME.damage.playerHit : GAME.damage.playerBody));
  combo = 0;
  flash = head ? 1 : 0.7;
  fx.shake(head ? 18 : 12);
  fx.burst(hudCanvas.width / 2, hudCanvas.height * (head ? 0.45 : 0.55), "#ff5f6d", head ? 26 : 16);
  bridge.fire("boxing_player_hit", { pan: clamp(enemy.attack ? enemy.attack.side * 0.7 : 0, -1, 1), gain: head ? 1 : 0.7 });
  if (playerHp <= 0) onDepleted("player");
}

/**
 * プレイヤーのグローブと敵の当たり判定。交差の立ち上がりでのみ発火し、
 * 同じ手はクールダウン中は再判定しない（1 スイング 1 回）。
 */
function updatePlayerPunches(nowMs) {
  if (!playerPose) return;
  const guardUp = enemy.phase === "idle";
  const target = { head: enemyHeadPos(), gloves: enemy.glove, guardUp,
    torsoTop: v3(0, COMBAT.enemy.torsoTopY, -COMBAT.enemyDist),
    torsoBottom: v3(0, COMBAT.enemy.torsoBottomY, -COMBAT.enemyDist) };
  for (const side of ["left", "right"]) {
    const arm = playerPose[side];
    const c = punchContact[side];
    // 当たり判定は「スイング中」だけ有効。ガード中に静止して腕が伸びていても当たらない。
    const swinging = !COMBAT.punchHit.requireSwing || !!gestureArms?.[side]?.swingActive;
    const eligible = swinging && arm.reach >= COMBAT.punchHit.minReach;
    const what = eligible ? resolvePlayerGlove(arm.wrist, COMBAT.player.gloveRadius, target, COMBAT) : null;
    if (what && !c.on && nowMs - c.lastMs > COMBAT.punchHit.cooldownMs) {
      c.lastMs = nowMs;
      onPlayerPunchLanded(side, what);
    }
    c.on = !!what;
  }
}

function onPlayerPunchLanded(side, what) {
  const pan = side === "left" ? -0.6 : 0.6;
  const x = hudCanvas.width * (0.5 + (side === "left" ? -0.12 : 0.12));
  if (what === "guard") {
    enemyHp = Math.max(0, enemyHp - GAME.damage.punchBlocked);
    score += GAME.score.punchBlocked;
    bridge.fire("boxing_punch_blocked", { pan });
    fx.burst(x, hudCanvas.height * 0.42, "#8b97a6", 8, 120);
    return;
  }
  const head = what === "head";
  enemyHp = Math.max(0, enemyHp - (head ? GAME.damage.punchHead : GAME.damage.punchTorso));
  combo++;
  bestCombo = Math.max(bestCombo, combo);
  score += (head ? GAME.score.punchHead : GAME.score.punchTorso) + (combo > 1 ? combo * GAME.score.comboBonus : 0);
  enemyHurt = 1;
  hitstopUntil = performance.now() + GAME.hitstopMs;
  fx.shake(head ? 12 : 7);
  fx.burst(x, hudCanvas.height * 0.4, head ? "#ffd479" : "#c9d4e2", head ? 24 : 12);
  bridge.fire("boxing_punch_hit", { pan, gain: head ? 1 : 0.6 });
  if (enemyHp <= 0) onDepleted("enemy");
}

/**
 * HP が尽きた時。テストモードでは勝敗を出さず、短い演出のあと自動で全回復して続行する
 * （体力管理より当たり方の調整を回したいので、止まらないほうが都合がよい）。
 */
function onDepleted(who) {
  if (!GAME.testMode) { endRound(who === "enemy" ? "ko" : "lose"); return; }
  if (resetAtMs) return;
  bridge.fire(who === "enemy" ? "boxing_ko" : "boxing_player_hit", { gain: 1 });
  flash = 1;
  fx.shake(20);
  fx.burst(hudCanvas.width / 2, hudCanvas.height * 0.4, who === "enemy" ? "#7c5cff" : "#ff5f6d", 36, 300);
  if (who === "enemy") enemyHurt = 1;
  resetAtMs = performance.now() + GAME.testResetDelayMs;
}

// ── ラウンド進行 ─────────────────────────────────────────────────────────────
function setState(next) {
  state = next;
  if (next === "TITLE") {
    showCard(`
      <h1>🥊 触覚ボクシング</h1>
      <p>カメラの前に立って、体で戦う。<br>
      <b>殴る</b>＝拳をカメラへ突き出す　<b>守る</b>＝腕を頭の前に上げる　<b>避ける</b>＝上体を振る／しゃがむ</p>
      <p style="color:#8b97a6">画面は自分の背後から。青く光る球とカプセルが自分の頭と胴の当たり判定。<br>
      敵は頭か胴を狙って腕を伸ばしてくるので、腕で止めるか、体ごと動かして外す。<br>
      全身が映るように 1.5〜2m 離れて立ってください。${GAME.testMode ? "<br>（テストモード: 勝敗を出さず、体力が尽きても自動で回復して続きます）" : ""}</p>
      <div class="actions"><button class="primary" id="cardStart">スタート（Space）</button></div>`);
    card.querySelector("#cardStart").onclick = () => startFight();
    setStatus("スタートを押すと構えの計測（約 1.5 秒）が始まります");
  } else if (next === "CALIB") {
    hideCard();
    gestures.recalibrate();
    setStatus("フレーム内に立って、ボクシングの構えを取ってください…");
  } else if (next === "FIGHT") {
    hideCard();
    setStatus("");
    enemy.phase = "idle";
    enemy.attack = null;
    enemy.nextAtMs = performance.now() + GAME.idleGapMs[0];
    bridge.fire("boxing_bell");
  }
}

function startFight() {
  if (!pose.ready) return;
  unlockAudio();
  playerHp = GAME.playerHp; enemyHp = GAME.enemyHp;
  timeLeft = GAME.roundSec; score = 0; combo = 0; bestCombo = 0; elapsed = 0;
  flash = 0; hitstopUntil = 0; slowMoUntil = 0; enemyHurt = 0; resetAtMs = 0;
  enemy.phase = "idle"; enemy.attack = null; enemy.resolved = false;
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
    fx.burst(hudCanvas.width / 2, hudCanvas.height * 0.4, "#7c5cff", 48, 320);
  } else bridge.fire("boxing_bell");
  const title = ko ? "KO 勝ち！" : result === "lose" ? "ダウン…" : playerHp >= enemyHp ? "判定勝ち" : "判定負け";
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
  else if (e.code === "KeyV" && scene) {
    const m = scene.toggleCameraMode();
    root.querySelector("#m_third").checked = m === "third";
  }
});

// ── 2D オーバーレイ（HUD / PIP / 粒子） ───────────────────────────────────────
let cssW = 1, cssH = 1;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = Math.max(1, Math.round(root.clientWidth));
  cssH = Math.max(1, Math.round(root.clientHeight));
  hudCanvas.width = Math.round(cssW * dpr);
  hudCanvas.height = Math.round(cssH * dpr);
  scene?.resize(cssW, cssH);
}
window.addEventListener("resize", resize);

/** HUD は数値のみ（両者 HP・残り時間・スコア）。ゲーム中の説明テキストは出さない。 */
function drawHud() {
  const W = hudCanvas.width, H = hudCanvas.height;
  const s = Math.min(W, H) / 620;
  const barW = W * 0.3, barH = 14 * s, y = 40 * s;
  const bar = (x, ratio, color, label, alignRight) => {
    ctx.fillStyle = "rgba(10,13,18,0.66)";
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = color;
    const w = barW * clamp(ratio, 0, 1);
    ctx.fillRect(alignRight ? x + barW - w : x, y, w, barH);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1.4 * s;
    ctx.strokeRect(x, y, barW, barH);
    ctx.fillStyle = "#cdd6e0";
    ctx.font = `600 ${Math.round(13 * s)}px system-ui, sans-serif`;
    ctx.textAlign = alignRight ? "right" : "left";
    ctx.fillText(label, alignRight ? x + barW : x, y - 6 * s);
  };
  bar(W * 0.05, playerHp / GAME.playerHp, "#4cc38a", "YOU", false);
  bar(W - W * 0.05 - barW, enemyHp / GAME.enemyHp, "#ff5f6d", "ENEMY", true);
  ctx.textAlign = "center";
  ctx.fillStyle = "#e6edf3";
  ctx.font = `bold ${Math.round(32 * s)}px system-ui, sans-serif`;
  // テストモードは時間制限が無いので残り時間は出さない
  if (!GAME.testMode) ctx.fillText(String(Math.ceil(Math.max(0, timeLeft))), W / 2, y + barH);
  ctx.textAlign = "left";
  ctx.font = `${Math.round(15 * s)}px system-ui, sans-serif`;
  ctx.fillStyle = "#8b97a6";
  ctx.fillText(`${score}${combo > 1 ? `  ×${combo}` : ""}`, W * 0.05, H - 18 * s);
}

/** 判定デバッグ ON のとき、リーチ推定の内訳を簡易バーで出す（実カメラでの調整用）。 */
function drawSignalBars() {
  if (!debugOn || !lastDebug?.left) return;
  const W = hudCanvas.width, H = hudCanvas.height;
  const s = Math.min(W, H) / 620;
  const rowH = 13 * s, w = 120 * s;
  let y = H * 0.22;
  ctx.font = `${Math.round(10 * s)}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  // 前後距離（1.00 = 構え位置）と、それを換算した踏み込み量
  ctx.fillStyle = "#ffd479";
  ctx.fillText(`dist ${(lastDebug.distanceRatio ?? 1).toFixed(2)}  step ${(playerPose?.step ?? 0).toFixed(2)}m`
    + `${lastDebug.hands ? "  hand21" : ""}`, 14 * s, y);
  y += rowH * 1.2;
  for (const side of ["left", "right"]) {
    const d = lastDebug[side];
    if (!d) continue;
    ctx.fillStyle = d.swing ? "#ffd479" : "#8b97a6";
    ctx.fillText(`${side}${d.swing ? " SWING" : ""}${lastDebug.guardLocked ? " guard-lock" : ""}`, 14 * s, y);
    y += rowH * 0.9;
    for (const [k, v] of [["angle", d.angle], ["shorten", d.shorten], ["hand4", d.handSize],
      ["hand21", d.handModel], ["imgZ", d.depthZ], ["raw", d.raw], ["reach", d.reach]]) {
      ctx.fillStyle = "rgba(42,49,60,0.85)";
      ctx.fillRect(52 * s, y - rowH * 0.62, w, rowH * 0.55);
      ctx.fillStyle = k === "reach" ? "#7c5cff" : k === "raw" ? "#4cc38a" : "#6cd1ff";
      ctx.fillRect(52 * s, y - rowH * 0.62, w * clamp(v ?? 0, 0, 1), rowH * 0.55);
      ctx.fillStyle = "#8b97a6";
      ctx.fillText(k, 14 * s, y);
      y += rowH;
    }
    y += rowH * 0.4;
  }
}

/**
 * デバッグ PIP: 実カメラ映像（ミラー）+ pose スケルトン（紫）+ 手の 21 点（緑）。
 * 手が検出できているかを PIP だけで判断できるように、pose とは別色で重ねる。
 * オーバーレイ配置なのでレイアウトは動かない。
 */
function drawPip(landmarks, hands) {
  if (!pipOn || !pose.ready || video.readyState < 2) return;
  const W = hudCanvas.width, H = hudCanvas.height;
  const frac = state === "FIGHT" || state === "RESULT" ? 0.16 : 0.28;
  const w = W * frac;
  const h = w * ((video.videoHeight / Math.max(1, video.videoWidth)) || 0.75);
  const pad = 14 * (W / 620);
  const x = W - w - pad, yTop = H - h - pad;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, yTop, w, h); ctx.clip();
  ctx.translate(x + w, yTop); ctx.scale(-1, 1); // ミラー
  ctx.drawImage(video, 0, 0, w, h);
  if (landmarks) {
    ctx.strokeStyle = "rgba(124,92,255,0.9)";
    ctx.lineWidth = Math.max(1.5, w / 120);
    for (const [a, b] of SKELETON) {
      const p1 = landmarks[a], p2 = landmarks[b];
      if (!p1 || !p2) continue;
      ctx.beginPath(); ctx.moveTo(p1.x * w, p1.y * h); ctx.lineTo(p2.x * w, p2.y * h); ctx.stroke();
    }
    ctx.fillStyle = "#ffd479";
    for (const lm of landmarks) { ctx.beginPath(); ctx.arc(lm.x * w, lm.y * h, Math.max(1.5, w / 90), 0, Math.PI * 2); ctx.fill(); }
  }
  // 手（HandLandmarker）: 検出できた手だけを緑で重ねる。出ていなければ手は取れていない。
  for (const hand of hands ?? []) {
    const lm = hand.landmarks;
    if (!lm?.length) continue;
    ctx.strokeStyle = "rgba(76,195,138,0.95)";
    ctx.lineWidth = Math.max(1.2, w / 150);
    for (const [a, b] of HAND_CONNECTIONS) {
      if (!lm[a] || !lm[b]) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = "#7dffc0";
    for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, Math.max(1.2, w / 130), 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(124,92,255,0.55)";
  ctx.lineWidth = Math.max(1, W / 700);
  ctx.strokeRect(x, yTop, w, h);
}

// ── メインループ ─────────────────────────────────────────────────────────────
let lastMs = performance.now();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const rawDt = clamp((nowMs - lastMs) / 1000, 0, 0.1);
  lastMs = nowMs;
  const slow = nowMs < slowMoUntil ? GAME.koSlowMo.timeScale : 1;
  const dt = nowMs < hitstopUntil ? 0 : rawDt * slow;
  if (Math.round(root.clientWidth) !== cssW || Math.round(root.clientHeight) !== cssH) resize();

  // ── 姿勢推定 → 体基準 2D → 3D の体 ──
  const result = pose.ready ? pose.detect(nowMs) : null;
  const hands = pose.ready ? pose.detectHands(nowMs) : null; // 2 フレームに 1 回だけ推論される
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
  const g = gestures.update(result, nowMs, rawDt, { aspect, calibrating: state === "CALIB", hands });
  playerPose = g.frame ? buildPlayerPose(g.frame, COMBAT.rig) : null;
  gestureArms = g.frame?.arms ?? null;
  lastDebug = g.debug;

  // ── 状態遷移 ──
  if (state === "CALIB") {
    if (!g.visible) setStatus("全身がフレームに入るように立ってください", "warn");
    else {
      setStatus(`構えを計測中… ${Math.round(gestures.calibProgress * 100)}%`);
      if (gestures.calibProgress >= 1) setState("FIGHT");
    }
  } else if (state === "FIGHT") {
    elapsed += dt;
    if (!GAME.testMode) timeLeft -= dt;
    // テストモード: HP が尽きたら少し待って全回復し、そのまま続行（勝敗は出さない）
    if (resetAtMs && nowMs >= resetAtMs) {
      playerHp = GAME.playerHp; enemyHp = GAME.enemyHp; combo = 0; resetAtMs = 0;
      enemy.phase = "idle"; enemy.attack = null; enemy.resolved = false;
      enemy.nextAtMs = nowMs + GAME.idleGapMs[0];
    }
    // ラウンド中に出すテキストは、姿勢を見失った時の警告だけ
    if (!g.visible && pose.ready) setStatus("姿勢を見失いました — フレーム内に戻ってください", "warn");
    else if (statusEl.textContent) setStatus("");
    if (dt > 0) {
      updateEnemy(nowMs);
      updatePlayerPunches(nowMs);
    }
    if (!GAME.testMode && state === "FIGHT" && timeLeft <= 0) endRound("time");
  }

  // ── 3D ──
  fx.update(rawDt);
  enemyHurt = Math.max(0, enemyHurt - rawDt * 4);
  flash = Math.max(0, flash - rawDt * 3);
  vignetteEl.style.opacity = String(flash * 0.9);
  if (scene) {
    scene.setShake(fx.ox * 0.0012, fx.oy * 0.0012);
    scene.update({
      pose: playerPose,
      enemy: {
        head: enemyHeadPos(), gloves: enemy.glove, guardUp: enemy.phase === "idle",
        activeHand: enemy.attack?.hand ?? null, phase: enemy.phase,
      },
      hurt: enemyHurt,
    });
    scene.render();
  }

  // ── 2D オーバーレイ ──
  ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  fx.draw(ctx);
  if (state === "FIGHT" || state === "RESULT") drawHud();
  drawSignalBars();
  drawPip(result?.landmarks, hands);
}

// ── 起動 ─────────────────────────────────────────────────────────────────────
function fail(message) {
  setStatus(message, "err");
  delegateEl.className = "badge off";
  delegateEl.textContent = "失敗";
  showCard(`
    <h1>🥊 触覚ボクシング</h1>
    <p style="color:#ff9a9a">${message}</p>
    <p>カメラを許可して再読み込みするか、別のブラウザ（Chrome / Edge 推奨）で開いてください。</p>
    <div class="actions"><button id="toMenu">メニュー</button></div>`);
  card.querySelector("#toMenu").onclick = () => { location.href = "../"; };
}

(async function boot() {
  resize();
  requestAnimationFrame(frame);
  setStatus("カメラ・3D・姿勢推定モデルを準備中…");
  if (!(await pose.start(video, { width: 640, height: 480 }))) { fail(pose.error); return; }
  try {
    const { Scene3D } = await import("./scene3d.js");
    scene = new Scene3D(glCanvas, COMBAT);
    scene.resize(cssW, cssH);
    scene.setDebug(debugOn);
  } catch (e) {
    fail(`3D 表示エラー: Three.js を読み込めません（オフライン？ ${e?.message ?? e}）`);
    return;
  }
  delegateEl.className = "badge on";
  delegateEl.textContent = pose.delegate;
  setState("TITLE");
})();
