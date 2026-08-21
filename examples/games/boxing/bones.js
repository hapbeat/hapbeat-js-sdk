/**
 * bones.js — 合成ポーズ（頭・肩・肘・手首の**位置**）から、人型モデルのボーン**回転**を出す。
 *
 * 当たり判定と IK は今まで通り位置ベースのデータ側（combat.js）で行い、メッシュは表示だけ。
 * SkinnedMesh は位置を直接置けない（親子関係で回転が伝播する）ので、
 * 「このボーンをどちらへ向けたいか」を親の姿勢を打ち消したローカル回転に変換する。
 *
 * Three.js に依存しない純関数なので node でテストできる（値は {x,y,z} / {x,y,z,w}）。
 */

const EPS = 1e-8;

export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export function vnorm(a) {
  const l = vlen(a);
  return l < EPS ? { x: 0, y: 1, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l };
}

export const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
export const qconj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

/** クォータニオンでベクトルを回す。 */
export function qrot(q, v) {
  const r = qmul(qmul(q, { w: 0, x: v.x, y: v.y, z: v.z }), qconj(q));
  return { x: r.x, y: r.y, z: r.z };
}

/**
 * 単位ベクトル a を b に重ねる最短回転。
 * 真逆（180°）のときは a に直交する適当な軸で半回転する。
 */
export function quatFromTo(a, b) {
  const u = vnorm(a), v = vnorm(b);
  const d = vdot(u, v);
  if (d > 1 - 1e-9) return { w: 1, x: 0, y: 0, z: 0 };
  if (d < -1 + 1e-9) {
    let axis = vcross({ x: 1, y: 0, z: 0 }, u);
    if (vlen(axis) < 1e-6) axis = vcross({ x: 0, y: 1, z: 0 }, u);
    const n = vnorm(axis);
    return { w: 0, x: n.x, y: n.y, z: n.z };
  }
  const c = vcross(u, v);
  const q = { w: 1 + d, x: c.x, y: c.y, z: c.z };
  const l = Math.hypot(q.w, q.x, q.y, q.z);
  return { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l };
}

/**
 * ボーンの**ローカル**回転を出す。
 *
 * 親のワールド回転を打ち消してから「休め姿勢での骨の向き」を「向けたい向き」へ重ねる。
 * これを親から順（肩 → 上腕 → 前腕）に適用すると、位置を直接いじらずに狙った形になる。
 *
 * @param {{x,y,z}} restDirLocal 休め姿勢での骨の向き（ボーンのローカル空間）
 * @param {{x,y,z}} targetDirWorld 向けたい向き（ワールド空間）
 * @param {{x,y,z,w}} parentWorldQuat 親のワールド回転
 * @returns {{x,y,z,w}} このボーンに入れるローカル回転
 */
export function boneLocalRotation(restDirLocal, targetDirWorld, parentWorldQuat) {
  const desiredLocal = qrot(qconj(parentWorldQuat), targetDirWorld);
  return quatFromTo(restDirLocal, desiredLocal);
}

/**
 * ボーン名から左右を読む。`Left/Right` のほか、区切り付きの `.R` `_l` や
 * 末尾の `UpperArmR` のような書き方も拾う（モデルによって流儀が違うため）。
 * @returns {"left"|"right"|null}
 */
export function boneSide(name) {
  const raw = String(name ?? "");
  const lower = raw.toLowerCase();
  if (lower.includes("left")) return "left";
  if (lower.includes("right")) return "right";
  const sep = raw.match(/[._\s-]([lr])(?=$|[^a-zA-Z])/i);       // "upperarm.R" / "hand_l"
  if (sep) return sep[1].toLowerCase() === "l" ? "left" : "right";
  const tail = raw.match(/([LR])$/);                            // "UpperArmR"
  if (tail) return tail[1] === "L" ? "left" : "right";
  return null;
}

/**
 * ボーン名の判定（Mixamo / Quaternius / VRM でよくある綴りを吸収する）。
 * @param {string} name ボーン名
 * @param {"hips"|"spine"|"chest"|"neck"|"head"|"shoulder"|"upperArm"|"lowerArm"|"hand"} kind
 * @param {"left"|"right"|null} side
 */
export function matchBoneName(name, kind, side = null) {
  const raw = String(name ?? "");
  const n = raw.toLowerCase().replace(/[_.\s-]/g, "");
  const sideOk = side === null ? true : boneSide(raw) === side;
  const kinds = {
    hips: ["hips", "pelvis", "root"],
    spine: ["spine", "spine1"],
    chest: ["chest", "spine2", "upperchest"],
    neck: ["neck"],
    head: ["head"],
    shoulder: ["shoulder", "clavicle"],
    upperArm: ["upperarm", "arm", "shoulderupper"],
    lowerArm: ["lowerarm", "forearm", "elbow"],
    hand: ["hand", "wrist"],
  }[kind] ?? [];
  // "arm" は upperArm の別名だが forearm/lowerarm に含まれてしまうので除外する
  const hit = kinds.some((k) => (k === "arm" ? /(^|[^a-z])arm/.test(n) && !n.includes("forearm") && !n.includes("lowerarm") : n.includes(k)));
  if (kind === "spine" && (n.includes("spine2") || n.includes("upperchest"))) return false;
  if (kind === "upperArm" && (n.includes("forearm") || n.includes("lowerarm"))) return false;
  return hit && sideOk;
}

/**
 * ボーン間距離からモデルの寸法を測り、ゲーム側の体格（肩幅・腕長）に合わせる倍率を出す。
 * @param {{shoulderSpan:number, armLength:number}} model 実測値 [m]
 * @param {{shoulderSpan:number, armLength:number}} target 目標値 [m]
 */
export function fitScale(model, target) {
  const cands = [];
  if (model.shoulderSpan > EPS) cands.push(target.shoulderSpan / model.shoulderSpan);
  if (model.armLength > EPS) cands.push(target.armLength / model.armLength);
  if (!cands.length) return 1;
  // 肩幅と腕長の平均（どちらか一方に引っ張られすぎないように）
  return cands.reduce((s, v) => s + v, 0) / cands.length;
}
