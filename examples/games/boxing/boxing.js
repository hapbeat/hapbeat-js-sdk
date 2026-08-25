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
import { createTrackerSource, frameToPlayerInput } from "./tracker-source.js";
import { GestureTracker } from "./gestures.js";
import { TUNING, COMBAT, GAME, AI } from "./tuning.js";
import { buildPlayerPose, buildEnemyPose, attackPathT, enemyGlovePos, resolveEnemyGlove, resolvePlayerGlove, v3, dist, lerpV } from "./combat.js";
import { EnemyAI } from "./enemy-ai.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
    <label><input type="checkbox" id="m_dbg" checked> 🎯 当たり判定・信号を表示</label>
    <div class="t">状態</div>
    <div style="font-size:12px;margin:4px 0">Helper: <span id="conn" class="badge off">未接続</span></div>
    <div style="font-size:12px;margin:4px 0">推論: <span id="delegate" class="badge off">未初期化</span></div>
    <div style="font-size:12px;margin:4px 0">入力: <span id="srcBadge" class="badge off">未接続</span></div>
    <div id="trackerStatus" style="font:10px/1.45 ui-monospace,monospace;color:#9fb0c4;min-height:58px;overflow:hidden">外部テレメトリ待ち</div>
    <div class="t">クレジット</div>
    <div id="credits" style="font-size:10.5px;line-height:1.6;color:#8b97a6">読み込み中…</div>
    <button id="recBtn">📝 10 秒記録して CSV 保存</button>
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
const trackerStatusEl = root.querySelector("#trackerStatus");

let pipOn = true, debugOn = true;
root.querySelector("#gear").onclick = () => menuEl.classList.toggle("hidden");
root.querySelector("#m_pip").onchange = (e) => { pipOn = e.target.checked; };
root.querySelector("#m_dbg").onchange = (e) => { debugOn = e.target.checked; scene?.setDebug(debugOn); };
root.querySelector("#m_third").onchange = (e) => scene?.setCameraMode(e.target.checked ? "third" : "first");
root.querySelector("#m_audio").onchange = (e) => bridge.setMaster("audio", e.target.checked);
root.querySelector("#m_haptic").onchange = (e) => bridge.setMaster("haptic", e.target.checked);
root.querySelector("#testBtn").onclick = () => { unlockAudio(); bridge.testHaptic(); };
root.querySelector("#menuBtn").onclick = () => { location.href = "../"; };
root.querySelector("#recBtn").onclick = () => startRecording(10);
// 押してから画面の前に戻って構える時間が要るので、スタートと同じ COUNTDOWN → CALIB を通す。
// recalibrate() は CALIB 遷移時に呼ばれるのでここでは呼ばない（二重呼び出しにしない）。
root.querySelector("#recalBtn").onclick = () => {
  if (!(tracker?.active || pose.ready)) return;
  menuEl.classList.add("hidden");
  setState("COUNTDOWN");
};

/**
 * 診断用の信号レコーダー。10 秒ぶんの各信号を貯めて CSV で落とす。
 * 実機でしか出ない挙動（腕が戻らない等）を、実データで詰めるための入口。
 */
const NL = String.fromCharCode(10);
const recorder = { active: false, untilMs: 0, rows: [] };
function startRecording(seconds = 10) {
  recorder.rows.length = 0;
  recorder.active = true;
  recorder.untilMs = performance.now() + seconds * 1000;
  setStatus(`信号を記録中… ${seconds} 秒`);
}
function recordFrame(nowMs, g) {
  if (!recorder.active) return;
  if (nowMs > recorder.untilMs) { recorder.active = false; downloadCsv(); return; }
  const d = g.debug ?? {};
  const row = { t: Math.round(nowMs), dist: (d.distanceRatio ?? 1).toFixed(3),
    step: (playerPose?.step ?? 0).toFixed(3), yawDeg: (d.yawDeg ?? 0).toFixed(1) };
  const tm = tracker?.last?.telemetry;
  if (tm) Object.assign(row, { input: tracker.label, seq: tracker.last.seq, frameAgeMs: Math.round(Date.now() - tm.sentAtMs),
    trackerFps: Number(tm.trackerFps ?? 0).toFixed(1), rgb: tm.rgb ? `${tm.rgb.width}x${tm.rgb.height}` : "",
    depth: tm.depth ? `${tm.depth.width}x${tm.depth.height}` : "", syncDeltaMs: tm.syncDeltaMs ?? "",
    validDepthRatio: tm.validDepthRatio ?? "", joint3dCount: tm.joint3dCount ?? "", latencyMs: tm.processingLatencyMs ?? "" });
  for (const side of ["left", "right"]) {
    const a = d[side] ?? {};
    const f = g.frame?.arms?.[side];
    const num = (v) => (v == null ? "" : (+v).toFixed(3));
    Object.assign(row, {
      [`${side}_angle`]: num(a.angle), [`${side}_shorten`]: num(a.shorten),
      [`${side}_hand4`]: num(a.handSize), [`${side}_hand21`]: num(a.handModel), [`${side}_imgZ`]: num(a.depthZ),
      [`${side}_raw`]: num(a.raw), [`${side}_reach`]: num(a.reach),
      [`${side}_handFresh`]: a.handFresh ? 1 : 0, [`${side}_home`]: a.home ? 1 : 0,
      [`${side}_swing`]: a.swing ? 1 : 0,
      [`${side}_wx`]: num(f?.wrist?.x), [`${side}_wy`]: num(f?.wrist?.y),
    });
  }
  recorder.rows.push(row);
}

function trackerDiagnostic(frame) {
  const tm = frame?.telemetry;
  if (!tm) return "Web カメラ（外部テレメトリなし）";
  const age = Math.max(0, Date.now() - tm.sentAtMs);
  const rgb = tm.rgb ? `${tm.rgb.width}×${tm.rgb.height} #${tm.rgb.seq}` : "-";
  const depth = tm.depth ? `${tm.depth.width}×${tm.depth.height} #${tm.depth.seq}` : "-";
  const drops = Object.entries(tm.dropCounts ?? {}).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(" ") || "0";
  return `${frame.source === "depth" ? "外部" : "外部2D"} seq ${frame.seq} age ${age.toFixed(0)}ms FPS ${(tm.trackerFps ?? 0).toFixed(1)}\n`
    + `RGB ${rgb} / Depth ${depth} Δ ${(tm.syncDeltaMs ?? 0).toFixed?.(1) ?? "-"}ms  valid ${((tm.validDepthRatio ?? 0) * 100).toFixed(0)}%  3D ${tm.joint3dCount ?? 0}\n`
    + `lat ${(tm.processingLatencyMs ?? 0).toFixed?.(1) ?? "-"}ms drops ${drops} ${tm.device ? `${tm.device.deviceId ?? ""} ${tm.device.usbSpeed ?? ""}` : ""}`;
}
function downloadCsv() {
  if (!recorder.rows.length) { setStatus("記録できませんでした（姿勢が取れていない）", "warn"); return; }
  const cols = Object.keys(recorder.rows[0]);
  const csv = [cols.join(","), ...recorder.rows.map((r) => cols.map((c) => r[c]).join(","))].join(NL);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `boxing-signals-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`CSV を保存しました（${recorder.rows.length} 行）`);
}

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
/** 入力ソース（深度トラッカー or Web カメラ）。tracker-source.js が切り替える。 */
let tracker = null;
const fx = new Fx();
let scene = null;

// ── ゲーム状態 ────────────────────────────────────────────────────────────────
let state = "LOADING"; // LOADING | TITLE | CALIB | FIGHT | RESULT
let playerHp = GAME.playerHp, enemyHp = GAME.enemyHp;
let timeLeft = GAME.roundSec, score = 0, combo = 0, bestCombo = 0;
let elapsed = 0, hitstopUntil = 0, slowMoUntil = 0, flash = 0, enemyHurt = 0;
let playerPose = null;      // combat.buildPlayerPose の結果（判定・描画で共用）
let gestureArms = null;     // gestures の arms（スイング中かの参照用）
let enemyPose = null;       // combat.buildEnemyPose の結果（判定・描画で共用）
let assetStatus = null;     // 任意の人型アセットの読み込み結果
let resetAtMs = 0;          // テストモードの自動回復時刻
let countdownUntilMs = 0;   // キャリブ前カウントダウンの終了時刻
let lastDebug = null;       // 判定デバッグのプロット用

/**
 * 敵の体の状態。**何をするかは enemy-ai.js（EnemyAI）が決める**。ここはその intents を
 * 位置・経路に落とすだけ（idle → 予備動作 → 打撃 → 戻り）。
 */
const enemy = {
  phase: "idle",       // "idle" | "approach"（予備動作） | "strike" | "retract"
  root: { x: 0, z: -COMBAT.enemyDist },  // 立ち位置（間合いはプレイヤー root との距離で決まる）
  startedMs: 0,
  attack: null,        // EnemyAI が出した attack intent
  cfg: null,           // その攻撃の経路パラメータ（telegraph/strike/recover を反映）
  from: v3(), windup: v3(), aim: v3(),
  glove: { left: v3(), right: v3() },
  guardMode: "high",   // "high" | "low" | "open"（位置で効く。腕がそこに無ければ通る）
  yaw: 0,              // 予備動作で入れる体幹のひねり（見た目のみ）
  resolved: false,
  outcome: null,       // "hit" | "block" | "feint"（未設定＝空振り）
  feintDone: false,
  retractScale: 1,     // 戻りの開始位置（途中で止めた時に前へワープしないため）
  minHeadDist: Infinity,
  intents: null,
};
/** 敵の意思決定。乱数は差し替え可能（テストは tests/boxing-enemy-ai.test.mjs で決定的に回す）。 */
const ai = new EnemyAI(AI, Math.random);

/** 敵を構えに戻し、AI の履歴（フェーズ・被弾数・癖の学習）も初期化する。 */
function resetEnemy(nowMs) {
  enemy.phase = "idle";
  enemy.attack = null;
  enemy.resolved = false;
  enemy.outcome = null;
  enemy.guardMode = "high";
  enemy.yaw = 0;
  enemy.intents = null;
  ai.reset(nowMs);
}
/** プレイヤーの手ごとの接触状態（1 スイング 1 回にするための立ち上がり検出）。 */
const punchContact = { left: { on: false, lastMs: -1e9 }, right: { on: false, lastMs: -1e9 } };
/** スイングの立ち上がり / 空振り検出（AI へ渡すイベントの元）。 */
const swingWatch = { left: { on: false, hit: false }, right: { on: false, hit: false } };

/** attack intent（EnemyAI）→ 経路パラメータ。予備動作 = approach、隙 = retract。 */
function attackCfgFor(atk) {
  return {
    ...COMBAT.attack,
    approachMs: Math.max(1, atk.telegraphMs),
    strikeMs: atk.strikeMs,
    retractMs: atk.recoverMs,
  };
}

const enemyHeadPos = () => v3(enemy.root.x, COMBAT.enemy.headY, enemy.root.z);
/** 敵の腕が届く最大距離（骨長の和）。攻撃を始めるかの判断に使う。 */
const enemyArmReach = () => COMBAT.enemy.bones.upperArm + COMBAT.enemy.bones.foreArm;
/** プレイヤーの立ち位置（root）。頭の水平位置で代表する。 */
const playerRoot = () => (playerPose ? { x: playerPose.head.x, z: playerPose.head.z } : { x: 0, z: 0 });

/**
 * 敵の足さばき。**寄る / 下がる / 回る の判断は EnemyAI（intents.footwork）**で、
 * ここはそれを速度制限つきの root 移動に落とすだけ。
 * 目標間合いはフェーズごとのバイアス（攻勢は詰める / 守勢は離れる）が乗る。
 */
function updateFootwork(dt, intents) {
  const f = COMBAT.footwork;
  const p = playerRoot();
  const dx = enemy.root.x - p.x, dz = enemy.root.z - p.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / d, uz = dz / d;              // プレイヤー → 敵の単位ベクトル
  const fw = intents?.footwork ?? "hold";
  let target = f.preferredDist + (intents?.distBias ?? 0);
  if (fw === "approach") target -= f.deadZone;   // 詰めたい時は目標を内側へ寄せる
  else if (fw === "retreat") target += f.deadZone;
  const err = d - target;
  if (Math.abs(err) > f.deadZone * 0.5) {
    const step = Math.sign(err) * f.speed * dt; // + なら離れているので近づく（-方向へ）
    enemy.root.x -= ux * step;
    enemy.root.z -= uz * step;
  }
  // 視線に直交する向き＝左右に回り込む（スリップ中は footworkScale が上がって素早く外す）
  const dir = fw === "circleL" ? -1 : fw === "circleR" ? 1 : 0;
  const sp = f.strafeSpeed * (intents?.footworkScale ?? 1);
  enemy.root.x += -uz * dir * sp * dt;
  enemy.root.z += ux * dir * sp * dt;
  enemy.root.x = clamp(enemy.root.x, f.clampX[0], f.clampX[1]);
  enemy.root.z = clamp(enemy.root.z, f.clampZ[0], f.clampZ[1]);
}

/** その狙点が今の立ち位置から腕の長さで届くか（届かないなら踏み込みを待つ）。 */
function inAttackRange(aim, hand) {
  const sign = hand === "left" ? -1 : 1;
  const h = enemyHeadPos();
  const shoulder = v3(h.x + sign * COMBAT.enemy.arm.shoulderX, h.y + COMBAT.enemy.arm.shoulderY, h.z + COMBAT.enemy.arm.shoulderZ);
  return dist(shoulder, aim) <= enemyArmReach() * COMBAT.footwork.attackRangeFactor;
}
/**
 * 敵グローブの構え位置。**ガードの高低は位置そのもの**で、
 * high=頭の前（頭を守る＝胴が開く） / low=胴の前（胴を守る＝頭が開く） / open=下ろす（両方開く）。
 */
function enemyGuardPos(side, mode = "high") {
  const h = enemyHeadPos();
  const e = COMBAT.enemy;
  const g = mode === "open" ? e.open : mode === "low" ? e.guardLow : e.guard;
  const sign = side === "left" ? -1 : 1;
  return v3(h.x + sign * g.x, h.y + g.y, h.z + g.z);
}

/**
 * 予備動作でグローブを引く位置（フックは大きく横へ、ボディは腰を落とす）。
 * 予告はテキストではなく**この動き**。ここから狙点へ向かって出てくる。
 */
function windupPos(from, atk) {
  const w = AI.windup;
  const sign = atk.hand === "left" ? -1 : 1;
  return v3(from.x + sign * (w.out[atk.kind] ?? 0.08), from.y - (w.drop[atk.kind] ?? 0), from.z - w.back);
}

/** 攻撃中のグローブ位置。予備動作の前半は「引き」、後半は既存の経路（直線 / 弧）。 */
function enemyAttackGlove(s) {
  const cfg = enemy.cfg;
  const wEnd = cfg.approachFrac * AI.windup.fracOfTelegraph;
  if (s <= wEnd && wEnd > 1e-6) return lerpV(enemy.from, enemy.windup, s / wEnd);
  const t = (s - wEnd) / Math.max(1e-6, 1 - wEnd);
  return enemyGlovePos(enemy.windup, enemy.aim, t, enemy.attack, cfg);
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

/** EnemyAI が出した attack intent を、実際の経路（予備動作 → 打撃 → 戻り）として始める。 */
function startAttack(nowMs, atk) {
  const j = COMBAT.attack.aimJitter;
  enemy.attack = atk;
  enemy.cfg = attackCfgFor(atk);
  enemy.startedMs = nowMs;
  enemy.from = enemyGuardPos(atk.hand, enemy.guardMode);
  enemy.windup = windupPos(enemy.from, atk);
  // 狙点は「攻撃を始めた瞬間」の頭 / 胴の位置に固定する＝あとから体を振れば避けられる
  const t = aimPoint(atk);
  enemy.aim = v3(t.x + (Math.random() * 2 - 1) * j, t.y + (Math.random() * 2 - 1) * j, t.z);
  enemy.resolved = false;
  enemy.outcome = null;
  enemy.feintDone = false;
  enemy.retractScale = 1;
  enemy.minHeadDist = Infinity;
  enemy.phase = "approach";
}

/**
 * AI を 1 フレーム進めて intents を得る。ここで渡す ctx は
 * **既存の判定結果（間合い・プレイヤーの構え・スイング）だけ**で作る。
 */
function updateAi(nowMs, dt, g) {
  const p = playerRoot();
  const d = Math.hypot(enemy.root.x - p.x, enemy.root.z - p.z);
  const intents = ai.update({
    nowMs,
    dist: d,
    preferredDist: COMBAT.footwork.preferredDist,
    deadZone: COMBAT.footwork.deadZone,
    inRange: !!playerPose && (inAttackRange(playerPose.head, "left") || inAttackRange(playerPose.head, "right")),
    handInRange: {
      left: !!playerPose && inAttackRange(playerPose.head, "left"),
      right: !!playerPose && inAttackRange(playerPose.head, "right"),
    },
    busy: enemy.phase !== "idle",
    player: buildPlayerState(g),
    hp: { self: enemyHp / GAME.enemyHp, player: playerHp / GAME.playerHp },
    elapsed,
  }, dt);
  enemy.intents = intents;
  return intents;
}

/** 敵の攻撃を 1 フレーム進め、位置ベースで ガード / 被弾 / 空振り を判定する。 */
function updateEnemy(nowMs, intents) {
  if (enemy.phase === "idle") {
    enemy.guardMode = intents?.guard ?? "high";
    enemy.yaw = 0;
    for (const side of ["left", "right"]) enemy.glove[side] = enemyGuardPos(side, enemy.guardMode);
    // 打つ / 打たないの判断は AI が持つ（間合いは ctx.inRange / handInRange で渡してある）。
    // ここで二重に弾くと、AI 側は「打った」つもりで履歴を進めるのに何も起きない状態になる。
    const atk = intents?.attack;
    if (atk && playerPose) startAttack(nowMs, atk);
    return;
  }
  const cfg = enemy.cfg;
  const atk = enemy.attack;
  const raw = attackPathT(nowMs - enemy.startedMs, cfg);
  const phase = raw.phase;
  enemy.phase = phase === "done" ? "idle" : phase;
  if (phase === "done") {
    // 当たらずに終わった: 頭のすぐ横を通っていれば「かわした」
    if (!enemy.resolved && !atk.feint && enemy.minHeadDist < cfg.dodgeNear) onDodge();
    ai.noteEvent({ type: "attackEnd", nowMs, kind: atk.kind, target: atk.target,
      outcome: enemy.outcome ?? (atk.feint ? "feint" : "miss") });
    enemy.attack = null;
    enemy.yaw = 0;
    return;
  }
  // 戻りは「今いた位置」から戻す（途中で止めた時に前へワープしない）
  const s = phase === "retract" ? raw.s * enemy.retractScale : raw.s;
  const hand = atk.hand;
  const other = hand === "left" ? "right" : "left";
  enemy.glove[hand] = enemyAttackGlove(s);
  enemy.glove[other] = enemyGuardPos(other, "open"); // 攻撃中は反対の手も下がる＝隙
  // 予備動作では体幹を入れる（打つ手の肩がこちらへ出る。見た目のみで判定には効かない）
  const windupT = clamp(s / Math.max(1e-6, cfg.approachFrac * AI.windup.fracOfTelegraph), 0, 1);
  enemy.yaw = -(hand === "left" ? -1 : 1) * AI.windup.yaw * windupT;

  // フェイント: 予備動作の途中で捨てる（判定は最初から持たない）
  if (atk.feint) {
    if (!enemy.feintDone && nowMs - enemy.startedMs >= cfg.approachMs * atk.feintCancelFrac) {
      enemy.feintDone = true;
      enemy.outcome = "feint";
      retractNow(nowMs, cfg, s);
    }
    return;
  }
  if (!playerPose || enemy.resolved) return;
  enemy.minHeadDist = Math.min(enemy.minHeadDist, dist(enemy.glove[hand], playerPose.head));
  const hit = resolveEnemyGlove(enemy.glove[hand], COMBAT.enemy.gloveRadius, playerPose, COMBAT);
  if (hit === "block") { enemy.resolved = true; enemy.outcome = "block"; onBlock(); retractNow(nowMs, cfg, s); }
  else if (hit) { enemy.resolved = true; enemy.outcome = "hit"; onPlayerHit(hit); retractNow(nowMs, cfg, s); }
}

/**
 * 判定が付いた / フェイントを捨てた時は、残りの接近をやめて戻りに入る。
 * `sNow` を渡して**今いる位置から**戻す（そうしないと戻り開始で拳が狙点まで飛ぶ）。
 */
function retractNow(nowMs, cfg, sNow) {
  enemy.retractScale = clamp(sNow, 0, 1);
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
  playerHp = Math.max(0, playerHp - (head ? GAME.damage.head : GAME.damage.torso));
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
  if (!playerPose || !enemyPose) return;
  for (const side of ["left", "right"]) {
    const arm = playerPose[side];
    const c = punchContact[side];
    // 当たり判定は「スイング中」だけ有効。ガード中に静止して腕が伸びていても当たらない。
    const swinging = !COMBAT.punchHit.requireSwing || !!gestureArms?.[side]?.swingActive;
    const eligible = swinging && arm.reach >= COMBAT.punchHit.minReach;
    const what = eligible ? resolvePlayerGlove(arm.wrist, COMBAT.player.gloveRadius, enemyPose, COMBAT) : null;
    if (what && !c.on && nowMs - c.lastMs > COMBAT.punchHit.cooldownMs) {
      c.lastMs = nowMs;
      swingWatch[side].hit = true;
      onPlayerPunchLanded(side, what, nowMs);
    }
    c.on = !!what;
    // スイングの立ち上がり / 終わりを AI に渡す（カウンターの抽選と、空振りの検知）
    const w = swingWatch[side];
    if (swinging && !w.on) { w.on = true; w.hit = false; ai.noteEvent({ type: "playerSwingStart", nowMs, side }); }
    else if (!swinging && w.on) {
      w.on = false;
      if (!w.hit) ai.noteEvent({ type: "playerWhiff", nowMs, side });
    }
  }
}

/**
 * AI に渡すプレイヤーの状態。**既存の検出結果だけ**から作る（新しい推定は増やさない）。
 * ガードの高低は「拳が頭のそばにあるか / 下がっているか」＝ 3D の位置で見る。
 */
function buildPlayerState(g) {
  const swinging = !!(gestureArms?.left?.swingActive || gestureArms?.right?.swingActive);
  const st = { guardHigh: false, guardLow: false, swinging, lean: g?.lean ?? 0, ducking: !!g?.duck,
    stepIn: false, stepBack: false };
  if (!playerPose) return st;
  const drop = AI.playerGuard.highDropM;
  const wrists = [playerPose.left.wrist, playerPose.right.wrist];
  const headY = playerPose.head.y;
  st.guardHigh = !swinging && wrists.every((w) => w.y > headY - drop);
  st.guardLow = !swinging && wrists.every((w) => w.y <= headY - drop);
  const step = playerPose.step ?? 0;
  st.stepIn = step > AI.playerGuard.stepThresholdM;
  st.stepBack = step < -AI.playerGuard.stepThresholdM;
  return st;
}

function onPlayerPunchLanded(side, what, nowMs) {
  const pan = side === "left" ? -0.6 : 0.6;
  const x = hudCanvas.width * (0.5 + (side === "left" ? -0.12 : 0.12));
  // 食らった部位を AI へ。頭に続けて入ると気絶し、胴に入るとガードを下げてくる
  if (what !== "guard") ai.noteEvent({ type: "tookHit", nowMs, part: what });
  if (what === "guard") {
    enemyHp = Math.max(0, enemyHp - GAME.damage.blocked);
    score += GAME.score.blocked;
    bridge.fire("boxing_punch_blocked", { pan });
    fx.burst(x, hudCanvas.height * 0.42, "#8b97a6", 8, 120);
    return;
  }
  const head = what === "head";
  enemyHp = Math.max(0, enemyHp - (head ? GAME.damage.head : GAME.damage.torso));
  combo++;
  bestCombo = Math.max(bestCombo, combo);
  score += (head ? GAME.score.head : GAME.score.torso) + (combo > 1 ? combo * GAME.score.comboBonus : 0);
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
      <p style="color:#8b97a6">スタート後、<b>カウントダウン（3・2・1）</b>のあいだに<b>両拳を胸の前に構えて</b>ください。<br>
      その姿勢が「腕を伸ばしていない状態」の基準になります。<br>
      画面は自分の背後から。青く光る球とカプセルが自分の頭と胴の当たり判定。<br>
      敵は頭か胴を狙って腕を伸ばしてくるので、腕で止めるか、体ごと動かして外す。<br>
      全身が映るように 1.5〜2m 離れて立ってください。${GAME.testMode ? "<br>（テストモード: 勝敗を出さず、体力が尽きても自動で回復して続きます）" : ""}</p>
      <div class="actions"><button class="primary" id="cardStart">スタート（Space）</button></div>`);
    card.querySelector("#cardStart").onclick = () => startFight();
    setStatus(`スタート → ${Math.round(TUNING.calibCountdownMs / 1000)} 秒のカウントダウン → 構えを計測（約 1.5 秒）`);
  } else if (next === "COUNTDOWN") {
    hideCard();
    countdownUntilMs = performance.now() + TUNING.calibCountdownMs;
    // 取り直し中に殴られないよう、敵はいったん構えに戻して待たせる
    resetEnemy(countdownUntilMs);
  } else if (next === "CALIB") {
    hideCard();
    gestures.recalibrate();
    setStatus("そのまま構えたまま… 計測中");
  } else if (next === "FIGHT") {
    hideCard();
    setStatus("");
    resetEnemy(performance.now());
    bridge.fire("boxing_bell");
  }
}

function startFight() {
  if (!(tracker?.active || pose.ready)) return;
  unlockAudio();
  playerHp = GAME.playerHp; enemyHp = GAME.enemyHp;
  timeLeft = GAME.roundSec; score = 0; combo = 0; bestCombo = 0; elapsed = 0;
  flash = 0; hitstopUntil = 0; slowMoUntil = 0; enemyHurt = 0; resetAtMs = 0;
  resetEnemy(performance.now());
  enemy.root = { x: 0, z: -COMBAT.enemyDist };
  setState("COUNTDOWN");
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
  const res = pose.resolution;
  ctx.fillText(`dist ${(lastDebug.distanceRatio ?? 1).toFixed(2)}  step ${(playerPose?.step ?? 0).toFixed(2)}m`
    + `  cam ${res ? `${res.width}x${res.height} (${(res.width / res.height).toFixed(2)})` : "?"}`
    + `  yaw ${(lastDebug.yawDeg ?? 0).toFixed(0)}°  入力 ${tracker?.label ?? "-"}`
    + `${lastDebug.hands ? "  hand21 OK" : "  hand21 なし"}`, 14 * s, y);
  y += rowH;
  const tm = tracker?.last?.telemetry;
  if (tm) {
    ctx.fillStyle = "#6cd1ff";
    ctx.fillText(`EXT #${tracker.last.seq} age ${Math.max(0, Date.now() - tm.sentAtMs).toFixed(0)}ms ${(tm.trackerFps ?? 0).toFixed(1)}fps`
      + ` RGB ${tm.rgb?.width ?? "?"}x${tm.rgb?.height ?? "?"} D ${tm.depth?.width ?? "-"}x${tm.depth?.height ?? "-"}`
      + ` sync ${(tm.syncDeltaMs ?? 0).toFixed(1)}ms valid ${((tm.validDepthRatio ?? 0) * 100).toFixed(0)}% 3D ${tm.joint3dCount ?? 0}`
      + ` lat ${(tm.processingLatencyMs ?? 0).toFixed(1)}ms`, 14 * s, y);
    y += rowH;
  }
  // 敵 AI: フェーズ / 下位ステート / 今の攻撃 / 難度（予備動作の倍率）
  ctx.fillStyle = "#c9a4ff";
  const atk = enemy.attack;
  ctx.fillText(`AI ${ai.describe()}  guard ${enemy.guardMode}`
    + `  atk ${atk ? `${atk.kind}/${atk.target}/${atk.hand} tel${atk.telegraphMs}` : "-"}`
    + `  foot ${enemy.intents?.footwork ?? "-"}  tele×${AI.telegraphLengthScale}`, 14 * s, y);
  y += rowH;
  // 距離比の内訳（肩幅 / 体幹 / 顔 / 骨格 bbox）。どれかが崩れていないか見るため。
  const dp = lastDebug.distParts;
  if (dp) {
    ctx.fillStyle = "#8b97a6";
    const fmt = (v) => (v == null ? "--" : v.toFixed(2));
    ctx.fillText(`  肩 ${fmt(dp.shoulder)}  体幹 ${fmt(dp.torso)}  顔 ${fmt(dp.face)}  骨格 ${fmt(dp.frame)}`, 14 * s, y);
  }
  y += rowH * 1.2;
  for (const side of ["left", "right"]) {
    const d = lastDebug[side];
    if (!d) continue;
    ctx.fillStyle = d.swing ? "#ffd479" : d.home ? "#4cc38a" : "#8b97a6";
    ctx.fillText(`${side}${d.swing ? " SWING" : ""}${d.home ? " home" : ""}`
      + `${d.handFresh ? " hand" : ""}${lastDebug.guardLocked ? " guard-lock" : ""}`, 14 * s, y);
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
const externalPreview = new Image();
let externalPreviewUrl = "";
function drawPip(landmarks, hands, previewDataUrl, source) {
  if (!pipOn) return;
  if (source !== "depth") { externalPreviewUrl = ""; externalPreview.removeAttribute("src"); }
  if (previewDataUrl && previewDataUrl !== externalPreviewUrl) { externalPreviewUrl = previewDataUrl; externalPreview.src = previewDataUrl; }
  const hasExternalPreview = externalPreview.complete && externalPreview.naturalWidth > 0;
  if (!hasExternalPreview && (!pose.ready || video.readyState < 2)) return;
  const W = hudCanvas.width, H = hudCanvas.height;
  const frac = state === "FIGHT" || state === "RESULT" ? 0.16 : 0.28;
  const w = W * frac;
  const h = w * (hasExternalPreview ? externalPreview.naturalHeight / externalPreview.naturalWidth
    : (video.videoHeight / Math.max(1, video.videoWidth)) || 0.75);
  const pad = 14 * (W / 620);
  const x = W - w - pad, yTop = H - h - pad;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, yTop, w, h); ctx.clip();
  ctx.translate(x + w, yTop); ctx.scale(-1, 1); // ミラー
  ctx.drawImage(hasExternalPreview ? externalPreview : video, 0, 0, w, h);
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
  // 変数名を `frame` にしない: この関数自身の名前を隠して 1 行目の
  // requestAnimationFrame(frame) が TDZ で落ちる（ループが 1 フレームで止まる）。
  const srcFrame = tracker ? tracker.poll(nowMs) : null;
  const result = srcFrame?.landmarks ? { landmarks: srcFrame.landmarks, worldLandmarks: srcFrame.worldLandmarks } : null;
  const hands = srcFrame?.hands ?? null;
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const g = gestures.update(result, nowMs, rawDt, { aspect, calibrating: state === "CALIB", hands });
  // 深度トラッカーがあれば実測の 3D をそのまま使い、無ければ 2D からの推定（従来経路）
  const tracked = srcFrame?.xyz ? frameToPlayerInput(srcFrame, COMBAT.rig) : null;
  const input = tracked ?? g.frame;
  playerPose = input ? buildPlayerPose(input, COMBAT.rig) : null;
  gestureArms = g.frame?.arms ?? null;
  lastDebug = g.debug;
  recordFrame(nowMs, g);

  // ── 状態遷移 ──
  if (state === "COUNTDOWN") {
    // 構えを作る時間。押した瞬間の姿勢で基準を取らないための待ち。
    const left = countdownUntilMs - nowMs;
    if (left <= 0) setState("CALIB");
    else setStatus(`両拳を胸の前に構えてください… ${Math.ceil(left / 1000)}`);
  } else if (state === "CALIB") {
    if (!g.visible) setStatus("全身がフレームに入るように立ってください", "warn");
    else {
      setStatus(`構えを計測中… ${Math.round(gestures.calibProgress * 100)}%（この姿勢が基準になります）`);
      if (gestures.calibProgress >= 1) setState("FIGHT");
    }
  } else if (state === "FIGHT") {
    elapsed += dt;
    if (!GAME.testMode) timeLeft -= dt;
    // テストモード: HP が尽きたら少し待って全回復し、そのまま続行（勝敗は出さない）
    if (resetAtMs && nowMs >= resetAtMs) {
      playerHp = GAME.playerHp; enemyHp = GAME.enemyHp; combo = 0; resetAtMs = 0;
      resetEnemy(nowMs);
    }
    // ラウンド中に出すテキストは、姿勢を見失った時の警告だけ
    if (!g.visible && pose.ready) setStatus("姿勢を見失いました — フレーム内に戻ってください", "warn");
    else if (statusEl.textContent) setStatus("");
    if (dt > 0) {
      const intents = updateAi(nowMs, dt, g);
      updateFootwork(dt, intents);
      updateEnemy(nowMs, intents);
      enemyPose = buildEnemyPose(enemy.root, enemy.glove, COMBAT);
      enemyPose.guardUp = enemy.phase === "idle" && enemy.guardMode !== "open";
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
    if (!enemyPose) {
      enemyPose = buildEnemyPose(enemy.root, enemy.glove, COMBAT);
      enemyPose.guardUp = enemy.phase === "idle" && enemy.guardMode !== "open";
    }
    scene.update({
      pose: playerPose,
      enemy: { ...enemyPose, gloves: { left: enemyPose.left.wrist, right: enemyPose.right.wrist },
        activeHand: AI.telegraphGlow ? (enemy.attack?.hand ?? null) : null, phase: enemy.phase,
        yaw: enemy.yaw },
      hurt: enemyHurt,
    });
    scene.render();
  }

  // ── 2D オーバーレイ ──
  ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  fx.draw(ctx);
  if (state === "FIGHT" || state === "RESULT") drawHud();
  drawSignalBars();
  trackerStatusEl.textContent = trackerDiagnostic(srcFrame);
  const srcBadge = root.querySelector("#srcBadge");
  if (tracker) { srcBadge.className = "badge on"; srcBadge.textContent = tracker.label; }
  drawPip(result?.landmarks, hands, srcFrame?.debug?.previewDataUrl, srcFrame?.source);
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
  const picked = await createTrackerSource({
    pose, video,
    url: new URLSearchParams(location.search).get("tracker") || "ws://localhost:8770",
    startOpts: { width: 1280, height: 720 },
    onLost: () => { setStatus("深度トラッカーとの接続が切れました — Web カメラに切り替えます", "warn"); },
  });
  tracker = picked.source;
  if (!picked.ok) { fail(pose.error || tracker.error || "入力を開始できません"); return; }
  try {
    const { Scene3D } = await import("./scene3d.js");
    scene = new Scene3D(glCanvas, COMBAT);
    scene.resize(cssW, cssH);
    scene.setDebug(debugOn);
    // 任意の人型アセット。未配置でもプリミティブのまま続行する。
    const present = async (url) => {
      try { return (await fetch(url, { method: "HEAD" })).ok ? url : null; } catch { return null; }
    };
    const [playerGlb, enemyGlb] = await Promise.all([present("assets/player.glb"), present("assets/enemy.glb")]);
    assetStatus = await scene.loadAssets({ player: playerGlb, enemy: enemyGlb });
  } catch (e) {
    fail(`3D 表示エラー: Three.js を読み込めません（オフライン？ ${e?.message ?? e}）`);
    return;
  }
  delegateEl.className = "badge on";
  delegateEl.textContent = pose.delegate || "外部";
  const srcBadge = root.querySelector("#srcBadge");
  srcBadge.className = "badge on";
  srcBadge.textContent = tracker.label;
  // 任意 CC0 人型の出典だけを示す。背景はThree.jsの単色・自作リング/照明のみ。
  root.querySelector("#credits").innerHTML = [
    assetStatus?.player || assetStatus?.enemy
      ? '人型: <b>Universal Base Characters</b> — <a href="https://quaternius.com/packs/universalbasecharacters.html" target="_blank" style="color:#9ab">Quaternius</a>（CC0）'
      : "人型: 未配置（プリミティブ表示中・assets/README 参照）",
    "背景・リング・照明は Three.js の自作表現",
  ].join("<br>");
  setState("TITLE");
})();
