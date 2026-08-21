/**
 * PoseTracker — カメラ取得 + MediaPipe PoseLandmarker のセットアップと毎フレーム推論。
 *
 * ゲーム側（boxing.js）は landmarks の中身だけを見ればよく、モデルのロード失敗・カメラ拒否は
 * すべて `error`（日本語 1 行）に畳んで返す。例外は投げない = 描画ループが死なない。
 *
 * tasks-vision は CDN(jsdelivr) から ESM で直接読む。ビルド手順を増やさないための選択で、
 * オフライン展示ではここをローカルパスに差し替える（README 参照）。
 */

const VISION_VERSION = "0.10.14";
const VISION_MODULE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
const VISION_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** HandLandmarker の 21 点のうち使うもの。 */
export const HL = { wrist: 0, thumbTip: 4, indexMcp: 5, middleMcp: 9, pinkyMcp: 17, middleTip: 12 };

/** 手の骨格（デバッグ PIP 表示用）。手首から 5 本の指へ。 */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],            // 親指
  [0, 5], [5, 6], [6, 7], [7, 8],            // 人差し指
  [9, 10], [10, 11], [11, 12],               // 中指
  [13, 14], [14, 15], [15, 16],              // 薬指
  [0, 17], [17, 18], [18, 19], [19, 20],     // 小指
  [5, 9], [9, 13], [13, 17],                 // 手のひら
];

/** MediaPipe Pose のランドマーク index（使うものだけ）。 */
export const LM = {
  nose: 0,
  // 目・耳（顔の見かけ幅＝前後距離の推定に使う）
  eyeL: 2, eyeR: 5, earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  // 手先（手の 2D スパン＝奥行きキューに使う）
  pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20, thumbL: 21, thumbR: 22,
  hipL: 23, hipR: 24,
};

/** 片手ぶんの手先ランドマーク（スパン計算用）。 */
export const HAND_POINTS = {
  left: [LM.wristL, LM.pinkyL, LM.indexL, LM.thumbL],
  right: [LM.wristR, LM.pinkyR, LM.indexR, LM.thumbR],
};

/** 描画用の骨格接続（デバッグ表示）。 */
export const SKELETON = [
  [LM.shoulderL, LM.shoulderR],
  [LM.shoulderL, LM.elbowL], [LM.elbowL, LM.wristL],
  [LM.shoulderR, LM.elbowR], [LM.elbowR, LM.wristR],
  [LM.shoulderL, LM.hipL], [LM.shoulderR, LM.hipR], [LM.hipL, LM.hipR],
];

export class PoseTracker {
  constructor() {
    this.video = null;
    this.landmarker = null;
    this.stream = null;
    this.ready = false;
    this.error = "";        // 日本語 1 行。空なら正常
    this.delegate = "";     // "GPU" / "CPU"（HUD 表示用）
    this._lastVideoTime = -1;
    this._last = null;      // 直近の推論結果（同一 videoTime なら再利用）
  }

  /**
   * カメラ → モデルの順に初期化する。どちらかが落ちても throw せず `error` に理由を入れて false を返す。
   * @param {HTMLVideoElement} video
   */
  async start(video, { width = 640, height = 480 } = {}) {
    this.video = video;
    if (!(await this._openCamera(video, width, height))) return false;
    if (!(await this._loadModel())) return false;
    this.ready = true;
    this.error = "";
    return true;
  }

  /**
   * 検証用の疑似カメラ（URL に ?fakecam=1）。
   * MediaPipe 公式サンプル写真を canvas に流し続けて MediaStream にする。実カメラが
   * 無い環境（CI / ヘッドレス / ブラウザのカメラ権限が無い）でも、本物のランドマークが
   * 取れる状態で通し確認できる。通常起動時は一切通らない。
   */
  async _fakeCameraStream(width, height) {
    const cv = document.createElement("canvas");
    cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    // createImageBitmap で取る（Image.decode() は描画が止まっているタブだと解決しないことがある）
    let bmp = null;
    try {
      const r = await fetch("https://storage.googleapis.com/mediapipe-assets/pose.jpg", { mode: "cors" });
      if (r.ok) bmp = await createImageBitmap(await r.blob());
    } catch { /* 取れなくても黒画面で続行する */ }
    const draw = () => {
      ctx.fillStyle = "#101820";
      ctx.fillRect(0, 0, width, height);
      if (bmp) ctx.drawImage(bmp, 0, 0, width, height);
    };
    draw();
    this._fakeTimer = setInterval(draw, 33);
    return cv.captureStream(30);
  }

  async _openCamera(video, width, height) {
    if (new URLSearchParams(location.search).get("fakecam") === "1") {
      this.fake = true;
      this.stream = await this._fakeCameraStream(width, height);
      video.srcObject = this.stream;
      video.playsInline = true; video.muted = true;
      try { await video.play(); } catch (e) { this.error = `疑似カメラを再生できません（${e?.message ?? e}）`; return false; }
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = "カメラエラー: このブラウザは getUserMedia に対応していません（HTTPS か localhost で開いてください）";
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      const name = e?.name ?? "";
      this.error =
        name === "NotAllowedError" ? "カメラエラー: 使用が許可されませんでした（ブラウザのカメラ許可を確認してください）"
        : name === "NotFoundError" || name === "OverconstrainedError" ? "カメラエラー: カメラが見つかりません（接続を確認してください）"
        : `カメラエラー: ${e?.message ?? e}`;
      return false;
    }
    video.srcObject = this.stream;
    video.playsInline = true;
    video.muted = true;
    try {
      await video.play();
    } catch (e) {
      this.error = `カメラエラー: 映像を再生できません（${e?.message ?? e}）`;
      return false;
    }
    return true;
  }

  async _loadModel() {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ VISION_MODULE);
    } catch (e) {
      this.error = `姿勢推定エラー: MediaPipe を読み込めません（オフライン？ ${e?.message ?? e}）`;
      return false;
    }
    const { FilesetResolver, PoseLandmarker } = mod;
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(VISION_WASM);
    } catch (e) {
      this.error = `姿勢推定エラー: WASM を読み込めません（${e?.message ?? e}）`;
      return false;
    }
    // GPU が使えない環境（古い GPU / ソフトウェアレンダリング）では CPU に落とす。
    for (const delegate of ["GPU", "CPU"]) {
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        this.delegate = delegate;
        // 手のモデルは「あれば使う」扱い。落ちても pose だけで動く（リーチ推定の精度が下がるだけ）。
        try {
          this.handLandmarker = await mod.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
            runningMode: "VIDEO",
            numHands: 2,
          });
        } catch (e) {
          this.handError = String(e?.message ?? e);
        }
        return true;
      } catch (e) {
        this.error = `姿勢推定エラー: モデルを初期化できません（${e?.message ?? e}）`;
      }
    }
    return false;
  }

  /**
   * 手のランドマーク（21 点 × 最大 2）。pose より重いので handEveryNth フレームに 1 回だけ回し、
   * 間のフレームは直前結果を返す。モデルが無い環境では常に null。
   * @returns {{landmarks:Array, handedness:string}[]|null}
   */
  detectHands(nowMs, everyNth = 2) {
    if (!this.handLandmarker || !this.ready || this.video?.readyState < 2) return this._hands ?? null;
    if ((this._handTick = (this._handTick ?? 0) + 1) % everyNth !== 0) return this._hands ?? null;
    try {
      const res = this.handLandmarker.detectForVideo(this.video, nowMs + 0.5); // pose と同 timestamp を避ける
      this._hands = (res?.landmarks ?? []).map((landmarks, i) => ({
        landmarks,
        handedness: res.handednesses?.[i]?.[0]?.categoryName ?? "",
      }));
    } catch {
      /* 手の推論だけ失敗しても pose の結果は使い続ける */
    }
    return this._hands ?? null;
  }

  /**
   * 1 フレーム分の推論。映像が進んでいなければ前回結果を返す（同一 timestamp を投げると例外になるため）。
   * @returns {{landmarks:Array, worldLandmarks:Array}|null}
   */
  detect(nowMs) {
    if (!this.ready || !this.video || this.video.readyState < 2) return this._last;
    if (this.video.currentTime === this._lastVideoTime) return this._last;
    this._lastVideoTime = this.video.currentTime;
    try {
      const res = this.landmarker.detectForVideo(this.video, nowMs);
      this._last = res?.landmarks?.length
        ? { landmarks: res.landmarks[0], worldLandmarks: res.worldLandmarks?.[0] ?? null }
        : null;
    } catch (e) {
      this.error = `姿勢推定エラー: ${e?.message ?? e}`;
      this._last = null;
    }
    return this._last;
  }

  stop() {
    if (this._fakeTimer) { clearInterval(this._fakeTimer); this._fakeTimer = null; }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.ready = false;
  }
}
