/**
 * Browser transport: relays semantic commands to hapbeat-helper over a
 * WebSocket. Browsers cannot open raw UDP sockets, so the locally-running
 * helper (pip install hapbeat-helper) does the UDP broadcast on our behalf.
 *
 * Helper WS protocol (hapbeat-helper server.py):
 *   -> { type: "play_event",  payload: { event_id, target, gain } }
 *   -> { type: "stop_event",  payload: { event_id, target } }   // "" id = stop all
 *   -> { type: "ping" } / { type: "rescan" }
 *   <- { type: "device_list", payload: { devices: [...] } }
 */

import type { Device, HapbeatOptions, Transport } from "./types.js";

const DEFAULT_HELPER_URL = "ws://localhost:7703";

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
  private readonly devices = new Map<string, Device>();

  constructor(options: HapbeatOptions = {}) {
    this.url = options.helperUrl ?? DEFAULT_HELPER_URL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
    this.onConnectionLost = options.onConnectionLost;
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
    let msg: { type?: string; payload?: { devices?: unknown[] } };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type !== "device_list" || !Array.isArray(msg.payload?.devices)) return;
    for (const raw of msg.payload.devices) {
      const d = raw as Record<string, unknown>;
      const ip = String(d.ip ?? d.address ?? "");
      if (!ip) continue;
      this.devices.set(ip, {
        ip,
        name: (d.name ?? d.device_name) as string | undefined,
        address: d.address as string | undefined,
        firmwareVersion: (d.firmware_version ?? d.firmwareVersion) as string | undefined,
        lastSeen: Date.now(),
      });
    }
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

  play(eventId: string, gain: number, target: string, _targetTimeUs: number): void {
    // Helper builds the PLAY packet; targetTime scheduling is not exposed
    // over the helper WS at level-1 (immediate playback).
    this.send("play_event", { event_id: eventId, target, gain });
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

  async discover(timeoutMs: number): Promise<Device[]> {
    // helper waits ~250ms after a rescan before pushing device_list, so pass a
    // timeout of at least ~300ms (the Hapbeat.discover default of 1500ms is fine).
    const before = Date.now();
    this.send("rescan");
    await new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)));
    return [...this.devices.values()].filter((d) => d.lastSeen >= before - 50);
  }

  close(): void {
    this.open = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }
}
