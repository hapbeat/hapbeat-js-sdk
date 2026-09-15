/**
 * enemy-ai.js — 敵ボクサーの意思決定（純ロジック。DOM / Three.js に依存しない）。
 *
 * ここは「何をするか」だけを決める。位置・経路・当たり判定は boxing.js / combat.js の担当で、
 * この層は毎フレーム **intents**（足さばき / ガード高 / 攻撃の発注）を返すだけ。
 * DOM も乱数も外から注入するので node で決定的にテストできる（tests/boxing-enemy-ai.test.mjs）。
 *
 * ── 攻守のメリハリの作り方 ──────────────────────────────────────────────────
 * トップ層に「今どういう気分か」のフェーズを置き、その下で個々の行動を抽選する。
 *   OBSERVE     様子見。ジャブだけ、間合いを測る
 *   AGGRESSIVE  攻勢。攻撃間隔が短く、ガードは薄い
 *   DEFENSIVE   守勢。ガードを固めて回り込み、フェイントで打たせてカウンターを待つ
 *   FATIGUE     疲れ。被弾の蓄積 / 空振りの連続で突入し、予備動作が長く隙が大きい＝決め時
 * ずっと同じ密度で殴ってくると「強い / 弱い」しか残らないので、山（攻勢）と谷（疲れ）を
 * 意図的に作る。谷はプレイヤーが必ず殴り返せる時間として置いている。
 *
 * ── 予告は「動き」で出す ────────────────────────────────────────────────────
 * 攻撃には必ず予備動作（telegraphMs）がある。人の反応時間 ~0.25s + 体を動かす時間が要るので、
 * 大技ほど長くしてある（Hook 1.0s）。テキストの予告は出さない（既存方針）。
 *
 * ── 離散イベントの受け渡し ──────────────────────────────────────────────────
 * 被弾・空振り・プレイヤーのスイングは「起きた瞬間」にしか分からないので、
 * ctx に毎フレーム履歴を積むのではなく `noteEvent()` で push してもらう（呼び出し側が
 * 判定した所でそのまま呼べる）。直近 N 件の履歴は AI 側で保持する。
 */

/** 重み付き抽選。weights = { key: number }。合計が 0 なら null。 */
export function pickWeighted(weights, rng) {
  let total = 0;
  for (const k in weights) total += Math.max(0, weights[k] ?? 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const k in weights) {
    r -= Math.max(0, weights[k] ?? 0);
    if (r < 0) return k;
  }
  return null;
}

export const AI_PHASES = ["OBSERVE", "AGGRESSIVE", "DEFENSIVE", "FATIGUE"];

export class EnemyAI {
  /**
   * @param {object} cfg tuning.js の `AI`
   * @param {() => number} rng 0..1 の乱数（テストでは決定的な列を注入する）
   */
  constructor(cfg, rng = Math.random) {
    this.cfg = cfg;
    this.rng = rng;
    this.reset(0);
  }

  reset(nowMs = 0) {
    const c = this.cfg;
    this.phase = "OBSERVE";
    this.state = "Idle_Observe";
    this.scriptStep = 0;
    this.phaseStartedMs = nowMs;
    this.phaseUntilMs = nowMs + this._phaseLenMs("OBSERVE");
    this.nextAttackAtMs = nowMs + c.openingDelayMs;
    this.comboQueue = [];
    this.pendingCounterAtMs = 0;
    this.slipUntilMs = 0;
    this.slipDir = 0;
    this.lastCounterMs = -1e9;
    this.stunUntilMs = 0;
    this.headOutcomes = [];     // 頭を狙った攻撃の結果（直近 N 件）
    this.headHitTimes = [];     // 自分が頭に食らった時刻（Stunned の判定に使う）
    this.damageTaken = 0;       // FATIGUE 突入までの被弾数
    this.whiffStreak = 0;       // 連続空振り数
    this.lowGuardUntilMs = 0;   // 胴を打たれた直後はガードを下げる
    this.guard = "high";
    this.guardUntilMs = 0;
    this.guardStaticMs = 0;     // プレイヤーがガードを上げたまま動かない時間
    this.leanSum = 0;           // リーンの偏り（+ が続けば右へ寄る癖）
    this.lastAttack = null;
    this.lastAttackEnd = null;
    // 台本モードなら開始フェーズも台本から取る（reset 直後に 2 回 OBSERVE に入らないように）
    if (c.script && c.scriptPhases.length) {
      const [name, sec] = c.scriptPhases[this.scriptStep++];
      this._enterPhase(name, nowMs, sec);
    }
  }

  // ── 外から流し込む離散イベント ─────────────────────────────────────────────
  /**
   * @param {{type:string, kind?:string, target?:string, outcome?:string, part?:string, side?:string, nowMs?:number}} ev
   *   attackEnd        自分の攻撃が終わった（outcome: hit | block | miss | feint）
   *   tookHit          自分が食らった（part: head | torso | guard）
   *   playerSwingStart プレイヤーがスイングを始めた（カウンターの抽選トリガ）
   *   playerWhiff      プレイヤーが空振りした（カウンターの好機）
   */
  noteEvent(ev) {
    const now = ev.nowMs ?? 0;
    const c = this.cfg;
    if (ev.type === "attackEnd") {
      this.lastAttackEnd = ev;
      if (ev.target === "head" && ev.outcome !== "feint") {
        this.headOutcomes.push(ev.outcome);
        if (this.headOutcomes.length > c.reaction.headWindow) this.headOutcomes.shift();
      }
      if (ev.outcome === "miss") this.whiffStreak++;
      else if (ev.outcome === "hit" || ev.outcome === "block") this.whiffStreak = 0;
      // コンビネーションは 1 発目が止められたら畳む（当たらない連打を続けない）
      if (ev.outcome === "block" && this.comboQueue.length) this.comboQueue.length = 0;
    } else if (ev.type === "tookHit") {
      this.damageTaken++;
      this.comboQueue.length = 0;
      if (ev.part === "torso") this.lowGuardUntilMs = now + c.reaction.lowGuardHoldMs;
      if (ev.part === "head") {
        this.headHitTimes.push(now);
        this.headHitTimes = this.headHitTimes.filter((t) => now - t <= c.stun.windowMs);
        if (this.headHitTimes.length >= c.stun.hits) {
          this.stunUntilMs = now + c.stun.durationMs;
          this.headHitTimes.length = 0;
          this.comboQueue.length = 0;
          this.state = "Stunned";
        }
      }
    } else if (ev.type === "playerSwingStart") {
      // スリップ → カウンター。連発すると理不尽なのでクールダウンを置く
      if (this.phase !== "FATIGUE" && now >= this.stunUntilMs
        && now - this.lastCounterMs >= c.counterCooldownMs
        && !this.pendingCounterAtMs && this.rng() < c.counterChance) {
        this.slipDir = ev.side === "left" ? 1 : -1;   // 来た手と逆へ体をずらす
        this.slipUntilMs = now + c.slipMs;
        this.pendingCounterAtMs = this.slipUntilMs;
        this.lastCounterMs = now;
      }
    } else if (ev.type === "playerWhiff") {
      // 空振りは差し込みどころ。次の攻撃を前倒しする
      this.nextAttackAtMs = Math.min(this.nextAttackAtMs, now + c.whiffPunishDelayMs);
    }
  }

  // ── メイン ────────────────────────────────────────────────────────────────
  /**
   * @param {object} ctx {
   *   nowMs, dist（root 間距離 [m]）, preferredDist, deadZone, inRange（腕が届くか）,
   *   busy（攻撃モーション中）, player:{guardHigh,guardLow,swinging,lean,ducking,stepIn,stepBack},
   *   hp:{self,player}（0..1）, elapsed [s] }
   * @param {number} dt [s]
   * @returns {{phase,state,footwork,footworkScale,distBias,guard,attack,slip}}
   */
  update(ctx, dt) {
    const c = this.cfg;
    const now = ctx.nowMs;
    const p = ctx.player ?? {};
    this._trackPlayer(p, dt);
    const stunned = now < this.stunUntilMs;
    if (!stunned) this._updatePhase(ctx);
    else this.state = "Stunned";

    const intents = {
      phase: this.phase, state: this.state,
      footwork: "hold", footworkScale: 1, distBias: 0,
      guard: "high", attack: null, slip: 0,
    };

    // ── ガード（構えている間だけ意味がある。攻撃中のグローブは経路が決める） ──
    intents.guard = this._decideGuard(ctx, stunned);
    // ── 足さばき ──
    Object.assign(intents, this._decideFootwork(ctx, stunned));
    // ── 攻撃 ──
    if (!stunned && !ctx.busy) {
      const atk = this._decideAttack(ctx);
      if (atk) {
        intents.attack = atk;
        this.lastAttack = atk;
        this.state = atk.state;
      }
    }
    intents.phase = this.phase;
    intents.state = this.state;
    return intents;
  }

  /** デバッグ表示用の 1 行。 */
  describe() {
    const q = this.comboQueue.length ? ` combo+${this.comboQueue.length}` : "";
    return `${this.phase}/${this.state}${q} dmg${this.damageTaken} whiff${this.whiffStreak}`;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────
  _rangeMs(range) {
    const [lo, hi] = range;
    return (lo + this.rng() * (hi - lo)) * 1000;
  }

  _phaseLenMs(phase) {
    const d = this.cfg.phaseDurations[phase];
    return this._rangeMs(d ?? [3, 5]);
  }

  _enterPhase(phase, nowMs, durationSec) {
    this.phase = phase;
    this.phaseStartedMs = nowMs;
    this.phaseUntilMs = nowMs + (durationSec != null ? durationSec * 1000 : this._phaseLenMs(phase));
    this.state = phase === "OBSERVE" ? "Idle_Observe" : phase === "FATIGUE" ? "Stagger_Fatigue" : "Idle";
    if (phase === "FATIGUE") { this.damageTaken = 0; this.whiffStreak = 0; this.comboQueue.length = 0; }
    // フェーズが変わった直後は少し間を置く（切り替わりが見えるように）
    this.nextAttackAtMs = Math.max(this.nextAttackAtMs, nowMs + this.cfg.phaseSwitchDelayMs);
  }

  _nextPhase(nowMs) {
    const c = this.cfg;
    if (c.script && this.scriptStep < c.scriptPhases.length) {
      const [name, sec] = c.scriptPhases[this.scriptStep++];
      this._enterPhase(name, nowMs, sec);
      return;
    }
    const next = this.phase === "AGGRESSIVE" ? "DEFENSIVE" : "AGGRESSIVE";
    this._enterPhase(next, nowMs);
  }

  _updatePhase(ctx) {
    const c = this.cfg;
    const now = ctx.nowMs;
    // 被弾の蓄積 / 空振りの連続 → 疲れる（プレイヤーが殴り返せる山場を作る）
    if (this.phase !== "FATIGUE"
      && (this.damageTaken >= c.fatigueTriggerDamage || this.whiffStreak >= c.fatigueTriggerWhiffs)) {
      this._enterPhase("FATIGUE", now);
      return;
    }
    // 様子見中でも間合いが詰まったら攻勢へ（棒立ちで詰められない）
    if (this.phase === "OBSERVE" && ctx.dist <= c.closeDist) { this._enterPhase("AGGRESSIVE", now); return; }
    if (now >= this.phaseUntilMs) this._nextPhase(now);
  }

  /** プレイヤーの癖（ガードを上げたまま静止 / 同じ側にばかりリーン）を貯める。 */
  _trackPlayer(p, dt) {
    const c = this.cfg.reaction;
    if (p.guardHigh && !p.swinging) this.guardStaticMs += dt * 1000;
    else this.guardStaticMs = 0;
    const lean = p.lean ?? 0;
    // 指数移動平均。片側に居続ければ ±1 に寄る
    const k = 1 - Math.exp(-Math.max(dt, 0) / c.leanTauSec);
    this.leanSum += k * (lean - this.leanSum);
  }

  /** 直近の頭狙いのうちガードされた割合が高いか（＝胴に切り替える合図）。 */
  _headIsWalled() {
    const c = this.cfg.reaction;
    if (this.headOutcomes.length < c.headWindow) return false;
    const blocked = this.headOutcomes.filter((o) => o === "block").length;
    return blocked >= c.headBlockedMin;
  }

  _decideGuard(ctx, stunned) {
    const c = this.cfg;
    const now = ctx.nowMs;
    // 気絶・疲れは腕が下がる（頭が開く＝見て分かる隙）
    if (stunned || this.phase === "FATIGUE") return "open";
    if (now < this.guardUntilMs) return this.guard;
    this.guardUntilMs = now + c.guardHoldMs;
    // 胴を打たれた直後は下げる／プレイヤーが胴を狙って伸ばしていれば下げる
    if (now < this.lowGuardUntilMs) { this.guard = "low"; return this.guard; }
    const rate = this.phase === "DEFENSIVE" ? Math.min(1, c.guardRate + c.defensiveGuardBonus)
      : this.phase === "AGGRESSIVE" ? c.guardRate * c.aggressiveGuardScale : c.guardRate;
    this.guard = this.rng() < rate ? "high" : "open";
    return this.guard;
  }

  _decideFootwork(ctx, stunned) {
    const c = this.cfg;
    const now = ctx.nowMs;
    const out = { footwork: "hold", footworkScale: 1, distBias: 0, slip: 0 };
    if (stunned) { out.footwork = "retreat"; out.footworkScale = c.stun.footworkScale; return out; }
    // スリップは上体の演出だけで、fencing 型の足さばきは前後に限定する。
    if (now < this.slipUntilMs) {
      out.footwork = "hold";
      out.slip = this.slipDir;
      this.state = "SlipDuck";
      return out;
    }
    if (this.pendingCounterAtMs) this.state = "CounterWindow";
    const p = ctx.player ?? {};
    out.distBias = this.phase === "AGGRESSIVE" ? -c.aggressiveCloseIn
      : this.phase === "DEFENSIVE" ? c.defensiveBackOff
        : this.phase === "FATIGUE" ? c.fatigueBackOff : 0;
    const target = (ctx.preferredDist ?? 0.68) + out.distBias;
    const err = ctx.dist - target;
    if (err > (ctx.deadZone ?? 0.1) || p.stepBack) { out.footwork = "approach"; return out; }
    if (err < -(ctx.deadZone ?? 0.1)) {
      // 詰められすぎ: 守勢なら下がる、攻勢ならその間合いのまま近距離を打つ
      out.footwork = this.phase === "AGGRESSIVE" ? "hold" : "retreat";
      return out;
    }
    return out;
  }

  /** 攻撃の発注。null なら今は打たない。 */
  _decideAttack(ctx) {
    const c = this.cfg;
    const now = ctx.nowMs;
    // ① スリップ明けのカウンター（間合いが届く時だけ）
    if (this.pendingCounterAtMs && now >= this.pendingCounterAtMs) {
      this.pendingCounterAtMs = 0;
      if (ctx.inRange) {
        this.nextAttackAtMs = now + this._attackGapMs();
        return this._makeAttack("counter", this._pickHand(ctx), "head", { state: "CounterPunch" });
      }
    }
    // ② コンビネーションの続き（予備動作なしで即座に次弾）
    if (this.comboQueue.length) {
      if (!ctx.inRange) { this.comboQueue.length = 0; }
      else {
        const next = this.comboQueue.shift();
        return next;
      }
    }
    if (!ctx.inRange || now < this.nextAttackAtMs) return null;
    if (this.phase === "FATIGUE" && this.rng() > c.fatigueAttackChance) {
      this.nextAttackAtMs = now + this._attackGapMs();
      return null;
    }
    this.nextAttackAtMs = now + this._attackGapMs();

    const hand = this._pickHand(ctx);
    const p = ctx.player ?? {};
    // ③ フェイントの直後にガードが崩れていたらコンビネーションで畳みかける
    if (this.lastAttackEnd?.outcome === "feint" && !p.guardHigh && this.phase !== "FATIGUE") {
      this.lastAttackEnd = null;
      return this._startCombo(hand);
    }
    // ④ フェイント（ガードを上げたまま固まっている相手ほど多く出す）
    const guardStatic = this.guardStaticMs >= c.reaction.guardStaticMs;
    const feintRate = c.feintRate * (guardStatic ? c.reaction.feintBoost : 1);
    if (this.phase !== "OBSERVE" && this.phase !== "FATIGUE" && this.rng() < feintRate) {
      return this._makeAttack("feint", hand, "head", { state: "Feint" });
    }
    // ⑤ 通常の抽選
    const kind = pickWeighted(this._attackWeights(ctx), this.rng) ?? "jab";
    if (kind === "combo") return this._startCombo(hand);
    const target = kind === "body" ? "torso"
      : this._headIsWalled() ? "torso"
        : this.rng() < c.headTargetRate ? "head" : "torso";
    return this._makeAttack(kind, hand, target, {});
  }

  _attackWeights(ctx) {
    const c = this.cfg;
    const w = { ...(c.attackWeights[this.phase] ?? c.attackWeights.AGGRESSIVE) };
    // 頭が壁になっている（直近の頭狙いが止められている）→ 胴を増やす
    if (this._headIsWalled()) w.body = (w.body ?? 0) * c.reaction.bodyBoost + c.reaction.bodyFloor;
    // 近すぎる間合いでは長いストレートより回し / 胴
    if (ctx.dist < c.closeDist) {
      w.hook = (w.hook ?? 0) * 2;
      w.body = (w.body ?? 0) * 2;
      w.jab = (w.jab ?? 0) * 0.4;
      w.straight = (w.straight ?? 0) * 0.5;
    }
    return w;
  }

  /**
   * 使う腕。プレイヤーが同じ側にばかりリーンするなら、その逃げ先（＝逆側）へ回す。
   * 敵の右手は +X 側にあるので、プレイヤーが +X へ逃げる癖なら右手を選ぶ。
   * 回り込みの途中は片手しか届かないことがあるので、届く手があればそちらを優先する
   * （ここで選び損ねると boxing.js 側で攻撃が無かったことになってしまう）。
   */
  _pickHand(ctx) {
    const ok = ctx?.handInRange;
    const usable = ok ? ["left", "right"].filter((h) => ok[h]) : ["left", "right"];
    const bias = this.leanSum;
    const want = bias > 0 ? "right" : "left";
    if (Math.abs(bias) >= this.cfg.reaction.leanBiasMin && (!usable.length || usable.includes(want))) return want;
    if (usable.length === 1) return usable[0];
    return this.rng() < 0.5 ? "left" : "right";
  }

  _attackGapMs() {
    const c = this.cfg;
    const scale = c.phaseAttackScale[this.phase] ?? 1;
    return this._rangeMs(c.attackFrequency) * scale;
  }

  /** 1 発ぶんの攻撃 intent を組む（予備動作は難度スケールと疲労で伸びる）。 */
  _makeAttack(kind, hand, target, { telegraphMs, recoverMs, state, combo } = {}) {
    const c = this.cfg;
    const a = c.attacks[kind];
    const fatigue = this.phase === "FATIGUE" ? c.fatigueTelegraphScale : 1;
    const tele = (telegraphMs != null ? telegraphMs : a.telegraphMs) * c.telegraphLengthScale * fatigue;
    return {
      kind, hand, target,
      side: kind === "hook" ? (hand === "left" ? -1 : 1) : 0,
      telegraphMs: Math.round(tele),
      strikeMs: a.strikeMs,
      recoverMs: recoverMs != null ? recoverMs : a.recoverMs,
      feint: kind === "feint",
      feintCancelFrac: kind === "feint" ? c.feintCancelFrac : 0,
      state: state ?? (kind === "body" ? "BodyBlow" : kind[0].toUpperCase() + kind.slice(1)),
      combo: combo ?? null,
    };
  }

  /** 1-2-フック。1 発目だけ予備動作があり、以降は間を空けずに続く（キャンセル不可）。 */
  _startCombo(hand) {
    const c = this.cfg;
    const len = c.comboLength[0] + Math.floor(this.rng() * (c.comboLength[1] - c.comboLength[0] + 1));
    const seq = c.comboSequence.slice(0, len);
    const other = hand === "left" ? "right" : "left";
    const link = c.attacks.combo.linkRecoverMs;
    const shots = seq.map((kind, i) => {
      const h = i % 2 === 0 ? hand : other;
      const target = this._headIsWalled() && i === seq.length - 1 ? "torso" : kind === "body" ? "torso" : "head";
      return this._makeAttack(kind, h, target, {
        telegraphMs: i === 0 ? undefined : c.attacks.combo.followTelegraphMs,
        recoverMs: i === seq.length - 1 ? c.attacks.combo.recoverMs : link,
        state: `Combination${i + 1}/${seq.length}`,
        combo: { index: i, total: seq.length },
      });
    });
    this.comboQueue = shots.slice(1);
    return shots[0];
  }
}
