// examples/games/boxing の当たり判定と体の合成（combat.js は純関数なので node で回せる）。
//
// このデモの肝は「見えている位置＝当たる位置」であること。描画（scene3d.js）も判定
// （boxing.js）も同じ combat.js を通すので、ここが守られていれば両者はずれない。
//
// 特に守りたいルール:
//   ・単眼カメラに奥行きは無いので、前方リーチ（2D から推定）で拳が敵まで届くこと
//   ・ガードは「腕がグローブの通り道にあるか」だけで決まること（ジェスチャー判定ではない）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlayerPose, buildEnemyPose, attackPathT, enemyGlovePos, resolveEnemyGlove, resolvePlayerGlove,
  sphereHitsCapsule, closestPointOnSegment, dist, v3, lerpV, solveIK, resolveHit,
} from "../examples/games/boxing/combat.js";
import { COMBAT } from "../examples/games/boxing/tuning.js";

/** 構え（腕を軽くたたんだ状態）の体基準 2D フレーム。 */
const frame = (reachL = 0, reachR = 0, head = { x: 0, y: 0 }) => ({
  head,
  arms: {
    left: { elbow: { x: -0.35, y: 0.35 }, wrist: { x: -0.2, y: 0.1 }, reach: reachL },
    right: { elbow: { x: 0.35, y: 0.35 }, wrist: { x: 0.2, y: 0.1 }, reach: reachR },
  },
});
const enemyHead = () => v3(0, COMBAT.enemy.headY, -COMBAT.enemyDist);

test("左右: プレイヤーの右手は +X（画面右）、左手は -X に来る", () => {
  const pose = buildPlayerPose(frame(), COMBAT.rig);
  assert.ok(pose.right.wrist.x > 0, `right.x=${pose.right.wrist.x}`);
  assert.ok(pose.left.wrist.x < 0, `left.x=${pose.left.wrist.x}`);
  assert.ok(pose.shoulders.right.x > pose.shoulders.left.x);
});

test("奥行き: reach で前へ伸びるが、骨の長さは超えない（間合いが意味を持つ）", () => {
  const back = buildPlayerPose(frame(0, 0), COMBAT.rig).right;
  const mid = buildPlayerPose(frame(0, 0.5), COMBAT.rig).right;
  const full = buildPlayerPose(frame(0, 1), COMBAT.rig);
  assert.ok(mid.wrist.z < back.wrist.z, "reach 0.5 で前に出る");
  assert.ok(full.right.wrist.z < mid.wrist.z, "reach 1.0 でさらに前に出る");

  // 骨は伸びない: 手首は肩から (上腕 + 前腕) を超えない
  const maxArm = COMBAT.rig.bones.upperArm + COMBAT.rig.bones.foreArm;
  for (const r of [0, 0.5, 1]) {
    const p = buildPlayerPose(frame(0, r), COMBAT.rig);
    assert.ok(dist(p.right.wrist, p.shoulders.right) <= maxArm + 1e-6,
      `reach=${r} で腕が伸びている (${dist(p.right.wrist, p.shoulders.right).toFixed(3)} > ${maxArm})`);
  }

  // 開始距離では届かず、間合い（footwork.preferredDist）まで詰めればガードの隙に入る
  const atDist = (d, mode) => {
    const o = mode === "open" ? COMBAT.enemy.open : COMBAT.enemy.guard;
    const head = v3(0, COMBAT.enemy.headY, -d);
    const gloves = { left: v3(head.x - o.x, head.y + o.y, head.z + o.z), right: v3(head.x + o.x, head.y + o.y, head.z + o.z) };
    const enemy = buildEnemyPose({ x: 0, z: -d }, gloves, COMBAT);
    return resolvePlayerGlove(full.right.wrist, COMBAT.player.gloveRadius, enemy, COMBAT);
  };
  assert.equal(atDist(COMBAT.enemyDist, "open"), null, "開始距離で届いてしまう（間合いが無意味）");
  assert.equal(atDist(COMBAT.footwork.preferredDist, "open"), "head", "間合いまで詰めても頭に届かない");
  assert.equal(atDist(COMBAT.footwork.preferredDist, "guard"), "guard", "ガード中の相手に素通しで入る");
});

test("肘は手首より手前（elbowFrac 分だけしか前に出ない）", () => {
  const pose = buildPlayerPose(frame(0, 1), COMBAT.rig);
  assert.ok(pose.right.elbow.z > pose.right.wrist.z, "肘が手首より前に出ている");
  assert.ok(pose.right.elbow.z < pose.shoulders.right.z, "肘が肩より後ろにある");
});

test("頭は左右のリーン / ダックで動く（＝避けられる）", () => {
  const straight = buildPlayerPose(frame(0, 0, { x: 0, y: 0 }), COMBAT.rig).head;
  const leanRight = buildPlayerPose(frame(0, 0, { x: 0.45, y: 0 }), COMBAT.rig).head;
  const ducked = buildPlayerPose(frame(0, 0, { x: 0, y: 0.5 }), COMBAT.rig).head;
  assert.ok(leanRight.x > straight.x + COMBAT.player.headRadius, "リーンで頭半径以上動かない＝避けられない");
  assert.ok(ducked.y < straight.y - COMBAT.player.headRadius, "ダックで頭半径以上下がらない＝避けられない");
});

test("ガードは位置で決まる: 腕が通り道にあれば block、無ければ head に届いて hit", () => {
  const head = v3(0, 0, 0);
  // 腕を頭の前に置いた姿勢（手動で組む: グローブが頭の 0.2m 前）
  const guarding = {
    head,
    left: { elbow: v3(-0.2, -0.25, 0.05), wrist: v3(-0.09, -0.02, -0.2) },
    right: { elbow: v3(0.2, -0.25, 0.05), wrist: v3(0.09, -0.02, -0.2) },
  };
  const open = {
    head,
    left: { elbow: v3(-0.25, -0.3, 0.05), wrist: v3(-0.3, -0.5, 0.05) },
    right: { elbow: v3(0.25, -0.3, 0.05), wrist: v3(0.3, -0.5, 0.05) },
  };
  const R = COMBAT.enemy.gloveRadius;
  const incoming = v3(0.05, -0.02, -0.22); // 正面から頭へ向かう途中
  assert.equal(resolveEnemyGlove(incoming, R, guarding, COMBAT), "block");
  assert.equal(resolveEnemyGlove(incoming, R, open, COMBAT), null, "腕が無ければまだ届いていない");
  assert.equal(resolveEnemyGlove(v3(0, 0, -0.05), R, open, COMBAT), "head", "頭まで来れば被弾");
  // 頭に到達しても腕が間にあればガードが優先される
  assert.equal(resolveEnemyGlove(v3(0, 0, -0.05), R, guarding, COMBAT), "block");
});

test("前腕（カプセル）でもガードできる（グローブ球だけではない）", () => {
  const head = v3(0, 0, 0);
  const pose = {
    head,
    left: { elbow: v3(-0.28, -0.3, -0.18), wrist: v3(0.05, -0.05, -0.18) }, // 前腕を顔の前で横に構える
    right: { elbow: v3(0.5, -0.5, 0.2), wrist: v3(0.6, -0.6, 0.2) },        // 右手は下ろしている
  };
  const onForearm = v3(-0.12, -0.18, -0.2); // グローブ球からは離れているが前腕の上
  assert.ok(dist(onForearm, pose.left.wrist) > COMBAT.enemy.gloveRadius + COMBAT.player.gloveRadius,
    "この点はグローブ球には触れていない前提");
  assert.equal(resolveEnemyGlove(onForearm, COMBAT.enemy.gloveRadius, pose, COMBAT), "block");
});

test("敵側: 腕（グローブ/前腕/上腕）に当たれば guard、開いていれば頭 / 胴に入る", () => {
  const d = COMBAT.footwork.preferredDist;
  const root = { x: 0, z: -d };
  const head = v3(0, COMBAT.enemy.headY, -d);
  const posed = (mode) => {
    const o = mode === "open" ? COMBAT.enemy.open : COMBAT.enemy.guard;
    return buildEnemyPose(root, {
      left: v3(head.x - o.x, head.y + o.y, head.z + o.z),
      right: v3(head.x + o.x, head.y + o.y, head.z + o.z),
    }, COMBAT);
  };
  const guarding = posed("guard"), open = posed("open");
  const R = COMBAT.player.gloveRadius;
  // ガードのグローブそのものに当てれば弾かれる
  assert.equal(resolvePlayerGlove(guarding.right.wrist, R, guarding, COMBAT), "guard");
  // 前腕の途中でも弾かれる（グローブ球だけではない）
  const foreMid = lerpV(guarding.right.elbow, guarding.right.wrist, 0.5);
  assert.equal(resolvePlayerGlove(foreMid, R, guarding, COMBAT), "guard");
  // 腕が下りていれば頭・胴に入る
  assert.equal(resolvePlayerGlove(head, R, open, COMBAT), "head");
  assert.equal(resolvePlayerGlove(v3(0, COMBAT.enemy.torsoTopY - 0.1, -d), R, open, COMBAT), "torso");
  assert.equal(resolvePlayerGlove(v3(0, 0, 0), R, open, COMBAT), null, "自分の手前で当たってしまう");
});

test("攻撃の進行: approach → strike → retract → done、経路端は from / aim に一致", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800, strikeMs: 130, retractMs: 300 };
  assert.equal(attackPathT(0, cfg).phase, "approach");
  assert.equal(attackPathT(400, cfg).phase, "approach");
  assert.ok(attackPathT(799, cfg).s < cfg.approachFrac + 1e-6, "approach 中は経路の approachFrac まで");
  assert.equal(attackPathT(cfg.approachMs + 10, cfg).phase, "strike");
  assert.equal(attackPathT(cfg.approachMs + cfg.strikeMs + 10, cfg).phase, "retract");
  assert.equal(attackPathT(cfg.approachMs + cfg.strikeMs + cfg.retractMs + 1, cfg).phase, "done");
  // 打ち切りの s は 1（＝狙点に到達）
  const end = attackPathT(cfg.approachMs + cfg.strikeMs - 1, cfg);
  assert.ok(end.s > 0.99, `s=${end.s}`);

  const from = v3(0.15, 0, -1.0), aim = v3(0, 0, 0);
  const straight = { kind: "straight", side: 0 };
  assert.deepEqual(enemyGlovePos(from, aim, 0, straight, cfg), from);
  const at1 = enemyGlovePos(from, aim, 1, straight, cfg);
  assert.ok(dist(at1, aim) < 1e-9, "s=1 で狙点に届く");
  // フックは途中で横に膨らむ（真っ直ぐ来ない＝横から回り込む）
  const hookMid = enemyGlovePos(from, aim, 0.5, { kind: "hook", side: 1 }, cfg);
  const lineMid = enemyGlovePos(from, aim, 0.5, straight, cfg);
  assert.ok(hookMid.x > lineMid.x + 0.1, "フックが横に膨らんでいない");
});

test("幾何ヘルパ: 線分上の最近点とカプセル判定", () => {
  const a = v3(-1, 0, 0), b = v3(1, 0, 0);
  assert.deepEqual(closestPointOnSegment(v3(0, 0.5, 0), a, b), v3(0, 0, 0));
  assert.deepEqual(closestPointOnSegment(v3(-5, 0, 0), a, b), a, "線分の外は端点に丸める");
  assert.ok(sphereHitsCapsule(v3(0, 0.3, 0), 0.2, a, b, 0.15));
  assert.ok(!sphereHitsCapsule(v3(0, 0.6, 0), 0.2, a, b, 0.15));
});

// boxing.js のフレームループがやっていること（攻撃を進める → 毎フレーム判定 → 最初に触れた
// ものが結果）を時間軸で再現する。腕を頭の前に置いたか否かだけで block / hit が分かれる。
function simulateAttack({ pose, attack = { kind: "straight", side: 0 }, from, aim, cfg }) {
  let resolved = null, minHeadDist = Infinity, t = 0;
  const total = cfg.approachMs + cfg.strikeMs;
  while (t <= total) {
    const { s } = attackPathT(t, cfg);
    const glove = enemyGlovePos(from, aim, s, attack, cfg);
    minHeadDist = Math.min(minHeadDist, dist(glove, pose.head));
    const hit = resolveEnemyGlove(glove, COMBAT.enemy.gloveRadius, pose, COMBAT);
    if (hit) { resolved = hit; break; }
    t += 16; // ~60fps
  }
  return { resolved, minHeadDist, dodged: !resolved && minHeadDist < cfg.dodgeNear };
}

test("接近してくる敵グローブ: 腕を頭の前に置けば block、下ろしていれば hit", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800, strikeMs: 130, retractMs: 300 };
  const head = v3(0, 0, 0);
  const from = v3(COMBAT.enemy.guard.x, COMBAT.enemy.guard.y, -COMBAT.enemyDist + COMBAT.enemy.guard.z);
  const guarding = {
    head,
    left: { elbow: v3(-0.2, -0.26, 0.04), wrist: v3(-0.09, -0.02, -0.19) },
    right: { elbow: v3(0.2, -0.26, 0.04), wrist: v3(0.09, -0.02, -0.19) },
  };
  const armsDown = {
    head,
    left: { elbow: v3(-0.24, -0.32, 0.05), wrist: v3(-0.3, -0.62, 0.05) },
    right: { elbow: v3(0.24, -0.32, 0.05), wrist: v3(0.3, -0.62, 0.05) },
  };
  assert.equal(simulateAttack({ pose: guarding, from, aim: head, cfg }).resolved, "block");
  assert.equal(simulateAttack({ pose: armsDown, from, aim: head, cfg }).resolved, "head");
});

test("狙点は攻撃開始時の頭に固定される: あとで頭をどければ空振り（dodge）になる", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800, strikeMs: 130, retractMs: 300 };
  const aimedAt = v3(0, 0, 0);                       // 攻撃開始時にここを狙われた
  const from = v3(COMBAT.enemy.guard.x, COMBAT.enemy.guard.y, -COMBAT.enemyDist + COMBAT.enemy.guard.z);
  const armsDown = (head) => ({
    head,
    left: { elbow: v3(head.x - 0.24, head.y - 0.32, 0.05), wrist: v3(head.x - 0.3, head.y - 0.62, 0.05) },
    right: { elbow: v3(head.x + 0.24, head.y - 0.32, 0.05), wrist: v3(head.x + 0.3, head.y - 0.62, 0.05) },
  });
  // 頭を動かさなければ当たる
  assert.equal(simulateAttack({ pose: armsDown(aimedAt), from, aim: aimedAt, cfg }).resolved, "head");
  // 横へ 0.28m 逃げると当たらず、かすめて通る（＝回避成立）
  const leaned = simulateAttack({ pose: armsDown(v3(0.28, 0, 0)), from, aim: aimedAt, cfg });
  assert.equal(leaned.resolved, null);
  assert.ok(leaned.dodged, `かすらず遠すぎ (minHeadDist=${leaned.minHeadDist.toFixed(3)})`);
  // しゃがんでも同様
  const ducked = simulateAttack({ pose: armsDown(v3(0, -0.3, 0)), from, aim: aimedAt, cfg });
  assert.equal(ducked.resolved, null);
});

test("胴狙い: 前腕を下げていれば block、上げたままなら胴に入る", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800, strikeMs: 130, retractMs: 300 };
  const head = v3(0, 0, 0);
  const torsoTop = v3(0, -0.24, 0.06);
  const torsoBottom = v3(0, -0.24 - COMBAT.rig.torsoLength, 0.06);
  const bodyAim = v3(torsoTop.x, torsoTop.y + (torsoBottom.y - torsoTop.y) * COMBAT.attack.torsoAimFrac, torsoTop.z);
  const from = v3(COMBAT.enemy.guard.x, COMBAT.enemy.guard.y, -COMBAT.enemyDist + COMBAT.enemy.guard.z);
  // 顔の前で構えたまま（胴ががら空き）
  const highGuard = { head, torsoTop, torsoBottom,
    left: { elbow: v3(-0.2, -0.26, 0.04), wrist: v3(-0.09, -0.02, -0.19) },
    right: { elbow: v3(0.2, -0.26, 0.04), wrist: v3(0.09, -0.02, -0.19) } };
  // 前腕を下げて胴の前に置いた（ボディガード）
  const bodyGuard = { head, torsoTop, torsoBottom,
    left: { elbow: v3(-0.22, -0.3, 0.04), wrist: v3(-0.02, -0.42, -0.16) },
    right: { elbow: v3(0.22, -0.3, 0.04), wrist: v3(0.02, -0.42, -0.16) } };
  assert.equal(simulateAttack({ pose: highGuard, from, aim: bodyAim, cfg }).resolved, "torso");
  assert.equal(simulateAttack({ pose: bodyGuard, from, aim: bodyAim, cfg }).resolved, "block");
});

test("胴狙いも体ごと横へ逃げれば当たらない（headGain / shoulderFollow の効き）", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800, strikeMs: 130, retractMs: 300 };
  const straight = buildPlayerPose(frame(0, 0, { x: 0, y: 0 }), COMBAT.rig);
  const bodyAim = v3(straight.torsoTop.x,
    straight.torsoTop.y + (straight.torsoBottom.y - straight.torsoTop.y) * COMBAT.attack.torsoAimFrac,
    straight.torsoTop.z);
  const from = v3(COMBAT.enemy.guard.x, COMBAT.enemy.guard.y, -COMBAT.enemyDist + COMBAT.enemy.guard.z);
  // 腕を判定の外へどけた姿勢を作り、リーン単体の効きだけを見る
  const armsOut = (headX) => {
    const pose = buildPlayerPose(frame(0, 0, { x: headX, y: 0 }), COMBAT.rig);
    // 腕を判定の外（体の真横〜後ろ）へどけて、リーン単体の効きだけを見る
    for (const side of ["left", "right"]) {
      const sign = side === "left" ? -1 : 1;
      const sh = pose.shoulders[side];
      pose[side] = { elbow: v3(sh.x + sign * 0.5, sh.y - 0.2, sh.z + 0.45),
        wrist: v3(sh.x + sign * 0.7, sh.y - 0.4, sh.z + 0.7), reach: 0 };
    }
    return pose;
  };
  assert.equal(simulateAttack({ pose: armsOut(0), from, aim: bodyAim, cfg }).resolved, "torso", "棒立ちなら当たる");
  assert.equal(simulateAttack({ pose: armsOut(0.5), from, aim: bodyAim, cfg }).resolved, null, "リーンで胴を外せない");
  // 参考: 胸の高さで構えているだけでは腹は守れない（腕を下げるガードが要る＝上のテスト）
  assert.equal(simulateAttack({ pose: straight, from, aim: bodyAim, cfg }).resolved, "torso");
});

// ── 骨長固定（2 ボーン IK）と左右対称の当たり判定 ────────────────────────────
test("IK: 目標が遠くても手首は肩から (上腕+前腕) を超えない", () => {
  const sh = v3(0, 0, 0);
  const l1 = 0.32, l2 = 0.30;
  for (const target of [v3(0, 0, -5), v3(3, 2, -1), v3(0.1, 0, -0.05)]) {
    const ik = solveIK(sh, target, l1, l2, v3(1, -1, 0));
    assert.ok(dist(sh, ik.wrist) <= l1 + l2 + 1e-9, `腕が伸びた (${dist(sh, ik.wrist).toFixed(3)})`);
    // 骨の長さそのものが保たれている
    assert.ok(Math.abs(dist(sh, ik.elbow) - l1) < 1e-6, `上腕長が変わった (${dist(sh, ik.elbow).toFixed(4)})`);
    assert.ok(Math.abs(dist(ik.elbow, ik.wrist) - l2) < 1e-6, `前腕長が変わった (${dist(ik.elbow, ik.wrist).toFixed(4)})`);
  }
  // 届かない目標では reached=false（＝間合いが足りない）
  assert.equal(solveIK(sh, v3(0, 0, -5), l1, l2, v3(1, -1, 0)).reached, false);
  assert.equal(solveIK(sh, v3(0, 0, -0.4), l1, l2, v3(1, -1, 0)).reached, true);
});

test("IK: 肘は曲げヒント側へ張り出す", () => {
  const sh = v3(0, 0, 0), target = v3(0, 0, -0.4);
  const right = solveIK(sh, target, 0.32, 0.30, v3(1, 0, 0));
  const left = solveIK(sh, target, 0.32, 0.30, v3(-1, 0, 0));
  const down = solveIK(sh, target, 0.32, 0.30, v3(0, -1, 0));
  assert.ok(right.elbow.x > 0.05, `右ヒントで肘が右に出ない (${right.elbow.x.toFixed(3)})`);
  assert.ok(left.elbow.x < -0.05, "左ヒントで肘が左に出ない");
  assert.ok(down.elbow.y < -0.05, "下ヒントで肘が下に出ない");
});

test("左右対称: 同じ resolveHit で、プレイヤー / 敵とも 腕 > 頭 > 胴 の順に判定される", () => {
  const d = COMBAT.footwork.preferredDist;
  const head = v3(0, COMBAT.enemy.headY, -d);
  const g = COMBAT.enemy.guard;
  const enemy = buildEnemyPose({ x: 0, z: -d }, {
    left: v3(head.x - g.x, head.y + g.y, head.z + g.z),
    right: v3(head.x + g.x, head.y + g.y, head.z + g.z),
  }, COMBAT);
  const player = buildPlayerPose(frame(0, 0), COMBAT.rig);
  // 敵の腕（上腕の途中）に当てても guard
  const upperMid = lerpV(enemy.shoulders.right, enemy.right.elbow, 0.5);
  assert.equal(resolveHit(upperMid, COMBAT.player.gloveRadius, enemy, COMBAT.enemy), "guard");
  // プレイヤー側も同じ関数・同じ順序で効く（腕が前にあれば頭より先に当たる）
  assert.equal(resolveHit(player.right.wrist, COMBAT.enemy.gloveRadius, player, COMBAT.player), "guard");
  assert.equal(resolveHit(player.head, COMBAT.enemy.gloveRadius, { ...player, left: null, right: null }, COMBAT.player), "head");
});
