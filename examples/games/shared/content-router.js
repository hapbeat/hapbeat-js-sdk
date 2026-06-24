/**
 * ContentRouter — the "つなぎ" between a game's logical events and playback.
 *
 *   event-content.js (audio: file→synth)
 *        +  eventmap.json (per-event: kitEvent / mode / gain / target / directional)
 *        +  kit/manifest.json  (Hapbeat Studio output — HAPTIC clips; UNMODIFIED)
 *        →  ContentRouter routes each fire to FILES first, SYNTH as fallback.
 *
 * Design notes
 * - The manifest is parsed by the SDK's own `EventMap.fromManifest` (schema 2.0.0).
 *   We NEVER invent a manifest schema — Studio owns it. This class only reads it
 *   (which kitEvents have clips + their intensity/filename) and routes.
 * - Haptic clips are loaded with the SDK's exported `parseWav` and streamed via the
 *   bridge's existing `streamPcm` (which paces through the SDK ClipStreamer). For
 *   `directional` events the clip's mono PCM is panned L/R (equal-power) exactly
 *   like the synth path, so the file swap keeps the left/right localization.
 * - Audio files are decoded through an attached AudioContext and played spatially
 *   (HRTF) — audio is managed entirely in event-content.js (`audio.file`).
 * - With NO assets (empty manifest, no audio.file), every call hits the fallback,
 *   so behaviour is byte-for-byte today's synth until you drop in WAVs.
 */

import { EventMap, parseWav } from "@hapbeat/sdk";
import { CONTENT } from "./event-content.js";

const clamp01 = (g) => (g < 0 ? 0 : g > 1 ? 1 : g);
const clampPan = (p) => (p < -1 ? -1 : p > 1 ? 1 : p);

async function fetchJson(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback; // file:// or missing → caller's default (everything synths)
  }
}

export class ContentRouter {
  /** @param {import("./hapbeat-bridge.js").ArcadeBridge} bridge */
  constructor(bridge) {
    this.bridge = bridge;
    this.map = {};               // logical event → eventmap binding
    this.kit = new EventMap();   // SDK EventMap built from the Studio manifest
    this.clipBase = "";          // URL prefix for stream-clips/ WAVs
    this.hapticPcm = new Map();  // kitEvent → {data, sampleRate, channels} (decoded clip)
    this._audioCtx = null;
    this._audioDest = null;
    this.audioBuf = new Map();   // logical event → AudioBuffer (decoded audio file)
    this.ready = false;
  }

  /**
   * Load eventmap.json + the Studio kit manifest. `clipBase` is the URL prefix the
   * haptic clip filenames resolve against (Studio puts stream-mode clips in
   * stream-clips/). Pre-decodes every clip so the first fire has no load latency.
   */
  async load({ eventmapUrl, manifestUrl, clipBase = "" }) {
    this.clipBase = clipBase;
    this.map = await fetchJson(eventmapUrl, {});
    const manifest = await fetchJson(manifestUrl, { events: {}, stream_events: {} });
    this.kit = EventMap.fromManifest(manifest);
    await this._preloadClips();
    this.ready = true;
    return this;
  }

  /** Attach an AudioContext (+ destination node) so audio FILES can play spatially. */
  attachAudio(ctx, destination) {
    this._audioCtx = ctx || null;
    this._audioDest = destination || (ctx ? ctx.destination : null);
  }

  /** Decode the `audio.file` WAVs referenced by event-content for the given events. */
  async loadAudioFiles(audioBase = "") {
    if (!this._audioCtx) return;
    const jobs = [];
    for (const [name, ev] of Object.entries(CONTENT)) {
      const file = ev?.audio?.file;
      if (!file) continue;
      jobs.push(
        fetch(audioBase + file)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`audio ${r.status}`))))
          .then((buf) => this._audioCtx.decodeAudioData(buf.slice(0)))
          .then((ab) => this.audioBuf.set(name, ab))
          .catch(() => {/* missing → synth fallback */}),
      );
    }
    await Promise.all(jobs);
  }

  binding(name) { return this.map[name] || null; }

  /** True when this logical event has a HAPTIC clip available (decoded) → file path. */
  hasHapticClip(name) {
    const b = this.binding(name);
    return !!(b && b.kitEvent && this.hapticPcm.has(b.kitEvent));
  }

  /** True when this logical event has an AUDIO file decoded → file path. */
  hasAudioFile(name) { return this.audioBuf.has(name); }

  /**
   * HAPTIC for a logical event. Plays the manifest clip if present (panned for
   * `directional` events), else calls `fallback()` (the game's existing synth).
   * @param {{pan?:number, gain?:number, target?:string}} opts
   * @returns {boolean} true if a FILE played (so the caller can skip its synth)
   */
  haptic(name, opts = {}, fallback) {
    if (this.hasHapticClip(name)) {
      const b = this.binding(name);
      const def = this.kit.get(b.kitEvent);
      const gain = clamp01((b.gain ?? 1) * (opts.gain ?? 1) * (def?.intensity ?? 1));
      const pan = b.directional ? clampPan(opts.pan ?? 0) : 0;
      const pcm = this._panClip(this.hapticPcm.get(b.kitEvent), pan, gain);
      this.bridge.streamPcm(pcm, { channels: 2, sampleRate: this.hapticPcm.get(b.kitEvent).sampleRate, gain: 1, target: opts.target ?? b.target });
      return true;
    }
    if (fallback) fallback();
    return false;
  }

  /**
   * AUDIO for a logical event. Plays the decoded file (HRTF at worldPos, or stereo
   * pan) if present, else calls `fallback()` (e.g. the FPS's procedural gun burst).
   * @param {{worldPos?:{x,y,z}, pan?:number, gain?:number}} opts
   * @returns {boolean} true if a FILE played
   */
  audio(name, opts = {}, fallback) {
    // file path self-gates on the audio master; the synth fallback self-gates too
    if (this.bridge.master.audio && this.hasAudioFile(name) && this._audioCtx) {
      const ev = CONTENT[name];
      const vol = clamp01((opts.gain ?? 1) * (ev?.audio?.vol ?? 1));
      this._playBuffer(this.audioBuf.get(name), vol, opts.worldPos, opts.pan ?? 0);
      return true;
    }
    if (fallback) fallback();
    return false;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  async _preloadClips() {
    this.hapticPcm.clear();
    const jobs = [];
    for (const id of this.kit.ids()) {
      const def = this.kit.get(id);
      const clip = def?.clip; // EventMap sets `clip` for stream_events (CLIP mode)
      if (!clip) continue;
      jobs.push(
        fetch(this.clipBase + clip)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`clip ${r.status}`))))
          .then((buf) => this.hapticPcm.set(id, parseWav(buf)))
          .catch(() => {/* missing → synth fallback for this event */}),
      );
    }
    await Promise.all(jobs);
  }

  /** Pan a (mono or stereo) PCM16 clip into stereo PCM16 — equal-power, matching synth.js. */
  _panClip(wav, pan, gain) {
    const src = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength);
    const ch = wav.channels || 1;
    const frames = Math.floor(wav.data.length / 2 / ch);
    const theta = ((clampPan(pan) + 1) / 2) * (Math.PI / 2);
    const lAmp = Math.cos(theta) * gain;
    const rAmp = Math.sin(theta) * gain;
    const out = new Uint8Array(frames * 2 * 2); // stereo PCM16
    const dv = new DataView(out.buffer);
    for (let i = 0; i < frames; i++) {
      let s;
      if (ch === 1) {
        s = src.getInt16(i * 2, true) / 32768;
      } else {
        s = (src.getInt16(i * 4, true) + src.getInt16(i * 4 + 2, true)) / 2 / 32768; // downmix
      }
      const l = Math.max(-1, Math.min(1, s * lAmp));
      const r = Math.max(-1, Math.min(1, s * rAmp));
      dv.setInt16(i * 4, (l * 32767) | 0, true);
      dv.setInt16(i * 4 + 2, (r * 32767) | 0, true);
    }
    return out;
  }

  _playBuffer(buffer, vol, worldPos, pan) {
    const ctx = this._audioCtx;
    if (!ctx || vol <= 0.0002) return;
    if (ctx.state === "suspended") ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = vol;
    let node = g;
    if (worldPos && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 2; p.maxDistance = 60; p.rolloffFactor = 1.1;
      if (p.positionX) { p.positionX.value = worldPos.x; p.positionY.value = worldPos.y; p.positionZ.value = worldPos.z; }
      else p.setPosition(worldPos.x, worldPos.y, worldPos.z);
      g.connect(p); node = p;
    } else if (ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = clampPan(pan);
      g.connect(sp); node = sp;
    }
    src.connect(g);
    node.connect(this._audioDest || ctx.destination);
    src.start();
  }
}
