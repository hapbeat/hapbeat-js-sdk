/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  EVENT CONTENT MAP — the single place to tune every game's HAPTIC + AUDIO. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Think of this as the games' "EventMap": every logical event lists EXACTLY which
 * haptic and which audio it triggers, so it's obvious at a glance "event X → this
 * buzz + this sound". Games never hardcode freq/dur/gain — they call
 * `bridge.fire(name)` and the bridge reads the spec below.
 *
 * ⚠️ EVERYTHING HERE IS A PLACEHOLDER. Final haptic + audio design happens HERE,
 *    later, in one pass. Tweak numbers freely; nothing else needs to change.
 *
 * haptic — synthesized stereo PCM streamed to the device (no installed kit needed):
 *   kind:"blip"   { freq, durMs, gain, decay }                     one decaying pulse
 *   kind:"double" { freq, durMs, freq2, durMs2, gapMs, gain }      two pulses (e.g. "found!")
 *   gain is the BASE intensity 0..1 (a per-call gain overrides it).
 *
 * audio — synthesized WebAudio tone (placeholder; no WAV files):
 *   kind:"tone"   { type:"sine|triangle|square|sawtooth", freq, durMs, vol, attack, decay }
 *   vol is RELATIVE 0..1 and is multiplied by the event intensity.
 *   audio:null    → silent (haptic-only event).
 *
 * FPS note: the FPS demo computes pan/distance live (directional), but pulls its
 *   base freq/dur/gain from the `fps_*` rows here so its tuning lives in one place
 *   too. Its gunfire AUDIO is a procedural noise burst (kind:"gun") handled inside
 *   fps.js — the `freq/durMs/vol` here still drive it.
 */

export const CONTENT = {
  // ── 気づけるか (notice) ───────────────────────────────────────────────────
  notice_alert: {
    haptic: { kind: "blip", freq: 180, durMs: 110, gain: 0.95, decay: 5 },
    audio: { kind: "arp", type: "triangle", notes: [784, 1047, 1397], stepMs: 90, vol: 0.24, decay: 0.16 },
    usedBy: "notice", note: "通知（ながら作業中の気づき）。最重要：✋だけでも気づける鋭い単発＋上昇チャイム。",
  },
  notice_win: {
    haptic: { kind: "blip", freq: 150, durMs: 170, gain: 0.6, decay: 4 },
    audio: { kind: "tone", type: "sine", freq: 660, durMs: 220, vol: 0.22, attack: 0.01, decay: 0.2 },
    usedBy: "notice", note: "全課題クリアの締め。",
  },

  // ── 宝探し (hotcold) ──────────────────────────────────────────────────────
  hot_pulse: {
    haptic: { kind: "blip", freq: 180, durMs: 55, gain: 0.4, decay: 6 },
    audio: { kind: "tone", type: "square", freq: 520, durMs: 50, vol: 0.12, attack: 0.002, decay: 0.05 },
    usedBy: "hotcold", note: "近接ガイガーパルス。gain と間隔は近さでスケール（呼び出し側）。",
  },
  hot_found: {
    haptic: { kind: "double", freq: 240, durMs: 90, freq2: 120, durMs2: 180, gapMs: 40, gain: 1.0 },
    audio: { kind: "tone", type: "triangle", freq: 880, durMs: 240, vol: 0.24, attack: 0.005, decay: 0.22 },
    usedBy: "hotcold", note: "発見（強い当たり）。ガイガーと明確に違う『二段ドン』。",
  },
  hot_timeout: {
    haptic: { kind: "blip", freq: 90, durMs: 200, gain: 0.7, decay: 3 },
    audio: { kind: "tone", type: "sawtooth", freq: 200, durMs: 240, vol: 0.2, attack: 0.005, decay: 0.24 },
    usedBy: "hotcold", note: "制限時間切れ（フェイル）。",
  },

  // ── 反応速度 (reflex) ─────────────────────────────────────────────────────
  reflex_go: {
    haptic: { kind: "blip", freq: 175, durMs: 120, gain: 0.75, decay: 5 },
    audio: { kind: "tone", type: "triangle", freq: 760, durMs: 90, vol: 0.34, attack: 0.001, decay: 0.085 },
    usedBy: "reflex", note: "GO 合図。高め・強アタックの単発（FPS の盾ブロック『ぽこん』風）。",
  },
  reflex_foul: {
    haptic: { kind: "blip", freq: 95, durMs: 150, gain: 0.6, decay: 4 },
    audio: { kind: "tone", type: "sawtooth", freq: 180, durMs: 150, vol: 0.24, attack: 0.004, decay: 0.15 },
    usedBy: "reflex", note: "お手つき（フライング）。",
  },
  reflex_win: {
    haptic: { kind: "blip", freq: 150, durMs: 170, gain: 0.6, decay: 4 },
    audio: { kind: "tone", type: "sine", freq: 600, durMs: 200, vol: 0.2, attack: 0.01, decay: 0.2 },
    usedBy: "reflex", note: "好成績の締め（全周回クリア時）。",
  },

  // ── 触覚FPS (fps) — base values; pan/distance are applied live in fps.js ───
  fps_enemy_fire: {
    haptic: { kind: "dir", freq: 170, durMs: 95, gain: 0.55 },
    audio: { kind: "gun", freq: 230, durMs: 150, vol: 0.55 },
    usedBy: "fps", note: "敵の発砲（方向）。L/R は弾の方位で決まる。",
  },
  fps_player_hit: {
    haptic: { kind: "dir", freq: 120, durMs: 150, gain: 1.0 },
    audio: { kind: "gun", freq: 150, durMs: 220, vol: 0.8 },
    usedBy: "fps", note: "被弾（強）。",
  },
  fps_own_shot: {
    haptic: { kind: "blip", freq: 220, durMs: 70, gain: 0.7 },
    audio: { kind: "gun", freq: 320, durMs: 110, vol: 0.7 },
    usedBy: "fps", note: "自分の発砲。",
  },
  fps_block: {
    haptic: { kind: "blip", freq: 90, durMs: 120, gain: 0.95 },
    audio: { kind: "gun", freq: 520, durMs: 120, vol: 0.75 },
    usedBy: "fps", note: "盾ブロック（成功・『ぽこん』）。被弾とは別フィードバック。",
  },
  fps_kill: {
    haptic: { kind: "blip", freq: 300, durMs: 80, gain: 0.6 },
    audio: { kind: "gun", freq: 480, durMs: 90, vol: 0.6 },
    usedBy: "fps", note: "撃破。",
  },
  fps_walk: {
    haptic: { kind: "blip", freq: 55, durMs: 60, gain: 0.35 },
    audio: { kind: "thud", freq: 72, durMs: 95, vol: 0.28 },
    usedBy: "fps", note: "歩行（上下動＋低い踏み込み音＋足音振動）。敵銃撃の音/触覚をマスクする＝止まると気づきやすい。",
  },
  // 連続モード（~100Hz の方向触覚）の数値は fps/tuning.js の CONTINUOUS にまとめてある（波形+アルゴリズム両方）。
};

const clamp01 = (g) => (g < 0 ? 0 : g > 1 ? 1 : g);
const clampPan = (p) => (p < -1 ? -1 : p > 1 ? 1 : p);

/**
 * Build the stereo PCM for an event's HAPTIC spec at the given pan + intensity.
 * Returns interleaved PCM16 LE stereo bytes (channels=2), or null for unsupported
 * kinds. `stereoBlip` is injected to avoid a hard import cycle.
 * @param {(pan:number,opts:object)=>Uint8Array} stereoBlip
 */
export function buildHaptic(stereoBlip, spec, { pan = 0, gain } = {}) {
  if (!spec) return null;
  const g = clamp01(gain ?? spec.gain ?? 0.8);
  const p = clampPan(pan);
  if (spec.kind === "double") {
    const a = stereoBlip(p, { gain: g, durMs: spec.durMs, freq: spec.freq, decay: spec.decay ?? 4 });
    const gap = new Uint8Array(Math.max(0, Math.floor(((spec.gapMs ?? 40) / 1000) * 16000)) * 4);
    const b = stereoBlip(p, { gain: g, durMs: spec.durMs2 ?? spec.durMs, freq: spec.freq2 ?? spec.freq, decay: spec.decay ?? 3 });
    const out = new Uint8Array(a.length + gap.length + b.length);
    out.set(a, 0); out.set(gap, a.length); out.set(b, a.length + gap.length);
    return out;
  }
  // "blip" (and "dir"/"tone" fall back to a single blip when fired discretely)
  return stereoBlip(p, { gain: g, durMs: spec.durMs ?? 90, freq: spec.freq ?? 175, decay: spec.decay ?? 5 });
}
