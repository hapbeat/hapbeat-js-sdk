/**
 * ArcadeBridge — the games' single touch-point to Hapbeat.
 *
 * Wraps @hapbeat/sdk (browser → hapbeat-helper WS) and the WebAudio bank, and
 * exposes one `fire(name, opts)` call that drives haptic + audio together,
 * gated by global modality master switches. Degrades gracefully: if the helper
 * is not running, audio + visuals still work and `connected` stays false so the
 * UI can show a "haptics disabled" banner.
 */

import { connect } from "@hapbeat/sdk";
import { CONTENT, buildHaptic } from "./event-content.js";
import { AudioBank } from "./audio.js";
import { stereoBlip } from "./synth.js";

const clamp01 = (g) => (g < 0 ? 0 : g > 1 ? 1 : g);
const clampPan = (p) => (p < -1 ? -1 : p > 1 ? 1 : p);

export class ArcadeBridge {
  constructor() {
    this.hb = null;
    this.connected = false;
    this.connecting = false;
    this.settled = false; // has at least one connect attempt finished?
    this.lastError = "";
    this.devices = [];
    /** Master modality switches (👁 映像 / 👂 音 / ✋ 触覚). Games read `visual`
     *  to gate their on-screen hints; `audio`/`haptic` gate fire(). */
    this.master = { visual: true, audio: true, haptic: true };
    this.audio = new AudioBank();
    this._listeners = new Set();
  }

  /** Load audio (always), then try the helper. Never throws. */
  async init({ appName = "HapbeatArcade", helperUrl, audioBase = "" } = {}) {
    await this.audio.loadAll(audioBase);
    await this.connectHelper({ appName, helperUrl });
    return this;
  }

  async connectHelper({ appName = "HapbeatArcade", helperUrl } = {}) {
    if (this.connecting) return;
    this.connecting = true;
    this.lastError = "";
    this._emit();
    try {
      this.hb = await connect({
        appName,
        helperUrl,
        onConnectionLost: () => this._onLost(),
      });
      this.connected = true;
      this.devices = await safe(() => this.hb.discover(1500), []);
    } catch (e) {
      this.connected = false;
      this.hb = null;
      this.lastError = e?.message ?? String(e);
    } finally {
      this.connecting = false;
      this.settled = true;
      this._emit();
    }
  }

  /** Called by the SDK when an established helper WS connection drops. */
  _onLost() {
    if (!this.connected) return;
    this.connected = false;
    this.hb = null;
    this.devices = [];
    this.lastError = "helper との接続が切れました";
    this._emit();
  }

  async rediscover() {
    if (!this.connected || !this.hb) return;
    this.devices = await safe(() => this.hb.discover(1200), this.devices);
    this._emit();
  }

  /**
   * Fire a logical event across modalities — haptic + audio specs come from the
   * central event-content map (the single tuning surface; see event-content.js).
   * @param {string} name  key in CONTENT
   * @param {{gain?:number, pan?:number, haptic?:boolean, audio?:boolean}} opts
   *   gain overrides the event's base intensity; per-call haptic/audio default
   *   true and are AND-ed with the master switch.
   */
  fire(name, opts = {}) {
    const ev = CONTENT[name];
    if (!ev) {
      console.warn(`[arcade] unknown event "${name}"`);
      return;
    }
    const gain = clamp01(opts.gain ?? ev.haptic?.gain ?? 0.8);
    const pan = clampPan(opts.pan ?? 0);
    const wantHaptic = opts.haptic !== false;
    const wantAudio = opts.audio !== false;

    if (wantHaptic && this.master.haptic && this.connected && this.hb) {
      try {
        const pcm = buildHaptic(stereoBlip, ev.haptic, { pan, gain });
        if (pcm) this.hb.streamPcm(pcm, { channels: 2, sampleRate: 16000, gain: 1 });
      } catch (e) {
        console.warn(`[arcade] haptic stream failed: ${e?.message ?? e}`);
      }
    }
    if (wantAudio && this.master.audio) {
      this.audio.playSpec(ev.audio, { gain, pan });
    }
  }

  /**
   * Stream an ad-hoc PCM16 buffer to the device (e.g. a synthesized STEREO
   * directional cue — see shared/synth.js). Gated by the haptic master.
   * @param {Uint8Array} pcm
   * @param {{sampleRate?:number, channels?:number, gain?:number}} opts
   */
  streamPcm(pcm, opts = {}) {
    if (this.master.haptic && this.connected && this.hb) {
      try {
        this.hb.streamPcm(pcm, opts);
      } catch (e) {
        console.warn(`[arcade] streamPcm failed: ${e?.message ?? e}`);
      }
    }
  }

  /**
   * Open a PERSISTENT stream session for continuously-modulated haptics (no
   * per-chunk teardown — see hapbeat-web-sdk LiveStream). Returns a handle with
   * write(pcm)/close()/closed, or null if haptics aren't available. The caller
   * must feed chunks at ~real-time rate and re-open if `closed` (a discrete
   * fire/streamPcm ends the live stream — 1 session = 1 stream).
   * @returns {{write:(pcm:Uint8Array)=>void, close:()=>void, closed:boolean}|null}
   */
  openStream(opts = {}) {
    if (this.master.haptic && this.connected && this.hb) {
      try {
        return this.hb.openStream(opts);
      } catch (e) {
        console.warn(`[arcade] openStream failed: ${e?.message ?? e}`);
      }
    }
    return null;
  }

  /** Quick "is the device alive" tap — fires a known event at moderate gain. */
  testHaptic() {
    this.fire("reflex_go", { gain: 0.6, audio: true });
  }

  stopAll() {
    if (this.connected && this.hb) {
      try {
        this.hb.stopAll();
      } catch {
        /* ignore */
      }
    }
  }

  setMaster(key, value) {
    this.master[key] = !!value;
    this._emit();
  }

  /** Resume AudioContext from a user gesture. */
  unlockAudio() {
    return this.audio.unlock();
  }

  onChange(fn) {
    this._listeners.add(fn);
    fn(this);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch {
        /* ignore */
      }
    }
  }
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
