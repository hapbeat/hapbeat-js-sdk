/**
 * AudioBank — tiny WebAudio wrapper that preloads the placeholder WAVs and
 * plays them as one-shots with gain + stereo pan. Used for the *audio*
 * modality of the games (independent of the device haptics), so visitors can
 * A/B audio vs. haptic vs. both.
 *
 * The AudioContext starts suspended; call unlock() from a user gesture
 * (a click/keypress) before the first sound, per browser autoplay policy.
 */

import { EVENTS, clipUrls } from "./events.js";

export class AudioBank {
  constructor() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = Ctx ? new Ctx() : null;
    this.buffers = new Map(); // url -> AudioBuffer
    this.master = this.ctx ? this.ctx.createGain() : null;
    if (this.master) {
      this.master.gain.value = 1.0;
      this.master.connect(this.ctx.destination);
    }
    this.ready = false;
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

  /** Fetch + decode every distinct clip. Safe to call once at startup. */
  async loadAll(baseUrl = "") {
    if (!this.ctx) return;
    const urls = clipUrls();
    await Promise.all(
      urls.map(async (rel) => {
        const url = baseUrl + rel;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const raw = await res.arrayBuffer();
          const buf = await this.ctx.decodeAudioData(raw);
          this.buffers.set(rel, buf);
        } catch (e) {
          console.warn(`[arcade-audio] failed to load ${url}: ${e.message}`);
        }
      }),
    );
    this.ready = true;
  }

  /**
   * Play the clip bound to a logical event name.
   * @param {string} name  key in EVENTS
   * @param {{gain?:number, pan?:number, rate?:number}} opts
   */
  play(name, { gain = 1.0, pan = 0, rate = 1.0 } = {}) {
    if (!this.ctx || !this.master) return;
    const ev = EVENTS[name];
    if (!ev) return;
    const buf = this.buffers.get(ev.audioClip);
    if (!buf) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, gain));

    let tail = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      tail = p;
    }
    src.connect(g);
    tail.connect(this.master);
    src.start();
  }

  setMasterGain(v) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }
}
