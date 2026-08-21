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
import { combineSignals, ReachFilter, SwingDetector, isGuardLocked } from "../examples/games/boxing/reach.js";
import { TUNING } from "../examples/games/boxing/tuning.js";

const DT = 1 / 30;
/** 再現可能な擬似乱数（テストを毎回同じ結果にする）。 */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => (((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1); // -1..1
}

test("1€ フィルタ: 静止時のノイズを潰しつつ、速いステップには追従する", () => {
  const rand = rng(7);
  const f = new OneEuro(TUNING.filter.landmark);
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    const out = f.filter(0.5 + rand() * 0.02, DT); // ±0.02 の静止ノイズ
    if (i > 30) peak = Math.max(peak, Math.abs(out - 0.5));
  }
  assert.ok(peak < 0.011, `静止ノイズが残りすぎ (±${peak.toFixed(4)})`); // 入力 ±0.02 の約半分まで落ちる

  const g = new OneEuro(TUNING.filter.landmark);
  for (let i = 0; i < 60; i++) g.filter(0, DT);
  let v = 0;
  for (let i = 0; i < 5; i++) v = g.filter(1, DT); // 5 フレーム(≈166ms)でステップ
  assert.ok(v > 0.65, `速い変化への追従が遅すぎ (${v.toFixed(3)})`);
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
