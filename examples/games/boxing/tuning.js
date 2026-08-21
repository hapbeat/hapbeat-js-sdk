/**
 * 触覚ボクシング — チューニング一式（ジェスチャー閾値 / 前方リーチ推定 / 3D 当たり判定 / バランス）。
 *
 * ここ以外に閾値を書かない。体格・カメラ位置・照明で当たり判定の出やすさが変わるので、
 * 実カメラで詰める前提の「調整面」を 1 ファイルに集約している（fps/tuning.js と同じ役割）。
 *
 * 座標系のメモ:
 * - ジェスチャー側は「ミラー表示の 2D 画面座標」。x は 0=画面左 / 1=画面右＝プレイヤーの左右と一致。
 * - 距離系の閾値はすべて「肩幅に対する比率」。カメラとの距離が変わってもそのまま効く。
 * - 3D 側（COMBAT）はメートル。+X=画面右 / +Y=上 / -Z=前方（敵の方向）。
 */

export const TUNING = {
  /** キャリブレーション（構え）の平均化時間。腕の 2D 長さの基準もここで取る。 */
  calibrationMs: 1500,
  /** FIGHT 中に基準（肩幅 / 鼻位置 / 肩中点 / 腕の長さ）を追従させる時定数 [s]。 */
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
    /**
     * 3 つ目の発火条件: 推定リーチが一気に伸びた（＝突き出した）。
     * world z が当てにならないカメラでも「突いた」を拾えるようにするための保険。
     */
    reachTrigger: { min: 0.78, ratePerSec: 2.2 },
  },

  /**
   * 前方リーチ推定（0=引いている / 1=伸び切り）。単眼カメラに奥行きは無いので、
   * 2D から取れる 2 つの信号で代用する。
   *   angle   : 肘角度（伸びるほど 1）
   *   shorten : 前腕の 2D 長さ ÷ 構え時の長さ（カメラを向くほど短く映る＝小さいほど 1）
   */
  reach: {
    angle: { minDeg: 70, maxDeg: 165 },
    shorten: { minRatio: 0.35, maxRatio: 0.95 },
    /** "max"（どちらか出た方を採る＝出やすい） / "weighted"（重み付き和＝落ち着く） */
    combine: "max",
    weights: { angle: 0.5, shorten: 0.5 },
    /** リーチの EMA 係数（大きいほど機敏・ノイジー）。 */
    ema: 0.4,
    /**
     * 肘角度は 3D（normalized landmark の x,y,z）と 2D（x,y のみ）の両方を計算し、
     * フレーム間のブレ（|Δangle| の EMA）が小さい方を毎フレーム自動採用する。
     * jitterTau はそのブレ計測の時定数 [s]。判定結果は state.angleSource で確認できる。
     */
    jitterTauSec: 0.6,
    /** パンチ発火時の突き出しアニメーション（推定リーチに重ねる）。 */
    snap: { riseMs: 120, holdMs: 60, fallMs: 200, speedRefMps: 3.5, minAmount: 0.75 },
  },

  /** 左右のリーン（肩中点 x の基準からのずれ / 肩幅）。入り閾値 > 抜け閾値でチャタリング防止。 */
  lean: { enterRatio: 0.45, exitRatio: 0.3 },
  /** ダッキング（鼻 y が基準から下がった量 / 肩幅）。 */
  duck: { enterRatio: 0.5, exitRatio: 0.32 },
};

/**
 * 3D の体格と当たり判定（メートル）。描画（scene3d.js）と判定（boxing.js）は
 * どちらもこの値と combat.js を使うので、見えている位置と当たる位置は必ず一致する。
 */
export const COMBAT = {
  /** 敵の正面距離。プレイヤーの頭がほぼ原点。 */
  enemyDist: 1.2,

  /** 一人称の体の組み立て（combat.buildPlayerPose）。 */
  rig: {
    shoulderWidthM: 0.38,   // 肩幅の実寸見積り（体基準 2D → メートル変換に使う）
    headGain: 1.6,          // リーン/ダックで頭がどれだけ動くか（回避の効き。上げると避けやすい）
    shoulderFollow: 0.7,    // 頭の移動に肩がついていく割合
    shoulderHalf: 0.19,     // 肩の左右位置
    shoulderDrop: 0.24,     // 目線から肩までの落差
    shoulderBack: 0.06,     // 肩は目より少し後ろ
    lateralGain: 1.0,       // 2D の腕の動きを 3D の左右上下へ写す倍率
    /** reach=1 のときグローブが前方へ進む距離。敵の頭（1.2m）に届く値にしておく。 */
    forwardMeters: 1.15,
    elbowFrac: 0.45,        // 肘は手首の前進量のこの割合だけ前に出る
    /**
     * 伸ばしきった時にどれだけ狙点へ寄せるか（0=肩から真っ直ぐ / 1=完全に狙点へ）。
     * 肩は中心から 0.19m 横にあるので、0 だと正面の敵の頭を素通りして当たらない。
     * 上げるほど当てやすく大味になる。
     */
    convergence: 0.72,
    /** 寄せる先（＝敵の頭の位置。正面・目線の高さ）。 */
    aim: { x: 0, y: 0.02 },
  },

  /**
   * 視点。既定は背後やや上（over-the-shoulder）。自分の頭とその当たり判定球が見えるので、
   * 「腕を頭の前に置けばガード」「上体を動かせば頭球が逃げる」が目で見て分かる。
   * 一人称（first）は没入用のトグル。頭球は一人称では非表示。
   */
  view: {
    mode: "third",                    // "third" | "first"
    third: { back: 1.05, up: 0.42, lookAhead: 0.55 }, // カメラの引き / 高さ / 注視点を前へ寄せる量
    first: { back: 0.12, up: 0.02 },
  },

  player: { headRadius: 0.12, gloveRadius: 0.085, forearmRadius: 0.06 },
  enemy: {
    headRadius: 0.14, headY: 0.02,
    torsoRadius: 0.2, torsoTopY: -0.3, torsoBottomY: -0.78,
    gloveRadius: 0.1,
    /** ガード時のグローブ位置（敵ローカル。頭の前に構える）。 */
    guard: { x: 0.15, y: -0.04, z: 0.2 },
    /** 硬直中に下がるガード位置（＝頭が狙える隙）。 */
    open: { x: 0.28, y: -0.42, z: 0.06 },
  },

  attack: {
    /** 近づいてくる時間（見てから反応できる速さ）。難易度で [開始, 最終] を補間。 */
    approachMs: [1000, 700],
    /** 最後に打ち込む時間。 */
    strikeMs: 130,
    /** 戻り（この間 敵のガードは開いたまま＝差し込みどころ）。 */
    retractMs: 300,
    /** 経路のうち approach で進む割合。残りが strike。 */
    approachFrac: 0.7,
    /** フックの弧の膨らみ [m] と持ち上げ [m]。 */
    hookArc: 0.55, hookRise: 0.12,
    /** 狙点のばらつき [m]（毎回同じ場所に来ないように）。 */
    aimJitter: 0.05,
    /** 当たらなかったとき「かすった（回避成功）」とみなす頭からの距離 [m]。 */
    dodgeNear: 0.32,
  },

  /** プレイヤーのパンチ判定。1 スイング 1 回にするための条件。 */
  punchHit: {
    /** これ未満のリーチでは当たり判定を取らない（構えているだけで当たらないように）。 */
    minReach: 0.5,
    /** 同じ手が続けて判定されるまでの間隔 [ms]。 */
    cooldownMs: 350,
  },
};

export const GAME = {
  /** 1 ラウンドの長さ [s]。時間切れは残 HP 比で判定。 */
  roundSec: 80,
  playerHp: 100,
  enemyHp: 100,

  /** 硬直明けから次の攻撃までの待ち [ms]。時間経過で短くなる。 */
  idleGapMs: [1200, 600],
  /** この秒数かけて approachMs / idleGapMs が [0] → [1] に遷移する。 */
  rampSec: 45,

  damage: {
    /** 敵の攻撃をまともに食らった時のプレイヤー HP 減。 */
    playerHit: 12,
    /** 敵の頭に入った時の敵 HP 減。 */
    punchHead: 12,
    /** 胴に入った時。 */
    punchTorso: 5,
    /** ガードに当たった時（ほぼ削れない）。 */
    punchBlocked: 1,
  },

  score: { punchHead: 120, punchTorso: 40, punchBlocked: 5, block: 40, dodge: 60, comboBonus: 25 },

  /** 演出。 */
  hitstopMs: 80,
  koSlowMo: { durationMs: 1400, timeScale: 0.25 },
  /** 攻撃種の抽選比。フックは横から側頭部へ、ストレートは正面から。 */
  attackWeights: { hookLeft: 1, hookRight: 1, straight: 1.2 },
};
