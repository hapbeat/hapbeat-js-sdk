/**
 * Scene3D — 一人称の 3D 表示（Three.js）。
 *
 * 実カメラ映像は表示しない（トラッキング入力にだけ使う）。プレイヤーの上半身は
 * MediaPipe の worldLandmarks から作ったボーン（関節=球 / 骨=シリンダー / 手首=グローブ）で、
 * カメラは鼻の位置に置く。敵は正面 1.2m のスタイライズ 3D。
 *
 * ── 軸の対応（推測ではなく実測で確定） ────────────────────────────────────────
 * MediaPipe 公式アセット（storage.googleapis.com/mediapipe-assets/pose.jpg）を
 * IMAGE モードで推論した実データ（2026-08-21 計測）:
 *
 *   左肩(11) world x = +0.165 / 右肩(12) world x = -0.147
 *      → +X は画像右。カメラ映像は鏡像でないので、画像右に写るのは被写体の「左」側。
 *        つまり +X_mp ＝ 被写体の左方向。
 *   鼻(0) world y = -0.619（腰の中点が原点）
 *      → +Y は下向き。
 *   鼻(0) world z = -0.146 / カメラへ突き出した左手首(15) z = -0.185（腰原点 = 0）
 *      → z は負ほどカメラに近い（＝前方は -Z_mp）。公式ドキュメントの記述とも一致。
 *
 * 一人称では「自分の右手が画面右」「突き出したグローブが画面奥（敵の方）へ伸びる」に
 * したいので、Three.js（既定カメラは -Z を向き、+Y が上、+X が画面右）へは
 *
 *      (x, y, z)_three = (-x, -y, z)_mp
 *
 * で写す。diag(-1,-1,1) は行列式 +1 の回転なので鏡像化は起きない。結果:
 *   ・被写体の右（-X_mp）→ +X_three → 画面右 ✓
 *   ・上（-Y_mp）→ +Y_three ✓
 *   ・前方（-Z_mp）→ -Z_three ＝ カメラの正面方向 → 突きは奥（敵方向）へ伸びる ✓
 */

import * as THREE from "three";

const LM = { nose: 0, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16, hipL: 23, hipR: 24 };
const TRACKED = Object.values(LM);

/** 平滑化の時定数 [s]。小さいほど追従が速く、ジッタも増える。 */
const SMOOTH_TAU = 0.06;
/** 視点（頭）の基準位置がゆっくり追従する時定数 [s]。リーン/ダックの「戻り」を作る。 */
const REST_TAU = 2.0;
/** 頭の変位を視点にどれだけ反映するか。1.0 は動きすぎるので減衰させる。 */
const HEAD_DAMP = 0.5;
/** 目より少し後ろにカメラを引く [m]（自分の腕が画面に入る FPS 的な構図にするため）。 */
const EYE_BACK = 0.12;
const EYE_UP = 0.02;

const ENEMY_DIST = 1.2;   // 正面距離 [m]
const ENEMY_HEAD_DROP = 0.02; // 自分の目線に対する敵の頭の高さ差 [m]
const FLOOR_DROP = 1.55;  // 目線から床までの距離 [m]

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** MediaPipe worldLandmark → Three.js 座標（上のコメントの実測に基づく変換）。 */
function mpToThree(lm, out) { return out.set(-lm.x, -lm.y, lm.z); }

/** 円柱メッシュを 2 点間に架け渡す（geometry は半径 r・高さ 1・原点中心）。 */
function orientBone(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.scale.set(1, len, 1);
}

export class Scene3D {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1018);
    this.scene.fog = new THREE.Fog(0x0a1018, 3, 12);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 60);

    this.scene.add(new THREE.HemisphereLight(0x9fc7ff, 0x202028, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.2, 2.4, 1.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7c5cff, 0.8);
    rim.position.set(-1.5, 1.2, -2.2);
    this.scene.add(rim);

    this._buildRing();
    this._buildEnemy();
    this._buildPlayer();

    // 平滑化済みランドマーク（Three.js 座標）
    this.pt = new Map(TRACKED.map((i) => [i, new THREE.Vector3()]));
    this.hasPose = false;
    this.rest = new THREE.Vector3(0, 0, 0); // 頭のゆっくり追従する基準位置
    this._restInit = false;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this.shake = { x: 0, y: 0 };
  }

  // ── シーンの構築 ────────────────────────────────────────────────────────────
  _buildRing() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.floor = floor;
    this.scene.add(floor);

    // ロープ 3 本（奥行き感のためだけの飾り）
    this.ropes = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const rope = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.02, 6, 40),
        new THREE.MeshStandardMaterial({ color: 0x7c5cff, emissive: 0x2a1f6b, roughness: 0.6 }),
      );
      rope.rotation.x = -Math.PI / 2;
      rope.position.y = 0.45 + i * 0.35;
      this.ropes.add(rope);
    }
    this.scene.add(this.ropes);
  }

  _buildEnemy() {
    const g = new THREE.Group();
    this.enemyMat = new THREE.MeshStandardMaterial({ color: 0x38445a, roughness: 0.55, metalness: 0.05 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 18), this.enemyMat);
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.2, 0.42, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0x2b3444, roughness: 0.8 }),
    );
    torso.position.y = -0.44;
    g.add(head, torso);

    // グローブ（左右で色を分ける。プレイヤー視点で見て左が画面左）
    this.enemyGloves = {};
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshStandardMaterial({
        color: side < 0 ? 0xd24a4a : 0xc23c3c,
        emissive: 0x000000, roughness: 0.45,
      });
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.095, 20, 16), mat);
      g.add(glove);
      this.enemyGloves[side] = { mesh: glove, mat, pos: new THREE.Vector3(side * 0.19, -0.2, 0.12) };
      glove.position.copy(this.enemyGloves[side].pos);
    }
    this.enemy = g;
    this.scene.add(g);
  }

  _buildPlayer() {
    const rig = new THREE.Group();
    const jointMat = new THREE.MeshStandardMaterial({ color: 0xdfe7f2, roughness: 0.5 });
    const boneMat = new THREE.MeshStandardMaterial({ color: 0x9aa8bd, roughness: 0.6 });
    const jointGeo = new THREE.SphereGeometry(0.045, 16, 12);
    const boneGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 12); // 高さ 1 → scale.y で伸ばす

    this.joints = {};
    for (const i of [LM.shoulderL, LM.shoulderR, LM.elbowL, LM.elbowR, LM.hipL, LM.hipR]) {
      const m = new THREE.Mesh(jointGeo, jointMat);
      this.joints[i] = m;
      rig.add(m);
    }
    // 骨: 上腕 / 前腕 / 肩ライン / 背骨
    this.bones = [
      { a: LM.shoulderL, b: LM.elbowL }, { a: LM.elbowL, b: LM.wristL },
      { a: LM.shoulderR, b: LM.elbowR }, { a: LM.elbowR, b: LM.wristR },
      { a: LM.shoulderL, b: LM.shoulderR }, { a: LM.hipL, b: LM.hipR },
    ].map((s) => ({ ...s, mesh: new THREE.Mesh(boneGeo, boneMat) }));
    for (const b of this.bones) rig.add(b.mesh);
    // 背骨（肩中点↔腰中点）は端点を毎フレーム計算するので別扱い
    this.spine = new THREE.Mesh(boneGeo, boneMat);
    rig.add(this.spine);

    // グローブ: 左=青 / 右=赤（一人称で自分の右手は画面右に出る）
    this.gloves = {
      [LM.wristL]: new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 16),
        new THREE.MeshStandardMaterial({ color: 0x4a7bff, emissive: 0x0a1740, roughness: 0.4 })),
      [LM.wristR]: new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 16),
        new THREE.MeshStandardMaterial({ color: 0xff5f6d, emissive: 0x3a0d12, roughness: 0.4 })),
    };
    for (const m of Object.values(this.gloves)) rig.add(m);

    this.rig = rig;
    rig.visible = false; // 姿勢が来るまで出さない
    this.scene.add(rig);
  }

  // ── 更新 ───────────────────────────────────────────────────────────────────
  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * プレイヤーのボーンと視点を worldLandmarks から更新する。
   * @param {Array<{x,y,z}>|null} world MediaPipe worldLandmarks（メートル・腰原点）
   */
  updatePlayer(world, dtSec) {
    if (!world) { this.rig.visible = false; return; }
    const k = 1 - Math.exp(-Math.max(dtSec, 0) / SMOOTH_TAU);
    const tmp = this._tmpA;
    for (const i of TRACKED) {
      const lm = world[i];
      if (!lm) continue;
      mpToThree(lm, tmp);
      const p = this.pt.get(i);
      if (!this.hasPose) p.copy(tmp);
      else p.lerp(tmp, k);
    }
    this.hasPose = true;
    this.rig.visible = true;

    // ボーン / 関節 / グローブ
    for (const [i, m] of Object.entries(this.joints)) m.position.copy(this.pt.get(Number(i)));
    for (const b of this.bones) orientBone(b.mesh, this.pt.get(b.a), this.pt.get(b.b));
    for (const [i, m] of Object.entries(this.gloves)) m.position.copy(this.pt.get(Number(i)));
    const shoulderMid = this._tmpA.copy(this.pt.get(LM.shoulderL)).add(this.pt.get(LM.shoulderR)).multiplyScalar(0.5);
    const hipMid = this._tmpB.copy(this.pt.get(LM.hipL)).add(this.pt.get(LM.hipR)).multiplyScalar(0.5);
    orientBone(this.spine, shoulderMid, hipMid);

    // 視点: 鼻に追従。ゆっくり動く基準からの変位だけを HEAD_DAMP 倍して効かせる
    // （リーン/ダックで視点は動くが、じわじわしたズレは基準側が吸収する）。
    const head = this.pt.get(LM.nose);
    if (!this._restInit) { this.rest.copy(head); this._restInit = true; }
    else this.rest.lerp(head, 1 - Math.exp(-Math.max(dtSec, 0) / REST_TAU));
    const eye = this._tmpA.copy(this.rest).addScaledVector(this._tmpB.subVectors(head, this.rest), HEAD_DAMP);
    this.camera.position.set(eye.x + this.shake.x, eye.y + EYE_UP + this.shake.y, eye.z + EYE_BACK);
    this.camera.lookAt(eye.x, eye.y + EYE_UP, eye.z - ENEMY_DIST); // 正面（敵）を向く

    // 敵と床をプレイヤーの目線高さに合わせる
    this.enemyBaseZ = this.rest.z - ENEMY_DIST;
    this.enemy.position.set(0, this.rest.y - ENEMY_HEAD_DROP, this.enemyBaseZ);
    this.floor.position.y = this.rest.y - FLOOR_DROP;
    this.ropes.position.y = this.rest.y - FLOOR_DROP;
  }

  /**
   * 敵の見た目を状態から更新する（ロジックは boxing.js 側のまま。ここは表現だけ）。
   * @param {{phase:string, prog:number, attack:{kind:string, side:number}|null, hurt:number}} v
   */
  updateEnemy(v, dtSec) {
    const k = 1 - Math.exp(-Math.max(dtSec, 0) / 0.045);
    const tel = v.phase === "telegraph", strike = v.phase === "strike", recover = v.phase === "recover";
    for (const side of [-1, 1]) {
      const gl = this.enemyGloves[side];
      // 伸ばすのは attack.hand の 1 本だけ（両手が同時に迫ると画面が埋まって何も見えない）
      const active = !!v.attack && (v.attack.hand ?? v.attack.side) === side;
      const t = this._tmpA;
      if (active && tel) {
        // 引いて溜める（＋発光で予告）
        t.set(side * (0.19 + 0.1 * v.prog), -0.2 + 0.12 * v.prog, 0.12 - 0.22 * v.prog);
      } else if (active && strike) {
        // こちらへ伸ばす: +Z_three ＝ カメラ（プレイヤー）方向。カメラは敵から 1.2m なので
        // 0.72 まで＝顔の手前 ~0.5m で止める（近すぎると画面がグローブで埋まる）。
        t.set(v.attack.kind === "hook" ? v.attack.side * 0.34 : side * 0.1, v.attack.kind === "straight" ? -0.06 : -0.12, 0.72);
      } else if (recover) {
        t.set(side * 0.22, -0.5, 0.02); // ガードが下がる＝隙
      } else {
        t.set(side * 0.19, -0.2, 0.12);
      }
      gl.mesh.position.lerp(t, k);
      const glow = active && tel ? 0.15 + 0.85 * v.prog : active && strike ? 1 : 0;
      gl.mat.emissive.setRGB(glow * 1.0, glow * 0.55, 0);
      const scale = active && strike ? 1.25 : 1;
      gl.mesh.scale.setScalar(gl.mesh.scale.x + (scale - gl.mesh.scale.x) * k);
    }
    // 被弾で仰け反る + 硬直の色変化（位置は毎フレーム基準からの絶対値で置く＝累積しない）
    const hurt = clamp(v.hurt, 0, 1);
    this.enemy.rotation.x = -0.35 * hurt;
    this.enemy.position.z = (this.enemyBaseZ ?? -ENEMY_DIST) - 0.12 * hurt;
    this.enemyMat.color.setHex(hurt > 0.02 ? 0xa35b5b : recover ? 0x4a3f5e : 0x38445a);
  }

  /** 画面シェイク量 [m] を渡す（次の updatePlayer/render で反映）。 */
  setShake(x, y) { this.shake.x = x; this.shake.y = y; }

  render() { this.renderer.render(this.scene, this.camera); }

  dispose() { this.renderer.dispose(); }
}
