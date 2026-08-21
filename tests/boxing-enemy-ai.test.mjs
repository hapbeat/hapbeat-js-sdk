// examples/games/boxing の敵 AI（enemy-ai.js は純ロジックなので node で回せる）。
//
// このデモの敵に求めているのは「強さ」ではなく **攻守のメリハリと、読める予告**。
// なので次の 3 つを守れているかをここで固定する:
//   ・フェーズ（観察 / 攻勢 / 守勢 / 疲れ）が時間とイベントの両方で切り替わる
//   ・攻撃ごとに予備動作（telegraph）と隙（recover）が仕様どおり付く
//   ・プレイヤーの癖（ガード高で固まる / 同じ側に逃げる / 空振り）に反応が返る
// 乱数は注入するので、確率のかかった枝も決定的に踏める。
import assert from "node:assert/strict";
import { test } from "node:test";
import { EnemyAI, pickWeighted } from "../examples/games/boxing/enemy-ai.js";
import { AI } from "../examples/games/boxing/tuning.js";

/** 常に同じ値を返す rng（0 に近い＝確率判定を必ず通す / 1 に近い＝必ず外す）。 */
const constRng = (v) => () => v;
const cfg = (over = {}) => ({ ...structuredClone(AI), ...over });

const baseCtx = (over = {}) => ({
  nowMs: 0, dist: 0.68, preferredDist: 0.68, deadZone: 0.1,
  inRange: true, busy: false,
  player: { guardHigh: false, guardLow: false, swinging: false, lean: 0, ducking: false, stepIn: false, stepBack: false },
  hp: { self: 1, player: 1 }, elapsed: 0,
  ...over,
});

/** 何も起きない時間を進める。attack intent が出たら（既定では）そのまま捨てる。 */
function run(ai, { fromMs = 0, ms, stepMs = 50, ctx = {}, onAttack } = {}) {
  const out = [];
  for (let t = fromMs; t < fromMs + ms; t += stepMs) {
    const intents = ai.update(baseCtx({ nowMs: t, ...ctx }), stepMs / 1000);
    if (intents.attack) {
      out.push({ t, ...intents.attack });
      if (onAttack) onAttack(intents.attack, t);
    }
  }
  return out;
}

test("pickWeighted: 重み 0 の項目は選ばれず、合計 0 なら null", () => {
  assert.equal(pickWeighted({ a: 1, b: 0 }, constRng(0.99)), "a");
  assert.equal(pickWeighted({ a: 0, b: 0 }, constRng(0.5)), null);
});

// ── フェーズ遷移 ──────────────────────────────────────────────────────────────
test("台本モード: OBSERVE → AGGRESSIVE → DEFENSIVE → AGGRESSIVE の順で切り替わる", () => {
  const c = cfg();
  const ai = new EnemyAI(c, constRng(0.5));
  const seen = [];
  for (let t = 0; t < 26000; t += 100) {
    const i = ai.update(baseCtx({ nowMs: t, dist: 0.68 }), 0.1);
    if (seen[seen.length - 1] !== i.phase) seen.push(i.phase);
  }
  assert.deepEqual(seen.slice(0, 4), ["OBSERVE", "AGGRESSIVE", "DEFENSIVE", "AGGRESSIVE"]);
});

test("台本の各フェーズは指定秒だけ続く（OBSERVE 5s）", () => {
  const ai = new EnemyAI(cfg(), constRng(0.5));
  assert.equal(ai.update(baseCtx({ nowMs: 4900 }), 0.1).phase, "OBSERVE");
  assert.equal(ai.update(baseCtx({ nowMs: 5100 }), 0.1).phase, "AGGRESSIVE");
});

test("被弾が閾値に達したら、時間を待たずに FATIGUE へ落ちる（プレイヤーの山場）", () => {
  const ai = new EnemyAI(cfg(), constRng(0.5));
  ai.update(baseCtx({ nowMs: 100 }), 0.1);
  for (let i = 0; i < AI.fatigueTriggerDamage; i++) ai.noteEvent({ type: "tookHit", nowMs: 200, part: "torso" });
  const intents = ai.update(baseCtx({ nowMs: 300 }), 0.1);
  assert.equal(intents.phase, "FATIGUE");
  assert.equal(intents.guard, "open", "疲れている間は腕が下がって頭が開く");
});

test("空振りが続いても FATIGUE に落ちる", () => {
  const ai = new EnemyAI(cfg(), constRng(0.5));
  ai.update(baseCtx({ nowMs: 100 }), 0.1);
  for (let i = 0; i < AI.fatigueTriggerWhiffs; i++) {
    ai.noteEvent({ type: "attackEnd", nowMs: 200, kind: "jab", target: "head", outcome: "miss" });
  }
  assert.equal(ai.update(baseCtx({ nowMs: 300 }), 0.1).phase, "FATIGUE");
});

test("OBSERVE 中でも間合いを詰められたら攻勢へ早期遷移する", () => {
  const ai = new EnemyAI(cfg(), constRng(0.5));
  const intents = ai.update(baseCtx({ nowMs: 100, dist: AI.closeDist - 0.05 }), 0.1);
  assert.equal(intents.phase, "AGGRESSIVE");
});

test("台本を切ると最初から抽選（OBSERVE の後は攻勢 ↔ 守勢を往復する）", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.5));
  const seen = [];
  for (let t = 0; t < 40000; t += 100) {
    const i = ai.update(baseCtx({ nowMs: t }), 0.1);
    if (seen[seen.length - 1] !== i.phase) seen.push(i.phase);
  }
  assert.equal(seen[0], "OBSERVE");
  assert.ok(seen.includes("AGGRESSIVE") && seen.includes("DEFENSIVE"), seen.join(","));
});

// ── 攻撃のパラメータ ──────────────────────────────────────────────────────────
test("OBSERVE 中はジャブしか出さない（様子見）", () => {
  const ai = new EnemyAI(cfg(), constRng(0.99));   // フェイント抽選は必ず外す
  const shots = run(ai, { ms: 4800, ctx: {} });
  assert.ok(shots.length > 0, "1 発は出る");
  assert.ok(shots.every((a) => a.kind === "jab"), shots.map((a) => a.kind).join(","));
});

test("予備動作 / 判定 / 隙は tuning の値 × telegraphLengthScale になる", () => {
  const c = cfg({ script: false, telegraphLengthScale: 2 });
  const ai = new EnemyAI(c, constRng(0.99));
  const atk = ai._makeAttack("hook", "right", "head", {});
  assert.equal(atk.telegraphMs, AI.attacks.hook.telegraphMs * 2);
  assert.equal(atk.strikeMs, AI.attacks.hook.strikeMs);
  assert.equal(atk.recoverMs, AI.attacks.hook.recoverMs);
  assert.equal(atk.side, 1, "右フックは +X 側へ膨らむ");
});

test("FATIGUE の攻撃は予備動作が伸びる＝見てから殴り返せる", () => {
  const ai = new EnemyAI(cfg(), constRng(0.1));
  ai._enterPhase("FATIGUE", 0);
  const atk = ai._makeAttack("jab", "right", "head", {});
  assert.ok(atk.telegraphMs > AI.attacks.jab.telegraphMs * AI.telegraphLengthScale,
    `${atk.telegraphMs}`);
});

test("フェイントは予備動作の途中で捨てる指示（feint フラグ + キャンセル位置）を持つ", () => {
  // feintRate 1.0 で必ずフェイントを引く
  const ai = new EnemyAI(cfg({ script: false, feintRate: 1 }), constRng(0.0));
  ai._enterPhase("AGGRESSIVE", 0);
  const shots = run(ai, { fromMs: 1000, ms: 3000 });
  assert.ok(shots.length > 0);
  assert.equal(shots[0].kind, "feint");
  assert.equal(shots[0].feint, true);
  assert.equal(shots[0].feintCancelFrac, AI.feintCancelFrac);
});

test("コンビネーションは 2 発目以降が予備動作なしで続き、隙は最後だけ大きい", () => {
  const ai = new EnemyAI(cfg({ script: false, feintRate: 0 }), constRng(0.5));
  ai._enterPhase("AGGRESSIVE", 0);
  const first = ai._startCombo("left");
  assert.equal(first.combo.index, 0);
  assert.ok(first.telegraphMs > 0, "1 発目には予備動作がある");
  const rest = [];
  // 1 発ごとに「終わった」と伝えると、次弾が即座に出る（間を空けない）
  for (let i = 0; i < first.combo.total - 1; i++) {
    ai.noteEvent({ type: "attackEnd", nowMs: 500 + i, kind: "jab", target: "head", outcome: "miss" });
    const intents = ai.update(baseCtx({ nowMs: 500 + i }), 0.016);
    assert.ok(intents.attack, `${i + 2} 発目が出ていない`);
    rest.push(intents.attack);
  }
  assert.ok(rest.every((a) => a.telegraphMs === 0), rest.map((a) => a.telegraphMs).join(","));
  assert.equal(rest[rest.length - 1].recoverMs, AI.attacks.combo.recoverMs);
  assert.equal(first.hand === "left" ? "right" : "left", rest[0].hand, "左右交互に出す");
});

test("コンビネーションは 1 発目を止められたら畳む（当たらない連打を続けない）", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.5));
  ai._startCombo("left");
  ai.noteEvent({ type: "attackEnd", nowMs: 500, kind: "jab", target: "head", outcome: "block" });
  assert.equal(ai.comboQueue.length, 0);
});

// ── プレイヤーへの反応（design doc §5 の表） ──────────────────────────────────
test("頭を続けてガードされたら胴へ切り替える（単発の狙いが胴になる）", () => {
  // コンビネーションは頭から入って最後に胴へ落とすので、ここでは単発だけを見る
  const c = cfg({ script: false, feintRate: 0 });
  c.attackWeights.AGGRESSIVE = { jab: 1, straight: 1, hook: 1 };
  const ai = new EnemyAI(c, constRng(0.99));
  ai._enterPhase("AGGRESSIVE", 0);
  for (let i = 0; i < AI.reaction.headWindow; i++) {
    ai.noteEvent({ type: "attackEnd", nowMs: 100 * i, kind: "jab", target: "head", outcome: "block" });
  }
  const shots = run(ai, { fromMs: 1000, ms: 6000 });
  assert.ok(shots.length > 0);
  assert.ok(shots.every((a) => a.target === "torso"), shots.map((a) => a.target).join(","));
});

test("スイングを見たらスリップ → カウンター（確率を通した場合）", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.0)); // counterChance を必ず通す
  ai._enterPhase("AGGRESSIVE", 0);
  ai.noteEvent({ type: "playerSwingStart", nowMs: 1000, side: "right" });
  const slip = ai.update(baseCtx({ nowMs: 1050 }), 0.05);
  assert.equal(slip.state, "SlipDuck");
  assert.ok(slip.footworkScale > 1, "横へ素早く外す");
  assert.equal(slip.slip, -1, "右手が来たら逆（-X）へ");
  const counter = ai.update(baseCtx({ nowMs: 1000 + AI.slipMs + 10 }), 0.05);
  assert.equal(counter.attack?.kind, "counter");
  assert.equal(counter.attack.telegraphMs, Math.round(AI.attacks.counter.telegraphMs * AI.telegraphLengthScale));
});

test("カウンターの抽選を外した場合はスリップしない", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.99));
  ai._enterPhase("AGGRESSIVE", 0);
  ai.noteEvent({ type: "playerSwingStart", nowMs: 1000, side: "right" });
  assert.equal(ai.update(baseCtx({ nowMs: 1050 }), 0.05).state !== "SlipDuck", true);
});

test("空振りを見たら次の攻撃を前倒しする", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.99));
  ai.nextAttackAtMs = 9999;
  ai.noteEvent({ type: "playerWhiff", nowMs: 1000, side: "left" });
  assert.equal(ai.nextAttackAtMs, 1000 + AI.whiffPunishDelayMs);
});

test("下がられたら詰める / 詰められすぎたら守勢は下がる", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.5));
  ai._enterPhase("AGGRESSIVE", 0);
  const far = ai.update(baseCtx({ nowMs: 100, dist: 1.2 }), 0.1);
  assert.equal(far.footwork, "approach");
  ai._enterPhase("DEFENSIVE", 200);
  const near = ai.update(baseCtx({ nowMs: 300, dist: 0.3 }), 0.1);
  assert.equal(near.footwork, "retreat");
});

test("ガードを上げたまま静止するとフェイントが増える", () => {
  const c = cfg({ script: false, feintRate: 0.2 });
  const ai = new EnemyAI(c, constRng(0.45));   // 0.2 では外れ、0.2*2.5=0.5 なら通る
  ai._enterPhase("AGGRESSIVE", 0);
  const guarding = { player: { ...baseCtx().player, guardHigh: true } };
  // まだ静止時間が足りない間はフェイントにならない
  const early = ai.update(baseCtx({ nowMs: 1000, ...guarding }), 0.1);
  assert.notEqual(early.attack?.kind, "feint");
  run(ai, { fromMs: 1000, ms: AI.reaction.guardStaticMs + 500, ctx: guarding });
  ai.nextAttackAtMs = 0;
  const late = ai.update(baseCtx({ nowMs: 5000, ...guarding }), 0.1);
  assert.equal(late.attack?.kind, "feint");
});

test("フェイント後にガードが崩れていればコンビネーションで畳みかける", () => {
  const ai = new EnemyAI(cfg({ script: false, feintRate: 0 }), constRng(0.5));
  ai._enterPhase("AGGRESSIVE", 0);
  ai.noteEvent({ type: "attackEnd", nowMs: 1000, kind: "feint", target: "head", outcome: "feint" });
  ai.nextAttackAtMs = 0;
  const intents = ai.update(baseCtx({ nowMs: 1100 }), 0.05);
  assert.ok(intents.attack?.combo, "コンビネーションが出ていない");
});

test("同じ側にばかりリーンすると、その逃げ先の手で打ってくる", () => {
  const ai = new EnemyAI(cfg({ script: false, feintRate: 0 }), constRng(0.99));
  ai._enterPhase("AGGRESSIVE", 0);
  const leaning = { player: { ...baseCtx().player, lean: 1 } };  // +X（画面右）へ逃げ続ける
  run(ai, { fromMs: 0, ms: 4000, ctx: leaning });
  ai.nextAttackAtMs = 0;
  const intents = ai.update(baseCtx({ nowMs: 5000, ...leaning }), 0.1);
  assert.equal(intents.attack?.hand, "right");
});

test("胴を打たれた直後はガードを下げる（打たれた部位に応じて構えが変わる）", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.5));
  ai._enterPhase("AGGRESSIVE", 0);
  ai.noteEvent({ type: "tookHit", nowMs: 1000, part: "torso" });
  assert.equal(ai.update(baseCtx({ nowMs: 1100 }), 0.1).guard, "low");
});

// ── 気絶 ──────────────────────────────────────────────────────────────────────
test("頭に短時間で連続被弾すると気絶し、時間が経つと復帰する", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.5));
  ai._enterPhase("AGGRESSIVE", 0);
  for (let i = 0; i < AI.stun.hits; i++) ai.noteEvent({ type: "tookHit", nowMs: 1000 + i * 100, part: "head" });
  const stunned = ai.update(baseCtx({ nowMs: 1200 }), 0.1);
  assert.equal(stunned.state, "Stunned");
  assert.equal(stunned.guard, "open", "腕が下がって頭が開く");
  assert.equal(stunned.attack, null, "気絶中は打ってこない");
  const back = ai.update(baseCtx({ nowMs: 1100 + AI.stun.durationMs + 100 }), 0.1);
  assert.notEqual(back.state, "Stunned");
});

test("攻撃モーション中（busy）は新しい攻撃を出さない", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.1));
  ai._enterPhase("AGGRESSIVE", 0);
  const shots = run(ai, { fromMs: 0, ms: 6000, ctx: { busy: true } });
  assert.equal(shots.length, 0);
});

test("片手しか届かない位置では、届く手で打つ（intent が捨てられないように）", () => {
  // コンビネーションは左右交互に出すので、ここでは単発だけを見る
  const c = cfg({ script: false, feintRate: 0 });
  c.attackWeights.AGGRESSIVE = { jab: 1, straight: 1, hook: 1 };
  const ai = new EnemyAI(c, constRng(0.99));
  ai._enterPhase("AGGRESSIVE", 0);
  const shots = run(ai, { fromMs: 0, ms: 6000, ctx: { handInRange: { left: true, right: false } } });
  assert.ok(shots.length > 0);
  assert.ok(shots.every((a) => a.hand === "left"), shots.map((a) => a.hand).join(","));
});

test("腕が届かない間合いでは打たずに詰める", () => {
  const ai = new EnemyAI(cfg({ script: false }), constRng(0.1));
  ai._enterPhase("AGGRESSIVE", 0);
  const shots = run(ai, { fromMs: 0, ms: 6000, ctx: { inRange: false, dist: 1.3 } });
  assert.equal(shots.length, 0);
});
