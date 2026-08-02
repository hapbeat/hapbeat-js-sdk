/** Shared types for the Hapbeat Web SDK. */

import type { EventMap } from "./eventmap.js";
import type { StreamMeta } from "./clip.js";

export interface Device {
  ip: string;
  name?: string;
  address?: string;
  firmwareVersion?: string;
  lastSeen: number;
}

export interface HapbeatOptions {
  /** UDP destination port commands are sent to (Node/RN transport). Default 7700. */
  port?: number;
  /**
   * Local UDP port to bind the *receive* socket to (Node/RN transport).
   * Default `0` = ephemeral (OS-assigned), per DEC-036: only the daemon
   * (hapbeat-helper) binds the well-known 7700; SDKs receive on an ephemeral
   * port and send to 7700, so an SDK never steals 7700 from the helper.
   * Set `bindPort: 7700` to opt in to binding the well-known port (e.g. a
   * daemon-style listener); it falls back to ephemeral if 7700 is busy.
   */
  bindPort?: number;
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
  /** Browser transport: called when an *established* helper WS connection drops. */
  onConnectionLost?: () => void;
  /** Browser transport: ms to wait for the helper WS to open before giving up. Default 4000. */
  connectTimeoutMs?: number;
  /** Optional tuning catalog used to resolve default gains by event id. */
  eventMap?: EventMap;
  /**
   * Whether to run the keep-alive (Node/RN only): a PING every 5 s, plus
   * CONNECT_STATUS when `appName` is set. Default true. The PING is what keeps
   * unicast alive — devices answer PONG only to a PING — so turning this off
   * makes commands fall back to broadcast once the last PONG ages out.
   */
  keepalive?: boolean;
  /**
   * Send PLAY/STOP/STOP_ALL and clip streams straight to devices that answered
   * a PING (Node/RN only), instead of broadcasting. Default true.
   *
   * Wi-Fi APs hold broadcast frames until the next DTIM beacon (100-300 ms)
   * whenever any client on the AP is power-saving, which is heard as late
   * haptics and stuttering streams; unicast frames are not batched. Falls back
   * to broadcast until a device replies. Set `false` to always broadcast (e.g.
   * many devices that must fire in lockstep, where one broadcast beats N
   * sequential unicasts).
   */
  unicast?: boolean;
  /**
   * How long a device stays a unicast destination after its last PONG, in ms.
   * Default 15000 (three keep-alive PINGs).
   */
  deviceTtlMs?: number;
  /**
   * Base location of stream-clip WAVs (clip-mode events). The event's `clip`
   * filename is resolved against this. Browser: a URL prefix (e.g.
   * "/demo-kit/stream-clips/"); Node: a directory path. Default "".
   */
  clipBase?: string;
  /**
   * Loads a clip's bytes by resolved reference. Injected per-environment
   * (browser = fetch, Node = fs). Override to load from a bundle/cache.
   */
  clipLoader?: (ref: string) => Promise<ArrayBuffer | Uint8Array>;
  /** Clip streaming send-ahead buffer in seconds (< 0.256). Default 0.15. */
  streamSendAheadSec?: number;
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
  // Clip streaming (UDP audio). The ClipStreamer paces calls to these.
  streamBegin(meta: StreamMeta): void;
  streamData(offset: number, data: Uint8Array): void;
  streamEnd(): void;
}
