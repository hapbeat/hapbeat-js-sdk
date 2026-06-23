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

import { ClipStreamer } from "./clip.js";
import { LiveStream, type LiveStreamHandle } from "./live-stream.js";
import type { EventDef, EventMap } from "./eventmap.js";
import { parseWav, type WavPcm } from "./wav.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

const clamp01 = (g: number): number => (g < 0 ? 0 : g > 1 ? 1 : g);

export interface PlayOpts {
  gain?: number;
  target?: string;
  targetTimeUs?: number;
}

export class Hapbeat {
  private readonly transport: Transport;
  private readonly eventMap?: EventMap;
  private readonly defaultTarget: string;

  private readonly clipStreamer: ClipStreamer;
  private liveStream: LiveStream | null = null;
  private readonly clipBase: string;
  private readonly clipLoader?: (ref: string) => Promise<ArrayBuffer | Uint8Array>;
  private readonly clipCache = new Map<string, WavPcm>();

  constructor(transport: Transport, options: HapbeatOptions = {}) {
    this.transport = transport;
    this.eventMap = options.eventMap;
    this.defaultTarget = options.defaultTarget ?? "";
    this.clipBase = options.clipBase ?? "";
    this.clipLoader = options.clipLoader;
    this.clipStreamer = new ClipStreamer(transport, { sendAheadSec: options.streamSendAheadSec });
  }

  /** Open the transport (UDP socket / WebSocket). */
  async connect(): Promise<this> {
    await this.transport.connect();
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
      this.playClip(eventId, def, gain, target);
    } else {
      this.transport.play(eventId, gain, target, opts.targetTimeUs ?? 0);
    }
  }

  /**
   * Stream an ad-hoc PCM16 buffer (not from a manifest) — e.g. a synthesized
   * stereo directional cue where L/R balance conveys direction. `channels: 2`
   * with per-channel amplitude is how you get left/right haptics (the PLAY
   * command has no pan). Paced like any clip.
   */
  streamPcm(
    pcm: Uint8Array,
    opts: { sampleRate?: number; channels?: number; gain?: number; target?: string } = {},
  ): void {
    this.endLiveStream(); // a one-shot clip replaces any persistent stream (1 session = 1 stream)
    this.clipStreamer.play(pcm, {
      sampleRate: opts.sampleRate ?? 16000,
      channels: opts.channels ?? 1,
      gain: clamp01(opts.gain ?? 1.0),
      target: opts.target ?? this.defaultTarget,
    });
  }

  /**
   * Open a PERSISTENT stream session for continuously-modulated haptics. Send
   * STREAM_BEGIN once, then push chunks via `handle.write(pcm)` in real time, and
   * `handle.close()` when done. Unlike repeated `streamPcm()` (which tears the
   * stream down and back up each call → per-chunk gaps), this keeps ONE stream
   * open so a continuous directional tone has no underrun/re-buffer choppiness.
   *
   * Only one active stream exists at a time (1 session = 1 stream): opening a new
   * one — or any `streamPcm()` / clip `play()` — ends the previous live stream.
   * The caller must feed chunks at ~real-time rate (the device ring is ~256 ms).
   */
  openStream(opts: { sampleRate?: number; channels?: number; gain?: number; target?: string } = {}): LiveStreamHandle {
    this.clipStreamer.stop();
    this.endLiveStream();
    this.liveStream = new LiveStream(this.transport, {
      sampleRate: opts.sampleRate ?? 16000,
      channels: opts.channels ?? 1,
      gain: clamp01(opts.gain ?? 1.0),
      target: opts.target ?? this.defaultTarget,
    });
    return this.liveStream;
  }

  private endLiveStream(): void {
    if (this.liveStream && !this.liveStream.closed) this.liveStream.close();
    this.liveStream = null;
  }

  private playClip(eventId: string, def: EventDef, gain: number, target: string): void {
    this.endLiveStream(); // a clip replaces any persistent stream (1 session = 1 stream)
    const cached = this.clipCache.get(eventId);
    if (cached) {
      this.clipStreamer.play(cached.data, {
        sampleRate: cached.sampleRate,
        channels: cached.channels,
        gain,
        target,
      });
      return;
    }
    // First play: load + decode asynchronously, then stream (cache for next time).
    void this.loadClip(eventId, def).then((pcm) => {
      if (pcm) {
        this.clipStreamer.play(pcm.data, {
          sampleRate: pcm.sampleRate,
          channels: pcm.channels,
          gain,
          target,
        });
      }
    });
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
      if (pcm.sampleRate !== 16000) {
        console.warn(
          `[hapbeat] clip "${def.clip}" is ${pcm.sampleRate}Hz; device expects 16000Hz (pitch will be off)`,
        );
      }
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
      this.clipStreamer.stop(); // a stream is session-level — stop the active one
    } else {
      this.transport.stop(eventId, target ?? this.defaultTarget);
    }
  }

  stopAll(target?: string): void {
    this.endLiveStream();
    this.clipStreamer.stop();
    this.transport.stopAll(target ?? this.defaultTarget);
  }

  ping(): void {
    this.transport.ping();
  }

  /** Broadcast a probe and collect devices that reply within `timeoutMs`. */
  discover(timeoutMs = 1500): Promise<Device[]> {
    return this.transport.discover(timeoutMs);
  }

  async close(): Promise<void> {
    this.endLiveStream();
    this.clipStreamer.stop();
    await this.transport.close();
  }
}
