/** Endpoint-scoped multi-source mixing for WifiUdp streaming. */

import * as protocol from "./protocol.js";

export const STREAM_SAMPLE_RATE = 16_000;
export const STREAM_CHANNELS = 2;
const CHUNK_FRAMES = 256;
const MAX_LIVE_BUFFER_FRAMES = 4096;
const DEFAULT_SEND_AHEAD_SEC = 0.15;
const SESSION_END_LINGER_MS = 310;

export type PlaybackStatus = "Deferred" | "Active" | "Stopped";
export type DeferredReason = "NoResolvedEndpoint";

export interface StreamEndpoint {
  ip: string;
  address: string;
  port?: number;
}

export interface EndpointStreamSink {
  streamEndpoints(): StreamEndpoint[];
  streamBeginEndpoint(endpoint: StreamEndpoint): void;
  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array): void;
  streamEndEndpoint(endpoint: StreamEndpoint): void;
}

export interface StreamPlayback {
  readonly id: string;
  readonly status: PlaybackStatus;
  readonly deferredReason?: DeferredReason;
  gain: number;
  pan: number;
  loop: boolean;
  stop(): void;
}

export interface LiveStreamHandle extends StreamPlayback {
  /** False means Deferred or the bounded 256 ms queue is full; input is dropped. */
  write(pcm: Uint8Array): boolean;
  close(): void;
  readonly closed: boolean;
}

export interface StreamPlayOptions {
  sampleRate?: number;
  channels?: number;
  gain?: number;
  pan?: number;
  loop?: boolean;
  target?: string;
  key?: string;
}

type SourceKind = "finite" | "live";

interface Source {
  id: string;
  kind: SourceKind;
  samples: number[];
  target: string;
  gain: number;
  pan: number;
  loop: boolean;
  key?: string;
  playback: PlaybackHandle;
  completedEndpoints: Set<string>;
  baseFrame: number;
  nextFrame: number;
  inputSampleRate: number;
  inputChannels: number;
}

interface EndpointSession {
  endpoint: StreamEndpoint;
  cursors: Map<string, number>;
  offset: number;
  startedAt: number;
  framesSent: number;
  emptySince?: number;
}

class PlaybackHandle implements StreamPlayback {
  private _status: PlaybackStatus = "Deferred";
  private _deferredReason: DeferredReason | undefined = "NoResolvedEndpoint";
  private _gain: number;
  private _pan: number;
  private _loop: boolean;

  constructor(
    protected readonly hub: StreamHub,
    readonly id: string,
    gain: number,
    pan: number,
    loop: boolean,
  ) {
    this._gain = gain;
    this._pan = pan;
    this._loop = loop;
  }

  get status(): PlaybackStatus { return this._status; }
  get deferredReason(): DeferredReason | undefined { return this._deferredReason; }
  get gain(): number { return this._gain; }
  set gain(value: number) {
    this._gain = clamp(value, 0, 1);
    this.hub.setSourceProperty(this.id, "gain", this._gain);
  }
  get pan(): number { return this._pan; }
  set pan(value: number) {
    this._pan = clamp(value, -1, 1);
    this.hub.setSourceProperty(this.id, "pan", this._pan);
  }
  get loop(): boolean { return this._loop; }
  set loop(value: boolean) {
    this._loop = Boolean(value);
    this.hub.setSourceProperty(this.id, "loop", this._loop);
  }
  stop(): void { this.hub.stop(this.id); }

  setState(status: PlaybackStatus, reason?: DeferredReason): void {
    this._status = status;
    this._deferredReason = reason;
  }
}

class LivePlaybackHandle extends PlaybackHandle implements LiveStreamHandle {
  constructor(
    hub: StreamHub,
    id: string,
    gain: number,
    pan: number,
    loop: boolean,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {
    super(hub, id, gain, pan, loop);
  }

  get closed(): boolean { return this.status === "Stopped"; }
  write(pcm: Uint8Array): boolean {
    return this.hub.writeLive(this.id, pcm, this.sampleRate, this.channels);
  }
  close(): void { this.stop(); }
}

export class StreamHub {
  private readonly sources = new Map<string, Source>();
  private readonly sessions = new Map<string, EndpointSession>();
  private readonly lastEndAt = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextId = 0;
  private readonly sendAheadSec: number;

  constructor(private readonly sink: EndpointStreamSink, opts: { sendAheadSec?: number } = {}) {
    this.sendAheadSec = Math.max(0, opts.sendAheadSec ?? DEFAULT_SEND_AHEAD_SEC);
  }

  playPcm(pcm: Uint8Array, opts: StreamPlayOptions = {}): StreamPlayback {
    const sampleRate = opts.sampleRate ?? STREAM_SAMPLE_RATE;
    const channels = opts.channels ?? 1;
    const samples = normalizePcm16(pcm, sampleRate, channels);
    if (samples.length === 0) throw new Error("pcm must contain at least one complete frame");
    const source = this.makeSource("finite", samples, opts, sampleRate, channels);
    this.sources.set(source.id, source);
    this.reconcileNow();
    this.schedule(0);
    return source.playback;
  }

  openLive(opts: StreamPlayOptions = {}): LiveStreamHandle {
    const sampleRate = opts.sampleRate ?? STREAM_SAMPLE_RATE;
    const channels = opts.channels ?? 1;
    if (sampleRate <= 0 || (channels !== 1 && channels !== 2)) {
      throw new Error("live stream requires a positive sampleRate and 1 or 2 channels");
    }
    const source = this.makeSource("live", [], opts, sampleRate, channels, true);
    const live = new LivePlaybackHandle(
      this,
      source.id,
      source.gain,
      source.pan,
      source.loop,
      sampleRate,
      channels,
    );
    source.playback = live;
    this.sources.set(source.id, source);
    this.reconcileNow();
    this.schedule(0);
    return live;
  }

  stop(id: string): void {
    const source = this.sources.get(id);
    if (!source) return;
    this.sources.delete(id);
    source.playback.setState("Stopped");
    const now = Date.now();
    for (const session of this.sessions.values()) {
      session.cursors.delete(id);
      if (session.cursors.size === 0) session.emptySince ??= now;
    }
    this.schedule(0);
  }

  stopKey(key: string, target?: string): number {
    const ids = [...this.sources.values()]
      .filter((source) => source.key === key && (target === undefined || source.target === target))
      .map((source) => source.id);
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  stopTarget(target: string): number {
    const ids = [...this.sources.values()]
      .filter((source) => source.target === target)
      .map((source) => source.id);
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  stopAll(): void {
    for (const id of [...this.sources.keys()]) this.stop(id);
  }

  open(): void { this.closed = false; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const source of this.sources.values()) source.playback.setState("Stopped");
    this.sources.clear();
    for (const session of this.sessions.values()) {
      this.sink.streamEndEndpoint(session.endpoint);
      this.recordEnd(session.endpoint);
    }
    this.sessions.clear();
  }

  reconcile(): void {
    if (this.closed) return;
    this.reconcileNow();
    this.schedule(0);
  }

  setSourceProperty(id: string, property: "gain" | "pan" | "loop", value: number | boolean): void {
    const source = this.sources.get(id);
    if (!source) return;
    (source as unknown as Record<string, number | boolean>)[property] = value;
    if (property === "loop" && value === true) {
      source.completedEndpoints.clear();
      this.reconcileNow();
      this.schedule(0);
    }
  }

  writeLive(id: string, pcm: Uint8Array, sampleRate: number, channels: number): boolean {
    const source = this.sources.get(id);
    if (!source || source.kind !== "live" || source.playback.status !== "Active") return false;
    const normalized = normalizePcm16(pcm, sampleRate, channels);
    if (normalized.length === 0) return false;
    this.trimLive(source);
    const bufferedFrames = source.nextFrame - source.baseFrame;
    const addedFrames = normalized.length / STREAM_CHANNELS;
    if (bufferedFrames + addedFrames > MAX_LIVE_BUFFER_FRAMES) return false;
    source.samples.push(...normalized);
    source.nextFrame += addedFrames;
    this.schedule(0);
    return true;
  }

  private makeSource(
    kind: SourceKind,
    samples: number[],
    opts: StreamPlayOptions,
    sampleRate: number,
    channels: number,
    forceNoLoop = false,
  ): Source {
    if (this.closed) throw new Error("StreamHub is closed");
    const id = `stream-${++this.nextId}`;
    const gain = clamp(opts.gain ?? 1, 0, 1);
    const pan = clamp(opts.pan ?? 0, -1, 1);
    const loop = forceNoLoop ? false : Boolean(opts.loop);
    const playback = new PlaybackHandle(this, id, gain, pan, loop);
    return {
      id, kind, samples, target: opts.target ?? "", gain, pan, loop, key: opts.key,
      playback, completedEndpoints: new Set(), baseFrame: 0,
      nextFrame: samples.length / STREAM_CHANNELS, inputSampleRate: sampleRate,
      inputChannels: channels,
    };
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private tick(): void {
    this.timer = undefined;
    if (this.closed) return;
    this.reconcileNow();
    this.pump();
    if (this.sources.size || this.sessions.size) this.schedule(this.sessions.size ? 5 : 100);
  }

  private reconcileNow(): void {
    const now = Date.now();
    for (const [key, endedAt] of this.lastEndAt) {
      if (now - endedAt > SESSION_END_LINGER_MS * 2) this.lastEndAt.delete(key);
    }
    const endpoints = new Map<string, StreamEndpoint>();
    for (const endpoint of this.sink.streamEndpoints()) {
      if (endpoint.ip && endpoint.address) endpoints.set(endpointKey(endpoint), endpoint);
    }

    const missing = [...this.sessions.entries()].filter(([key]) => !endpoints.has(key));
    const unclaimed = new Map([...endpoints].filter(([key]) => !this.sessions.has(key)));
    for (const [oldKey, session] of missing) {
      const candidates = [...unclaimed.entries()].filter(([, endpoint]) =>
        endpoint.address === session.endpoint.address || endpoint.ip === session.endpoint.ip,
      );
      if (candidates.length !== 1) continue;
      const [newKey, newEndpoint] = candidates[0];
      this.sessions.delete(oldKey);
      session.endpoint = newEndpoint;
      this.sessions.set(newKey, session);
      unclaimed.delete(newKey);
      for (const source of this.sources.values()) {
        if (source.completedEndpoints.delete(oldKey)) source.completedEndpoints.add(newKey);
      }
    }
    for (const [key] of [...this.sessions]) {
      if (endpoints.has(key)) continue;
      this.sessions.delete(key);
      for (const source of this.sources.values()) source.completedEndpoints.delete(key);
    }

    for (const session of this.sessions.values()) {
      for (const sourceId of [...session.cursors.keys()]) {
        const source = this.sources.get(sourceId);
        if (!source || !protocol.addressMatches(source.target, session.endpoint.address)) {
          session.cursors.delete(sourceId);
        }
      }
      if (session.cursors.size === 0) session.emptySince ??= now;
    }

    for (const source of this.sources.values()) {
      for (const [key, endpoint] of endpoints) {
        if (!protocol.addressMatches(source.target, endpoint.address)) continue;
        if (source.completedEndpoints.has(key)) continue;
        let session = this.sessions.get(key);
        if (!session) {
          if (this.restartCooldown(endpoint)) continue;
          session = { endpoint, cursors: new Map(), offset: 0, startedAt: now, framesSent: 0 };
          this.sessions.set(key, session);
          this.sink.streamBeginEndpoint(endpoint);
        }
        if (!session.cursors.has(source.id)) {
          if (session.emptySince !== undefined) {
            session.startedAt = now - session.framesSent / STREAM_SAMPLE_RATE * 1000;
            session.emptySince = undefined;
          }
          session.cursors.set(
            source.id,
            source.kind === "live" ? source.nextFrame : 0,
          );
        }
      }
      const active = [...this.sessions.values()].some((session) => session.cursors.has(source.id));
      source.playback.setState(active ? "Active" : "Deferred", active ? undefined : "NoResolvedEndpoint");
    }
  }

  private pump(): void {
    const now = Date.now();
    for (const [key, session] of [...this.sessions]) {
      const wanted = Math.floor((
        (now - session.startedAt) / 1000 + this.sendAheadSec
      ) * STREAM_SAMPLE_RATE);
      while (session.cursors.size && session.framesSent < wanted) {
        const frames = this.chunkFrames(session);
        if (frames <= 0) break;
        const { data, finished } = this.mix(session, frames);
        this.sink.streamDataEndpoint(session.endpoint, session.offset, data);
        session.offset += data.length;
        session.framesSent += frames;
        for (const sourceId of finished) {
          const source = this.sources.get(sourceId);
          if (source) source.completedEndpoints.add(key);
          session.cursors.delete(sourceId);
          this.completeIfUnreferenced(sourceId);
        }
      }
      if (session.cursors.size === 0) {
        session.emptySince ??= now;
        if (now - session.emptySince >= SESSION_END_LINGER_MS) {
          this.sink.streamEndEndpoint(session.endpoint);
          this.recordEnd(session.endpoint);
          this.sessions.delete(key);
        }
      }
    }
  }

  private chunkFrames(session: EndpointSession): number {
    let maximum = 0;
    for (const [sourceId, cursor] of session.cursors) {
      const source = this.sources.get(sourceId);
      if (!source) continue;
      if (source.kind === "live") maximum = Math.max(maximum, source.nextFrame - cursor);
      else if (source.loop && source.nextFrame) return CHUNK_FRAMES;
      else maximum = Math.max(maximum, source.nextFrame - cursor);
    }
    return Math.min(CHUNK_FRAMES, Math.max(0, maximum));
  }

  private mix(session: EndpointSession, frames: number): { data: Uint8Array; finished: Set<string> } {
    const mixed = new Float64Array(frames * STREAM_CHANNELS);
    const finished = new Set<string>();
    for (const [sourceId, initialCursor] of [...session.cursors]) {
      const source = this.sources.get(sourceId);
      if (!source) { finished.add(sourceId); continue; }
      const [leftGain, rightGain] = channelGains(source.gain, source.pan);
      let cursor = initialCursor;
      for (let frame = 0; frame < frames; frame++) {
        if (cursor >= source.nextFrame) {
          if (source.kind === "finite" && source.loop) cursor = 0;
          else {
            if (source.kind === "finite") finished.add(sourceId);
            break;
          }
        }
        const sampleFrame = source.kind === "live" ? cursor - source.baseFrame : cursor;
        if (sampleFrame < 0 || sampleFrame * 2 + 1 >= source.samples.length) break;
        mixed[frame * 2] += source.samples[sampleFrame * 2] * leftGain;
        mixed[frame * 2 + 1] += source.samples[sampleFrame * 2 + 1] * rightGain;
        cursor++;
      }
      session.cursors.set(sourceId, cursor);
      if (source.kind === "finite" && !source.loop && cursor >= source.nextFrame) finished.add(sourceId);
    }
    const data = new Uint8Array(frames * 4);
    const view = new DataView(data.buffer);
    for (let i = 0; i < mixed.length; i++) view.setInt16(i * 2, saturatePcm16(mixed[i]), true);
    return { data, finished };
  }

  private completeIfUnreferenced(id: string): void {
    if ([...this.sessions.values()].some((session) => session.cursors.has(id))) return;
    const source = this.sources.get(id);
    if (source?.kind === "finite") {
      this.sources.delete(id);
      source.playback.setState("Stopped");
    }
  }

  private trimLive(source: Source): void {
    const cursors = [...this.sessions.values()]
      .map((session) => session.cursors.get(source.id))
      .filter((cursor): cursor is number => cursor !== undefined);
    if (!cursors.length) return;
    const minimum = Math.min(...cursors);
    const removeFrames = Math.max(0, minimum - source.baseFrame);
    if (removeFrames) {
      source.samples.splice(0, removeFrames * STREAM_CHANNELS);
      source.baseFrame += removeFrames;
    }
  }

  private recordEnd(endpoint: StreamEndpoint): void {
    const now = Date.now();
    this.lastEndAt.set(`ip:${endpoint.ip}`, now);
    this.lastEndAt.set(`address:${endpoint.address}`, now);
  }

  private restartCooldown(endpoint: StreamEndpoint): boolean {
    const latest = Math.max(
      this.lastEndAt.get(`ip:${endpoint.ip}`) ?? 0,
      this.lastEndAt.get(`address:${endpoint.address}`) ?? 0,
    );
    return Date.now() - latest < SESSION_END_LINGER_MS;
  }
}

function endpointKey(endpoint: StreamEndpoint): string {
  return `${endpoint.ip}\0${endpoint.address}\0${endpoint.port ?? 7700}`;
}

function normalizePcm16(pcm: Uint8Array, sampleRate: number, channels: number): number[] {
  if (sampleRate <= 0) throw new Error("sampleRate must be positive");
  if (channels !== 1 && channels !== 2) throw new Error("channels must be 1 or 2");
  const bytesPerFrame = channels * 2;
  if (pcm.length % bytesPerFrame) throw new Error("PCM16 data must contain complete frames");
  if (!pcm.length) return [];
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const values = new Array<number>(pcm.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);
  const inputFrames = values.length / channels;
  const outputFrames = Math.max(1, Math.round(inputFrames * STREAM_SAMPLE_RATE / sampleRate));
  const output = new Array<number>(outputFrames * STREAM_CHANNELS);
  for (let out = 0; out < outputFrames; out++) {
    const position = out * sampleRate / STREAM_SAMPLE_RATE;
    const leftIndex = Math.min(inputFrames - 1, Math.floor(position));
    const rightIndex = Math.min(inputFrames - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    for (let channel = 0; channel < STREAM_CHANNELS; channel++) {
      const actualChannel = channels === 1 ? 0 : channel;
      const a = values[leftIndex * channels + actualChannel];
      const b = values[rightIndex * channels + actualChannel];
      output[out * 2 + channel] = Math.round(a * (1 - fraction) + b * fraction);
    }
  }
  return output;
}

function channelGains(gain: number, pan: number): [number, number] {
  return [gain * (pan <= 0 ? 1 : 1 - pan), gain * (pan >= 0 ? 1 : 1 + pan)];
}

function saturatePcm16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
