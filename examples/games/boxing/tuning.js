/**
 * 触覚ボクシング — チューニング一式（ジェスチャー閾値 + ゲームバランス）。
 *
 * ここ以外に閾値を書かない。体格・カメラ位置・照明で当たり判定の出やすさが変わるので、
 * 実カメラで詰める前提の「調整面」を 1 ファイルに集約している（fps/tuning.js と同じ役割）。
 *
 * 座標系のメモ:
 * - 画面（ミラー表示）座標で扱う。x は 0=画面左 / 1=画面右。プレイヤーから見た左右と一致する。
 * - 距離系の閾値はすべて「肩幅に対する比率」。カメラとの距離が変わってもそのまま効く。
 * - 速度は MediaPipe の worldLandmarks（メートル）由来なので m/s。
 */

export const TUNING = {
  /** キャリブレーション（構え）の平均化時間。 */
  calibrationMs: 1500,
  /** FIGHT 中に基準（肩幅 / 鼻位置 / 肩中点）を追従させる時定数 [s]。長いほど動じない。 */
  baselineTauSec: 10,
  /** この可視度を下回るランドマークは「見えていない」として扱う。 */
  minVisibility: 0.5,
  /** 姿勢が取れない状態がこの時間続いたら HUD に警告を出す。 */
  lostPoseWarnMs: 700,

  punch: {
    /** 同じ手の連打上限（片手ごとに独立）。 */
    cooldownMs: 400,
    /** 手首速度（EMA 後）がこれを超えたら突きの候補。 */
    speedThreshMps: 2.0,
    /** カメラ方向（-z）成分が速度全体に占める比率の下限。横振りを弾くための条件。 */
    forwardRatio: 0.55,
    /** 速度 EMA の係数（1 に近いほど生の値。ノイズと反応速度のトレードオフ）。 */
    velocityEma: 0.5,
    /** 肘の伸展判定: flexAngle 以下 → extendAngle 以上へ windowMs 以内に変化したら発火。 */
    flexAngleDeg: 100,
    extendAngleDeg: 150,
    extendWindowMs: 150,
  },

  block: {
    /** 両手首が顔の中心からこの距離（肩幅比）以内にあること。 */
    faceRadiusRatio: 0.6,
    /** 手首が肘より上にあること（ガードの形）。肩幅比のマージン。 */
    wristAboveElbowRatio: 0.02,
  },

  /** 左右のリーン（肩中点 x の基準からのずれ / 肩幅）。入り閾値 > 抜け閾値でチャタリング防止。 */
  lean: { enterRatio: 0.45, exitRatio: 0.3 },
  /** ダッキング（鼻 y が基準から下がった量 / 肩幅）。 */
  duck: { enterRatio: 0.5, exitRatio: 0.32 },
};

export const GAME = {
  /** 1 ラウンドの長さ [s]。時間切れは残 HP 比で判定。 */
  roundSec: 80,
  playerHp: 100,
  enemyHp: 100,

  /** 予告 → 打撃 → 硬直。予告は難易度の進行で telegraphMs[0] → [1] へ短くなる。 */
  telegraphMs: [900, 600],
  strikeMs: 200,
  recoverMs: 600,
  /** 硬直明けから次の予告までの待ち [ms]。同じく時間経過で短くなる。 */
  idleGapMs: [1400, 700],
  /** この秒数かけて telegraphMs / idleGapMs が [0] → [1] に遷移する。 */
  rampSec: 45,

  damage: {
    /** 敵の攻撃をまともに食らった時のプレイヤー HP 減。 */
    playerHit: 12,
    /** 隙に刺さった自分のパンチの敵 HP 減。 */
    punchHit: 10,
    /** ガードされた自分のパンチの敵 HP 減（ほぼ削れない）。 */
    punchBlocked: 2,
  },

  score: { punchHit: 100, punchBlocked: 5, block: 40, dodge: 60, comboBonus: 25 },

  /** 演出。 */
  hitstopMs: 80,
  koSlowMo: { durationMs: 1400, timeScale: 0.25 },
  /** 攻撃種の抽選比。straight はブロック or ダック、hook は逆側へのリーンで回避。 */
  attackWeights: { hookLeft: 1, hookRight: 1, straight: 1.2 },
};
