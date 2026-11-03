/**
 * Browser transport: relays semantic commands to hapbeat-helper over a
 * WebSocket. Browsers cannot open raw UDP sockets, so the locally-running
 * helper (pip install hapbeat-helper) does the UDP I/O on our behalf, and is
 * the Stream Gen 2 sender for us (contracts helper-ws.md, helper-streaming.md):
 *   <- { type: "helper_hello", payload: { version, generation, types, features } }
 *   -> { type: "play_event",  payload: { event_id, target, gain, pan } }
 *   -> { type: "stop_event",  payload: { event_id, target } }   // "" id = stop all
 *   -> { type: "ping" } / { type: "rescan" }
 *   -> { type: "stream_begin", payload: { stream_id, ip, targets: [ip], target, sample_rate, channels, format, total_samples, gain } }
 *   -> { type: "stream_data",  payload: { stream_id, ip, offset, data } } // data = base64 PCM16
 *   -> { type: "stream_end",   payload: { stream_id, ip } }
 *   <- { type: "device_list", payload: { devices: [...] } }
 *   <- { type: "stream_ack", payload: { stream_id, status, targets, deferred? } }
 *   <- { type: "stream_displaced", payload: { stream_id, targets, by, same_client } }
 *   <- { type: "stream_lost", payload: { stream_id, targets, reason } }
 * Each endpoint session has its own stream_id. stream_begin never carries
 * `takeover`: this SDK plays cues automatically, so a device another
 * application took is left to it (the helper defers it).
 */

import type { StreamEndpoint, StreamSessionEvent } from "./stream.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";
import { warnIfNewerGeneration } from "./version.js";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in browsers and Node ≥16.
  return btoa(bin);
}

const DEFAULT_HELPER_URL = "ws://localhost:7703";
const DEFAULT_DEVICE_TTL_MS = 15_000;

/** Wire state of one endpoint session behind the helper. */
interface HelperWire {
  streamId: string;
}

let nextStreamId = 0;

function newStreamId(): string {
  return `js-${Date.now().toString(36)}-${++nextStreamId}`;
}

function ipsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

// Minimal structural WebSocket type so we depend on neither the DOM lib nor
// @types/node's global. The real constructor is resolved from globalThis.
interface WSLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
type WSCtor = new (url: string) => WSLike;

function resolveWebSocket(): WSCtor {
  const ctor = (globalThis as { WebSocket?: WSCtor }).WebSocket;
  if (!ctor) {
    throw new Error(
      "WebSocket is unavailable; the browser transport needs a browser (or Node 22+).",
    );
  }
  return ctor;
}

export class BrowserWsTransport implements Transport {
  private readonly url: string;
  private ws?: WSLike;
  private open = false;
  private readonly connectTimeoutMs: number;
  private readonly onConnectionLost?: () => void;
  private readonly deviceTtlMs: number;
  private readonly knownDevices = new Map<string, Device>();
  /** Endpoint sessions by stream_id, until they end here or at the helper. */
  private readonly sessions = new Map<string, { endpoint: StreamEndpoint; wire: HelperWire }>();
  private sessionListener?: (event: StreamSessionEvent) => void;
  private helperErrorLogged = false;

  constructor(options: HapbeatOptions = {}) {
    this.url = options.helperUrl ?? DEFAULT_HELPER_URL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
    this.onConnectionLost = options.onConnectionLost;
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const WS = resolveWebSocket();
      const ws = new WS(this.url);
      // A refused/dropped handshake normally fires onerror, but guard against a
      // socket that stalls in CONNECTING (slow firewall drop) so the caller's
      // graceful fallback always runs instead of hanging.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`hapbeat-helper did not respond at ${this.url} within ${this.connectTimeoutMs}ms.`));
        }
      }, this.connectTimeoutMs);
      ws.onopen = () => {
        settled = true;
        clearTimeout(timer);
        this.open = true;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `cannot reach hapbeat-helper at ${this.url}. Is it running? ` +
                "Install with: pip install hapbeat-helper",
            ),
          );
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true; // closed during the opening handshake
          reject(new Error(`hapbeat-helper connection to ${this.url} closed before it opened.`));
        } else if (this.open) {
          this.open = false; // lost an established connection (helper quit/restarted)
          this.onConnectionLost?.();
        }
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      this.ws = ws;
    });
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: { type?: unknown; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const payload = msg?.payload ?? {};
    switch (msg?.type) {
      case "device_list": return this.onDeviceList(payload);
      case "helper_hello": {
        const generation = typeof payload.generation === "number" ? payload.generation : undefined;
        return warnIfNewerGeneration("hapbeat-helper", generation, "hapbeat-helper");
      }
      case "stream_ack": return this.onStreamAck(payload);
      case "stream_displaced":
        // same_client: our own newer stream_id took it, which is not a loss.
        if (payload.same_client === true) return;
        return this.endFromHelper(payload, "stopped", "displaced");
      case "stream_lost": {
        const reason = String(payload.reason ?? "unreachable");
        // stopped (STOP_ALL) is for good; the others start again (superseded after a backoff).
        return this.endFromHelper(payload, reason === "stopped" ? "stopped" : "lost", reason);
      }
      default: return; // unknown messages and fields are ignored (versioning.md §7.1)
    }
  }

  /**
   * stream_ack: `ok` started the destinations in `targets`; one listed in
   * `deferred` (unknown class, no lease, superseded) did not start, nor does
   * any with `no_target`; `no_session` says the helper holds no destination
   * for that stream_id. Each ends the session here; StreamHub begins a new
   * one (after a backoff when deferred).
   */
  private onStreamAck(payload: Record<string, unknown>): void {
    const status = payload.status;
    if (status === "ok") {
      const deferred = ipsOf(payload.deferred);
      if (deferred?.length) this.endFromHelper(payload, "lost", "deferred", deferred);
    } else if (status === "no_target") {
      this.endFromHelper(payload, "lost", "deferred", null);
    } else if (status === "no_session") {
      this.endFromHelper(payload, "lost", "no_session", null);
    } else if (status === "error") {
      if (!this.helperErrorLogged) {
        this.helperErrorLogged = true;
        console.warn(`[hapbeat] hapbeat-helper rejected a stream: ${String(payload.message ?? "no reason given")}.`);
      }
      this.endFromHelper(payload, "lost", "error", null);
    }
  }

  /**
   * The helper ended one of our sessions on its device: forget it and tell
   * StreamHub. `ips`: the destinations it concerns (default: the payload's
   * `targets`); null when the message is about the whole stream_id.
   */
  private endFromHelper(
    payload: Record<string, unknown>,
    kind: StreamSessionEvent["kind"],
    reason: string,
    ips: string[] | null = ipsOf(payload.targets) ?? null,
  ): void {
    const streamId = typeof payload.stream_id === "string" ? payload.stream_id : undefined;
    const session = streamId === undefined ? undefined : this.sessions.get(streamId);
    if (!streamId || !session) return;
    if (ips && !ips.includes(session.endpoint.ip)) return;
    this.sessions.delete(streamId);
    this.sessionListener?.({ endpoint: session.endpoint, wire: session.wire, kind, reason });
  }

  private onDeviceList(payload: Record<string, unknown>): void {
    if (!Array.isArray(payload.devices)) return;
    const nextDevices = new Map<string, Device>();
    const identityIps = new Map<string, string>();
    for (const raw of payload.devices) {
      const d = raw as Record<string, unknown>;
      const ip = String(d.ip ?? d.ipAddress ?? "");
      if (!ip) continue;
      if (d.online === false) continue;
      const device: Device = {
        ip,
        name: (d.name ?? d.device_name) as string | undefined,
        address: d.address as string | undefined,
        firmwareVersion: (d.firmware_version ?? d.firmwareVersion) as string | undefined,
        lastSeen: Date.now(),
      };
      if (device.name && device.address) {
        const identity = `${device.name}\0${device.address}`;
        const oldIp = identityIps.get(identity);
        if (oldIp) nextDevices.delete(oldIp);
        identityIps.set(identity, ip);
      }
      nextDevices.set(ip, device);
    }
    this.knownDevices.clear();
    for (const [ip, device] of nextDevices) this.knownDevices.set(ip, device);
  }

  private send(type: string, payload: Record<string, unknown> = {}): void {
    // readyState 1 === OPEN. Sending on CONNECTING throws InvalidStateError and
    // on CLOSING/CLOSED is silently dropped — guard both so a stale handle is a
    // no-op rather than an exception.
    if (!this.ws || this.ws.readyState !== 1) {
      console.warn("[hapbeat] send while not connected — dropped");
      return;
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }

  play(eventId: string, gain: number, target: string, _targetTimeUs: number, pan = 0): void {
    // Helper builds the PLAY packet; targetTime scheduling is not exposed
    // over the helper WS at level-1 (immediate playback). `pan` is passed
    // through per contracts §0x01 (DEC-055); a helper that does not yet read
    // it ignores the field and the event plays centred.
    this.send("play_event", { event_id: eventId, target, gain, pan });
  }

  stop(eventId: string, target: string): void {
    this.send("stop_event", { event_id: eventId, target });
  }

  stopAll(target: string): void {
    this.send("stop_event", { event_id: "", target }); // empty id -> stop all
  }

  ping(): void {
    this.send("ping");
  }

  /**
   * The helper owns the wire format per device (Stream Gen 2 with its lease
   * and generation, or Stream Gen 1 for firmware 0.4.x), recovers the
   * device-side errors it can, and applies the 300 ms Gen 1 END -> BEGIN guard
   * itself; device_list does not report the class. These endpoints therefore
   * carry no `legacy` flag or class, so StreamHub adds no cooldown of its own
   * on this path.
   */
  streamEndpoints(): StreamEndpoint[] {
    return this.aliveDevices()
      .filter((device) => Boolean(device.address))
      .map((device) => ({ ip: device.ip, address: device.address! }));
  }

  /** The devices in the helper's last device_list, without asking it again. */
  devices(): Device[] {
    return this.aliveDevices().map((device) => ({ ...device }));
  }

  private aliveDevices(): Device[] {
    const cutoff = Date.now() - this.deviceTtlMs;
    return [...this.knownDevices.values()].filter((device) => device.lastSeen >= cutoff);
  }

  setSessionListener(listener: (event: StreamSessionEvent) => void): void {
    this.sessionListener = listener;
  }

  streamBeginEndpoint(endpoint: StreamEndpoint): HelperWire {
    const wire: HelperWire = { streamId: newStreamId() };
    this.sessions.set(wire.streamId, { endpoint, wire });
    this.send("stream_begin", {
      stream_id: wire.streamId,
      ip: endpoint.ip,
      targets: [endpoint.ip],
      target: endpoint.address,
      sample_rate: 16000,
      channels: 2,
      format: "pcm",
      total_samples: 0,
      gain: 1.0,
    });
    return wire;
  }

  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array, wire?: unknown): void {
    const streamId = (wire as HelperWire | undefined)?.streamId;
    const session = streamId === undefined ? undefined : this.sessions.get(streamId);
    if (session) session.endpoint = endpoint;
    this.send("stream_data", { stream_id: streamId, ip: endpoint.ip, offset, data: toBase64(data) });
  }

  streamEndEndpoint(endpoint: StreamEndpoint, wire?: unknown): void {
    const streamId = (wire as HelperWire | undefined)?.streamId;
    if (streamId !== undefined) this.sessions.delete(streamId);
    this.send("stream_end", { stream_id: streamId, ip: endpoint.ip });
  }

  async discover(timeoutMs: number): Promise<Device[]> {
    // helper waits ~250ms after a rescan before pushing device_list, so pass a
    // timeout of at least ~300ms (the Hapbeat.discover default of 1500ms is fine).
    const before = Date.now();
    this.send("rescan");
    await new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)));
    return this.devices().filter((d) => d.lastSeen >= before - 50);
  }

  close(): void {
    this.open = false;
    this.sessions.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }
}
