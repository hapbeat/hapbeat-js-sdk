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
import { solveArm } from "./combat.js";

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

    this._buildRing();
    this._buildEnemy();
    this._buildPlayer();
    this._buildDebug();
  }

  _buildRing() {
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.95 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -FLOOR_DROP;
    this.scene.add(this.floor);
    this.ropes = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const rope = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.02, 6, 40),
        new THREE.MeshStandardMaterial({ color: 0x7c5cff, emissive: 0x2a1f6b, roughness: 0.6 }),
      );
      rope.rotation.x = -Math.PI / 2;
      rope.position.y = -FLOOR_DROP + 0.45 + i * 0.35;
      this.ropes.add(rope);
    }
    this.scene.add(this.ropes);
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
    };
    this.dbgEnemy = {
      head: wire(c.enemy.headRadius, 0xffa04a),
      torso: new THREE.Mesh(new THREE.CapsuleGeometry(c.enemy.torsoRadius, c.enemy.torsoTopY - c.enemy.torsoBottomY, 6, 12),
        new THREE.MeshBasicMaterial({ color: 0xffa04a, wireframe: true, transparent: true, opacity: 0.4 })),
      gloveL: wire(c.enemy.gloveRadius, 0xffa04a), gloveR: wire(c.enemy.gloveRadius, 0xffa04a),
    };
    this.dbg.add(...Object.values(this.dbgPlayer), ...Object.values(this.dbgEnemy));
    this.dbg.visible = false;
    this.scene.add(this.dbg);
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
    for (const side of ["left", "right"]) {
      setV(this.enemyGloves[side].mesh, enemy.gloves[side]);
      // 腕: 肩からグローブまでを 2 本の骨で繋ぐ（肘は見た目だけ。判定には使わない）
      const a = this.cfg.enemy.arm;
      const sign = side === "left" ? -1 : 1;
      const shoulder = { x: enemy.head.x + sign * a.shoulderX, y: enemy.head.y + a.shoulderY, z: enemy.head.z + a.shoulderZ };
      const elbow = solveArm(shoulder, enemy.gloves[side], { x: sign, y: -1, z: 0.2 }, a);
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

    // ── プレイヤー ──
    if (!pose) { this.rig.visible = false; return; }
    this.rig.visible = true;
    setV(this.pHead, pose.head);
    setV(this.pHeadHit, pose.head);
    // 頭球と体は一人称では見えると邪魔なので隠す
    const third = this.mode === "third";
    this.pHead.visible = third;
    this.pHeadHit.visible = third;
    this.pTorsoHit.visible = third;
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
    }

    this._placeCamera(pose, enemy);
  }

  _placeCamera(pose, enemy) {
    const v = this.cfg.view;
    const h = pose.head;
    if (this.mode === "first") {
      this.camera.position.set(h.x + this.shake.x, h.y + v.first.up + this.shake.y, h.z + v.first.back);
      // わずかに下を向く（構えた自分の拳が画面下部に入るように）
      this.camera.lookAt(enemy.head.x, enemy.head.y - (v.first.lookDown ?? 0), enemy.head.z);
    } else {
      // 背後やや上。頭の動きにはゆるく追従（頭球が画面内で動く＝避けたのが見える）
      this.camera.position.set(h.x * 0.45 + this.shake.x, h.y * 0.45 + v.third.up + this.shake.y, h.z + v.third.back);
      this.camera.lookAt(h.x * 0.3, h.y * 0.3 - 0.02, h.z - v.third.lookAhead - this.cfg.enemyDist * 0.35);
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
  dispose() { this.renderer.dispose(); }
}
