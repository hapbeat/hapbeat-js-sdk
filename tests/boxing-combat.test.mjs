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
  buildPlayerPose, attackPathT, enemyGlovePos, resolveEnemyGlove, resolvePlayerGlove,
  sphereHitsCapsule, closestPointOnSegment, dist, v3,
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

test("奥行き: reach を上げるとグローブが前（-Z）へ進み、reach=1 で敵の頭に届く", () => {
  const back = buildPlayerPose(frame(0, 0), COMBAT.rig).right.wrist;
  const mid = buildPlayerPose(frame(0, 0.5), COMBAT.rig).right.wrist;
  const full = buildPlayerPose(frame(0, 1), COMBAT.rig).right.wrist;
  assert.ok(mid.z < back.z, "reach 0.5 で前に出る");
  assert.ok(full.z < mid.z, "reach 1.0 でさらに前に出る");

  // reach=1 のとき、グローブ球が敵の頭球に接触できる距離まで到達している
  const reachDist = dist(full, enemyHead());
  const contact = COMBAT.player.gloveRadius + COMBAT.enemy.headRadius;
  assert.ok(reachDist <= contact, `reach=1 で敵の頭に届かない (dist=${reachDist.toFixed(3)}, contact=${contact.toFixed(3)})`);
  // 引いた状態では絶対に届かない（構えているだけで当たると成立しない）
  assert.ok(dist(back, enemyHead()) > contact * 3, "reach=0 でも届いてしまう");
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
  assert.equal(resolveEnemyGlove(v3(0, 0, -0.05), R, open, COMBAT), "hit", "頭まで来れば被弾");
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

test("敵側: ガード中はグローブに弾かれ、開いていれば頭/胴に入る", () => {
  const head = enemyHead();
  const gloves = {
    left: v3(head.x - COMBAT.enemy.guard.x, head.y + COMBAT.enemy.guard.y, head.z + COMBAT.enemy.guard.z),
    right: v3(head.x + COMBAT.enemy.guard.x, head.y + COMBAT.enemy.guard.y, head.z + COMBAT.enemy.guard.z),
  };
  const enemyUp = { head, gloves, guardUp: true,
    torsoTop: v3(0, COMBAT.enemy.torsoTopY, head.z), torsoBottom: v3(0, COMBAT.enemy.torsoBottomY, head.z) };
  const enemyOpen = { ...enemyUp, guardUp: false };
  const R = COMBAT.player.gloveRadius;
  assert.equal(resolvePlayerGlove(gloves.right, R, enemyUp, COMBAT), "guard");
  assert.equal(resolvePlayerGlove(head, R, enemyOpen, COMBAT), "head");
  assert.equal(resolvePlayerGlove(v3(0, COMBAT.enemy.torsoTopY - 0.1, head.z), R, enemyOpen, COMBAT), "torso");
  assert.equal(resolvePlayerGlove(v3(0, 0, 0), R, enemyOpen, COMBAT), null, "自分の手前では当たらない");
});

test("攻撃の進行: approach → strike → retract → done、経路端は from / aim に一致", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800 };
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
  const cfg = { ...COMBAT.attack, approachMs: 800 };
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
  assert.equal(simulateAttack({ pose: armsDown, from, aim: head, cfg }).resolved, "hit");
});

test("狙点は攻撃開始時の頭に固定される: あとで頭をどければ空振り（dodge）になる", () => {
  const cfg = { ...COMBAT.attack, approachMs: 800 };
  const aimedAt = v3(0, 0, 0);                       // 攻撃開始時にここを狙われた
  const from = v3(COMBAT.enemy.guard.x, COMBAT.enemy.guard.y, -COMBAT.enemyDist + COMBAT.enemy.guard.z);
  const armsDown = (head) => ({
    head,
    left: { elbow: v3(head.x - 0.24, head.y - 0.32, 0.05), wrist: v3(head.x - 0.3, head.y - 0.62, 0.05) },
    right: { elbow: v3(head.x + 0.24, head.y - 0.32, 0.05), wrist: v3(head.x + 0.3, head.y - 0.62, 0.05) },
  });
  // 頭を動かさなければ当たる
  assert.equal(simulateAttack({ pose: armsDown(aimedAt), from, aim: aimedAt, cfg }).resolved, "hit");
  // 横へ 0.28m 逃げると当たらず、かすめて通る（＝回避成立）
  const leaned = simulateAttack({ pose: armsDown(v3(0.28, 0, 0)), from, aim: aimedAt, cfg });
  assert.equal(leaned.resolved, null);
  assert.ok(leaned.dodged, `かすらず遠すぎ (minHeadDist=${leaned.minHeadDist.toFixed(3)})`);
  // しゃがんでも同様
  const ducked = simulateAttack({ pose: armsDown(v3(0, -0.3, 0)), from, aim: aimedAt, cfg });
  assert.equal(ducked.resolved, null);
});
