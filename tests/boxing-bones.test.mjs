// 人型モデルのボーン駆動（bones.js）。位置ベースの合成ポーズ → ボーン回転の変換を検証する。
//
// 当たり判定は今まで通り位置（combat.js）で行い、メッシュは表示だけ。
// ここが正しくないと「判定はしているが見た目がずれている」状態になるので、
// 「回転を適用した結果、骨が狙った向きを向く」ことを数値で固定する。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  quatFromTo, boneLocalRotation, qrot, qmul, qconj, vnorm, vsub, vlen,
  matchBoneName, fitScale,
} from "../examples/games/boxing/bones.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const vclose = (a, b, eps = 1e-6) => close(a.x, b.x, eps) && close(a.y, b.y, eps) && close(a.z, b.z, eps);

test("quatFromTo: a を b に重ねる（同方向・直交・真逆）", () => {
  const x = { x: 1, y: 0, z: 0 }, y = { x: 0, y: 1, z: 0 };
  assert.ok(vclose(qrot(quatFromTo(x, y), x), y), "直交ケース");
  assert.ok(vclose(qrot(quatFromTo(x, x), x), x), "同方向は無回転");
  const back = { x: -1, y: 0, z: 0 };
  assert.ok(vclose(qrot(quatFromTo(x, back), x), back), "真逆ケース（180°）");
});

test("boneLocalRotation: 親の回転を打ち消して、適用後にワールドで狙った向きを向く", () => {
  // 親が Y 軸まわりに 90° 回っている状況
  const s = Math.SQRT1_2;
  const parent = { w: s, x: 0, y: s, z: 0 };
  const restDir = { x: 0, y: -1, z: 0 };        // 休め姿勢では骨は真下を向いている
  for (const target of [{ x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, { x: 0.3, y: -0.5, z: -0.8 }]) {
    const local = boneLocalRotation(restDir, target, parent);
    // 親 → 自分 と合成したワールド回転で rest を回すと target に一致する
    const world = qmul(parent, local);
    assert.ok(vclose(qrot(world, restDir), vnorm(target), 1e-6),
      `target=${JSON.stringify(target)} を向かない`);
  }
});

test("肩→肘→手首: 親から順に回転を適用すると、肘・手首が狙った位置に来る", () => {
  // 骨長固定のリグを模す（肩から肘 0.32、肘から手首 0.30）
  const L1 = 0.32, L2 = 0.30;
  const shoulder = { x: 0.19, y: 0, z: 0 };
  const elbowT = { x: 0.30, y: -0.22, z: -0.15 };
  const wristT = { x: 0.16, y: -0.10, z: -0.42 };
  // 実際の距離を骨長に合わせておく（IK 済みの想定）
  const fix = (from, to, len) => {
    const d = vnorm(vsub(to, from));
    return { x: from.x + d.x * len, y: from.y + d.y * len, z: from.z + d.z * len };
  };
  const elbow = fix(shoulder, elbowT, L1);
  const wrist = fix(elbow, wristT, L2);

  const rest = { x: 0, y: -1, z: 0 };            // 休め姿勢はどちらの骨も真下向き
  const identity = { w: 1, x: 0, y: 0, z: 0 };
  // 上腕: 肩→肘の向きへ
  const upperLocal = boneLocalRotation(rest, vsub(elbow, shoulder), identity);
  const upperWorld = qmul(identity, upperLocal);
  const elbowPos = {
    x: shoulder.x + qrot(upperWorld, rest).x * L1,
    y: shoulder.y + qrot(upperWorld, rest).y * L1,
    z: shoulder.z + qrot(upperWorld, rest).z * L1,
  };
  assert.ok(vclose(elbowPos, elbow, 1e-6), "肘が目標位置に来ない");
  // 前腕: 肘→手首の向きへ（親＝上腕のワールド回転を打ち消す）
  const lowerLocal = boneLocalRotation(rest, vsub(wrist, elbow), upperWorld);
  const lowerWorld = qmul(upperWorld, lowerLocal);
  const wristPos = {
    x: elbowPos.x + qrot(lowerWorld, rest).x * L2,
    y: elbowPos.y + qrot(lowerWorld, rest).y * L2,
    z: elbowPos.z + qrot(lowerWorld, rest).z * L2,
  };
  assert.ok(vclose(wristPos, wrist, 1e-6), "手首が目標位置に来ない");
  assert.ok(close(vlen(vsub(wristPos, elbowPos)), L2, 1e-9), "前腕長が変わっている");
});

test("ボーン名の判定: Mixamo / Quaternius / VRM のよくある綴りを拾う", () => {
  assert.ok(matchBoneName("mixamorig:LeftUpperArm", "upperArm", "left"));
  assert.ok(matchBoneName("mixamorig:RightForeArm", "lowerArm", "right"));
  assert.ok(matchBoneName("Left_Hand", "hand", "left"));
  assert.ok(matchBoneName("Hips", "hips"));
  assert.ok(matchBoneName("Neck", "neck"));
  assert.ok(matchBoneName("upperarm.R", "upperArm", "right"));
  // 取り違えやすい組み合わせを弾く
  assert.ok(!matchBoneName("mixamorig:LeftForeArm", "upperArm", "left"), "forearm を upperArm と誤認");
  assert.ok(!matchBoneName("mixamorig:LeftUpperArm", "upperArm", "right"), "左右を取り違える");
  assert.ok(!matchBoneName("Spine2", "spine"), "Spine2 は chest 扱い");
  assert.ok(matchBoneName("Spine2", "chest"));
});

test("モデルの自動スケール: 肩幅と腕長の実測からゲームの体格に合わせる", () => {
  // モデルが 2 倍大きければ 0.5 倍にする
  assert.ok(close(fitScale({ shoulderSpan: 0.76, armLength: 1.24 }, { shoulderSpan: 0.38, armLength: 0.62 }), 0.5));
  // 片方しか測れない場合はそれだけで決める
  assert.ok(close(fitScale({ shoulderSpan: 0.38, armLength: 0 }, { shoulderSpan: 0.19, armLength: 0.62 }), 0.5));
  assert.equal(fitScale({ shoulderSpan: 0, armLength: 0 }, { shoulderSpan: 0.38, armLength: 0.62 }), 1);
});
