/**
 * High-level Hapbeat facade — the level-1 "fire" surface.
 *
 * Transport-agnostic: it resolves per-event default gain from the optional
 * EventMap, clamps it, and hands semantic commands to a Transport. The same
 * facade works over UDP (Node) and over the helper WebSocket (browser).
 */

import type { EventMap } from "./eventmap.js";
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

  constructor(transport: Transport, options: HapbeatOptions = {}) {
    this.transport = transport;
    this.eventMap = options.eventMap;
    this.defaultTarget = options.defaultTarget ?? "";
  }

  /** Open the transport (UDP socket / WebSocket). */
  async connect(): Promise<this> {
    await this.transport.connect();
    return this;
  }

  /**
   * Play a haptic event by id. `event id` must exist in the kit on the device.
   * `gain` is the absolute wire gain (0..1); when omitted, the bound EventMap
   * supplies the per-event default, else 1.0.
   */
  play(eventId: string, opts: PlayOpts = {}): void {
    const gain =
      opts.gain ?? (this.eventMap ? this.eventMap.gainFor(eventId) : 1.0);
    this.transport.play(
      eventId,
      clamp01(gain),
      opts.target ?? this.defaultTarget,
      opts.targetTimeUs ?? 0,
    );
  }

  stop(eventId: string, target?: string): void {
    this.transport.stop(eventId, target ?? this.defaultTarget);
  }

  stopAll(target?: string): void {
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
    await this.transport.close();
  }
}
