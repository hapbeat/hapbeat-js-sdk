/** Endpoint-scoped multi-source mixing for WifiUdp streaming. */

import * as protocol from "./protocol.js";

export const STREAM_SAMPLE_RATE = 16_000;
export const STREAM_CHANNELS = 2;
const CHUNK_FRAMES = 256;
const MAX_LIVE_BUFFER_FRAMES = 4096;
const DEFAULT_SEND_AHEAD_SEC = 0.15;
// Keep an empty endpoint session alive for one AP beacon interval, so a new
// source can join without END -> BEGIN. Linger is not the Gen 1 guard below.
const SESSION_END_LINGER_MS = 310;
// Stream Gen 1 firmware cannot reject a stale END, so after an END there the
// next BEGIN there waits this long (contracts stream-session.md "Legacy
// receiver fallback"). Stream Gen 2 receivers order sessions themselves.
const LEGACY_END_TO_BEGIN_MS = 300;
// Sender requirement 3 (stream-session.md): after 3 s without DATA (process
// suspended, debugger, sleep) a Stream Gen 2 session is ended and a new
// generation begun, instead of resuming one the receiver may have timed out.
const OWN_GAP_MS = 3000;
// Re-splice (sdk-multi-stream.md §6.14): a source added inside blocks already
// sent restarts the session only when the device holds at least this much
// audio after its start (the receiver's 32 ms BEGIN flush threshold plus
// packets in flight); a shorter queue is left alone.
const RESPLICE_MIN_QUEUED_MS = 40;
// hapbeat-helper deferred a destination (unknown class, no lease, superseded):
// try that endpoint again after this long with a new stream_id.
const HELPER_DEFER_BACKOFF_MS = 2000;
// Mix bus (contracts sdk-multi-stream.md §5.8): a sum whose peak is within
// LIMIT_THRESHOLD (the PCM16 range including -32768, so one full-scale clip
// alone never triggers it) passes unchanged; one past it is scaled down to LIMIT_TARGET (attack within the
// block, release by LIMIT_RELEASE_PER_CHUNK per block, ramped per sample) and a
// soft knee above LIMIT_KNEE replaces the hard clamp for what is left over.
const FULL_SCALE = 32767;
const LIMIT_THRESHOLD = 32768;
const LIMIT_TARGET = 0.9 * FULL_SCALE;
const LIMIT_KNEE = 0.95 * FULL_SCALE;
const LIMIT_RELEASE_PER_CHUNK = 0.05;

export type PlaybackStatus = "Deferred" | "Active" | "Stopped";
/**
 * Why a Playback is Deferred (sdk-multi-stream.md §3): no endpoint matches its
 * target; the device has not answered this SDK's lease request yet; it has no
 * usable stream lease; another application started a newer session on it.
 */
export type DeferredReason = "NoResolvedEndpoint" | "UnknownClass" | "LeaseUnavailable" | "Superseded";
/** Stream receiver class of an endpoint (contracts stream-session.md "Receiver classification"). */
export type StreamClass = "gen1" | "gen2" | "unknown";
/** Lease of a Stream Gen 2 endpoint; "none" for other classes. */
export type StreamLeaseState = "valid" | "unavailable" | "superseded" | "none";

// Reported when matching endpoints disagree: the reason the user can act on
// most comes first (§3).
const DEFERRED_PRIORITY: readonly DeferredReason[] = ["Superseded", "LeaseUnavailable", "UnknownClass", "NoResolvedEndpoint"];

export interface StreamEndpoint {
  ip: string;
  address: string;
  port?: number;
  /**
   * Stream Gen 1 receiver: after an END there, the next BEGIN there waits
   * 300 ms. Absent or false means no StreamHub-side guard: a Stream Gen 2
   * receiver orders sessions itself, and behind hapbeat-helper the helper
   * applies the guard per device.
   */
  legacy?: boolean;
  /**
   * The wire identity a session on this endpoint begins under (stream class
   * and, for Stream Gen 2, device boot + lease + restart count). When it
   * changes the running session is ended in the format it began with before
   * the next BEGIN.
   */
  wireEpoch?: string;
  /**
   * Stream class and device boot. A new session whose lineage equals the one
   * just replaced (only the ticket or restart count changed) continues each
   * finite source from its cursor (stream-session.md Sender requirement 8).
   */
  wireLineage?: string;
  /** Undefined behind hapbeat-helper, which owns the wire format per device. */
  streamClass?: StreamClass;
  leaseState?: StreamLeaseState;
  /** Why a session cannot begin here now (set while wireEpoch defers). */
  deferredReason?: DeferredReason;
  /** CAPS haptic_channels: 1 = one motor, so pan is not applied (§6.15). */
  hapticChannels?: number;
}

/** Per-endpoint stream state, as exposed to applications (sdk-multi-stream.md §3). */
export interface StreamEndpointInfo {
  ip: string;
  /** The full device address the device reported. */
  address: string;
  /** Undefined behind hapbeat-helper (the helper owns the class). */
  streamClass?: StreamClass;
  /** Undefined behind hapbeat-helper; "none" unless the class is gen2. */
  leaseState?: StreamLeaseState;
}

/** Device-side outcome of a session the sink began. */
export interface StreamSessionEvent {
  endpoint: StreamEndpoint;
  /** The wire state streamBeginEndpoint returned for that session. */
  wire: unknown;
  /**
   * "stopped": STOP_ALL ended it, or another client displaced it; the same
   * Playback does not rejoin that endpoint. "lost": the far side ended it; a
   * new session begins on the next reconcile (finite sources continue).
   * Either way the far side already ended the session: no END is sent.
   */
  kind: "stopped" | "lost";
  reason?: string;
}

/** A Playback lost one endpoint for good (STOP_ALL, or another client took it). */
export interface StreamLostEvent {
  playbackId: string;
  ip: string;
  reason: string;
}

export interface EndpointStreamSink {
  streamEndpoints(): StreamEndpoint[];
  /**
   * Begin one endpoint session. Returns the sink's wire state for it, handed
   * back on every DATA / END of that session, or `false` when the session
   * cannot begin now (its sources stay deferred).
   */
  streamBeginEndpoint(endpoint: StreamEndpoint): unknown;
  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array, wire?: unknown): void;
  streamEndEndpoint(endpoint: StreamEndpoint, wire?: unknown): void;
  /** Targets the hub may stream to now (sources Deferred or Active). */
  setStreamInterest?(provider: () => readonly string[]): void;
  /** Endpoints that defer for lack of a class or lease: ask for one now. */
  requestLeases?(endpoints: readonly StreamEndpoint[]): void;
  /** Device-side outcome of a session the sink began. */
  setSessionListener?(listener: (event: StreamSessionEvent) => void): void;
}

export interface StreamPlayback {
  readonly id: string;
  readonly status: PlaybackStatus;
  readonly deferredReason?: DeferredReason;
  /** The last reason an endpoint was lost for good (see HapbeatOptions.onStreamLost). */
  readonly lostReason?: string;
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
  /** @internal The Playback id to use (Hapbeat binds a pending clip play under its own id). */
  id?: string;
}

export interface StreamHubOptions {
  sendAheadSec?: number;
  onStreamLost?: (event: StreamLostEvent) => void;
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
  /** Matching Gen 1 endpoints whose session waits out the END -> BEGIN guard. */
  guardedEndpoints: Set<string>;
  /** Endpoints this Playback lost for good (STREAM_STOPPED, displaced, §6.13). */
  stoppedEndpoints: Set<string>;
  /** A finite source that has played to its end on at least one endpoint. */
  played: boolean;
  baseFrame: number;
  nextFrame: number;
  inputSampleRate: number;
  inputChannels: number;
}

interface EndpointSession {
  endpoint: StreamEndpoint;
  /** Sink wire state returned by streamBeginEndpoint. */
  wire: unknown;
  cursors: Map<string, number>;
  /** framesSent when each source joined (re-splice needs to know who started inside the queue). */
  joined: Map<string, number>;
  /** Channel gains each source ended the previous mix block at. */
  gains: Map<string, [number, number]>;
  /** Limiter gain at the end of the previous mix block. */
  limit: number;
  offset: number;
  startedAt: number;
  framesSent: number;
  /** Wall clock of the last DATA (or of the BEGIN, before any DATA). */
  lastDataAt: number;
  emptySince?: number;
}

/** What a replaced session leaves for the next one on the same endpoint. */
interface ParkedSession {
  lineage?: string;
  cursors: Map<string, number>;
  gains: Map<string, [number, number]>;
  limit: number;
}

class PlaybackHandle implements StreamPlayback {
  private _status: PlaybackStatus = "Deferred";
  private _deferredReason: DeferredReason | undefined = "NoResolvedEndpoint";
  private _lostReason: string | undefined;
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
  get lostReason(): string | undefined { return this._lostReason; }
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

  setLost(reason: string): void { this._lostReason = reason; }
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
  /** Cursors of sessions replaced under a new identity, per endpoint key (§8). */
  private readonly parked = new Map<string, ParkedSession>();
  /** Endpoints hapbeat-helper deferred: no new session there until `until`. */
  private readonly backoff = new Map<string, { until: number; reason: DeferredReason }>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextId = 0;
  private readonly sendAheadSec: number;
  private readonly onStreamLost?: (event: StreamLostEvent) => void;

  constructor(private readonly sink: EndpointStreamSink, opts: StreamHubOptions = {}) {
    this.sendAheadSec = Math.max(0, opts.sendAheadSec ?? DEFAULT_SEND_AHEAD_SEC);
    this.onStreamLost = opts.onStreamLost;
    sink.setStreamInterest?.(() => [...this.sources.values()].map((source) => source.target));
    sink.setSessionListener?.((event) => this.onSessionEvent(event));
  }

  playPcm(pcm: Uint8Array, opts: StreamPlayOptions = {}): StreamPlayback {
    const sampleRate = opts.sampleRate ?? STREAM_SAMPLE_RATE;
    const channels = opts.channels ?? 1;
    const samples = normalizePcm16(pcm, sampleRate, channels);
    if (samples.length === 0) throw new Error("pcm must contain at least one complete frame");
    const source = this.makeSource("finite", samples, opts, sampleRate, channels);
    this.sources.set(source.id, source);
    this.reconcileNow();
    this.resplice(source);
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
    for (const parked of this.parked.values()) parked.cursors.delete(id);
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
    for (const [key, session] of [...this.sessions]) this.endSession(key, session);
    this.parked.clear();
    this.backoff.clear();
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
    const id = opts.id ?? `stream-${++this.nextId}`;
    const gain = clamp(opts.gain ?? 1, 0, 1);
    const pan = clamp(opts.pan ?? 0, -1, 1);
    const loop = forceNoLoop ? false : Boolean(opts.loop);
    const playback = new PlaybackHandle(this, id, gain, pan, loop);
    return {
      id, kind, samples, target: opts.target ?? "", gain, pan, loop, key: opts.key,
      playback, completedEndpoints: new Set(), guardedEndpoints: new Set(), stoppedEndpoints: new Set(),
      played: false, baseFrame: 0, nextFrame: samples.length / STREAM_CHANNELS, inputSampleRate: sampleRate,
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
      if (now - endedAt > LEGACY_END_TO_BEGIN_MS * 2) this.lastEndAt.delete(key);
    }
    for (const [key, entry] of this.backoff) {
      if (now >= entry.until) this.backoff.delete(key);
    }
    const endpoints = new Map<string, StreamEndpoint>();
    for (const endpoint of this.sink.streamEndpoints()) {
      if (endpoint.ip && endpoint.address) endpoints.set(endpointKey(endpoint), endpoint);
    }

    // A route-only change keeps the session and its cursor. The wire identity
    // must be the same: a different one is not the same session.
    const missing = [...this.sessions.entries()].filter(([key]) => !endpoints.has(key));
    const unclaimed = new Map([...endpoints].filter(([key]) => !this.sessions.has(key)));
    for (const [oldKey, session] of missing) {
      const candidates = [...unclaimed.entries()].filter(([, endpoint]) =>
        (endpoint.address === session.endpoint.address || endpoint.ip === session.endpoint.ip)
        && sameWire(endpoint, session.endpoint),
      );
      if (candidates.length !== 1) continue;
      const [newKey, newEndpoint] = candidates[0];
      this.sessions.delete(oldKey);
      session.endpoint = newEndpoint;
      this.sessions.set(newKey, session);
      unclaimed.delete(newKey);
      for (const source of this.sources.values()) {
        if (source.completedEndpoints.delete(oldKey)) source.completedEndpoints.add(newKey);
        if (source.stoppedEndpoints.delete(oldKey)) source.stoppedEndpoints.add(newKey);
      }
    }
    for (const [key, session] of [...this.sessions]) {
      const current = endpoints.get(key);
      if (!current) {
        this.sessions.delete(key);
        for (const source of this.sources.values()) source.completedEndpoints.delete(key);
        continue;
      }
      // Class change, device reboot, lease renewal or restart: end the running
      // session NOW (no linger) in the format and identity it began with, so no
      // further DATA goes out under the retired identity. Its sources rejoin
      // the new session below, finite ones from their cursor when only the
      // lease changed.
      if (!sameWire(current, session.endpoint)) this.endSession(key, session, { park: true });
      else session.endpoint = current; // same identity; later fields (CAPS) refresh
    }
    for (const key of [...this.parked.keys()]) {
      if (!endpoints.has(key)) this.parked.delete(key);
    }

    for (const [key, session] of this.sessions) {
      for (const sourceId of [...session.cursors.keys()]) {
        const source = this.sources.get(sourceId);
        if (!source || !protocol.addressMatches(source.target, session.endpoint.address)
          || source.stoppedEndpoints.has(key)) {
          session.cursors.delete(sourceId);
        }
      }
      if (session.cursors.size === 0) session.emptySince ??= now;
    }

    const leaseRequests = new Map<string, StreamEndpoint>();
    for (const source of this.sources.values()) {
      source.guardedEndpoints.clear();
      const reasons: DeferredReason[] = [];
      let matching = 0;
      for (const [key, endpoint] of endpoints) {
        if (!protocol.addressMatches(source.target, endpoint.address)) continue;
        if (source.stoppedEndpoints.has(key)) continue;
        matching++;
        if (source.completedEndpoints.has(key)) continue;
        let session = this.sessions.get(key);
        if (!session) {
          if (this.restartCooldown(endpoint)) {
            source.guardedEndpoints.add(key);
            continue;
          }
          const held = this.backoff.get(key);
          if (held) {
            reasons.push(held.reason);
            continue;
          }
          const opened = this.openSession(key, endpoint, now);
          if (!opened) {
            const reason = endpoint.deferredReason ?? "NoResolvedEndpoint";
            reasons.push(reason);
            if (reason === "UnknownClass" || reason === "LeaseUnavailable") leaseRequests.set(key, endpoint);
            continue;
          }
          session = opened;
        }
        if (!session.cursors.has(source.id)) {
          if (session.emptySince !== undefined) {
            session.startedAt = now - session.framesSent / STREAM_SAMPLE_RATE * 1000;
            session.emptySince = undefined;
          }
          addCursor(session, source.id, source.kind === "live" ? source.nextFrame : 0);
        }
      }
      const active = [...this.sessions.values()].some((session) => session.cursors.has(source.id));
      // Waiting out a Gen 1 guard is not Deferred (§3, §6.10).
      if (active || source.guardedEndpoints.size) source.playback.setState("Active");
      else source.playback.setState("Deferred", matching ? pickReason(reasons) : "NoResolvedEndpoint");
    }

    for (const source of [...this.sources.values()]) {
      // A guarded endpoint that expired or stopped matching left guardedEndpoints
      // above: a finite source already played elsewhere completes now, not on that
      // endpoint's next pump (§6.10).
      if (source.played && !source.loop) this.completeIfUnreferenced(source.id);
      // A loop / live source whose every endpoint was lost for good (§6.13).
      else if (source.stoppedEndpoints.size && !this.hasRemainingEndpoint(source, endpoints)) {
        this.stop(source.id);
      }
    }

    if (leaseRequests.size) this.sink.requestLeases?.([...leaseRequests.values()]);
  }

  /** Begin a session on `endpoint`, taking over the cursors its replaced session parked. */
  private openSession(key: string, endpoint: StreamEndpoint, now: number): EndpointSession | false {
    const wire = this.sink.streamBeginEndpoint(endpoint);
    if (wire === false) return false;
    const session: EndpointSession = {
      endpoint, wire, cursors: new Map(), joined: new Map(), gains: new Map(), limit: 1,
      offset: 0, startedAt: now, framesSent: 0, lastDataAt: now,
    };
    const parked = this.parked.get(key);
    this.parked.delete(key);
    if (parked && parked.lineage === endpoint.wireLineage) {
      // Only the lease changed (ticket, LEASE_INVALID, TIMED_OUT, own gap):
      // finite sources continue from their cursor, never from frame 0
      // (Sender requirement 8). Live sources resume at their newest input.
      for (const [sourceId, cursor] of parked.cursors) {
        const source = this.sources.get(sourceId);
        if (!source || source.stoppedEndpoints.has(key)
          || !protocol.addressMatches(source.target, endpoint.address)) continue;
        addCursor(session, sourceId, source.kind === "live" ? source.nextFrame : cursor, Number.NEGATIVE_INFINITY);
        const gains = parked.gains.get(sourceId);
        if (gains) session.gains.set(sourceId, gains);
      }
      session.limit = parked.limit;
    }
    this.sessions.set(key, session);
    return session;
  }

  private hasRemainingEndpoint(source: Source, endpoints: Map<string, StreamEndpoint>): boolean {
    if ([...this.sessions.values()].some((session) => session.cursors.has(source.id))) return true;
    for (const [key, endpoint] of endpoints) {
      if (protocol.addressMatches(source.target, endpoint.address) && !source.stoppedEndpoints.has(key)) return true;
    }
    return false;
  }

  /**
   * Re-splice (sdk-multi-stream.md §6.14): a finite source added while a Stream
   * Gen 2 session already sent audio past now would otherwise join behind that
   * queue and play the send-ahead late. When the device holds at least 40 ms of
   * it, the other sources go back to now, the new source enters at frame 0,
   * and the session ENDs its generation and BEGINs the next under the same
   * lease; the receiver flushes its queue on that BEGIN, so the re-mixed
   * blocks replace it. A one-shot that finished inside the queue is not sent
   * again. Stream Gen 1 sessions (300 ms guard) are left alone.
   */
  private resplice(source: Source): void {
    const now = Date.now();
    for (const [key, session] of [...this.sessions]) {
      if (session.endpoint.streamClass !== "gen2" || session.framesSent === 0) continue;
      if (!session.cursors.has(source.id) || session.joined.get(source.id) !== session.framesSent) continue;
      const queuedMs = session.framesSent / STREAM_SAMPLE_RATE * 1000 - (now - session.startedAt);
      if (queuedMs < RESPLICE_MIN_QUEUED_MS) continue;
      const rewind = Math.min(session.framesSent, Math.round(queuedMs / 1000 * STREAM_SAMPLE_RATE));
      this.sink.streamEndEndpoint(session.endpoint, session.wire);
      const wire = this.sink.streamBeginEndpoint(session.endpoint);
      if (wire === false) {
        // The lease moved on meanwhile: the sources continue in the next session.
        this.parked.set(key, parkOf(session));
        this.sessions.delete(key);
        continue;
      }
      session.wire = wire;
      for (const [sourceId, cursor] of session.cursors) {
        if (sourceId === source.id) continue;
        const other = this.sources.get(sourceId);
        if (!other) continue;
        const inSession = session.framesSent - (session.joined.get(sourceId) ?? Number.NEGATIVE_INFINITY);
        let next: number;
        if (other.kind === "live") next = Math.max(other.baseFrame, cursor - rewind);
        else if (inSession <= rewind) next = inSession - rewind; // it started inside the queue: before its start
        else if (other.loop && other.nextFrame) next = mod(cursor - rewind, other.nextFrame);
        else next = Math.max(0, cursor - rewind);
        session.cursors.set(sourceId, next);
      }
      session.framesSent -= rewind;
      session.offset = 0;
      session.cursors.set(source.id, 0);
      for (const [sourceId, at] of session.joined) session.joined.set(sourceId, Math.min(at, session.framesSent));
    }
  }

  private pump(): void {
    const now = Date.now();
    for (const [key, session] of [...this.sessions]) {
      let current = session;
      if (current.cursors.size && now - current.lastDataAt >= OWN_GAP_MS) {
        const restarted = this.recoverOwnGap(key, current, now);
        if (!restarted) continue;
        current = restarted;
      }
      const wanted = Math.floor((
        (now - current.startedAt) / 1000 + this.sendAheadSec
      ) * STREAM_SAMPLE_RATE);
      while (current.cursors.size && current.framesSent < wanted) {
        const frames = this.chunkFrames(current);
        if (frames <= 0) break;
        const { data, finished } = this.mix(current, frames);
        this.sink.streamDataEndpoint(current.endpoint, current.offset, data, current.wire);
        current.offset += data.length;
        current.framesSent += frames;
        current.lastDataAt = now;
        for (const sourceId of finished) {
          const source = this.sources.get(sourceId);
          if (source) {
            source.completedEndpoints.add(key);
            source.played = true;
          }
          current.cursors.delete(sourceId);
          this.completeIfUnreferenced(sourceId);
        }
      }
      if (current.cursors.size === 0) {
        current.emptySince ??= now;
        if (now - current.emptySince >= SESSION_END_LINGER_MS) this.endSession(key, current);
      }
    }
  }

  /**
   * No DATA went out for 3 s or more (the process was suspended). A Stream
   * Gen 2 session is replaced by a new generation, continuing its sources from
   * their cursors; other sessions only drop the backlog. Either way the missed
   * time is not sent in one burst.
   */
  private recoverOwnGap(key: string, session: EndpointSession, now: number): EndpointSession | undefined {
    if (session.endpoint.streamClass !== "gen2") {
      session.startedAt = now - session.framesSent / STREAM_SAMPLE_RATE * 1000;
      session.lastDataAt = now;
      return session;
    }
    const endpoint = session.endpoint;
    this.endSession(key, session, { park: true });
    return this.openSession(key, endpoint, now) || undefined;
  }

  private chunkFrames(session: EndpointSession): number {
    let maximum = 0;
    for (const [sourceId, cursor] of session.cursors) {
      const source = this.sources.get(sourceId);
      if (!source) continue;
      // A live source without new input is mixed as silence: the session's
      // DATA never stops while it is open (§6.12, receiver inactivity timeout).
      if (source.kind === "live") return CHUNK_FRAMES;
      if (source.loop && source.nextFrame) return CHUNK_FRAMES;
      maximum = Math.max(maximum, source.nextFrame - cursor);
    }
    return Math.min(CHUNK_FRAMES, Math.max(0, maximum));
  }

  private mix(session: EndpointSession, frames: number): { data: Uint8Array; finished: Set<string> } {
    const mixed = new Float64Array(frames * STREAM_CHANNELS);
    const finished = new Set<string>();
    // One motor: the receiver plays (L+R)/2, so pan is not applied and both
    // channels carry the same mix (§6.15). Unknown (no CAPS) keeps pan.
    const mono = session.endpoint.hapticChannels === 1;
    for (const [sourceId, initialCursor] of [...session.cursors]) {
      const source = this.sources.get(sourceId);
      if (!source) { finished.add(sourceId); continue; }
      const [leftGain, rightGain] = channelGains(source.gain, mono ? 0 : source.pan);
      // A new source starts at its own gains (its PCM carries the onset); a
      // changed gain / pan ramps linearly over this block (no zipper, §5.7).
      const [left0, right0] = session.gains.get(sourceId) ?? [leftGain, rightGain];
      session.gains.set(sourceId, [leftGain, rightGain]);
      const stepLeft = (leftGain - left0) / frames;
      const stepRight = (rightGain - right0) / frames;
      const ramp = stepLeft !== 0 || stepRight !== 0;
      let cursor = source.kind === "live" ? Math.max(initialCursor, source.baseFrame) : initialCursor;
      for (let frame = 0; frame < frames; frame++) {
        // Before its start (re-splice moved it back): silence until frame 0.
        if (cursor < 0) {
          cursor++;
          continue;
        }
        if (cursor >= source.nextFrame) {
          if (source.kind === "finite" && source.loop) cursor = 0;
          else {
            // A finite source ended; a live one has no new input yet: the rest
            // of the block is silence and the cursor waits for input.
            if (source.kind === "finite") finished.add(sourceId);
            break;
          }
        }
        const sampleFrame = source.kind === "live" ? cursor - source.baseFrame : cursor;
        if (sampleFrame < 0 || sampleFrame * 2 + 1 >= source.samples.length) break;
        const gainLeft = ramp ? left0 + stepLeft * (frame + 1) : leftGain;
        const gainRight = ramp ? right0 + stepRight * (frame + 1) : rightGain;
        let left = source.samples[sampleFrame * 2];
        let right = source.samples[sampleFrame * 2 + 1];
        if (mono) left = right = (left + right) / 2;
        mixed[frame * 2] += left * gainLeft;
        mixed[frame * 2 + 1] += right * gainRight;
        cursor++;
      }
      session.cursors.set(sourceId, cursor);
      if (source.kind === "finite" && !source.loop && cursor >= source.nextFrame) finished.add(sourceId);
    }
    for (const sourceId of [...session.gains.keys()]) {
      if (finished.has(sourceId) || !session.cursors.has(sourceId)) session.gains.delete(sourceId);
    }
    limit(session, mixed, frames);
    const data = new Uint8Array(frames * 4);
    const view = new DataView(data.buffer);
    for (let i = 0; i < mixed.length; i++) view.setInt16(i * 2, saturatePcm16(mixed[i]), true);
    return { data, finished };
  }

  private completeIfUnreferenced(id: string): void {
    if ([...this.sessions.values()].some((session) => session.cursors.has(id))) return;
    // Waiting for the replacement of a session that ended mid-way (§8).
    if ([...this.parked.values()].some((parked) => parked.cursors.has(id))) return;
    const source = this.sources.get(id);
    // Still owed to a Gen 1 endpoint that is waiting out its END -> BEGIN
    // guard: finishing elsewhere must not drop the cue there.
    if (source?.guardedEndpoints.size) return;
    if (source?.kind === "finite") {
      this.sources.delete(id);
      source.playback.setState("Stopped");
    }
  }

  /**
   * The device or hapbeat-helper ended a session (§6.13, helper-streaming.md).
   * "stopped": its sources leave that endpoint for good (a finite one counts
   * as played there). "lost": the sources continue in the next session, after
   * a backoff when the helper deferred the endpoint.
   */
  private onSessionEvent(event: StreamSessionEvent): void {
    if (this.closed) return;
    const entry = [...this.sessions].find(([, session]) => session.wire === event.wire);
    if (!entry) return;
    const [key, session] = entry;
    const reason = event.reason ?? event.kind;
    if (event.kind === "stopped") {
      for (const sourceId of session.cursors.keys()) {
        const source = this.sources.get(sourceId);
        if (!source) continue;
        source.stoppedEndpoints.add(key);
        if (source.kind === "finite") source.played = true;
        source.playback.setLost(reason);
        this.onStreamLost?.({ playbackId: source.id, ip: session.endpoint.ip, reason });
      }
      // No linger: another Playback joining it would send DATA of the stopped
      // generation and be stopped again.
      this.endSession(key, session, { sendEnd: false });
    } else {
      this.endSession(key, session, { sendEnd: false, park: true });
      if (reason === "deferred" || reason === "superseded" || reason === "error") {
        this.backoff.set(key, {
          until: Date.now() + HELPER_DEFER_BACKOFF_MS,
          reason: reason === "superseded" ? "Superseded" : "LeaseUnavailable",
        });
      }
    }
    this.reconcileNow();
    this.schedule(0);
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

  /**
   * Forget the session; send END in its own format unless the far side already
   * ended it, and keep its cursors for its replacement when `park` is set.
   */
  private endSession(
    key: string,
    session: EndpointSession,
    { sendEnd = true, park = false }: { sendEnd?: boolean; park?: boolean } = {},
  ): void {
    if (sendEnd) {
      this.sink.streamEndEndpoint(session.endpoint, session.wire);
      // Only a Gen 1 END arms the guard: a Gen 2 END is identity-stamped, so
      // the next Gen 2 BEGIN is immediate.
      if (session.endpoint.legacy) this.recordLegacyEnd(session.endpoint);
    }
    if (park && session.cursors.size) this.parked.set(key, parkOf(session));
    this.sessions.delete(key);
  }

  /** Keyed per endpoint (ip, port, address): another device sharing the
   * address or IP is not delayed (§6.11). */
  private recordLegacyEnd(endpoint: StreamEndpoint): void {
    this.lastEndAt.set(endpointKey(endpoint), Date.now());
  }

  /** The Gen 1 END -> BEGIN guard, for Gen 1 endpoints only. */
  private restartCooldown(endpoint: StreamEndpoint): boolean {
    if (!endpoint.legacy) return false;
    const latest = this.lastEndAt.get(endpointKey(endpoint)) ?? 0;
    return Date.now() - latest < LEGACY_END_TO_BEGIN_MS;
  }
}

function endpointKey(endpoint: StreamEndpoint): string {
  return `${endpoint.ip}\0${endpoint.address}\0${endpoint.port ?? 7700}`;
}

function sameWire(a: StreamEndpoint, b: StreamEndpoint): boolean {
  return Boolean(a.legacy) === Boolean(b.legacy) && a.wireEpoch === b.wireEpoch;
}

function addCursor(session: EndpointSession, sourceId: string, cursor: number, joined = session.framesSent): void {
  session.cursors.set(sourceId, cursor);
  session.joined.set(sourceId, joined);
}

function parkOf(session: EndpointSession): ParkedSession {
  return {
    lineage: session.endpoint.wireLineage,
    cursors: new Map(session.cursors),
    gains: new Map(session.gains),
    limit: session.limit,
  };
}

function pickReason(reasons: readonly DeferredReason[]): DeferredReason {
  for (const reason of DEFERRED_PRIORITY) if (reasons.includes(reason)) return reason;
  return "NoResolvedEndpoint";
}

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Keep the summed sources in range without a hard clamp (§5.8): a block whose
 * peak is within LIMIT_THRESHOLD passes bit-identical (+32768 then saturates to
 * 32767); past it, a gain reduction to
 * LIMIT_TARGET / peak (attack within the block, release by
 * LIMIT_RELEASE_PER_CHUNK per block), ramped per sample, then a soft knee.
 */
function limit(session: EndpointSession, mixed: Float64Array, frames: number): void {
  let peak = 0;
  for (let i = 0; i < mixed.length; i++) peak = Math.max(peak, Math.abs(mixed[i]));
  const want = peak > LIMIT_THRESHOLD ? LIMIT_TARGET / peak : 1;
  const start = session.limit;
  const end = want < start ? want : Math.min(want, start + LIMIT_RELEASE_PER_CHUNK);
  session.limit = end;
  if (start === 1 && end === 1) return;
  const step = (end - start) / frames;
  const span = FULL_SCALE - LIMIT_KNEE;
  for (let frame = 0; frame < frames; frame++) {
    const g = start + step * (frame + 1);
    for (let channel = 0; channel < STREAM_CHANNELS; channel++) {
      const i = frame * STREAM_CHANNELS + channel;
      const v = mixed[i] * g;
      const a = Math.abs(v);
      mixed[i] = a > LIMIT_KNEE ? Math.sign(v) * (LIMIT_KNEE + span * Math.tanh((a - LIMIT_KNEE) / span)) : v;
    }
  }
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
