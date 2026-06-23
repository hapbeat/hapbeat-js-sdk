/**
 * LiveStream — a PERSISTENT stream session for continuously-modulated haptics.
 *
 * Unlike ClipStreamer (which sends STREAM_BEGIN…DATA…END per call and cancels
 * the previous stream on every `play()` — the "1 session = 1 stream" rule), a
 * LiveStream sends STREAM_BEGIN ONCE, lets the caller push STREAM_DATA chunks in
 * real time, and sends STREAM_END only on `close()`. Keeping one stream open
 * means a continuous signal (e.g. a directional ~100 Hz tone modulated every
 * frame) feeds the device ring buffer without the per-chunk teardown that
 * otherwise causes underrun/re-buffer gaps ("choppiness").
 *
 * The device ring buffer holds ~256 ms, so the CALLER must keep feeding at
 * roughly real-time rate (a game loop pushing one chunk per frame is ideal).
 * The SDK does not pace — it just forwards each `write()` as STREAM_DATA with a
 * running byte offset.
 */

import type { StreamMeta, StreamSink } from "./clip.js";
import { STREAM_FORMAT_PCM16 } from "./protocol.js";

const MAX_DATA_BYTES = 1024; // per STREAM_DATA payload (well under the 1472 cap)

export interface LiveStreamHandle {
  /** Push a PCM16 chunk (frame-aligned) — sent as STREAM_DATA. No-op once closed. */
  write(pcm: Uint8Array): void;
  /** End the session (STREAM_END). The device ring drains naturally. Idempotent. */
  close(): void;
  /** True once close() has run. */
  readonly closed: boolean;
}

export class LiveStream implements LiveStreamHandle {
  private offset = 0;
  private _closed = false;
  private readonly bytesPerFrame: number;
  private readonly chunkBytes: number;

  constructor(private readonly sink: StreamSink, meta: StreamMeta) {
    const channels = Math.max(1, meta.channels);
    this.bytesPerFrame = channels * 2;
    this.chunkBytes = Math.max(this.bytesPerFrame, MAX_DATA_BYTES - (MAX_DATA_BYTES % this.bytesPerFrame));
    this.sink.streamBegin({
      sampleRate: meta.sampleRate || 16000,
      channels,
      format: meta.format ?? STREAM_FORMAT_PCM16,
      totalSamples: 0, // open-ended
      gain: meta.gain ?? 1.0,
      target: meta.target ?? "",
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  write(pcm: Uint8Array): void {
    if (this._closed || pcm.length === 0) return;
    for (let i = 0; i < pcm.length; i += this.chunkBytes) {
      const end = Math.min(i + this.chunkBytes, pcm.length);
      this.sink.streamData(this.offset, pcm.subarray(i, end));
      this.offset += end - i;
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.sink.streamEnd();
  }
}
