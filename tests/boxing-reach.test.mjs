// examples/games/boxing のリーチ推定と安定化（filters.js / reach.js は純関数なので node で回せる）。
//
// 実機フィードバック「ガード中に関節が震えて『伸びた』判定になる / 動きがぷるぷる」に対する
// 回帰テスト。守りたいルール:
//   ・静止時の細かい揺らぎは出力に出さない（1€ + デッドバンド + スルーレート）
//   ・パンチの立ち上がり（150ms 程度で大きく増える）はちゃんと通す
//   ・「突いた」は値ではなく速度で判定する（震えでは発火しない）
//   ・顔の前で手が止まっていればリーチは上限でクランプ（ガード中は腕が伸びない）
import assert from "node:assert/strict";
import { test } from "node:test";
import { OneEuro, slew, deadband, weightedMedian } from "../examples/games/boxing/filters.js";
import { combineSignals, ReachFilter, SwingDetector, isGuardLocked, isHome } from "../examples/games/boxing/reach.js";
import { TUNING, COMBAT as _COMBAT } from "../examples/games/boxing/tuning.js";
const COMBAT_REACH = TUNING.reach;

const DT = 1 / 30;
/** 再現可能な擬似乱数（テストを毎回同じ結果にする）。 */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => (((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1); // -1..1
}

// 方針は「平滑化は弱め＝速い」。静止ノイズを完全に消すのではなく、遅延を出さない側に振り、
// 震えでの誤発火はスイング（速度）判定で防ぐ。実測: 入力 ±0.02 → 残 ±0.0144、166ms で 0.95 到達。
test("1€ フィルタ: 静止ノイズを半分以下にしつつ、速いステップにはほぼ素通しで追従する", () => {
  const rand = rng(7);
  const f = new OneEuro(TUNING.filter.landmark);
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    const out = f.filter(0.5 + rand() * 0.02, DT); // ±0.02 の静止ノイズ
    if (i > 30) peak = Math.max(peak, Math.abs(out - 0.5));
  }
  assert.ok(peak < 0.016, `静止ノイズが残りすぎ (±${peak.toFixed(4)})`); // 入力 ±0.02 に対し ±0.014 程度

  const g = new OneEuro(TUNING.filter.landmark);
  for (let i = 0; i < 60; i++) g.filter(0, DT);
  let v = 0;
  for (let i = 0; i < 5; i++) v = g.filter(1, DT); // 5 フレーム(≈166ms)でステップ
  assert.ok(v > 0.9, `速い変化への追従が遅すぎ (${v.toFixed(3)})`); // 5 フレーム(166ms)で 0.95
});

test("スルーレート制限とデッドバンド", () => {
  assert.equal(deadband(0.5, 0.53, 0.05), 0.5, "小さな変化は無視");
  assert.equal(deadband(0.5, 0.6, 0.05), 0.6, "大きな変化は通す");
  // 伸び 6/s・戻り 4/s → 1 フレーム(1/30s)では 0.2 / 0.133 まで
  assert.ok(Math.abs(slew(0, 1, DT, 6, 4) - 0.2) < 1e-9);
  assert.ok(Math.abs(slew(1, 0, DT, 6, 4) - (1 - 4 / 30)) < 1e-9);
});

test("重み付きメディアンは外れ値 1 つに引っ張られない", () => {
  assert.equal(weightedMedian([[0.1, 1], [0.15, 1], [0.9, 1]]), 0.15);
  assert.equal(weightedMedian([]), 0);
});

test("信号合成: median / weighted / max、取れない信号は無視される", () => {
  const cfg = { combine: "median", weights: { angle: 1, shorten: 1, handSize: 1 } };
  assert.equal(combineSignals({ angle: 0.1, shorten: 0.2, handSize: 0.95 }, cfg), 0.2);
  assert.equal(combineSignals({ angle: 0.1, shorten: null, handSize: 0.9 }, { ...cfg, combine: "max" }), 0.9);
  const w = combineSignals({ angle: 0.0, shorten: 1.0, handSize: null }, { ...cfg, combine: "weighted" });
  assert.ok(Math.abs(w - 0.5) < 1e-9, `weighted=${w}`);
});

test("震え（±0.05 の揺らぎ）ではパンチが発火しない", () => {
  const rand = rng(3);
  const filter = new ReachFilter(TUNING.reach);
  const swing = new SwingDetector(TUNING.punch.swing);
  let fires = 0, t = 0, maxReach = 0;
  for (let i = 0; i < 300; i++) {   // 10 秒ぶん
    t += DT * 1000;
    const raw = 0.45 + rand() * 0.05; // ガード気味の姿勢で震えているイメージ
    const r = filter.update(raw, DT, {});
    maxReach = Math.max(maxReach, r);
    if (swing.update(r, t).fired) fires++;
  }
  assert.equal(fires, 0, `震えで ${fires} 回発火した`);
  assert.ok(maxReach < TUNING.punch.swing.reachMin, `震えでリーチが伸びすぎ (${maxReach.toFixed(3)})`);
});

test("150ms で 0.2 → 0.9 に伸びるパンチは発火し、スイング窓が開いて閉じる", () => {
  const filter = new ReachFilter(TUNING.reach);
  const swing = new SwingDetector(TUNING.punch.swing);
  let t = 0, fired = false, activeFrames = 0;
  for (let i = 0; i < 30; i++) { t += DT * 1000; const r = filter.update(0.2, DT, {}); swing.update(r, t); }
  const steps = Math.round(150 / (DT * 1000));
  for (let i = 1; i <= steps; i++) {
    t += DT * 1000;
    const r = filter.update(0.2 + (0.9 - 0.2) * (i / steps), DT, {});
    const s = swing.update(r, t);
    if (s.fired) fired = true;
    if (s.active) activeFrames++;
  }
  // 立ち上がり直後（腕を伸ばしきっている間）に発火すればよい
  for (let i = 0; i < 6; i++) {
    t += DT * 1000;
    const s = swing.update(filter.update(0.9, DT, {}), t);
    if (s.fired) fired = true;
    if (s.active) activeFrames++;
  }
  assert.ok(fired, "パンチが発火しない");
  assert.ok(activeFrames > 0, "スイング窓が開かない");
  // 腕を戻すと窓が閉じる
  let active = true;
  for (let i = 0; i < 40; i++) { t += DT * 1000; const r = filter.update(0.1, DT, {}); active = swing.update(r, t).active; }
  assert.equal(active, false, "スイング窓が閉じない");
});

test("ガードロック: 顔の前で手が止まっていればリーチは上限にクランプされる", () => {
  const g = TUNING.reach.guardLock;
  const nose = { x: 0, y: 0 };
  const still = { left: 0.1, right: 0.1 }, moving = { left: 3, right: 0.1 };
  const atFace = { left: { x: -0.25, y: 0.1 }, right: { x: 0.25, y: 0.1 } };
  const down = { left: { x: -0.4, y: 1.2 }, right: { x: 0.4, y: 1.2 } };
  assert.equal(isGuardLocked({ nose, wrists: atFace, speeds: still }, g), true);
  assert.equal(isGuardLocked({ nose, wrists: atFace, speeds: moving }, g), false, "動いていればロックしない");
  assert.equal(isGuardLocked({ nose, wrists: down, speeds: still }, g), false, "手が下がっていればロックしない");

  // ロック中は生値が 1.0 でもリーチは maxReach 以下
  const filter = new ReachFilter(TUNING.reach);
  let r = 0;
  for (let i = 0; i < 120; i++) r = filter.update(1.0, DT, { guardLocked: true });
  assert.ok(r <= g.maxReach + 1e-6, `ガード中にリーチが伸びた (${r.toFixed(3)})`);
});

test("可視性が落ちたフレームは直前値を保持する（腕が飛ばない）", () => {
  const filter = new ReachFilter(TUNING.reach);
  let r = 0;
  for (let i = 0; i < 60; i++) r = filter.update(0.8, DT, {});
  const held = filter.update(0.0, DT, { visible: false });
  assert.equal(held, r, "見えていないフレームで値が動いた");
});

// ── 前後移動（踏み込み）と、再スケールした奥行き信号 ────────────────────────────
// 単眼なので「見かけの体格が大きくなった＝近づいた」で距離を推定する。
// 比 → メートルの換算と、その結果として間合いが変わることを守る。
import { buildPlayerPose, dist, v3 } from "../examples/games/boxing/combat.js";
const COMBAT = _COMBAT;
import { mapRange } from "../examples/games/boxing/reach.js";

const frameAt = (distanceRatio, reach = 0) => ({
  head: { x: 0, y: 0 }, distanceRatio,
  arms: {
    left: { elbow: { x: -0.35, y: 0.35 }, wrist: { x: -0.2, y: 0.1 }, reach: 0 },
    right: { elbow: { x: 0.35, y: 0.35 }, wrist: { x: 0.2, y: 0.1 }, reach },
  },
});

test("距離比 → 前後移動: 1.0 は原点、1.3 で約 +0.4m 前、範囲外はクランプされる", () => {
  assert.ok(Math.abs(buildPlayerPose(frameAt(1.0), COMBAT.rig).head.z) < 1e-9);
  const stepped = buildPlayerPose(frameAt(1.3), COMBAT.rig);
  assert.ok(Math.abs(stepped.head.z + 0.4) < 0.03, `head.z=${stepped.head.z.toFixed(3)}（-0.4 付近のはず）`);
  assert.ok(stepped.torsoTop.z < 0 && stepped.right.wrist.z < 0, "体全体が前に出ていない");
  const back = buildPlayerPose(frameAt(0.7), COMBAT.rig);
  assert.ok(back.head.z > 0, "下がると後ろへ動く");
  const far = buildPlayerPose(frameAt(3.0), COMBAT.rig); // 異常値でも敵にめり込まない
  assert.ok(-far.head.z <= COMBAT.rig.stepClamp[1] + 1e-9);
});

test("踏み込むと間合いが詰まる: 同じリーチでも敵の頭までの距離が縮む", () => {
  const enemyHead = v3(0, COMBAT.enemy.headY, -COMBAT.enemyDist);
  const at = (ratio) => dist(buildPlayerPose(frameAt(ratio, 0.6), COMBAT.rig).right.wrist, enemyHead);
  const base = at(1.0), stepIn = at(1.3);
  assert.ok(stepIn < base - 0.3, `踏み込みで間合いが詰まらない (${base.toFixed(3)} → ${stepIn.toFixed(3)})`);
  assert.ok(at(0.8) > base, "下がっても間合いが変わらない");
});

test("画像空間 z 信号は『構え時からの差分』で見る: 構えで 0、伸ばしきりで ~1", () => {
  const c = COMBAT_REACH.depthZ;
  // ピンホール投影モデルの実測値 (肩z - 手首z)/肩幅。構え 0.316 を基準に引き算する。
  const GUARD = 0.316;
  const at = (abs) => mapRange(abs - GUARD, c.minDelta, c.maxDelta);
  assert.equal(at(GUARD), 0, "構えで 0 にならない（腕が最初から前に出て見える）");
  assert.equal(at(0.053), 0, "真横に伸ばした腕を拾ってしまう");
  const mid = at(0.789);   // 前へ 0.3m
  const full = at(1.579);  // 前へ 0.6m
  assert.ok(mid > 0.25 && mid < 0.6, `中間が飽和 / 鈍すぎ (${mid.toFixed(2)})`);
  assert.ok(full > 0.95, `伸ばしきりで 1 に届かない (${full.toFixed(2)})`);
});

test("手の見かけサイズのスケール: 前へ 0.6m でほぼ 1.0 になる", () => {
  const c = COMBAT_REACH.handModel;
  assert.equal(mapRange(1.0, c.minRatio, c.maxRatio) < 0.1, true, "構えで 0 付近にならない");
  assert.equal(mapRange(0.949, c.minRatio, c.maxRatio), 0, "真横に伸ばした腕を拾ってしまう");
  assert.ok(mapRange(1.343, c.minRatio, c.maxRatio) > 0.9, "前へ 0.6m で 1 に届かない");
});

test("手の骨格（デバッグ PIP 用）は 21 点の範囲に収まり、5 本指すべてを含む", async () => {
  const { HAND_CONNECTIONS, HL } = await import("../examples/games/boxing/pose.js");
  for (const [a, b] of HAND_CONNECTIONS) {
    assert.ok(a >= 0 && a <= 20 && b >= 0 && b <= 20, `範囲外の index: ${a}-${b}`);
    assert.notEqual(a, b);
  }
  const touched = new Set(HAND_CONNECTIONS.flat());
  for (const tip of [4, 8, 12, 16, 20]) assert.ok(touched.has(tip), `指先 ${tip} が描かれない`);
  assert.ok(touched.has(HL.wrist) && touched.has(HL.middleMcp), "手のひら長に使う点が描かれない");
});

// ── 「拳を戻したのに腕が伸びっぱなし」への対処 ────────────────────────────────
// 実機で一番効いた不具合。推定が高いまま張り付いても、手が構え領域に戻ったら
// リーチは速やかに 0 へ戻らなければならない。
test("構えに戻せば 300ms 以内に reach < 0.2（推定が高いまま張り付いても引き戻す）", () => {
  const filter = new ReachFilter(TUNING.reach);
  let t = 0;
  for (let i = 0; i < 30; i++) { t += DT * 1000; filter.update(0.95, DT, {}); } // 伸ばしきり
  assert.ok(filter.value > 0.85, `伸ばしきりに達していない (${filter.value.toFixed(2)})`);
  // 手は構えに戻したが、推定は 0.95 のまま張り付いている（手を見失った等）状況
  let elapsed = 0;
  while (elapsed < 300) { elapsed += DT * 1000; filter.update(0.95, DT, { inHome: true }); }
  assert.ok(filter.value < 0.2, `構えに戻しても戻らない (${filter.value.toFixed(2)})`);
});

test("構え領域の判定: 胸の前で低速なら home、伸ばした先や高速移動中は home ではない", () => {
  const c = TUNING.reach.home;
  // 座標は鼻を原点にした肩幅正規化（y は下が +）
  assert.equal(isHome({ x: 0.25, y: 0.35 }, 0.2, c), true, "胸の前が home にならない");
  assert.equal(isHome({ x: 0.25, y: 0.35 }, 5.0, c), false, "高速で動いていても home 扱いになる");
  assert.equal(isHome({ x: 0.2, y: 1.8 }, 0.2, c), false, "腕を下ろした位置まで home 扱い");
  assert.equal(isHome(null, 0.2, c), false);
});

test("スイング後の強制復帰: forceHome でフィルタ内部ごと 0 に戻る", () => {
  const filter = new ReachFilter(TUNING.reach);
  for (let i = 0; i < 30; i++) filter.update(0.9, DT, {});
  filter.forceHome();
  assert.equal(filter.value, 0);
  // 直後に高い生値が来ても、跳ね返らずスルーレート内で上がる
  const after = filter.update(0.9, DT, {});
  assert.ok(after <= TUNING.reach.slewUp * DT + 1e-6, `跳ね返った (${after.toFixed(3)})`);
});

test("見失った信号は合成から外れる（保持しない）", () => {
  const cfg = { combine: "median", weights: { angle: 0.15, shorten: 0.15, handSize: 0.3, handModel: 0.5, depthZ: 0.4 } };
  const extended = { angle: 1, shorten: 0.3, handSize: 0.95, handModel: 0.98, depthZ: 1 };
  assert.ok(combineSignals(extended, cfg) > 0.9);
  // 手を見失い（handModel/handSize = null）、構えに戻して z も戻った状態
  const back = { angle: 1, shorten: 0, handSize: null, handModel: null, depthZ: 0 };
  assert.ok(combineSignals(back, cfg) < 0.2, "見失った手の値が残って高いままになる");
});
