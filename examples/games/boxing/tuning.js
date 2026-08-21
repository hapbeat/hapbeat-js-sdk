/**
 * 触覚ボクシング — チューニング一式（ジェスチャー / リーチ推定と安定化 / 3D 当たり判定 / バランス）。
 *
 * ここ以外に閾値を書かない。体格・カメラ位置・照明で効き方が変わるので、実カメラで詰める
 * 前提の「調整面」を 1 ファイルに集約している（fps/tuning.js と同じ役割）。
 *
 * 座標系のメモ:
 * - ジェスチャー側は「ミラー表示の 2D 画面座標」。x は 0=画面左 / 1=画面右＝プレイヤーの左右と一致。
 * - 2D の距離・速度はすべて「肩幅＝1」で正規化。カメラとの距離が変わっても同じ値で効く。
 * - 3D 側（COMBAT）はメートル。+X=画面右 / +Y=上 / -Z=前方（敵の方向）。
 */

export const TUNING = {
  /** キャリブレーション（構え）の平均化時間。腕の 2D 長さ・手のスパンの基準もここで取る。 */
  calibrationMs: 1500,
  /** FIGHT 中に基準（肩幅 / 鼻位置 / 肩中点 / 腕の長さ）を追従させる時定数 [s]。 */
  baselineTauSec: 10,
  /** この可視度を下回るランドマークは「見えていない」＝推定を更新せず直前値を保持する。 */
  minVisibility: 0.5,

  /**
   * ランドマークの 1€ フィルタ。静止時のプルプルを殺しつつ、速い動きは通す。
   * minCutoff を下げるほど静止時に硬くなり（遅れる）、beta を上げるほど速い動きに追従する。
   */
  filter: {
    // 実測（±0.02 の静止ノイズ / 5 フレーム 166ms のステップ応答, 30fps）:
    //   minCutoff 0.6 → 残ノイズ ±0.0072 / ステップ到達 0.58
    //   minCutoff 1.0 → ±0.0094 / 0.74   ← 採用（ノイズを半分に落としつつ追従を残す）
    //   minCutoff 1.5 → ±0.0112 / 0.82（震えが残る）
    landmark: { minCutoff: 1.0, beta: 0.05, dCutoff: 1.0 }, // 正規化ランドマーク（2D 位置・角度の元）
    world: { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 },    // worldLandmarks（速度の元。より強めに平滑化）
  },

  /**
   * 前方リーチ推定（0=引いている / 1=伸び切り）。3 つの 2D 手がかりを合成する。
   *   angle    肘角度
   *   shorten  前腕の 2D 長さ / 構え時（カメラを向くほど短く映る）
   *   handSize 手の 2D スパン / 構え時（カメラに近いほど大きく映る = 単眼で最も安定した奥行きキュー）
   */
  reach: {
    angle: { minDeg: 70, maxDeg: 165 },
    shorten: { minRatio: 0.35, maxRatio: 0.95 },
    /**
     * 手の見かけサイズ比（構え時＝1.0）。ピンホール投影モデルの実測:
     *   構え 1.00 / 真横に伸ばす 0.95 / 前へ 0.3m 1.11 / 0.45m 1.21 / 0.6m 1.34 / 0.75m 1.50
     * 前方 0.6m でほぼ 1.0 になるよう上端を 1.35 にしてある（1.6 だと伸ばしきっても 0.6 止まりだった）。
     */
    handSize: { minRatio: 0.98, maxRatio: 1.35 },   // pose の 4 点（手首・親指・人差指・小指）版
    handModel: { minRatio: 0.98, maxRatio: 1.35 },  // HandLandmarker の手のひら長（手首→中指 MCP）版
    /**
     * pose の画像空間 z（肩→手首の手前方向の差 / 肩幅）。worldLandmarks.z とは別物。
     * モデル実測: 構え 0.32 / 真横 0.05 / 前 0.3m 0.79 / 0.45m 1.18 / 0.6m 1.58
     * 構えで 0 になるよう下端 0.35、前方 0.6m で ~1.0 になるよう上端 1.5。
     */
    depthZ: { minRatio: 0.35, maxRatio: 1.5 },
    /** "median"（重み付きメディアン・外れ値に強い） / "weighted"（重み和） / "max"（出やすい） */
    combine: "median",
    /**
     * 重み。ピンホール投影モデルで「前へ伸ばす」を「構え / 真横へ伸ばす」から分離できる度合いを
     * 測った結果（大きいほど良い）:
     *   depthZ +0.59 / handSize・handModel +0.53 / shorten +0.30 / angle +0.00
     * angle は真横に伸ばしても 1.0 になるので単独では使い物にならず、shorten は伸ばしきると
     * 逆に戻る（非単調）。よって手のサイズと画像 z を主、角度と短縮率を補助にする。
     */
    weights: { angle: 0.15, shorten: 0.15, handSize: 0.3, handModel: 0.5, depthZ: 0.4 },

    /** ── 安定化（この 4 段でガード中の「震えて伸びる」を潰す） ── */
    deadband: 0.05,        // これ未満の変化は完全に無視
    slewUp: 6.0,           // 伸びる方向の最大変化率 [1/s]
    slewDown: 4.0,         // 戻る方向の最大変化率 [1/s]
    /**
     * リーチ側の 1€。デッドバンドとスルーレートが先に効いているので、ここは追従寄りにする。
     * 実測: minCutoff 1.0〜2.0 だと 150ms で 0.2→0.9 のパンチが窓内に立ち上がりきらず発火しない。
     * 2.5 以上で発火し、±0.05 の震えでは（どの設定でも）発火しないことを確認済み。
     */
    oneEuro: { minCutoff: 2.5, beta: 0.15, dCutoff: 1.0 },
    /** 両手首が顔の近く（肩幅比）で、かつほとんど動いていない＝ガード中。リーチを上限で抑える。 */
    guardLock: { faceRadius: 0.7, maxSpeed: 0.9, maxReach: 0.3 },

    /** パンチ時の突き出しアニメーション（推定に重ねる）。 */
    snap: { riseMs: 120, holdMs: 60, fallMs: 200, speedRefMps: 3.5, minAmount: 0.75 },
  },

  /**
   * 「突いた」の判定はリーチの**速度**で行う（値そのものではない）。
   * windowMs 以内に deltaMin 以上増え、かつ reachMin 以上に達した時だけ発火。
   * 発火から endReach を割り込む / maxMs 経過するまでが 1 スイングで、
   * **当たり判定が有効なのはこの窓の間だけ**（ガード中に静止して伸びていても当たらない）。
   */
  punch: {
    swing: { windowMs: 150, deltaMin: 0.28, reachMin: 0.6, endReach: 0.45, maxMs: 450, cooldownMs: 350 },
  },

  /**
   * 前後移動（踏み込み / 下がり）。構え時の見かけサイズに対する比で距離を推定する。
   * 肩幅・体幹縦長・顔幅の 3 つの比のメディアン（腕を上げた等で 1 つ崩れても効かない）。
   */
  distance: {
    weights: { shoulder: 1, torso: 0.8, face: 1 },
    /** 推定値の許容範囲（顔が隠れた等の暴れを抑える）。 */
    ratioClamp: [0.6, 1.8],
    deadband: 0.015,
    /** じわじわ動いて見えないように強めに平滑化する。 */
    oneEuro: { minCutoff: 0.5, beta: 0.02, dCutoff: 1.0 },
  },

  /** 左右のリーン（肩中点 x の基準からのずれ / 肩幅）。入り閾値 > 抜け閾値でチャタリング防止。 */
  lean: { enterRatio: 0.45, exitRatio: 0.3 },
  /** ダッキング（鼻 y が基準から下がった量 / 肩幅）。 */
  duck: { enterRatio: 0.5, exitRatio: 0.32 },
};

/**
 * 3D の体格と当たり判定（メートル）。描画（scene3d.js）と判定（boxing.js）はどちらも
 * この値と combat.js を使うので、見えている位置と当たる位置は必ず一致する。
 */
export const COMBAT = {
  /** 敵の正面距離。プレイヤーの頭がほぼ原点。 */
  enemyDist: 1.2,

  /** 一人称／背後視点の体の組み立て（combat.buildPlayerPose）。 */
  rig: {
    shoulderWidthM: 0.38,
    headGain: 1.9,          // リーン/ダックで頭が動く量（回避の効き。上げると避けやすい）
    shoulderFollow: 0.85,   // 頭の移動に肩・胴がついていく割合（胴狙いを避けられるかに効く）
    shoulderHalf: 0.19,
    shoulderDrop: 0.24,
    shoulderBack: 0.06,
    lateralGain: 1.0,
    /** reach=1 でグローブが前へ進む距離。敵の頭（1.2m）に届く値にしておく。 */
    forwardMeters: 1.15,
    /**
     * 前後移動: distanceRatio 1.0 からのずれ 1 あたり何メートル動くか。
     * 既定では ratio 1.3（半歩踏み込んだくらい）で約 +0.4m 前に出る。
     * 上げるほど「少し動いただけで大きく踏み込む」。
     */
    stepMetersPerRatio: 1.33,
    /** 前後移動の範囲 [後ろ, 前]（メートル）。敵にめり込まないよう前側を制限する。 */
    stepClamp: [-0.35, 0.7],
    elbowFrac: 0.45,
    /**
     * 伸ばしきった時にどれだけ狙点へ寄せるか（0=肩から真っ直ぐ / 1=完全に狙点へ）。
     * 肩は中心から 0.19m 横にあるので、0 だと正面の敵の頭を素通りして当たらない。
     */
    convergence: 0.72,
    aim: { x: 0, y: 0.02 },
    /** 胴（当たり判定カプセル）の長さ。上端は肩の中点。 */
    torsoLength: 0.46,
  },

  player: { headRadius: 0.12, gloveRadius: 0.085, forearmRadius: 0.06, torsoRadius: 0.17 },
  enemy: {
    headRadius: 0.14, headY: 0.02,
    torsoRadius: 0.2, torsoTopY: -0.3, torsoBottomY: -0.78,
    gloveRadius: 0.1,
    /** 敵の肩の位置（頭からの相対）。ここから腕が生える。 */
    arm: { shoulderX: 0.26, shoulderY: -0.2, shoulderZ: 0.02, elbowFrac: 0.45, bend: 0.22, straightAt: 0.95 },
    /** ガード時のグローブ位置（頭の前に構える）。 */
    guard: { x: 0.15, y: -0.04, z: 0.2 },
    /** 攻撃中・硬直中に下がるガード位置（＝頭が狙える隙）。 */
    open: { x: 0.28, y: -0.42, z: 0.06 },
  },

  /**
   * 視点。既定は背後やや上（over-the-shoulder）。自分の頭とその当たり判定球が見えるので、
   * 「腕を頭の前に置けばガード」「上体を振れば頭球が逃げる」が目で見て分かる。
   */
  view: {
    mode: "third",
    third: { back: 1.05, up: 0.42, lookAhead: 0.55 },
    first: { back: 0.12, up: 0.02 },
  },

  attack: {
    /** 近づいてくる時間（見てから反応できる速さ）。難易度で [開始, 最終] を補間。 */
    approachMs: [1000, 700],
    strikeMs: 130,
    retractMs: 300,
    approachFrac: 0.7,
    hookArc: 0.55, hookRise: 0.12,
    aimJitter: 0.05,
    dodgeNear: 0.32,
    /** 狙う場所の抽選比（頭 / 胴）。 */
    aimTarget: { head: 1, torso: 1 },
    /** 胴を狙う時、胴カプセルのどの高さを狙うか（0=肩 / 1=下端）。 */
    torsoAimFrac: 0.4,
  },

  /** プレイヤーのパンチ判定。 */
  punchHit: {
    /** これ未満のリーチでは当たり判定を取らない。 */
    minReach: 0.5,
    /** 同じ手が続けて判定されるまでの間隔 [ms]。 */
    cooldownMs: 350,
    /** true: スイング窓の間だけ当たり判定を有効にする（静止して伸びていても当たらない）。 */
    requireSwing: true,
  },
};

export const GAME = {
  /**
   * テストモード: ラウンド時間・KO・勝敗を出さず無限に続ける。
   * どちらかの HP が 0 になったら短い演出のあと自動で全回復する（スコアは累積のまま）。
   * false にすると従来のラウンド制（時間切れ / KO / 勝敗表示）で動く。
   */
  testMode: true,
  testResetDelayMs: 900,

  roundSec: 80,
  playerHp: 100,
  enemyHp: 100,

  /** 硬直明けから次の攻撃までの待ち [ms]。時間経過で短くなる。 */
  idleGapMs: [1200, 600],
  rampSec: 45,

  damage: {
    playerHit: 12,      // 頭に食らった
    playerBody: 7,      // 胴に食らった
    punchHead: 12,
    punchTorso: 5,
    punchBlocked: 1,
  },

  score: { punchHead: 120, punchTorso: 40, punchBlocked: 5, block: 40, dodge: 60, comboBonus: 25 },

  hitstopMs: 80,
  koSlowMo: { durationMs: 1400, timeScale: 0.25 },
  /** 攻撃の経路の抽選比。 */
  attackWeights: { hookLeft: 1, hookRight: 1, straight: 1.2 },
};
