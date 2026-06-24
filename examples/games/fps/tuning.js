/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  触覚FPS — チューニング（挙動の数値はすべてここ。1 ファイルで完結）        ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * 既定値 / 難易度プリセット(easy・normal・hard) / 連続モード / 歩行 / 敵サイズ /
 * 自弾 を、ここを編集するだけで調整できる。人間が読み下せるよう全項目にコメント付き。
 *
 * ⚠️ 触覚・音の "波形"（各イベントの freq/dur/gain など）は別ファイル
 *    shared/event-content.js の `fps_*` 行で調整（敵の発砲・被弾・盾・撃破・歩行）。
 *    ここはゲーム"挙動"の数値のみ。
 */

// 「詳細設定」スライダーの既定値（スライダー範囲は fps.js の SLIDER_META 側）
export const DEFAULTS = {
  mode: "move",        // "move"(動いて撃つ) | "fixed"(その場で盾)
  killGoal: 20,        // クリアに必要な撃破数
  enemyCount: 4,       // 同時出現の上限（撃破で漸増）
  enemySpeed: 2.2,     // 敵の周回速度 m/s（move）
  enemyRange: 18,      // 敵の距離(基準) m
  rangeJitter: 3,      // 敵距離のばらつき ±m（0=固定）
  bulletSpeed: 20,     // 敵弾の弾速 m/s
  speedJitter: 4,      // 敵弾速のばらつき ±m/s
  fireGap: 3.0,        // 敵の発射間隔(平均) s
  fireJitter: 1.0,     // 発射間隔のばらつき ±s
  minShotGap: 0.8,     // 固定モードの全体最低発射間隔 s
  playerSpeed: 7,      // プレイヤー移動速度 m/s
  maxHp: 5,            // 最大HP
  infiniteHp: false,   // HP無限（デモ用）
  shieldArc: 26,       // 盾の半角°（固定モード）
  mouseSens: 1.5,      // カメラ感度（マウス）
  stickSens: 1.5,      // カメラ感度（右スティック）
  continuousHaptic: false, // 連続モード（最接近弾を ~100Hz で連続提示）
  walkFeedback: true,  // 歩行フィードバック（上下動 + 足音振動）
  preset: "normal",    // 現在選択中の難易度（常時どれか表示する用）
};

// 難易度プリセット（ボタンで DEFAULTS を一括上書き）
export const PRESETS = {
  easy:   { killGoal: 12, enemyCount: 2, enemySpeed: 1.6, enemyRange: 16, rangeJitter: 2, bulletSpeed: 14, speedJitter: 2, fireGap: 4.0, fireJitter: 1.0, minShotGap: 1.2, maxHp: 10, shieldArc: 34 },
  normal: { killGoal: 20, enemyCount: 4, enemySpeed: 2.2, enemyRange: 18, rangeJitter: 3, bulletSpeed: 20, speedJitter: 4, fireGap: 3.0, fireJitter: 1.0, minShotGap: 0.8, maxHp: 5,  shieldArc: 26 },
  hard:   { killGoal: 30, enemyCount: 6, enemySpeed: 3.2, enemyRange: 20, rangeJitter: 5, bulletSpeed: 30, speedJitter: 8, fireGap: 1.8, fireJitter: 1.4, minShotGap: 0.5, maxHp: 3,  shieldArc: 18 },
};

// 連続モード：最接近の敵弾の「方位=左右バランス」「距離=振幅」で ~100Hz を連続変調（ToH2022 Eqs.1–4）
export const CONTINUOUS = {
  freq: 100,      // Hz キャリア
  durMs: 120,     // チャンク長 ms
  periodS: 0.12,  // 送出周期 s（≈ チャンク長＝リアルタイム供給）
  gain: 1.0,      // 全体スケール 0..1
  floor: 0.25,    // ★最遠でも残す振幅（大きいほど遠い弾も気づきやすい）
  curve: 1,       // 距離→振幅カーブ（1=直線 / 2=2乗で近距離を強調）
  rmaxK: 1.6,     // floor に達する距離 = enemyRange × これ
};

// 歩行フィードバック（move モード）。足音振動が敵銃撃の触覚をマスクする＝止まると気づきやすい
export const WALK = {
  rate: 9,        // ★歩行の間隔。rad/s 歩調。2π ごとに足音1回（上下1回＝1回）。例: 9 → 約0.70s 間隔(≈1.4歩/s)。大きいほど速い
  bobAmp: 0.11,   // m 上下動の振幅（大きいほど揺れが分かりやすい）
  swayAmp: 0.055, // m 左右の揺れ（足2歩でひと往復＝左右交互）
};

// 敵・自弾
export const ENEMY = { scale: 1.5 }; // 敵の拡大率（胴体が目線高さ ≈ 1.6m に来るように）
export const PLAYER_BULLET = { speed: 70, streak: 2.2 }; // 自弾の速度 m/s / 残像の最小長 units
