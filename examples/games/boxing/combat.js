/**
 * combat.js — ボクシングの「体の合成」と「当たり判定」。すべて純関数。
 *
 * Three.js にも DOM にも依存しないので node で単体テストできる（tests/boxing-combat.test.mjs）。
 * 描画（scene3d.js）と判定（boxing.js）が同じ関数で位置を出すので、
 * **見えている位置と当たる位置が必ず一致する**。
 *
 * 座標系は scene3d.js と同じ Three.js 空間（+X=画面右 / +Y=上 / -Z=前方＝敵の方向）。
 * 単位はメートル。プレイヤーの頭がだいたい原点、敵は z = -ENEMY_DIST に立つ。
 *
 * ── なぜ z を worldLandmarks から取らないか ────────────────────────────────────
 * 単眼の姿勢推定に本物の奥行きは無く、worldLandmarks の z はカメラへ拳を突き出しても
 * ほとんど動かない（＝一人称の腕が前に伸びない）。そこで奥行きは捨てて、
 * **2D から前方リーチを推定する**（gestures.js）。ここはその推定値を受け取って腕を組む。
 */

// ── ベクタ（プレーンオブジェクト。THREE.Vector3 でも同じ形なので相互運用できる） ──
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const lerpV = (a, b, t) => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** 線分 ab 上で点 p に最も近い点。 */
export function closestPointOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-9) return a;
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return add(a, scale(ab, t));
}

export const sphereHitsSphere = (c1, r1, c2, r2) => dist(c1, c2) <= r1 + r2;
/** 球 (c,r) と カプセル（線分 ab・半径 rc）の交差。 */
export const sphereHitsCapsule = (c, r, a, b, rc) => dist(c, closestPointOnSegment(c, a, b)) <= r + rc;

/** 2 次ベジェ（フックの弧を描くのに使う）。 */
export const bezier2 = (p0, p1, p2, t) => lerpV(lerpV(p0, p1, t), lerpV(p1, p2, t), t);

/**
 * 一人称のプレイヤー上半身を組む。
 *
 * 入力は gestures.js が出す「体基準の 2D オフセット（肩幅＝1）」と「前方リーチ 0..1」。
 * 左右・上下は実際に映っている 2D の動きをそのまま使い、奥行きだけを reach で作る。
 * 腕の長さは一定にせず z 方向にだけ伸ばす（解剖学的には腕は 1.2m 届かないが、
 * 敵に手が届かないと殴った感が出ないため。誇張はここ 1 か所に閉じている）。
 *
 * @param {{head:{x:number,y:number}, arms:{left:object, right:object}}} frame 体基準 2D（x=画面右+, y=画面下+）
 * @param {object} cfg COMBAT.rig 相当
 * @returns {{head:object, shoulders:{left,right}, left:{elbow,wrist,reach}, right:{...}}}
 */
export function buildPlayerPose(frame, cfg) {
  const SW = cfg.shoulderWidthM;
  const head = v3(frame.head.x * SW * cfg.headGain, -frame.head.y * SW * cfg.headGain, 0);
  const out = { head, shoulders: {} };
  for (const [side, sign] of [["left", -1], ["right", 1]]) {
    const arm = frame.arms?.[side];
    // 肩は頭に部分的に追従（体ごと傾く）。左右位置は肩幅の半分で固定。
    const shoulder = v3(head.x * cfg.shoulderFollow + sign * cfg.shoulderHalf,
      head.y * cfg.shoulderFollow - cfg.shoulderDrop, cfg.shoulderBack);
    out.shoulders[side] = shoulder;
    if (!arm) { out[side] = { elbow: shoulder, wrist: shoulder, reach: 0 }; continue; }
    const reach = clamp(arm.reach ?? 0, 0, 1);
    /**
     * 伸ばすほど狙点（正面＝敵の頭の高さ）へ寄せる。
     * 肩は体の中心から 0.19m 横にあるので、肩からまっすぐ前に突くと拳は敵の頭の
     * 横 0.27m を素通りしてしまい、まともに構えて突いても当たらない。実際の
     * ボクシングでも拳は的へ向かって内側へ入るので、その分をここで作る。
     * 描画も判定もこの同じ位置を使うので「見えている通りに当たる」は保たれる。
     */
    const conv = cfg.convergence * reach;
    const place = (off, fwd, convScale) => {
      const k = conv * convScale;
      return v3(
        lerp(shoulder.x + off.x * SW * cfg.lateralGain, cfg.aim.x, k),
        lerp(shoulder.y - off.y * SW * cfg.lateralGain, cfg.aim.y, k),
        shoulder.z - reach * cfg.forwardMeters * fwd,
      );
    };
    out[side] = { elbow: place(arm.elbow, cfg.elbowFrac, 0.4), wrist: place(arm.wrist, 1, 1), reach };
  }
  return out;
}

/**
 * 敵の攻撃の進行度。予告は「文字」ではなく**グローブがゆっくり近づいてくること**で示す。
 *   approach: 経路の 0 → approachFrac をゆっくり（見てから反応できる速さ）
 *   strike  : 残りを一気に（当たる瞬間）
 *   retract : 戻り（この間は敵のガードが開く＝隙）
 * @returns {{s:number, phase:"approach"|"strike"|"retract"|"done"}}
 */
export function attackPathT(elapsedMs, cfg) {
  const { approachMs, strikeMs, retractMs, approachFrac } = cfg;
  if (elapsedMs < approachMs) return { s: (elapsedMs / approachMs) * approachFrac, phase: "approach" };
  const afterApproach = elapsedMs - approachMs;
  if (afterApproach < strikeMs) {
    return { s: approachFrac + (afterApproach / strikeMs) * (1 - approachFrac), phase: "strike" };
  }
  const afterStrike = afterApproach - strikeMs;
  if (afterStrike < retractMs) return { s: 1 - afterStrike / retractMs, phase: "retract" };
  return { s: 0, phase: "done" };
}

/**
 * 敵グローブの現在位置。ストレートは直線、フックは横に膨らむ弧。
 * `aim` は攻撃開始時に固定したプレイヤー頭の位置（＝あとで頭を動かせば避けられる）。
 */
export function enemyGlovePos(from, aim, s, { kind, side }, cfg) {
  if (kind === "hook") {
    const mid = lerpV(from, aim, 0.5);
    mid.x += side * cfg.hookArc;      // 横に膨らんでから側頭部へ回り込む
    mid.y += cfg.hookRise;
    return bezier2(from, mid, aim, s);
  }
  return lerpV(from, aim, s);
}

/**
 * 敵グローブ 1 個に対するプレイヤー側の判定。
 * 腕（グローブ球 + 前腕カプセル）が先に触れれば **ガード**、頭に触れれば **被弾**。
 * ガードはジェスチャー判定ではなく、この位置関係だけで決まる。
 * @returns {"block"|"hit"|null}
 */
export function resolveEnemyGlove(glove, gloveR, pose, cfg) {
  for (const side of ["left", "right"]) {
    const arm = pose[side];
    if (!arm) continue;
    if (sphereHitsSphere(glove, gloveR, arm.wrist, cfg.player.gloveRadius)) return "block";
    if (sphereHitsCapsule(glove, gloveR, arm.elbow, arm.wrist, cfg.player.forearmRadius)) return "block";
  }
  if (sphereHitsSphere(glove, gloveR, pose.head, cfg.player.headRadius)) return "hit";
  return null;
}

/**
 * プレイヤーのグローブ 1 個に対する敵側の判定。
 * ガードが上がっていればまずグローブに当たる（＝ほとんど効かない）。
 * @param {{head:object, torsoTop:object, torsoBottom:object, gloves:object, guardUp:boolean}} enemy
 * @returns {"head"|"torso"|"guard"|null}
 */
export function resolvePlayerGlove(glove, gloveR, enemy, cfg) {
  if (enemy.guardUp) {
    for (const side of ["left", "right"]) {
      if (enemy.gloves[side] && sphereHitsSphere(glove, gloveR, enemy.gloves[side], cfg.enemy.gloveRadius)) return "guard";
    }
  }
  if (sphereHitsSphere(glove, gloveR, enemy.head, cfg.enemy.headRadius)) return "head";
  if (sphereHitsCapsule(glove, gloveR, enemy.torsoTop, enemy.torsoBottom, cfg.enemy.torsoRadius)) return "torso";
  return null;
}
