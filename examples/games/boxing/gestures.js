/**
 * GestureTracker — ランドマーク列 → 「体基準の 2D フレーム」＋前方リーチ＋パンチ（スイング）。
 *
 * 出すもの
 *   frame  : 頭・肘・手首の 2D オフセット（肩幅＝1 の体基準）と、腕ごとのリーチ 0..1 / スイング中か
 *   punchL / punchR : スイングの立ち上がり（1 回だけ true）
 *   lean / duck     : 離散の補助検出（HUD 表示・頭位置の裏取り用）
 *   debug           : 各信号の生値（歯車メニューの判定デバッグで時系列表示する）
 *
 * ── 安定化の方針 ────────────────────────────────────────────────────────────
 * 姿勢推定の値は静止時に細かく震える。素通しすると「ガード中に関節が震えて伸びた判定」に
 * なるので、次の順で殺している:
 *   ① ランドマークを 1€ フィルタ（filters.js）— 静止で止まり、速い動きは通す
 *   ② 可視性の低いランドマークはフレームを飛ばして直前値を保持
 *   ③ リーチはデッドバンド → スルーレート制限 → 1€（reach.js の ReachFilter）
 *   ④ 顔の前で手が止まっていればガードとみなしてリーチを上限クランプ
 *   ⑤ 「突いた」は値ではなくリーチの**速度**で判定（reach.js の SwingDetector）
 *
 * 座標は「ミラー表示の画面座標」に統一（x を 1-x）。画面左＝プレイヤーの左。
 * 位置系は (x*aspect, y) の等方空間で扱い、量は肩幅で割る（カメラ距離に依らない）。
 * 閾値は全部 ./tuning.js の TUNING。ここには数値を直書きしない。
 */

import { LM, HL, HAND_POINTS } from "./pose.js";
import { TUNING } from "./tuning.js";
import { OneEuroVec3, OneEuro, deadband } from "./filters.js";
import { combineSignals, ReachFilter, SwingDetector, isGuardLocked, isHome, mapRange, estimateYaw } from "./reach.js";
import { weightedMedian, convexHullArea } from "./filters.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = 180 / Math.PI;
const SIDES = [
  ["left", { shoulder: LM.shoulderL, elbow: LM.elbowL, wrist: LM.wristL }],
  ["right", { shoulder: LM.shoulderR, elbow: LM.elbowR, wrist: LM.wristR }],
];
const TRACKED = [LM.nose, LM.shoulderL, LM.shoulderR, LM.elbowL, LM.elbowR, LM.wristL, LM.wristR,
  LM.pinkyL, LM.pinkyR, LM.indexL, LM.indexR, LM.thumbL, LM.thumbR,
  // 前後距離の推定に使う（顔の見かけ幅・体幹の縦長）
  LM.eyeL, LM.eyeR, LM.earL, LM.earR, LM.hipL, LM.hipR];

/** 関節角[deg]（a-b-c）。use3d=false なら z を無視した 2D 角。 */
function jointAngle(a, b, c, use3d) {
  const z = (p) => (use3d ? (p.z ?? 0) : 0);
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: z(a) - z(b) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: z(c) - z(b) };
  const n1 = Math.hypot(v1.x, v1.y, v1.z), n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  return Math.acos(clamp((v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2), -1, 1)) * DEG;
}

/** 点群の最大差し渡し（手の 2D スパン）。 */
function span(points) {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(max, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return max;
}

class ArmState {
  constructor(t) {
    this.reachFilter = new ReachFilter(t.reach);
    this.swing = new SwingDetector(t.punch.swing);
    this.worldWrist = new OneEuroVec3(t.filter.world);
    this.prevWorld = null;
    this.speed = 0;          // world 由来の手首速度 [m/s]（突き出しアニメの深さに使う）
    this.wristSpeed2d = 0;   // 2D 手首速度 [肩幅/s]（ガードロックの判定に使う）
    this.prevWrist2d = null;
    this.elbowDeg = 180;
    this.angleSource = "3d";
    this.jitter3d = 0; this.jitter2d = 0; this.prev3d = null; this.prev2d = null;
    this.lastPunchMs = -1e9;
    this.punchSpeed = 0;
    this.sig = { angle: null, shorten: null, handSize: null, handModel: null, handArea: null, depthZ: null };
    this.lastHandSeenMs = -1e9;  // HandLandmarker が最後にこの手を見た時刻
    this.inHome = false;         // 構え領域に戻っているか
    this.raw = 0;
    this.reach = 0;
    this.swingActive = false;
  }
}

export class GestureTracker {
  constructor(tuning = TUNING) {
    this.t = tuning;
    this.arms = { left: new ArmState(tuning), right: new ArmState(tuning) };
    this.lmFilters = new Map(TRACKED.map((i) => [i, new OneEuroVec3(tuning.filter.landmark)]));
    this.distFilter = new OneEuro(tuning.distance.oneEuro);
    this.distanceRatio = 1;
    this.yawFilter = new OneEuro(tuning.twist.oneEuro);
    this.yaw = 0;             // 体幹ヨー [rad]（+ = 右肩が前＝右ひねり）
    this.visible = new Map(TRACKED.map((i) => [i, false]));
    this.reset();
  }

  reset() {
    this.base = null;
    this._acc = null;
    this._calibStartMs = -1;
    this.calibProgress = 0;
    this.lean = 0;
    this.duck = false;
    this.guardLocked = false;
    this.distanceRatio = 1;
    this.distFilter.reset();
    this.yaw = 0;
    this.yawFilter.reset();
    for (const f of this.lmFilters.values()) f.reset();
    for (const a of Object.values(this.arms)) {
      a.reachFilter.reset(); a.swing.reset(); a.worldWrist.reset();
      a.prevWorld = null; a.prevWrist2d = null; a.reach = 0; a.raw = 0; a.swingActive = false;
    }
  }

  /**
   * 可視性ゲート付きで 1€ 平滑化した点を返す（ミラー・等方空間）。
   * 見えていないフレームは更新せず直前値を保持する（消えた瞬間に腕が飛ぶのを防ぐ）。
   */
  _points(landmarks, aspect, dt) {
    const out = {};
    for (const i of TRACKED) {
      const p = landmarks[i];
      const ok = !!p && (p.visibility == null || p.visibility >= this.t.minVisibility);
      const f = this.lmFilters.get(i);
      this.visible.set(i, ok);
      // ミラー: x を反転。z は正規化ランドマークのもの（3D 肘角度の計算にだけ使う）
      out[i] = ok ? f.filter({ x: (1 - p.x) * aspect, y: p.y, z: -(p.z ?? 0) }, dt) : f.hold();
      out[i].ok = ok;
    }
    return out;
  }

  /**
   * 1 フレーム更新。
   * @returns {{visible, calibrated, punchL, punchR, lean, duck, guardLocked,
   *            frame:{head, arms:{left,right}}|null, debug:object}}
   */
  update(pose, nowMs, dtSec, { aspect = 4 / 3, calibrating = false, hands = null } = {}) {
    const out = {
      visible: false, calibrated: !!this.base && this.calibProgress >= 1,
      punchL: false, punchR: false, lean: this.lean, duck: this.duck,
      guardLocked: this.guardLocked, frame: null, debug: {},
    };
    const lms = pose?.landmarks;
    if (!lms) { this.lean = 0; this.duck = false; out.lean = 0; out.duck = false; return out; }

    const dt = Math.max(dtSec, 1e-3);
    this._aspect = aspect;
    this._nowMs = nowMs;
    const p = this._points(lms, aspect, dt);
    const need = [LM.nose, LM.shoulderL, LM.shoulderR];
    if (!need.every((i) => this.visible.get(i))) return out;
    out.visible = true;

    const sL = p[LM.shoulderL], sR = p[LM.shoulderR], nose = p[LM.nose];
    const shoulderWidth = Math.hypot(sL.x - sR.x, sL.y - sR.y);
    const midX = (sL.x + sR.x) / 2;
    if (shoulderWidth < 1e-4) return out;

    // ── 腕ごとの 2D 量（すべて肩幅で正規化） ────────────────────────────────
    const seg = {};
    for (const [side, ix] of SIDES) {
      const sh = p[ix.shoulder], el = p[ix.elbow], wr = p[ix.wrist];
      const ok = this.visible.get(ix.elbow) && this.visible.get(ix.wrist);
      const handPts = HAND_POINTS[side].filter((i) => this.visible.get(i)).map((i) => p[i]);
      seg[side] = {
        ok, sh, el, wr,
        upperArm: Math.hypot(el.x - sh.x, el.y - sh.y) / shoulderWidth,
        forearm: Math.hypot(wr.x - el.x, wr.y - el.y) / shoulderWidth,
        handSpan: handPts.length >= 2 ? span(handPts) / shoulderWidth : null,
      };
    }

    // 手のモデル（HandLandmarker）が使えるなら、その手の見かけサイズを取る
    const handModel = this._handSizes(hands, aspect, shoulderWidth, seg);
    for (const [side] of SIDES) {
      seg[side].handModel = handModel[side]?.palm ?? null;
      seg[side].handArea = handModel[side]?.areaLen ?? null;
    }

    // 前後距離（見かけサイズ比）。体格量は肩幅・体幹縦長・顔幅の 3 つ。
    const body = this._bodyMetrics(p, shoulderWidth);

    if (calibrating || !this.base) this._calibrate(shoulderWidth, midX, nose.y, seg, body, nowMs);
    else this._follow(shoulderWidth, midX, nose.y, seg, dt);
    if (this.base) this._updateDistance(body, dt);
    if (this.base) this._updateYaw(p, shoulderWidth, dt);
    out.calibrated = !!this.base && this.calibProgress >= 1;
    if (!this.base) return out;
    const w = this.base.shoulderWidth;

    // ── 手首の 2D 速度（ガードロック判定用）と world 速度（突き出しの深さ用） ──
    for (const [side, ix] of SIDES) {
      const a = this.arms[side];
      const wr = seg[side].wr;
      if (a.prevWrist2d && seg[side].ok) {
        a.wristSpeed2d = Math.hypot(wr.x - a.prevWrist2d.x, wr.y - a.prevWrist2d.y) / w / dt;
      }
      a.prevWrist2d = { x: wr.x, y: wr.y };
      const world = pose.worldLandmarks?.[ix.wrist];
      if (world) {
        const f = a.worldWrist.filter(world, dt);
        if (a.prevWorld && dt < 0.2) {
          a.speed = Math.hypot(f.x - a.prevWorld.x, f.y - a.prevWorld.y, f.z - a.prevWorld.z) / dt;
        }
        a.prevWorld = f;
      }
    }

    // ── ガードロック: 両手が顔の前で止まっている＝ガード中（腕を伸ばさせない） ──
    this.guardLocked = isGuardLocked({
      nose: { x: (nose.x - this.base.midX) / w, y: (nose.y - this.base.noseY) / w },
      wrists: {
        left: seg.left.ok ? { x: (seg.left.wr.x - this.base.midX) / w, y: (seg.left.wr.y - this.base.noseY) / w } : null,
        right: seg.right.ok ? { x: (seg.right.wr.x - this.base.midX) / w, y: (seg.right.wr.y - this.base.noseY) / w } : null,
      },
      speeds: { left: this.arms.left.wristSpeed2d, right: this.arms.right.wristSpeed2d },
    }, this.t.reach.guardLock);
    out.guardLocked = this.guardLocked;

    // ── リーン / ダック（補助検出。ヒステリシス付き） ─────────────────────────
    const leanOff = (midX - this.base.midX) / w;
    const en = this.t.lean.enterRatio, ex = this.t.lean.exitRatio;
    if (this.lean === 0) this.lean = leanOff > en ? 1 : leanOff < -en ? -1 : 0;
    else if (Math.abs(leanOff) < ex || Math.sign(leanOff) !== this.lean) this.lean = 0;
    out.lean = this.lean;
    const duckOff = (nose.y - this.base.noseY) / w;
    this.duck = this.duck ? duckOff > this.t.duck.exitRatio : duckOff > this.t.duck.enterRatio;
    out.duck = this.duck;

    // ── リーチ推定 + スイング検出 ────────────────────────────────────────────
    const frame = {
      // head は「体（肩中点）に対する」頭の位置＝リーン / ダック。体ごとの移動は root。
      head: { x: (nose.x - midX) / w, y: (nose.y - this.base.noseY) / w },
      root: { x: (midX - this.base.midX) / w },
      distanceRatio: this.distanceRatio,   // 1.0 = 構え位置 / >1 = 近づいた
      yaw: this.yaw,                        // 体幹ひねり [rad]（+ = 右肩が前）
      arms: {},
    };
    const homeCfg = this.t.reach.home;
    for (const [side] of SIDES) {
      const a = this.arms[side];
      const s = seg[side];
      // 手首が「構え領域」（胸〜顔の前）でゆっくりしているか
      const wristRel = s.ok ? { x: (s.wr.x - this.base.midX) / w, y: (s.wr.y - this.base.noseY) / w } : null;
      a.inHome = isHome(wristRel, a.wristSpeed2d, homeCfg);
      a.sig = this._signals(side, s, dt, nowMs);
      a.raw = combineSignals(a.sig, this.t.reach);
      // 構えに戻っている間は基準をゆっくり再学習してドリフトを吸収する。
      // キャリブ中に手が映っていなかった場合は、構え領域で最初に検出できた時点で基準を取る。
      if (a.inHome && s.ok) {
        if (s.handModel != null && this.base.handModel[side] <= 1e-4) this.base.handModel[side] = s.handModel;
        if (s.handArea != null && this.base.handArea[side] <= 1e-4) this.base.handArea[side] = s.handArea;
        this._relearn(side, s, dt, homeCfg.relearnTauSec);
      }
      const reach = a.reachFilter.update(a.raw, dt, {
        visible: s.ok, guardLocked: this.guardLocked, inHome: a.inHome,
      });
      // スタック防止: パンチから一定時間たっても伸びたままで、手は構えに戻っている
      //   → 基準がずれていると判断して今の姿勢で取り直し、強制的に 0 へ戻す
      if (a.inHome && s.ok && reach > homeCfg.stuckReach && nowMs - a.lastPunchMs > homeCfg.stuckMs) {
        this._relearn(side, s, dt, 0);   // tau=0 → 即座に現在値を基準にする
        a.reachFilter.forceHome();
        a.swing.reset();
      }
      const sw = a.swing.update(a.reachFilter.value, nowMs);
      if (sw.fired) { a.lastPunchMs = nowMs; a.punchSpeed = a.speed; }
      a.swingActive = sw.active;
      a.reach = clamp(Math.max(a.reachFilter.value, this._snap(a, nowMs)), 0, 1);
      if (side === "left") out.punchL = sw.fired; else out.punchR = sw.fired;
      frame.arms[side] = {
        elbow: { x: (s.el.x - s.sh.x) / w, y: (s.el.y - s.sh.y) / w },
        wrist: { x: (s.wr.x - s.sh.x) / w, y: (s.wr.y - s.sh.y) / w },
        reach: a.reach,
        swingActive: a.swingActive,
      };
    }
    out.frame = frame;
    out.debug = {
      guardLocked: this.guardLocked,
      distanceRatio: this.distanceRatio,
      distParts: this.distParts ?? null,
      yawDeg: (this.yaw * 180) / Math.PI,
      hands: !!hands?.length,
      angleSource: this.arms.right.angleSource,
      left: this._armDebug("left"), right: this._armDebug("right"),
    };
    return out;
  }

  _armDebug(side) {
    const a = this.arms[side];
    return { angle: a.sig.angle, shorten: a.sig.shorten, handSize: a.sig.handSize,
      handModel: a.sig.handModel, depthZ: a.sig.depthZ,
      handArea: a.sig.handArea,
      raw: a.raw, reach: a.reach, swing: a.swingActive, elbowDeg: a.elbowDeg,
      home: a.inHome, handFresh: (this._nowMs - a.lastHandSeenMs) <= this.t.reach.handStaleMs };
  }

  /**
   * HandLandmarker の結果 → 手ごとの見かけサイズ（肩幅で正規化）。
   * 左右は handedness ラベルではなく **pose の手首位置に近い方**で対応付ける
   * （ミラー表示やラベルの揺れに影響されないため）。
   */
  _handSizes(hands, aspect, shoulderWidth, seg) {
    const out = { left: null, right: null };
    if (!hands?.length || shoulderWidth < 1e-4) return out;
    for (const h of hands) {
      const lm = h.landmarks;
      if (!lm?.length) continue;
      const at = (i) => ({ x: (1 - lm[i].x) * aspect, y: lm[i].y }); // pose と同じミラー等方空間
      const wrist = at(HL.wrist);
      // 手首→中指 MCP。指の開閉に影響されにくい「手のひらの長さ」。
      const palm = Math.hypot(at(HL.middleMcp).x - wrist.x, at(HL.middleMcp).y - wrist.y) / shoulderWidth;
      // 21 点の凸包面積 → sqrt で長さ次元に戻す。面積は距離の 2 乗で効くので S/N が良い。
      const pts = lm.map((_, i) => at(i));
      const areaLen = Math.sqrt(convexHullArea(pts)) / shoulderWidth;
      let best = null, bestD = Infinity;
      for (const [side] of SIDES) {
        if (!seg[side]?.ok) continue;
        const d = Math.hypot(seg[side].wr.x - wrist.x, seg[side].wr.y - wrist.y);
        if (d < bestD) { bestD = d; best = side; }
      }
      // 手首から遠すぎる検出は別人 / 誤検出として捨てる（肩幅の半分より遠い）
      if (best && bestD < shoulderWidth * 0.5) {
        out[best] = { palm, areaLen };
        this.arms[best].lastHandSeenMs = this._nowMs;
      }
    }
    return out;
  }

  /**
   * 体幹ヨー（ひねり）の更新。肩のヨーから腰のヨーを引いた「ひねり」を使い、
   * 腰が見えなければ肩のヨーをそのまま使う。構え時の値を 0 基準にする。
   */
  _updateYaw(p, shoulderWidth, dt) {
    const cfg = this.t.twist;
    const maxRad = (cfg.maxDeg * Math.PI) / 180;
    const sh = estimateYaw(
      { xL: p[LM.shoulderL].x, xR: p[LM.shoulderR].x, zL: p[LM.shoulderL].z, zR: p[LM.shoulderR].z },
      shoulderWidth / (this.base.shoulderWidth || shoulderWidth), this._aspect, maxRad,
    );
    if (sh == null) return;
    let yaw = sh;
    if (this.visible.get(LM.hipL) && this.visible.get(LM.hipR)) {
      const hip = estimateYaw(
        { xL: p[LM.hipL].x, xR: p[LM.hipR].x, zL: p[LM.hipL].z, zR: p[LM.hipR].z },
        1, this._aspect, maxRad,
      );
      // 体ごと向きを変えた分（腰のヨー）は差し引き、上体の「ひねり」だけを残す
      if (hip != null) yaw = sh - hip;
    }
    this.rawYaw = yaw;
    if (this.base.yaw == null) this.base.yaw = yaw;   // 構え時を 0 基準に
    const rel = yaw - this.base.yaw;
    const dead = (cfg.deadbandDeg * Math.PI) / 180;
    const target = Math.abs(rel) < dead ? 0 : rel;
    this.yaw = clamp(this.yawFilter.filter(target, dt), -maxRad, maxRad);
  }

  /** 前後距離の推定に使う「見かけの体格」。取れないものは null。 */
  _bodyMetrics(p, shoulderWidth) {
    const vis = (i) => this.visible.get(i);
    const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let torso = null;
    if (vis(LM.hipL) && vis(LM.hipR)) {
      const sm = { x: (p[LM.shoulderL].x + p[LM.shoulderR].x) / 2, y: (p[LM.shoulderL].y + p[LM.shoulderR].y) / 2 };
      const hm = { x: (p[LM.hipL].x + p[LM.hipR].x) / 2, y: (p[LM.hipL].y + p[LM.hipR].y) / 2 };
      torso = dist2(sm, hm);
    }
    let face = null;
    if (vis(LM.earL) && vis(LM.earR)) face = dist2(p[LM.earL], p[LM.earR]);
    else if (vis(LM.eyeL) && vis(LM.eyeR)) face = dist2(p[LM.eyeL], p[LM.eyeR]);
    // 骨格全体のスケール: 両肩+両腰の bbox 対角。腕の姿勢に影響されない一番素直な距離指標。
    let frame = null;
    if (vis(LM.hipL) && vis(LM.hipR)) {
      const q = [p[LM.shoulderL], p[LM.shoulderR], p[LM.hipL], p[LM.hipR]];
      const xs = q.map((a) => a.x), ys = q.map((a) => a.y);
      frame = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
    return { shoulder: shoulderWidth, torso, face, frame };
  }

  /**
   * 前後距離。構え時の見かけサイズに対する比（>1 = カメラに近づいた＝前へ出た）。
   * 肩幅 / 体幹縦長 / 顔幅 の比のメディアンを取り、腕を上げた等で 1 つが崩れても効かないようにする。
   * 1€ を強めに掛け、デッドバンドで小さな揺れを捨てる（じわじわ前進して見えるのを防ぐ）。
   */
  _updateDistance(body, dt) {
    const b = this.base;
    const pairs = [];
    const push = (cur, base, w) => { if (cur != null && base > 1e-4) pairs.push([cur / base, w]); };
    const c = this.t.distance;
    push(body.shoulder, b.shoulderWidth, c.weights.shoulder);
    push(body.torso, b.torsoLen, c.weights.torso);
    push(body.face, b.faceWidth, c.weights.face);
    push(body.frame, b.frameDiag, c.weights.frame);
    if (!pairs.length) return;
    this.distParts = { shoulder: body.shoulder / b.shoulderWidth,
      torso: body.torso != null && b.torsoLen > 1e-4 ? body.torso / b.torsoLen : null,
      face: body.face != null && b.faceWidth > 1e-4 ? body.face / b.faceWidth : null,
      frame: body.frame != null && b.frameDiag > 1e-4 ? body.frame / b.frameDiag : null };
    const raw = clamp(weightedMedian(pairs), c.ratioClamp[0], c.ratioClamp[1]);
    const target = deadband(this.distanceRatio, raw, c.deadband);
    this.distanceRatio = this.distFilter.filter(target, dt);
  }

  /** 各信号（肘角度 / 前腕の短縮 / 手の見かけサイズ / 手モデル / 画像空間 z）を 0..1 に正規化して返す。 */
  _signals(side, s, dt, nowMs) {
    const a = this.arms[side];
    const cfg = this.t.reach;
    // 見えていないフレームは**直前値を保持しない**（保持すると、伸ばした値のまま張り付いて腕が戻らない）
    if (!s.ok) return { angle: null, shorten: null, handSize: null, handModel: null, handArea: null, depthZ: null };

    // 肘角度: 3D / 2D の両方を出し、フレーム間のブレが小さい方を採用する
    const ang3d = jointAngle(s.sh, s.el, s.wr, true);
    const ang2d = jointAngle(s.sh, s.el, s.wr, false);
    const k = 1 - Math.exp(-dt / 0.6);
    if (a.prev3d != null) a.jitter3d += k * (Math.abs(ang3d - a.prev3d) - a.jitter3d);
    if (a.prev2d != null) a.jitter2d += k * (Math.abs(ang2d - a.prev2d) - a.jitter2d);
    a.prev3d = ang3d; a.prev2d = ang2d;
    a.angleSource = a.jitter3d <= a.jitter2d ? "3d" : "2d";
    a.elbowDeg = a.angleSource === "3d" ? ang3d : ang2d;

    const angle = mapRange(a.elbowDeg, cfg.angle.minDeg, cfg.angle.maxDeg);
    const baseFore = this.base.forearm[side] || s.forearm;
    const shorten = baseFore > 1e-4
      ? mapRange(s.forearm / baseFore, cfg.shorten.maxRatio, cfg.shorten.minRatio) : null;
    const baseHand = this.base.handSpan[side];
    const handSize = (baseHand > 1e-4 && s.handSpan != null)
      ? mapRange(s.handSpan / baseHand, cfg.handSize.minRatio, cfg.handSize.maxRatio) : null;
    // HandLandmarker 版（手のひら長）。pose の 4 点版より安定するので、あればこちらを主に使う。
    // ただし**見失ったら合成から外す**（最後の大きい値を持ち続けると腕が戻らなくなる）。
    const baseModel = this.base.handModel[side];
    const fresh = nowMs - a.lastHandSeenMs <= cfg.handStaleMs;
    const handModel = (fresh && baseModel > 1e-4 && s.handModel != null)
      ? mapRange(s.handModel / baseModel, cfg.handModel.minRatio, cfg.handModel.maxRatio) : null;
    // 21 点の凸包面積（sqrt 済み）の比。主信号。
    const baseArea = this.base.handArea[side];
    const handArea = (fresh && baseArea > 1e-4 && s.handArea != null)
      ? mapRange(s.handArea / baseArea, cfg.handArea.minRatio, cfg.handArea.maxRatio) : null;
    // pose の画像空間 z（腰中心の相対値・x と同スケール）。手首が肩より手前に出た量を肩幅で正規化。
    // ※ 最初に捨てた worldLandmarks.z とは別の量。
    // 肩幅は x を aspect 倍した空間で測っているが z は素のままなので、比較のため aspect を戻す。
    // 値は**構え時からの差分**で見る（構えで必ず 0 になる ＝ 胸の前に戻せば 0）。
    const swRaw = this.base.shoulderWidth / (this._aspect || 1);
    const dz = (s.wr.z - s.sh.z) / swRaw;
    a.rawDepthZ = dz;
    const depthZ = mapRange(dz - (this.base.depthZ[side] ?? 0), cfg.depthZ.minDelta, cfg.depthZ.maxDelta);
    return { angle, shorten, handSize, handModel, handArea, depthZ };
  }

  /**
   * 構えに戻っている間の基準の再学習。tau=0 なら即座に今の値を基準にする（スタック復帰）。
   * 「構え姿勢＝reach 0」を保ち続けるための仕組みで、キャリブレーション時とのズレ
   * （立ち位置・服・照明の変化）を吸収する。
   */
  _relearn(side, s, dt, tauSec) {
    const k = tauSec > 0 ? 1 - Math.exp(-Math.max(dt, 0) / tauSec) : 1;
    const b = this.base;
    if (s.forearm > 1e-4) b.forearm[side] += k * (s.forearm - b.forearm[side]);
    if (s.handSpan != null) b.handSpan[side] += k * (s.handSpan - b.handSpan[side]);
    if (s.handModel != null) b.handModel[side] += k * (s.handModel - b.handModel[side]);
    if (s.handArea != null) b.handArea[side] += k * (s.handArea - b.handArea[side]);
    const a = this.arms[side];
    if (a.rawDepthZ != null) b.depthZ[side] += k * (a.rawDepthZ - (b.depthZ[side] ?? 0));
  }

  /** パンチ発火からの経過で 0 → 1 → 0 と動く突き出し量。速いパンチほど深い。 */
  _snap(arm, nowMs) {
    const s = this.t.reach.snap;
    const dt = nowMs - arm.lastPunchMs;
    if (dt < 0 || dt > s.riseMs + s.holdMs + s.fallMs) return 0;
    const amount = clamp(Math.max(s.minAmount, arm.punchSpeed / s.speedRefMps), 0, 1);
    if (dt < s.riseMs) return amount * (dt / s.riseMs);
    if (dt < s.riseMs + s.holdMs) return amount;
    return amount * (1 - (dt - s.riseMs - s.holdMs) / s.fallMs);
  }

  _calibrate(shoulderWidth, midX, noseY, seg, body, nowMs) {
    if (this._calibStartMs < 0) {
      this._calibStartMs = nowMs;
      this._acc = { sw: 0, mx: 0, ny: 0, n: 0,
        fa: { left: 0, right: 0 }, ua: { left: 0, right: 0 }, an: { left: 0, right: 0 },
        hs: { left: 0, right: 0 }, hn: { left: 0, right: 0 },
        hm: { left: 0, right: 0 }, hmn: { left: 0, right: 0 },
        ha: { left: 0, right: 0 }, han: { left: 0, right: 0 },
        frame: 0, frameN: 0,
        dz: { left: 0, right: 0 }, dzn: { left: 0, right: 0 },
        yaw: 0, yawN: 0,
        torso: 0, torsoN: 0, face: 0, faceN: 0 };
    }
    this._acc.sw += shoulderWidth; this._acc.mx += midX; this._acc.ny += noseY; this._acc.n++;
    for (const [side] of SIDES) {
      if (!seg[side].ok) continue;
      this._acc.fa[side] += seg[side].forearm;
      this._acc.ua[side] += seg[side].upperArm;
      this._acc.an[side]++;
      if (seg[side].handSpan != null) { this._acc.hs[side] += seg[side].handSpan; this._acc.hn[side]++; }
      if (seg[side].handModel != null) { this._acc.hm[side] += seg[side].handModel; this._acc.hmn[side]++; }
      if (seg[side].handArea != null) { this._acc.ha[side] += seg[side].handArea; this._acc.han[side]++; }
      // 画像空間 z（構えでの肩→手首の手前方向の差）
      if (seg[side].sh && seg[side].wr) {
        const swRaw = shoulderWidth / (this._aspect || 1);
        this._acc.dz[side] += (seg[side].wr.z - seg[side].sh.z) / swRaw;
        this._acc.dzn[side]++;
      }
    }
    if (body?.torso != null) { this._acc.torso += body.torso; this._acc.torsoN++; }
    if (body?.face != null) { this._acc.face += body.face; this._acc.faceN++; }
    if (body?.frame != null) { this._acc.frame += body.frame; this._acc.frameN++; }
    if (this.rawYaw != null) { this._acc.yaw += this.rawYaw; this._acc.yawN++; }
    this.calibProgress = clamp((nowMs - this._calibStartMs) / this.t.calibrationMs, 0, 1);
    const n = this._acc.n;
    const avg = (m, c, side) => (c[side] ? m[side] / c[side] : 0);
    this.base = {
      shoulderWidth: this._acc.sw / n, midX: this._acc.mx / n, noseY: this._acc.ny / n,
      forearm: { left: avg(this._acc.fa, this._acc.an, "left"), right: avg(this._acc.fa, this._acc.an, "right") },
      upperArm: { left: avg(this._acc.ua, this._acc.an, "left"), right: avg(this._acc.ua, this._acc.an, "right") },
      handSpan: { left: avg(this._acc.hs, this._acc.hn, "left"), right: avg(this._acc.hs, this._acc.hn, "right") },
      handModel: { left: avg(this._acc.hm, this._acc.hmn, "left"), right: avg(this._acc.hm, this._acc.hmn, "right") },
      handArea: { left: avg(this._acc.ha, this._acc.han, "left"), right: avg(this._acc.ha, this._acc.han, "right") },
      // 画像空間 z の構え時の値（この差分でリーチを見る）
      depthZ: { left: avg(this._acc.dz, this._acc.dzn, "left"), right: avg(this._acc.dz, this._acc.dzn, "right") },
      // 前後距離の基準（構え位置での見かけサイズ）
      torsoLen: this._acc.torsoN ? this._acc.torso / this._acc.torsoN : 0,
      faceWidth: this._acc.faceN ? this._acc.face / this._acc.faceN : 0,
      frameDiag: this._acc.frameN ? this._acc.frame / this._acc.frameN : 0,
      // 構え時のヨー（この値を 0 とみなす）。計測できていなければ最初のフレームで入る。
      yaw: this._acc.yawN ? this._acc.yaw / this._acc.yawN : null,
    };
  }

  /**
   * FIGHT 中のゆるやかな基準追従。腕の長さ・手のスパンは「伸ばしている最中に基準が
   * 縮む / 育つ」と困るので、前腕は長い時だけ・手スパンは小さい時だけ追従させる
   * （構えの値＝前腕は最大長 / 手は最小サイズ、という扱い）。
   */
  _follow(shoulderWidth, midX, noseY, seg, dt) {
    const k = 1 - Math.exp(-dt / this.t.baselineTauSec);
    this.base.shoulderWidth += k * (shoulderWidth - this.base.shoulderWidth);
    this.base.midX += k * (midX - this.base.midX);
    this.base.noseY += k * (noseY - this.base.noseY);
    for (const [side] of SIDES) {
      const s = seg[side];
      if (!s.ok) continue;
      if (s.forearm > this.base.forearm[side]) this.base.forearm[side] += k * (s.forearm - this.base.forearm[side]);
      if (s.upperArm > this.base.upperArm[side]) this.base.upperArm[side] += k * (s.upperArm - this.base.upperArm[side]);
      if (s.handSpan != null && s.handSpan < this.base.handSpan[side]) {
        this.base.handSpan[side] += k * (s.handSpan - this.base.handSpan[side]);
      }
      if (s.handModel != null && this.base.handModel[side] > 1e-4 && s.handModel < this.base.handModel[side]) {
        this.base.handModel[side] += k * (s.handModel - this.base.handModel[side]);
      }
    }
  }

  recalibrate() {
    this._calibStartMs = -1;
    this._acc = null;
    this.calibProgress = 0;
    this.base = null;
    for (const a of Object.values(this.arms)) { a.reachFilter.reset(); a.swing.reset(); }
  }
}
