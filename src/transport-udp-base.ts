/**
 * Shared UDP transport: builds raw Layer 1 packets (via `protocol`) and
 * broadcasts them over a datagram socket. The platform-specific socket plumbing
 * (open / send / close) is left abstract so the Node (`node:dgram`) and React
 * Native (`react-native-udp`) transports stay byte-for-byte identical on the
 * wire and share all protocol logic, keepalive, discovery, and device tracking.
 */

import * as protocol from "./protocol.js";
import type { StreamMeta } from "./clip.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

export const DEFAULT_UDP_PORT = 7700;
export const DEFAULT_BROADCAST = "255.255.255.255";
const KEEPALIVE_MS = 5000;

export abstract class UdpTransportBase implements Transport {
  protected readonly port: number;
  protected readonly broadcastAddr: string;
  protected readonly appName: string;
  protected readonly deviceName: string;
  protected readonly group: number;
  protected readonly keepalive: boolean;

  private seq = 0;
  private readonly devices = new Map<string, Device>();
  private keepaliveTimer?: ReturnType<typeof setInterval>;

  constructor(options: HapbeatOptions = {}) {
    this.port = options.port ?? DEFAULT_UDP_PORT;
    this.broadcastAddr = options.broadcastAddr ?? DEFAULT_BROADCAST;
    this.appName = (options.appName ?? "").slice(0, protocol.MAX_APP_NAME_LEN);
    this.deviceName = options.deviceName ?? "";
    this.group = options.group ?? 0;
    this.keepalive = options.keepalive ?? true;
  }

  // --- platform hooks (implemented per environment) ---

  /** Open the socket, enable broadcast, and route each datagram to handleMessage. */
  protected abstract openSocket(): Promise<void>;
  /** Send raw bytes to (broadcastAddr, port). */
  protected abstract sendBytes(packet: Uint8Array): void;
  /** Close the socket. */
  protected abstract closeSocket(): void;

  /** Subclasses call this for every received datagram. */
  protected handleMessage(msg: Uint8Array, ip: string): void {
    const pong = protocol.parsePong(msg);
    if (!pong) return;
    const dev: Device = this.devices.get(ip) ?? { ip, lastSeen: 0 };
    dev.name = pong.deviceName ?? dev.name;
    dev.address = pong.address ?? dev.address;
    dev.firmwareVersion = pong.firmwareVersion ?? dev.firmwareVersion;
    dev.lastSeen = Date.now();
    this.devices.set(ip, dev);
  }

  // --- Transport surface (shared) ---

  async connect(): Promise<void> {
    await this.openSocket();
    if (this.keepalive && this.appName) this.startKeepalive();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  play(eventId: string, gain: number, target: string, targetTimeUs: number): void {
    this.sendBytes(protocol.buildPlay(this.nextSeq(), eventId, { target, targetTimeUs, gain }));
  }

  stop(eventId: string, target: string): void {
    this.sendBytes(protocol.buildStop(this.nextSeq(), eventId, target));
  }

  stopAll(target: string): void {
    this.sendBytes(protocol.buildStopAll(this.nextSeq(), target));
  }

  ping(): void {
    this.sendBytes(protocol.buildPing(this.nextSeq(), Date.now() * 1000));
  }

  streamBegin(meta: StreamMeta): void {
    this.sendBytes(
      protocol.buildStreamBegin(this.nextSeq(), {
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        format: meta.format,
        totalSamples: meta.totalSamples,
        gain: meta.gain,
        target: meta.target, // device self-filters on the in-packet target
      }),
    );
  }

  streamData(offset: number, data: Uint8Array): void {
    this.sendBytes(protocol.buildStreamData(this.nextSeq(), offset, data));
  }

  streamEnd(): void {
    this.sendBytes(protocol.buildStreamEnd(this.nextSeq()));
  }

  private connectStatus(connected: boolean): void {
    this.sendBytes(
      protocol.buildConnectStatus(this.nextSeq(), {
        connected,
        group: this.group,
        appName: this.appName,
        deviceName: this.deviceName,
      }),
    );
  }

  private startKeepalive(): void {
    this.connectStatus(true);
    this.keepaliveTimer = setInterval(() => this.connectStatus(true), KEEPALIVE_MS);
  }

  async discover(timeoutMs: number): Promise<Device[]> {
    const before = Date.now();
    this.ping();
    await new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)));
    return [...this.devices.values()].filter((d) => d.lastSeen >= before - 50);
  }

  close(): void {
    if (this.appName) {
      try {
        this.connectStatus(false);
      } catch {
        /* ignore */
      }
    }
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.closeSocket();
  }
}
