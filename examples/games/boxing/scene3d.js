/**
 * Scene3D — 3D 表示（Three.js）。**位置は一切ここで決めない**。
 *
 * プレイヤーの体も敵グローブの軌道も combat.js（純関数）が算出し、boxing.js が判定に使った
 * のと同じ座標をそのまま渡してくる。だから「見えている位置」と「当たる位置」は必ず一致する。
 *
 * 視点は 2 つ:
 *   third（既定）… 背後やや上。自分の上半身と**頭の当たり判定球**が見えるので、
 *                   腕を頭の前に置けばガードになる／上体を振れば頭球が逃げる、が目で分かる。
 *   first        … 一人称（頭球は非表示）。
 *
 * 座標系（combat.js と共通）: +X=画面右 / +Y=上 / -Z=前方（敵の方向）。単位はメートル。
 * プレイヤーの右手が画面右に来るのは、背後から見ても一人称でもカメラが -Z を向くため。
 * （MediaPipe の軸と実測の対応は gestures.js / README を参照）
 */

import * as THREE from "three";
import { boneLocalRotation, matchBoneName, fitScale, vsub, vlen } from "./bones.js";

const UP = new THREE.Vector3(0, 1, 0);
const FLOOR_DROP = 1.55;   // プレイヤーの目線から床まで [m]

/** 円柱メッシュを 2 点間に架け渡す（geometry は半径 r・高さ 1・原点中心）。 */
function orientBone(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const l = dir.length();
  if (l < 1e-5) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.scale.set(1, l, 1);
}
const setV = (o, p) => o.position.set(p.x, p.y, p.z);

/** カプセル（Y 軸・length=1 で生成）を 2 点間に置く。 */
function placeCapsule(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const l = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.scale.set(1, Math.max(l, 1e-4), 1);
}

export class Scene3D {
  /** @param {HTMLCanvasElement} canvas @param {object} cfg COMBAT */
  constructor(canvas, cfg) {
    this.cfg = cfg;
    this.mode = cfg.view.mode;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1018);
    this.scene.fog = new THREE.Fog(0x0a1018, 4, 14);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 60);
    this.shake = { x: 0, y: 0 };

    this.scene.add(new THREE.HemisphereLight(0x9fc7ff, 0x202028, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.2, 2.4, 1.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7c5cff, 0.9);
    rim.position.set(-1.5, 1.2, -2.4);
    this.scene.add(rim);

    this.humanoids = { player: null, enemy: null };
    this._buildRing();
    this._buildEnemy();
    this._buildPlayer();
    this._buildDebug();
  }

  /**
   * リング。マット + 4 本のポスト + 3 段ロープ + コーナーパッド（すべて簡易ジオメトリの自作）。
   * 両者の立ち位置を囲む位置（原点と敵の中間）に置く。
   */
  _buildRing() {
    const g = new THREE.Group();
    const R = this.cfg.ring ?? { half: 2.6, postHeight: 1.35, ropeYs: [0.45, 0.8, 1.15] };
    const floorY = -FLOOR_DROP;
    const mat = new THREE.Mesh(
      new THREE.BoxGeometry(R.half * 2, 0.12, R.half * 2),
      new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.95 }),
    );
    mat.position.set(0, floorY - 0.06, 0);
    g.add(mat);
    // 場外（会場の床）— 単色背景に地平線が出るよう広めに敷く
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(14, 40),
      new THREE.MeshStandardMaterial({ color: 0x11161f, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = floorY - 0.13;
    g.add(apron);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa8bd, roughness: 0.4, metalness: 0.5 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xd24a4a, roughness: 0.7 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, R.postHeight, 10), postMat);
        post.position.set(sx * R.half, floorY + R.postHeight / 2, sz * R.half);
        g.add(post);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, R.postHeight * 0.75, 12), padMat);
        pad.position.set(sx * R.half, floorY + R.postHeight * 0.42, sz * R.half);
        g.add(pad);
      }
    }
    // ロープ: 4 辺 × 3 段
    for (const y of R.ropeYs) {
      for (const axis of ["x", "z"]) {
        for (const s2 of [-1, 1]) {
          const len = R.half * 2;
          const rope = new THREE.Mesh(
            new THREE.BoxGeometry(axis === "x" ? len : 0.03, 0.03, axis === "x" ? 0.03 : len),
            ropeMat,
          );
          rope.position.set(axis === "x" ? 0 : s2 * R.half, floorY + y, axis === "x" ? s2 * R.half : 0);
          g.add(rope);
        }
      }
    }
    // リングの中心は両者の中間あたり（プレイヤーが原点、敵が -enemyDist）
    g.position.z = -this.cfg.enemyDist / 2;
    this.ring = g;
    this.scene.add(g);
    this.floor = mat;      // 既存コードの参照先を保つ
    this.ropes = g;
  }

  _buildEnemy() {
    const g = new THREE.Group();
    const c = this.cfg.enemy;
    this.enemyMat = new THREE.MeshStandardMaterial({ color: 0x46566f, roughness: 0.5 });
    // 頭は狙う的なので、胴よりはっきり見える色にする
    this.enemyHead = new THREE.Mesh(new THREE.SphereGeometry(c.headRadius, 26, 20), this.enemyMat);
    const torsoLen = c.torsoTopY - c.torsoBottomY;
    this.enemyTorso = new THREE.Mesh(
      new THREE.CapsuleGeometry(c.torsoRadius, torsoLen, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0x2b3444, roughness: 0.85 }),
    );
    g.add(this.enemyHead, this.enemyTorso);
    // 腕（肩→肘→グローブ）。グローブ単体が飛んでくるのではなく、腕が伸びてくるようにする。
    const armMat = new THREE.MeshStandardMaterial({ color: 0x7d8798, roughness: 0.6 });
    const armGeo = new THREE.CylinderGeometry(0.036, 0.036, 1, 12);
    this.enemyGloves = {};
    this.enemyArms = {};
    for (const side of ["left", "right"]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xd24a4a, emissive: 0x000000, roughness: 0.45 });
      const m = new THREE.Mesh(new THREE.SphereGeometry(c.gloveRadius, 22, 16), mat);
      this.enemyGloves[side] = { mesh: m, mat };
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), armMat);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), armMat);
      const upper = new THREE.Mesh(armGeo, armMat);
      const fore = new THREE.Mesh(armGeo, armMat);
      this.enemyArms[side] = { shoulder, elbow, upper, fore };
      g.add(m, shoulder, elbow, upper, fore);
    }
    this.enemy = g;
    this.scene.add(g);
  }

  _buildPlayer() {
    const rig = new THREE.Group();
    const c = this.cfg.player;
    // 敵を隠さないよう、体は細め＋半透明ぎみ
    const boneMat = new THREE.MeshStandardMaterial({ color: 0x9aa8bd, roughness: 0.6, transparent: true, opacity: 0.9 });
    const jointMat = new THREE.MeshStandardMaterial({ color: 0xdfe7f2, roughness: 0.5, transparent: true, opacity: 0.9 });
    const boneGeo = new THREE.CylinderGeometry(0.032, 0.032, 1, 12);

    this.pHead = new THREE.Mesh(
      new THREE.SphereGeometry(c.headRadius * 0.82, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: 0.45, transparent: true, opacity: 0.55 }),
    );
    // 当たり判定球そのものを薄く光らせて可視化する（敵グローブがここへ迫るのが見える）
    this.pHeadHit = new THREE.Mesh(
      new THREE.SphereGeometry(c.headRadius, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0x6cd1ff, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    // 胴の当たり判定カプセル（敵は頭か胴を狙ってくる）。頭球と同じく薄く光らせて見せる。
    this.pTorsoHit = new THREE.Mesh(
      new THREE.CapsuleGeometry(c.torsoRadius, 1, 6, 14),
      new THREE.MeshBasicMaterial({ color: 0x6cd1ff, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.pShoulders = { left: new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), jointMat), right: new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), jointMat) };
    this.pElbows = { left: new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 10), jointMat), right: new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 10), jointMat) };
    this.pBones = {
      upperL: new THREE.Mesh(boneGeo, boneMat), foreL: new THREE.Mesh(boneGeo, boneMat),
      upperR: new THREE.Mesh(boneGeo, boneMat), foreR: new THREE.Mesh(boneGeo, boneMat),
      chest: new THREE.Mesh(boneGeo, boneMat), spine: new THREE.Mesh(boneGeo, boneMat),
      neck: new THREE.Mesh(boneGeo, boneMat),
    };
    // グローブ: 左=青 / 右=赤（背後視点でも一人称でも、自分の右手は画面右）
    this.pGloves = {
      left: new THREE.Mesh(new THREE.SphereGeometry(c.gloveRadius, 22, 16),
        new THREE.MeshStandardMaterial({ color: 0x4a7bff, emissive: 0x0a1740, roughness: 0.4 })),
      right: new THREE.Mesh(new THREE.SphereGeometry(c.gloveRadius, 22, 16),
        new THREE.MeshStandardMaterial({ color: 0xff5f6d, emissive: 0x3a0d12, roughness: 0.4 })),
    };
    rig.add(this.pHead, this.pHeadHit, this.pTorsoHit, ...Object.values(this.pShoulders), ...Object.values(this.pElbows),
      ...Object.values(this.pBones), ...Object.values(this.pGloves));
    this.rig = rig;
    rig.visible = false;
    this.scene.add(rig);
  }

  /** 当たり判定のワイヤ可視化（トグル）。実際に判定に使う半径をそのまま描く。 */
  _buildDebug() {
    const wire = (r, color) => new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 10),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    const c = this.cfg;
    const cap = (r, color) => new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 1, 10),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45 }),
    );
    this.dbg = new THREE.Group();
    this.dbgPlayer = {
      head: wire(c.player.headRadius, 0x6cd1ff),
      gloveL: wire(c.player.gloveRadius, 0x6cd1ff), gloveR: wire(c.player.gloveRadius, 0x6cd1ff),
      foreL: new THREE.Mesh(new THREE.CylinderGeometry(c.player.forearmRadius, c.player.forearmRadius, 1, 10),
        new THREE.MeshBasicMaterial({ color: 0x6cd1ff, wireframe: true, transparent: true, opacity: 0.45 })),
      foreR: new THREE.Mesh(new THREE.CylinderGeometry(c.player.forearmRadius, c.player.forearmRadius, 1, 10),
        new THREE.MeshBasicMaterial({ color: 0x6cd1ff, wireframe: true, transparent: true, opacity: 0.45 })),
      torso: new THREE.Mesh(new THREE.CapsuleGeometry(c.player.torsoRadius, 1, 6, 12),
        new THREE.MeshBasicMaterial({ color: 0x6cd1ff, wireframe: true, transparent: true, opacity: 0.4 })),
      upperL: cap(c.player.upperArmRadius, 0x9ae6ff), upperR: cap(c.player.upperArmRadius, 0x9ae6ff),
    };
    this.dbgEnemy = {
      head: wire(c.enemy.headRadius, 0xffa04a),
      torso: new THREE.Mesh(new THREE.CapsuleGeometry(c.enemy.torsoRadius, c.enemy.torsoTopY - c.enemy.torsoBottomY, 6, 12),
        new THREE.MeshBasicMaterial({ color: 0xffa04a, wireframe: true, transparent: true, opacity: 0.4 })),
      gloveL: wire(c.enemy.gloveRadius, 0xffa04a), gloveR: wire(c.enemy.gloveRadius, 0xffa04a),
      foreL: cap(c.enemy.forearmRadius, 0xffd479), foreR: cap(c.enemy.forearmRadius, 0xffd479),
      upperL: cap(c.enemy.upperArmRadius, 0xffd479), upperR: cap(c.enemy.upperArmRadius, 0xffd479),
    };
    this.dbg.add(...Object.values(this.dbgPlayer), ...Object.values(this.dbgEnemy));
    this.dbg.visible = false;
    this.scene.add(this.dbg);
  }

  // ── 任意の人型アセット（CC0）。無ければプリミティブ表現のまま動く ─────────────
  /**
   * 人型モデルを読み込む。**すべて任意**で、失敗しても例外にせず
   * プリミティブ表現のまま続行する（アセットは git に入れていないため未配置が普通）。
   * @param {{player?:string, enemy?:string}} urls
   * @returns {Promise<{player:boolean, enemy:boolean, errors:string[]}>}
   */
  async loadAssets(urls = {}) {
    const result = { player: false, enemy: false, errors: [] };
    for (const who of ["player", "enemy"]) {
      if (!urls[who]) continue;
      try {
        const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
        const gltf = await new GLTFLoader().loadAsync(urls[who]);
        const rig = this._prepareHumanoid(gltf.scene, who);
        if (rig) { this.humanoids[who] = rig; result[who] = true; }
        else result.errors.push(`${who}: ボーンが見つかりません`);
      } catch (e) { result.errors.push(`${who}: ${e?.message ?? e}`); }
    }
    this._syncPrimitiveVisibility();
    return result;
  }

  /** モデルからボーンを拾い、体格を測って、ゲーム側の寸法に合わせる。 */
  _prepareHumanoid(model, who) {
    const bones = {};
    const want = [
      ["hips", null], ["spine", null], ["chest", null], ["neck", null], ["head", null],
      ["shoulder", "left"], ["shoulder", "right"],
      ["upperArm", "left"], ["upperArm", "right"],
      ["lowerArm", "left"], ["lowerArm", "right"],
      ["hand", "left"], ["hand", "right"],
    ];
    model.traverse((o) => {
      if (!o.isBone) return;
      for (const [kind, side] of want) {
        const key = side ? `${kind}${side === "left" ? "L" : "R"}` : kind;
        if (!bones[key] && matchBoneName(o.name, kind, side)) bones[key] = o;
      }
    });
    if (!bones.upperArmL || !bones.upperArmR || !bones.lowerArmL || !bones.lowerArmR) return null;

    model.updateWorldMatrix(true, true);
    const wp = (b) => { const v = new THREE.Vector3(); b.getWorldPosition(v); return { x: v.x, y: v.y, z: v.z }; };
    const shoulderSpan = vlen(vsub(wp(bones.upperArmL), wp(bones.upperArmR)));
    const armLength = vlen(vsub(wp(bones.upperArmL), wp(bones.lowerArmL)))
      + vlen(vsub(wp(bones.lowerArmL), wp(bones.handL ?? bones.lowerArmL)));
    const target = {
      shoulderSpan: this.cfg.rig.shoulderHalf * 2,
      armLength: this.cfg.rig.bones.upperArm + this.cfg.rig.bones.foreArm,
    };
    const scale = fitScale({ shoulderSpan, armLength }, target);
    model.scale.setScalar(scale);
    // 休め姿勢での骨の向き（この向きを「向けたい向き」へ回す）
    const restDir = {};
    for (const side of ["L", "R"]) {
      restDir[`upperArm${side}`] = this._localDir(bones[`upperArm${side}`], bones[`lowerArm${side}`]);
      restDir[`lowerArm${side}`] = this._localDir(bones[`lowerArm${side}`], bones[`hand${side}`] ?? bones[`lowerArm${side}`]);
    }
    this.scene.add(model);
    return { model, bones, restDir, scale, who };
  }

  /** 親ボーンのローカル空間で見た「子へ向かう向き」（＝休め姿勢の骨の向き）。 */
  _localDir(bone, child) {
    if (!bone || !child || bone === child) return { x: 0, y: 1, z: 0 };
    const v = child.position.clone().normalize();   // 子の position は親ローカル
    return { x: v.x, y: v.y, z: v.z };
  }

  /**
   * 人型が入ったら、その側のプリミティブの体は隠す（当たり判定の可視化は残す）。
   * プレイヤー側は視点によって出し分けがあるので update() 側で毎フレーム判断する。
   */
  _syncPrimitiveVisibility() {
    if (this.humanoids.enemy) {
      this.enemyHead.visible = false;
      this.enemyTorso.visible = false;
      for (const side of ["left", "right"]) {
        const a = this.enemyArms[side];
        for (const m of [a.shoulder, a.elbow, a.upper, a.fore]) m.visible = false;
      }
    }
  }

  /**
   * 合成ポーズ（位置）→ ボーン回転。位置を直接置かず、親から順に回す。
   * 当たり判定は今まで通りデータ側で行い、ここは表示だけ。
   */
  _driveHumanoid(rig, pose, facing) {
    const { model, bones, restDir } = rig;
    // 立ち位置: 肩の中点の真下に置き、相手の方を向かせる
    const mid = {
      x: (pose.shoulders.left.x + pose.shoulders.right.x) / 2,
      z: (pose.shoulders.left.z + pose.shoulders.right.z) / 2,
    };
    model.position.set(mid.x, -FLOOR_DROP, mid.z);
    model.rotation.set(0, facing + (pose.yaw ?? 0) * 0.5, 0);
    model.updateWorldMatrix(true, true);

    const q = new THREE.Quaternion();
    const apply = (bone, restLocal, targetDir) => {
      if (!bone || !bone.parent) return;
      bone.parent.getWorldQuaternion(q);
      const local = boneLocalRotation(restLocal, targetDir, { x: q.x, y: q.y, z: q.z, w: q.w });
      bone.quaternion.set(local.x, local.y, local.z, local.w);
      bone.updateWorldMatrix(false, true);
    };
    for (const [side, key] of [["left", "L"], ["right", "R"]]) {
      const arm = pose[side];
      if (!arm) continue;
      apply(bones[`upperArm${key}`], restDir[`upperArm${key}`], vsub(arm.elbow, pose.shoulders[side]));
      apply(bones[`lowerArm${key}`], restDir[`lowerArm${key}`], vsub(arm.wrist, arm.elbow));
    }
  }

  // ── 更新 ───────────────────────────────────────────────────────────────────
  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setCameraMode(mode) { this.mode = mode === "first" ? "first" : "third"; }
  toggleCameraMode() { this.setCameraMode(this.mode === "third" ? "first" : "third"); return this.mode; }
  setDebug(on) { this.dbg.visible = !!on; }
  setShake(x, y) { this.shake.x = x; this.shake.y = y; }

  /**
   * 1 フレーム反映。位置はすべて呼び出し側（combat.js 経由）が算出済みのワールド座標。
   * @param {{pose:object|null, enemy:object, hurt:number}} view
   */
  update(view) {
    const { pose, enemy } = view;
    // ── 敵 ──
    const e = this.cfg.enemy;
    setV(this.enemyHead, enemy.head);
    this.enemyTorso.position.set(enemy.head.x, (e.torsoTopY + e.torsoBottomY) / 2 + (enemy.head.y - e.headY), enemy.head.z);
    this.enemy.position.x = 0; // 位置は各パーツの絶対座標で置くので group は原点のまま
    for (const side of ["left", "right"]) {
      setV(this.enemyGloves[side].mesh, enemy.gloves[side]);
      // 腕: combat.buildEnemyPose が IK で解いた肩・肘をそのまま置く（判定と同じ位置）
      const shoulder = enemy.shoulders[side];
      const elbow = enemy[side].elbow;
      const arm = this.enemyArms[side];
      setV(arm.shoulder, shoulder);
      setV(arm.elbow, elbow);
      orientBone(arm.upper, shoulder, elbow);
      orientBone(arm.fore, elbow, enemy.gloves[side]);
    }
    const hurt = Math.max(0, Math.min(1, view.hurt ?? 0));
    this.enemy.rotation.x = -0.3 * hurt;
    this.enemyMat.color.setHex(hurt > 0.02 ? 0xb06060 : enemy.guardUp ? 0x46566f : 0x5b4a72);
    // 攻撃中のグローブは光らせる（テキスト予告の代わりに、光と接近そのものが予告）
    for (const side of ["left", "right"]) {
      const glow = enemy.activeHand === side ? (enemy.phase === "strike" ? 1 : 0.45) : 0;
      this.enemyGloves[side].mat.emissive.setRGB(glow, glow * 0.45, 0);
    }

    // ── 人型モデル（あれば）──
    if (this.humanoids.enemy) this._driveHumanoid(this.humanoids.enemy, enemy, 0);
    if (this.humanoids.player && pose) {
      this._driveHumanoid(this.humanoids.player, pose, Math.PI); // プレイヤーは -Z（敵）を向く
      // 一人称では自分の頭・胴が視界を塞ぐので隠す（腕だけ見せる）
      const headBone = this.humanoids.player.bones.head;
      if (headBone) headBone.scale.setScalar(this.mode === "first" ? 0.001 : 1);
    }

    // ── プレイヤー ──
    if (!pose) { this.rig.visible = false; return; }
    this.rig.visible = true;
    setV(this.pHead, pose.head);
    setV(this.pHeadHit, pose.head);
    // 頭球と体は一人称では見えると邪魔なので隠す
    const third = this.mode === "third";
    const modeled = !!this.humanoids.player;   // 人型が入っていれば素の体は出さない
    this.pHead.visible = third && !modeled;
    this.pHeadHit.visible = third;             // 当たり判定の可視化は残す
    this.pTorsoHit.visible = third;
    for (const m of [...Object.values(this.pShoulders), ...Object.values(this.pElbows), ...Object.values(this.pBones)]) {
      m.visible = m.visible && !modeled;
    }
    this.pBones.neck.visible = third;
    this.pBones.spine.visible = third;

    const shoulderMid = {
      x: (pose.shoulders.left.x + pose.shoulders.right.x) / 2,
      y: (pose.shoulders.left.y + pose.shoulders.right.y) / 2,
      z: (pose.shoulders.left.z + pose.shoulders.right.z) / 2,
    };
    const hip = { x: shoulderMid.x * 0.6, y: shoulderMid.y - 0.45, z: shoulderMid.z };
    for (const side of ["left", "right"]) {
      setV(this.pShoulders[side], pose.shoulders[side]);
      setV(this.pElbows[side], pose[side].elbow);
      setV(this.pGloves[side], pose[side].wrist);
    }
    orientBone(this.pBones.upperL, pose.shoulders.left, pose.left.elbow);
    orientBone(this.pBones.foreL, pose.left.elbow, pose.left.wrist);
    orientBone(this.pBones.upperR, pose.shoulders.right, pose.right.elbow);
    orientBone(this.pBones.foreR, pose.right.elbow, pose.right.wrist);
    orientBone(this.pBones.chest, pose.shoulders.left, pose.shoulders.right);
    orientBone(this.pBones.spine, shoulderMid, hip);
    orientBone(this.pBones.neck, shoulderMid, pose.head);
    if (pose.torsoTop) placeCapsule(this.pTorsoHit, pose.torsoTop, pose.torsoBottom);
    // 胴の見た目だけヨーで回す（カプセルは Y 軸対称なので当たり判定は変わらない）
    this.pTorsoHit.rotateY(pose.yaw ?? 0);

    // ── デバッグ判定表示 ──
    if (this.dbg.visible) {
      setV(this.dbgPlayer.head, pose.head);
      setV(this.dbgPlayer.gloveL, pose.left.wrist);
      setV(this.dbgPlayer.gloveR, pose.right.wrist);
      orientBone(this.dbgPlayer.foreL, pose.left.elbow, pose.left.wrist);
      orientBone(this.dbgPlayer.foreR, pose.right.elbow, pose.right.wrist);
      if (pose.torsoTop) placeCapsule(this.dbgPlayer.torso, pose.torsoTop, pose.torsoBottom);
      setV(this.dbgEnemy.head, enemy.head);
      this.dbgEnemy.torso.position.copy(this.enemyTorso.position);
      setV(this.dbgEnemy.gloveL, enemy.gloves.left);
      setV(this.dbgEnemy.gloveR, enemy.gloves.right);
      orientBone(this.dbgEnemy.foreL, enemy.left.elbow, enemy.left.wrist);
      orientBone(this.dbgEnemy.foreR, enemy.right.elbow, enemy.right.wrist);
      orientBone(this.dbgEnemy.upperL, enemy.shoulders.left, enemy.left.elbow);
      orientBone(this.dbgEnemy.upperR, enemy.shoulders.right, enemy.right.elbow);
      orientBone(this.dbgPlayer.upperL, pose.shoulders.left, pose.left.elbow);
      orientBone(this.dbgPlayer.upperR, pose.shoulders.right, pose.right.elbow);
    }

    this._placeCamera(pose, enemy);
  }

  _placeCamera(pose, enemy) {
    const v = this.cfg.view;
    const h = pose.head;
    if (this.mode === "first") {
      this.camera.position.set(h.x + this.shake.x, h.y + v.first.up + this.shake.y, h.z + v.first.back);
      // わずかに下を向く（構えた自分の拳が画面下部に入るように）。
      // 体幹ひねりの一部だけ視線も振る（酔い対策で pose.headYaw に減衰済み）。
      const hy = pose.headYaw ?? 0;
      const dz = enemy.head.z - h.z, dx = enemy.head.x - h.x;
      this.camera.lookAt(
        h.x + dx * Math.cos(hy) + dz * Math.sin(hy),
        enemy.head.y - (v.first.lookDown ?? 0),
        h.z - dx * Math.sin(hy) + dz * Math.cos(hy),
      );
    } else {
      // 背後やや上。頭の動きにはゆるく追従（頭球が画面内で動く＝避けたのが見える）
      this.camera.position.set(h.x + this.shake.x, h.y * 0.45 + v.third.up + this.shake.y, h.z + v.third.back);
      // 敵の方を向く（敵が左右に回り込んでも画面内に残る）
      this.camera.lookAt(
        h.x + (enemy.head.x - h.x) * 0.5,
        h.y * 0.3 - 0.02,
        h.z + (enemy.head.z - h.z) * 0.5 - v.third.lookAhead * 0.4,
      );
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
  dispose() { this.renderer.dispose(); }
}
