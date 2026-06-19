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
