/**
 * High-level Hapbeat facade — the level-1 "fire" surface.
 *
 * Transport-agnostic: it resolves per-event default gain from the optional
 * EventMap, clamps it, and hands semantic commands to a Transport. The same
 * facade works over UDP (Node) and over the helper WebSocket (browser).
 *
 * Two playback modes, branched purely by the EventMap (= the kit manifest):
 *  - **fire**  (manifest `events`)        → PLAY command; device plays its
 *    installed clip. `play(id)` stays a one-liner.
 *  - **clip**  (manifest `stream_events`) → the SDK loads the event's WAV
 *    (from `clipBase`) and UDP-streams it. Same `play(id)` call — the manifest
 *    decides which path runs.
 */

import type { EventDef, EventMap } from "./eventmap.js";
import {
  StreamHub,
  type LiveStreamHandle,
  type StreamPlayback,
} from "./stream.js";
import { parseWav, type WavPcm } from "./wav.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

const clamp01 = (g: number): number => (g < 0 ? 0 : g > 1 ? 1 : g);
const clampPan = (pan: number): number => (pan < -1 ? -1 : pan > 1 ? 1 : pan);
let nextPendingPlaybackId = 0;

class PendingStreamPlayback implements StreamPlayback {
  readonly id = `pending-stream-${++nextPendingPlaybackId}`;
  private inner?: StreamPlayback;
  private stopped = false;
  private _gain: number;
  private _pan: number;
  private _loop: boolean;

  constructor(gain: number, pan: number, loop: boolean, private readonly onStop: () => void) {
    this._gain = clamp01(gain);
    this._pan = clampPan(pan);
    this._loop = loop;
  }

  get status() { return this.stopped ? "Stopped" as const : this.inner?.status ?? "Deferred"; }
  get deferredReason() { return this.inner?.deferredReason; }
  get gain() { return this.inner?.gain ?? this._gain; }
  set gain(value: number) {
    this._gain = clamp01(value);
    if (this.inner) this.inner.gain = this._gain;
  }
  get pan() { return this.inner?.pan ?? this._pan; }
  set pan(value: number) {
    this._pan = clampPan(value);
    if (this.inner) this.inner.pan = this._pan;
  }
  get loop() { return this.inner?.loop ?? this._loop; }
  set loop(value: boolean) {
    this._loop = Boolean(value);
    if (this.inner) this.inner.loop = this._loop;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onStop();
    this.inner?.stop();
  }

  bind(playback: StreamPlayback): void {
    if (this.stopped) {
      playback.stop();
      return;
    }
    playback.gain = this._gain;
    playback.pan = this._pan;
    playback.loop = this._loop;
    this.inner = playback;
  }
}

interface PendingClipPlay {
  eventId: string;
  target: string;
  cancelled: boolean;
  playback: PendingStreamPlayback;
}

/** Options for {@link Hapbeat.playClipUrl} / {@link Hapbeat.playClipFile}. The WAV carries its own format. */
export interface ClipPlayOpts {
  /** 0..1, default 1. */
  gain?: number;
  /** Left/right balance: -1 = left only, 0 = centre (default), +1 = right only. */
  pan?: number;
  /** Repeat until stopped. Default false. */
  loop?: boolean;
  /** Device-addressing target; default = the Hapbeat's `defaultTarget`. */
  target?: string;
}

type ClipFileReader = (path: string | URL) => Promise<ArrayBuffer | Uint8Array>;
let clipFileReader: ClipFileReader | undefined;

/**
 * @internal Registered by the Node entry point, so `playClipFile()` can read
 * from disk without this module importing `node:fs` (which would leak into
 * browser / React Native bundles). Not part of the public API.
 */
export function setClipFileReader(reader: ClipFileReader): void {
  clipFileReader = reader;
}

export interface PlayOpts {
  gain?: number;
  target?: string;
  targetTimeUs?: number;
  /**
   * Left/right balance: -1 = left only, 0 = centre (default), +1 = right only.
   * Fire events apply it on-device; clip events apply it in the endpoint mixer.
   */
  pan?: number;
}

export class Hapbeat {
  private readonly transport: Transport;
  private readonly eventMap?: EventMap;
  private readonly defaultTarget: string;

  private readonly streamHub: StreamHub;
  private readonly clipBase: string;
  private readonly clipLoader?: (ref: string) => Promise<ArrayBuffer | Uint8Array>;
  private readonly clipCache = new Map<string, WavPcm>();
  private readonly pendingClipPlays = new Set<PendingClipPlay>();

  constructor(transport: Transport, options: HapbeatOptions = {}) {
    this.transport = transport;
    this.eventMap = options.eventMap;
    this.defaultTarget = options.defaultTarget ?? "";
    this.clipBase = options.clipBase ?? "";
    this.clipLoader = options.clipLoader;
    this.streamHub = new StreamHub(transport, { sendAheadSec: options.streamSendAheadSec });
  }

  /** Open the transport (UDP socket / WebSocket). */
  async connect(): Promise<this> {
    await this.transport.connect();
    this.streamHub.open();
    return this;
  }

  /**
   * Play a haptic event by id. The EventMap decides the mode:
   *  - fire event → PLAY command (device plays its installed clip)
   *  - clip event → the SDK streams the event's WAV over UDP
   * `gain` overrides the per-event default; otherwise the manifest intensity is used.
   */
  play(eventId: string, opts: PlayOpts = {}): void {
    const def = this.eventMap?.get(eventId);
    const gain = clamp01(opts.gain ?? def?.intensity ?? 1.0);
    const target = opts.target ?? this.defaultTarget;
    if (def?.streaming) {
      void this.playStream(eventId, opts);
    } else {
      this.transport.play(eventId, gain, target, opts.targetTimeUs ?? 0, opts.pan ?? 0);
    }
  }

  /**
   * Stream an ad-hoc PCM16 buffer (not from a manifest) — e.g. a synthesized
   * stereo directional cue where L/R balance conveys direction. `channels: 2`
   * with per-channel amplitude is how you get left/right haptics here; for fire
   * events use `play(id, { pan })` instead. Paced like any clip.
   */
  streamPcm(
    pcm: Uint8Array,
    opts: {
      sampleRate?: number;
      channels?: number;
      gain?: number;
      pan?: number;
      loop?: boolean;
      target?: string;
    } = {},
  ): StreamPlayback {
    return this.streamHub.playPcm(pcm, {
      sampleRate: opts.sampleRate ?? 16000,
      channels: opts.channels ?? 1,
      gain: clamp01(opts.gain ?? 1.0),
      pan: opts.pan ?? 0,
      loop: opts.loop ?? false,
      target: opts.target ?? this.defaultTarget,
    });
  }

  /**
   * Stream a PCM16 WAV from a URL, in one line: fetch → parseWav → streamPcm.
   * No kit or manifest needed. Works in the browser, React Native and Node 18+
   * (global `fetch`; http(s) URLs — for a file on disk in Node use
   * {@link playClipFile}). Each call fetches the URL again (the browser's HTTP
   * cache applies). Rejects if the fetch fails or the file is not
   * uncompressed 16-bit PCM WAV.
   *
   * ```js
   * await hb.playClipUrl("./hit_80hz.wav", { gain: 0.6 });
   * ```
   */
  async playClipUrl(url: string | URL, opts: ClipPlayOpts = {}): Promise<StreamPlayback> {
    if (typeof fetch !== "function") {
      throw new Error("[hapbeat] playClipUrl() needs a global fetch (Node 18+, browser, React Native)");
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[hapbeat] clip fetch ${res.status}: ${String(url)}`);
    return this.streamWav(parseWav(await res.arrayBuffer()), opts);
  }

  /**
   * Stream a PCM16 WAV file from disk, in one line (Node only; same as the
   * Python SDK's `play_clip_file`). `path` is a file path or a `file:` URL,
   * e.g. `new URL("./hit.wav", import.meta.url)`. Each call reads the file
   * again. Rejects if the file cannot be read or is not 16-bit PCM WAV; in
   * the browser / React Native use {@link playClipUrl} instead.
   *
   * ```js
   * await hb.playClipFile("hit_80hz.wav", { gain: 0.6 });
   * ```
   */
  async playClipFile(path: string | URL, opts: ClipPlayOpts = {}): Promise<StreamPlayback> {
    if (!clipFileReader) {
      throw new Error("[hapbeat] playClipFile() reads from disk and is Node-only; use playClipUrl() here");
    }
    return this.streamWav(parseWav(await clipFileReader(path)), opts);
  }

  private streamWav(wav: WavPcm, opts: ClipPlayOpts): StreamPlayback {
    return this.streamPcm(wav.data, {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      gain: opts.gain,
      pan: opts.pan,
      loop: opts.loop,
      target: opts.target,
    });
  }

  /**
   * Open a live logical source. Sources aimed at one device endpoint are mixed
   * into its one wire session; sources aimed at other endpoints remain isolated.
   * The caller must feed chunks at roughly real-time rate. While no endpoint is
   * resolved, or when the bounded queue is full, write() returns false and drops
   * that input rather than accumulating unbounded latency.
   */
  openStream(opts: {
    sampleRate?: number;
    channels?: number;
    gain?: number;
    pan?: number;
    target?: string;
  } = {}): LiveStreamHandle {
    return this.streamHub.openLive({
      sampleRate: opts.sampleRate ?? 16000,
      channels: opts.channels ?? 1,
      gain: clamp01(opts.gain ?? 1.0),
      pan: opts.pan ?? 0,
      target: opts.target ?? this.defaultTarget,
    });
  }

  /**
   * Play one manifest clip source and resolve its independently controllable
   * Playback. Unlike fire-mode play(), this waits for the first WAV load.
   */
  playStream(eventId: string, opts: PlayOpts = {}): StreamPlayback | null {
    const def = this.eventMap?.get(eventId);
    if (!def?.streaming) {
      console.warn(`[hapbeat] "${eventId}" is not a stream event`);
      return null;
    }
    const gain = clamp01(opts.gain ?? def.intensity ?? 1.0);
    const target = opts.target ?? this.defaultTarget;
    const pan = opts.pan ?? 0;
    const cached = this.clipCache.get(eventId);
    if (cached) {
      return this.streamHub.playPcm(cached.data, {
        sampleRate: cached.sampleRate,
        channels: cached.channels,
        gain,
        pan,
        loop: def.loop,
        target,
        key: eventId,
      });
    }
    // First play: load + decode asynchronously, then stream (cache for next time).
    let pending: PendingClipPlay;
    const playback = new PendingStreamPlayback(gain, pan, def.loop, () => {
      pending.cancelled = true;
    });
    pending = { eventId, target, cancelled: false, playback };
    this.pendingClipPlays.add(pending);
    void this.loadClip(eventId, def).then((pcm) => {
      this.pendingClipPlays.delete(pending);
      if (!pcm || pending.cancelled) return;
      pending.playback.bind(this.streamHub.playPcm(pcm.data, {
        sampleRate: pcm.sampleRate,
        channels: pcm.channels,
        gain: pending.playback.gain,
        pan: pending.playback.pan,
        loop: pending.playback.loop,
        target,
        key: eventId,
      }));
    });
    return pending.playback;
  }

  private async loadClip(eventId: string, def: EventDef): Promise<WavPcm | null> {
    const cached = this.clipCache.get(eventId);
    if (cached) return cached;
    if (!def.clip) {
      console.warn(`[hapbeat] clip event "${eventId}" has no clip filename`);
      return null;
    }
    if (!this.clipLoader) {
      console.warn(`[hapbeat] no clipLoader configured — cannot stream "${eventId}"`);
      return null;
    }
    try {
      const buf = await this.clipLoader(this.clipBase + def.clip);
      const pcm = parseWav(buf);
      this.clipCache.set(eventId, pcm);
      return pcm;
    } catch (e) {
      console.warn(`[hapbeat] failed to load clip "${def.clip}": ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Warm the clip cache (decode every clip-mode event's WAV up front) so the
   * first `play()` of each has no load latency. Resolves when all are attempted.
   */
  async preloadClips(): Promise<void> {
    if (!this.eventMap) return;
    const jobs: Promise<unknown>[] = [];
    for (const id of this.eventMap.ids()) {
      const def = this.eventMap.get(id);
      if (def?.streaming) jobs.push(this.loadClip(id, def));
    }
    await Promise.all(jobs);
  }

  stop(eventId: string, target?: string): void {
    const def = this.eventMap?.get(eventId);
    if (def?.streaming) {
      for (const pending of this.pendingClipPlays) {
        if (pending.eventId === eventId && (target === undefined || pending.target === target)) {
          pending.playback.stop();
        }
      }
      this.streamHub.stopKey(eventId, target);
    } else {
      this.transport.stop(eventId, target ?? this.defaultTarget);
    }
  }

  stopAll(target?: string): void {
    for (const pending of this.pendingClipPlays) {
      if (target === undefined || pending.target === target) pending.playback.stop();
    }
    if (target === undefined) this.streamHub.stopAll();
    else this.streamHub.stopTarget(target);
    this.transport.stopAll(target ?? this.defaultTarget);
  }

  ping(): void {
    this.transport.ping();
  }

  /**
   * Retake stream ownership after a device reported this client's lease as
   * superseded by another writer (contracts stream-session-v2.md): a new
   * client incarnation and a fresh PING, so every v2 device issues a new lease
   * on its matched reply and deferred streams resume. Call it once the other
   * writer has stopped. Returns false (with a warning) on a transport that
   * holds no device lease itself (browser: hapbeat-helper owns the leases).
   */
  reacquireStreamOwnership(): boolean {
    if (!this.transport.reacquireStreamOwnership) {
      console.warn(
        "[hapbeat] reacquireStreamOwnership() has no effect on this transport: " +
        "hapbeat-helper owns the device stream leases.",
      );
      return false;
    }
    this.transport.reacquireStreamOwnership();
    this.streamHub.reconcile();
    return true;
  }

  /** Broadcast a probe and collect devices that reply within `timeoutMs`. */
  discover(timeoutMs = 1500): Promise<Device[]> {
    return this.transport.discover(timeoutMs);
  }

  async close(): Promise<void> {
    for (const pending of this.pendingClipPlays) pending.playback.stop();
    this.streamHub.close();
    await this.transport.close();
  }
}
