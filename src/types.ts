/** Shared types for the Hapbeat Web SDK. */

import type { EventMap } from "./eventmap.js";

export interface Device {
  ip: string;
  name?: string;
  address?: string;
  firmwareVersion?: string;
  lastSeen: number;
}

export interface HapbeatOptions {
  /** UDP port (Node transport). Default 7700. */
  port?: number;
  /** Broadcast address (Node transport). Default 255.255.255.255. */
  broadcastAddr?: string;
  /** Helper WebSocket URL (Browser transport). Default ws://localhost:7703. */
  helperUrl?: string;
  /** App name shown on the device OLED (Node transport keep-alive). Max 16 chars. */
  appName?: string;
  /** Host/device name for the OLED. */
  deviceName?: string;
  /** Group id this sender targets. */
  group?: number;
  /** Default device-addressing target; "" = broadcast. */
  defaultTarget?: string;
  /** Optional tuning catalog used to resolve default gains by event id. */
  eventMap?: EventMap;
  /** Whether to run the CONNECT_STATUS keep-alive (Node only). Default true. */
  keepalive?: boolean;
}

/**
 * A transport carries semantic commands to devices. The Node transport builds
 * raw L1 packets and broadcasts them over UDP; the Browser transport sends
 * JSON to hapbeat-helper, which builds the packets. The Hapbeat facade is
 * written against this interface and never touches bytes.
 */
export interface Transport {
  connect(): Promise<void>;
  play(eventId: string, gain: number, target: string, targetTimeUs: number): void;
  stop(eventId: string, target: string): void;
  stopAll(target: string): void;
  ping(): void;
  discover(timeoutMs: number): Promise<Device[]>;
  close(): Promise<void> | void;
}
