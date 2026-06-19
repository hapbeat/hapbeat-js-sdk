/**
 * ClipStreamer — paces a decoded PCM16 clip out as STREAM_BEGIN / STREAM_DATA*
 * / STREAM_END through a transport's streaming primitives.
 *
 * The device ring buffer holds only ~256 ms (RING_FRAMES=4096 @16kHz), so a
 * whole clip cannot be burst at once — data is sent in frame-aligned chunks,
 * each scheduled ~`sendAheadSec` before its playback time so the device buffer
 * never overflows. STREAM_END is deferred until the clip has fully drained
 * (robust whether the firmware drains or flushes on END).
 *
 * A stream is session-level (one at a time): starting a new clip cancels the
 * previous one, matching the "1 session = 1 stream" rule in the protocol.
 */

import { STREAM_FORMAT_PCM16 } from "./protocol.js";

export interface StreamMeta {
  sampleRate: number;
  channels: number;
  format?: number; // 0=PCM16
  totalSamples?: number;
  gain?: number;
  target?: string;
}

/** The subset of Transport a ClipStreamer needs. */
export interface StreamSink {
  streamBegin(meta: StreamMeta): void;
  streamData(offset: number, data: Uint8Array): void;
  streamEnd(): void;
}

export interface ClipPlayOpts {
  sampleRate: number;
  channels: number;
  gain?: number;
  target?: string;
}

export interface ClipHandle {
  stop(): void;
}

const DEFAULT_SEND_AHEAD = 0.15; // s (< 0.256 s device ring)
const MAX_DATA_BYTES = 1024; // per STREAM_DATA payload (well under the 1472 cap)

export class ClipStreamer {
  private readonly sink: StreamSink;
  private readonly sendAheadSec: number;
  private active: { timers: Set<ReturnType<typeof setTimeout>>; ended: boolean } | null = null;

  constructor(sink: StreamSink, opts: { sendAheadSec?: number } = {}) {
    this.sink = sink;
    this.sendAheadSec = opts.sendAheadSec ?? DEFAULT_SEND_AHEAD;
  }

  /** Stream a PCM16 byte buffer, real-time paced. Cancels any active clip. */
  play(pcm: Uint8Array, opts: ClipPlayOpts): ClipHandle {
    this.stop();
    const channels = Math.max(1, opts.channels);
    const sampleRate = opts.sampleRate || 16000;
    const bytesPerFrame = channels * 2;
    const chunkBytes = Math.max(bytesPerFrame, MAX_DATA_BYTES - (MAX_DATA_BYTES % bytesPerFrame));
    const totalFrames = Math.floor(pcm.length / bytesPerFrame);

    const session = { timers: new Set<ReturnType<typeof setTimeout>>(), ended: false };
    this.active = session;

    this.sink.streamBegin({
      sampleRate,
      channels,
      format: STREAM_FORMAT_PCM16,
      totalSamples: totalFrames,
      gain: opts.gain ?? 1.0,
      target: opts.target ?? "",
    });

    const t0 = Date.now();
    let offset = 0;

    const pump = (): void => {
      if (session.ended) return;
      while (offset < pcm.length) {
        // playback time at which the audio BEFORE this chunk finishes
        const playedSec = offset / bytesPerFrame / sampleRate;
        const sendAtMs = t0 + (playedSec - this.sendAheadSec) * 1000;
        const wait = sendAtMs - Date.now();
        if (wait > 1) {
          const id = setTimeout(pump, wait);
          session.timers.add(id);
          return;
        }
        const end = Math.min(offset + chunkBytes, pcm.length);
        this.sink.streamData(offset, pcm.subarray(offset, end));
        offset = end;
      }
      // all data queued — END after the clip has fully played out
      const totalSec = totalFrames / sampleRate;
      const endWait = Math.max(0, t0 + totalSec * 1000 + 80 - Date.now());
      const id = setTimeout(() => {
        if (!session.ended) {
          session.ended = true;
          this.sink.streamEnd();
        }
      }, endWait);
      session.timers.add(id);
    };

    pump();

    return {
      stop: () => this.stopSession(session),
    };
  }

  private stopSession(session: { timers: Set<ReturnType<typeof setTimeout>>; ended: boolean }): void {
    for (const id of session.timers) clearTimeout(id);
    session.timers.clear();
    if (!session.ended) {
      session.ended = true;
      this.sink.streamEnd();
    }
    if (this.active === session) this.active = null;
  }

  /** Cancel the active clip (if any) and tell the device to stop. */
  stop(): void {
    if (this.active) this.stopSession(this.active);
  }
}
