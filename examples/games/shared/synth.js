/**
 * Tiny PCM16 synthesis for ad-hoc haptic cues — primarily a STEREO directional
 * blip whose left/right amplitude balance conveys direction. The device PLAY
 * command has no pan, so directional haptics must be STREAMED as stereo PCM
 * (channels=2). This is what makes "buzz to the left = turn left" work.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A short decaying tone, stereo, panned by equal-power L/R balance.
 * @param {number} pan -1 (full left) .. 0 (center) .. +1 (full right)
 * @returns {Uint8Array} interleaved PCM16 LE stereo bytes
 */
export function stereoBlip(pan = 0, { gain = 1, durMs = 90, freq = 160, sampleRate = 16000, decay = 5 } = {}) {
  const n = Math.max(1, Math.floor((durMs / 1000) * sampleRate));
  const theta = ((clamp(pan, -1, 1) + 1) / 2) * (Math.PI / 2); // 0..π/2
  const lAmp = Math.cos(theta) * gain;
  const rAmp = Math.sin(theta) * gain;
  const out = new Uint8Array(n * 2 * 2); // 2 ch * 2 bytes
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const env = Math.exp((-i / n) * decay);
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * env;
    const l = clamp(s * lAmp, -1, 1);
    const r = clamp(s * rAmp, -1, 1);
    dv.setInt16(i * 4, (l * 32767) | 0, true);
    dv.setInt16(i * 4 + 2, (r * 32767) | 0, true);
  }
  return out;
}

/** A double-blip both sides (e.g. "U-turn" / "arrived"). */
export function bothSides(gain = 1, opts = {}) {
  return stereoBlip(0, { gain, freq: 200, durMs: 140, ...opts });
}

/**
 * A SUSTAINED stereo tone with INDEPENDENT left/right amplitudes (not equal-power
 * coupled like stereoBlip). For continuous directional haptics where L and R must
 * be set separately per the modulation algorithm (ToH2022, Eqs. 1–3). A short
 * cosine attack/release avoids clicks when chunks are streamed back-to-back.
 * @param {number} lAmp 0..1 left amplitude
 * @param {number} rAmp 0..1 right amplitude
 * @returns {Uint8Array} interleaved PCM16 LE stereo bytes
 */
export function stereoTone(lAmp, rAmp, { freq = 100, durMs = 200, sampleRate = 16000, edgeMs = 8, startPhase = 0 } = {}) {
  const n = Math.max(1, Math.floor((durMs / 1000) * sampleRate));
  const edge = Math.max(1, Math.floor((edgeMs / 1000) * sampleRate));
  const L = clamp(lAmp, 0, 1), R = clamp(rAmp, 0, 1);
  const w = (2 * Math.PI * freq) / sampleRate;
  const out = new Uint8Array(n * 2 * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < edge) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge); // attack
    else if (i > n - edge) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / edge); // release
    // startPhase lets back-to-back chunks be PHASE-CONTINUOUS (no click/roughness
    // at chunk boundaries) when streaming a continuous tone — see fps continuous mode.
    const s = Math.sin(startPhase + w * i) * env;
    dv.setInt16(i * 4, (clamp(s * L, -1, 1) * 32767) | 0, true);
    dv.setInt16(i * 4 + 2, (clamp(s * R, -1, 1) * 32767) | 0, true);
  }
  return out;
}

/** Phase advance (radians) for a tone of `freq` over `durMs` — to carry across chunks. */
export function phaseAdvance(freq, durMs, sampleRate = 16000) {
  const n = Math.max(1, Math.floor((durMs / 1000) * sampleRate));
  return ((2 * Math.PI * freq) / sampleRate) * n;
}

/**
 * Fire a directional cue across modalities: STEREO haptic (L/R) + a panned
 * audio click. Each modality self-gates on the bridge master switches.
 * @param {import("./hapbeat-bridge.js").ArcadeBridge} bridge
 * @param {number} pan -1..1
 */
export function directionCue(bridge, pan, { gain = 0.85, durMs = 90, freq = 160, audioEvent = "reflex_go" } = {}) {
  bridge.streamPcm(stereoBlip(pan, { gain, durMs, freq }), { channels: 2, sampleRate: 16000, gain: 1 });
  // audio L/R via the panned one-shot (haptic suppressed; stream already did it)
  bridge.fire(audioEvent, { haptic: false, audio: true, pan: clamp(pan, -1, 1), gain: 0.45 });
}
