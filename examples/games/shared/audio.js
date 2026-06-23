/**
 * AudioBank — tiny WebAudio synth for the *audio* modality of the games. It
 * plays the placeholder TONES defined per event in event-content.js (no WAV
 * files), so audio works without any installed kit and every sound is tunable in
 * one place. Independent of the device haptics, so visitors can A/B audio vs.
 * haptic vs. both.
 *
 * The AudioContext starts suspended; call unlock() from a user gesture before the
 * first sound, per browser autoplay policy.
 */

import { CONTENT } from "./event-content.js";

export class AudioBank {
  constructor() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = Ctx ? new Ctx() : null;
    this.master = this.ctx ? this.ctx.createGain() : null;
    if (this.master) {
      this.master.gain.value = 1.0;
      this.master.connect(this.ctx.destination);
    }
    this.ready = true;
  }

  /** Resume the context — must run inside a user-gesture handler. */
  async unlock() {
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  /** Synth audio has nothing to preload (kept for the bridge's init contract). */
  async loadAll() {
    /* no-op */
  }

  /** Play the synth tone bound to a logical event name. */
  play(name, { gain = 1.0, pan = 0 } = {}) {
    const ev = CONTENT[name];
    if (ev) this.playSpec(ev.audio, { gain, pan });
  }

  /**
   * Play one audio spec. Two kinds:
   *   "tone" { type, freq, vol, attack, decay }            — a single oscillator pulse
   *   "arp"  { type, notes:[Hz,…], stepMs, vol, decay }    — a quick arpeggio (e.g. the notice chime)
   * @param {{gain?:number, pan?:number}} opts  gain = event intensity 0..1
   */
  playSpec(spec, { gain = 1.0, pan = 0 } = {}) {
    if (!this.ctx || !this.master || !spec) return;
    const intensity = Math.max(0, Math.min(1, gain));
    if (spec.kind === "tone") {
      this._tone(spec.type, spec.freq, intensity * (spec.vol ?? 0.3), spec.attack ?? 0.005, spec.decay ?? 0.15, pan, 0);
    } else if (spec.kind === "arp") {
      const notes = spec.notes || [];
      const step = (spec.stepMs ?? 90) / 1000;
      notes.forEach((f, i) => this._tone(spec.type, f, intensity * (spec.vol ?? 0.24), 0.012, spec.decay ?? 0.16, pan, i * step));
    }
  }

  /** One oscillator note with an attack/decay envelope, started `at` seconds from now. */
  _tone(type, freq, vol, atk, dec, pan, at) {
    if (vol <= 0.0002) return;
    const now = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.value = freq || 440;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, now + atk + dec);
    let tail = g;
    if (this.ctx.createStereoPanner) {
      const pn = this.ctx.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(pn);
      tail = pn;
    }
    o.connect(g);
    tail.connect(this.master);
    o.start(now);
    o.stop(now + atk + dec + 0.03);
  }

  setMasterGain(v) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }
}
