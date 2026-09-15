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
 * 前方成分は PoseInput の semantic forward / OAK hand depth から得る reach だけを使う。
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
 * 入力は PoseInput が出す「体基準の 2D オフセット（肩幅＝1）」と「前方リーチ 0..1」。
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
  // ルート（体そのものの位置）。前後は見かけサイズ比、左右は肩中点のオフセット由来。
  // 頭のリーン / ダックは「体に対する頭の動き」として root の上に乗る 2 階層構造。
  const rootX = (frame.root?.x ?? 0) * SW * (cfg.rootGain ?? 0);
  // 前後移動: 見かけサイズ比（1.0 = 構え位置 / >1 = 近づいた）を z のオフセットに変換する。
  // 体ごと敵の方（-Z）へ動くので、踏み込めば届き、下がれば届かない＝間合いが生まれる。
  // 深度トラッカーがあれば実測の前後移動 [m] をそのまま使い、無ければ見かけサイズ比から換算する
  const step = clamp(
    frame.stepMeters != null ? frame.stepMeters : ((frame.distanceRatio ?? 1) - 1) * cfg.stepMetersPerRatio,
    cfg.stepClamp[0], cfg.stepClamp[1],
  );
  const head = v3(rootX + frame.head.x * SW * cfg.headGain, -frame.head.y * SW * cfg.headGain, -step);
  // 体幹ヨー（+ = 右肩が前）。頭（＝一人称の視線）は一部だけ追従させる。
  const yaw = frame.yaw ?? 0;
  const twistGain = cfg.twistForwardGain ?? 1;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const out = { head, shoulders: {}, yaw, headYaw: yaw * (cfg.twistHeadFollow ?? 0) };
  for (const [side, sign] of [["left", -1], ["right", 1]]) {
    const arm = frame.arms?.[side];
    /**
     * 肩は頭に部分的に追従（体ごと傾く）。左右位置は肩幅の半分。
     * さらに体幹ヨー（ひねり）で背骨まわりに回す: ひねった側の肩が前（-Z）へ出る。
     * これで「右ひねりを伴う右ストレート」が、腕を伸ばす前から肩ごと前に出る。
     * 前後成分だけ forwardGain 倍して誇張している（実寸だと 30° で 0.1m 弱にしかならず見えない）。
     */
    const halfX = sign * cfg.shoulderHalf;
    const rigShoulder = v3(
      rootX + (head.x - rootX) * cfg.shoulderFollow + halfX * cosYaw,
      head.y * cfg.shoulderFollow - cfg.shoulderDrop,
      cfg.shoulderBack - step - halfX * sinYaw * twistGain,
    );
    const shoulder = v3(rigShoulder.x, rigShoulder.y, rigShoulder.z);
    // PoseInput の肩はキャリブ基準からの2D差分。z は既存の体幹/リーチモデルのままにする。
    shoulder.x += (arm?.shoulder?.x ?? 0) * SW * cfg.lateralGain;
    shoulder.y -= (arm?.shoulder?.y ?? 0) * SW * cfg.lateralGain;
    out.shoulders[side] = shoulder;
    if (!arm) { out[side] = { elbow: shoulder, wrist: shoulder, reach: 0 }; continue; }
    const reach = clamp(arm.reach ?? 0, 0, 1);
    /**
     * 奥行き: 構え（reach=0）でも拳は体の前 guardForward [m] に出ている。
     * ここを 0 にすると、胸の前でガードしていても 3D では手が体にめり込んで見える。
     * reach はそこから前へ伸び、reach=1 で forwardMeters に達する。
     */
    const gf = cfg.guardForward ?? 0;
    const wristFwd = gf + reach * Math.max(0, cfg.forwardMeters - gf);
    const elbowFwd = gf * 0.5 + reach * Math.max(0, cfg.forwardMeters - gf) * cfg.elbowFrac;
    // OAK は奥行きだけを補う。横・縦は常に MediaPipe の手首座標を使うので、
    // 前へパンチしても画面上の拳が固定の狙点へ吸い寄せられない。
    const rawTarget = v3(
      rigShoulder.x + arm.wrist.x * SW * cfg.lateralGain,
      rigShoulder.y - arm.wrist.y * SW * cfg.lateralGain,
      shoulder.z - wristFwd,
    );
    // 手首の画像面 X/Y は動かさない。通常の可動域では、必要なら前方 Z だけを
    // 短くして上腕＋前腕の最大長を超えないようにする。
    const maxArm = cfg.bones.upperArm + cfg.bones.foreArm;
    const lateralSq = (rawTarget.x - shoulder.x) ** 2 + (rawTarget.y - shoulder.y) ** 2;
    const maxForward = lateralSq < maxArm ** 2 ? Math.sqrt(maxArm ** 2 - lateralSq) : 0;
    const target = lateralSq < maxArm ** 2
      ? v3(rawTarget.x, rawTarget.y, Math.max(rawTarget.z, shoulder.z - maxForward))
      : rawTarget;

    // 肘は曲がる向きのヒントではなく、取得した X/Y を直接使う。深度は取らない
    // 方針なので、腕が胴の裏へ回らないよう Z だけを常に前方へ補う。
    const elbow = v3(
      rigShoulder.x + arm.elbow.x * SW * cfg.lateralGain,
      rigShoulder.y - arm.elbow.y * SW * cfg.lateralGain,
      shoulder.z - Math.max(cfg.elbowFrontMin ?? .08, elbowFwd),
    );
    const reached = lateralSq <= maxArm ** 2;
    out[side] = { elbow, wrist: target, reach, reached };
  }
  // 胴の当たり判定カプセル（上端＝肩の中点 / 下端＝そこから torsoLength 下）。
  // 敵が胴を狙ってくるので、腕で止めるか上体ごとどけるかの的になる。
  const sm = v3((out.shoulders.left.x + out.shoulders.right.x) / 2,
    (out.shoulders.left.y + out.shoulders.right.y) / 2,
    (out.shoulders.left.z + out.shoulders.right.z) / 2);
  out.torsoTop = sm;
  out.torsoBottom = v3(sm.x, sm.y - cfg.torsoLength, sm.z);
  out.step = step;   // 前後移動量 [m]（HUD / デバッグ表示用）
  return out;
}

/**
 * 2 ボーン IK（肩 → 肘 → 手首）。**骨の長さは伸びない**。
 *
 * 目標が届かない場所にあれば、肩から目標方向へ (l1+l2) の位置でクランプする
 * （腕が伸びるのではなく「届かない」が正しく表現される＝間合いが意味を持つ）。
 * 肘は解析解で決め、bendHint 側（外・下など）へ張り出させる。
 *
 * @param {{x,y,z}} shoulder 肩
 * @param {{x,y,z}} target   手首の目標位置
 * @param {number} l1 上腕長 [m] @param {number} l2 前腕長 [m]
 * @param {{x,y,z}} bendHint 肘を出したい向き
 * @returns {{elbow:object, wrist:object, reached:boolean}} reached=false なら届いていない
 */
export function solveIK(shoulder, target, l1, l2, bendHint) {
  const max = l1 + l2;
  const to = sub(target, shoulder);
  const dRaw = len(to);
  const reached = dRaw <= max;
  const dir = dRaw < 1e-6 ? v3(0, 0, -1) : scale(to, 1 / dRaw);
  const d = clamp(dRaw, Math.abs(l1 - l2) + 1e-4, max);
  const wrist = add(shoulder, scale(dir, d));
  // 肘: 肩-手首の軸上 a の位置から、軸に直交する向きへ h だけ張り出す
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const mid = add(shoulder, scale(dir, a));
  const proj = dot(bendHint, dir);
  let perp = sub(bendHint, scale(dir, proj));
  let pl = len(perp);
  if (pl < 1e-6) { // ヒントが軸と平行 → 適当な直交ベクトルを作る
    perp = Math.abs(dir.y) < 0.9 ? v3(-dir.z, 0, dir.x) : v3(1, 0, 0);
    pl = len(perp);
  }
  return { elbow: add(mid, scale(perp, h / pl)), wrist, reached };
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
 * 敵の体を組む。プレイヤーと**同じ構造**（頭球・胴カプセル・腕カプセル・グローブ球）にして、
 * 当たり判定も同じ関数で扱えるようにする。
 * @param {{x:number,z:number}} root 敵の立ち位置（足元の水平位置）
 * @param {{left:{x,y,z}, right:{x,y,z}}} gloveTargets グローブの目標位置（ワールド）
 */
export function buildEnemyPose(root, gloveTargets, cfg) {
  const e = cfg.enemy;
  const head = v3(root.x, e.headY, root.z);
  const pose = {
    head,
    torsoTop: v3(root.x, e.torsoTopY, root.z),
    torsoBottom: v3(root.x, e.torsoBottomY, root.z),
    shoulders: {},
  };
  for (const [side, sign] of [["left", -1], ["right", 1]]) {
    const shoulder = v3(head.x + sign * e.arm.shoulderX, head.y + e.arm.shoulderY, head.z + e.arm.shoulderZ);
    pose.shoulders[side] = shoulder;
    // 肘は外・下へ。骨長は固定なので、遠い目標には「届かない」（腕は伸びない）。
    const ik = solveIK(shoulder, gloveTargets[side], e.bones.upperArm, e.bones.foreArm, v3(sign, -1, 0.2));
    pose[side] = { elbow: ik.elbow, wrist: ik.wrist, reached: ik.reached };
  }
  return pose;
}

/**
 * 拳 1 個 対 相手の体、の当たり判定。**プレイヤー / 敵で同じ関数**を使う（左右対称）。
 * 腕（グローブ球 + 前腕 / 上腕カプセル）が先に触れれば "guard"、次に頭、最後に胴。
 * ガードは姿勢フラグではなく**位置関係だけ**で決まる（腕を下ろせば頭が空く）。
 * @param {{x,y,z}} glove @param {number} gloveR
 * @param {object} pose buildPlayerPose / buildEnemyPose の出力
 * @param {{headRadius,torsoRadius,gloveRadius,forearmRadius,upperArmRadius}} body
 * @returns {"guard"|"head"|"torso"|null}
 */
export function resolveHit(glove, gloveR, pose, body) {
  for (const side of ["left", "right"]) {
    const arm = pose[side];
    if (!arm) continue;
    if (sphereHitsSphere(glove, gloveR, arm.wrist, body.gloveRadius)) return "guard";
    if (sphereHitsCapsule(glove, gloveR, arm.elbow, arm.wrist, body.forearmRadius)) return "guard";
    const shoulder = pose.shoulders?.[side];
    if (shoulder && sphereHitsCapsule(glove, gloveR, shoulder, arm.elbow, body.upperArmRadius ?? body.forearmRadius)) return "guard";
  }
  if (sphereHitsSphere(glove, gloveR, pose.head, body.headRadius)) return "head";
  if (pose.torsoTop && sphereHitsCapsule(glove, gloveR, pose.torsoTop, pose.torsoBottom, body.torsoRadius)) return "torso";
  return null;
}

/**
 * 敵グローブ → プレイヤー。resolveHit の別名（"guard" を "block" と呼ぶだけ）。
 * @returns {"block"|"head"|"torso"|null}
 */
export function resolveEnemyGlove(glove, gloveR, pose, cfg) {
  const what = resolveHit(glove, gloveR, pose, cfg.player);
  return what === "guard" ? "block" : what;
}

/**
 * プレイヤーの拳 → 敵。
 * @returns {"guard"|"head"|"torso"|null}
 */
export function resolvePlayerGlove(glove, gloveR, enemy, cfg) {
  return resolveHit(glove, gloveR, enemy, cfg.enemy);
}

/**
 * Resolve a measured glove segment against the enemy. Callers must limit capture gaps;
 * this is deliberately interpolation of two authoritative samples, never prediction.
 */
export function resolvePlayerGloveSweep(from, to, gloveR, enemy, cfg) {
  const stepM = Math.max(0.02, gloveR * 0.5);
  const steps = Math.max(1, Math.ceil(dist(from, to) / stepM));
  for (let i = 0; i <= steps; i++) {
    const hit = resolvePlayerGlove(lerpV(from, to, i / steps), gloveR, enemy, cfg);
    if (hit) return hit;
  }
  return null;
}
