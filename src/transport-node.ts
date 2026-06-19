/**
 * Node transport: builds raw Layer 1 packets and broadcasts them over UDP.
 *
 * This file is imported only by the Node entry point so the `node:dgram`
 * dependency never leaks into browser bundles.
 */

import * as dgram from "node:dgram";

import * as protocol from "./protocol.js";
import type { StreamMeta } from "./clip.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

const DEFAULT_PORT = 7700;
const DEFAULT_BROADCAST = "255.255.255.255";
const KEEPALIVE_MS = 5000;

export class NodeUdpTransport implements Transport {
  private readonly port: number;
  private readonly broadcastAddr: string;
  private readonly appName: string;
  private readonly deviceName: string;
  private readonly group: number;
  private readonly keepalive: boolean;

  private socket?: dgram.Socket;
  private seq = 0;
  private readonly devices = new Map<string, Device>();
  private keepaliveTimer?: ReturnType<typeof setInterval>;

  constructor(options: HapbeatOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.broadcastAddr = options.broadcastAddr ?? DEFAULT_BROADCAST;
    this.appName = (options.appName ?? "").slice(0, protocol.MAX_APP_NAME_LEN);
    this.deviceName = options.deviceName ?? "";
    this.group = options.group ?? 0;
    this.keepalive = options.keepalive ?? true;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bind = (port: number, isFallback: boolean): void => {
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const onBindError = (err: Error): void => {
          sock.removeListener("error", onBindError);
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          // Port busy (e.g. hapbeat-helper holds 7700) -> ephemeral fallback.
          if (!isFallback) bind(0, true);
          else reject(err);
        };
        sock.once("error", onBindError);
        sock.bind(port, () => {
          sock.removeListener("error", onBindError);
          sock.on("error", (e) => console.warn("[hapbeat] udp error:", e.message));
          sock.on("message", (msg, rinfo) => this.onMessage(msg, rinfo.address));
          sock.setBroadcast(true);
          this.socket = sock;
          if (this.keepalive && this.appName) this.startKeepalive();
          resolve();
        });
      };
      bind(this.port, false);
    });
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  private send(packet: Uint8Array): void {
    this.socket?.send(packet, this.port, this.broadcastAddr, (err) => {
      if (err) console.warn("[hapbeat] udp send failed:", err.message);
    });
  }

  private onMessage(msg: Uint8Array, ip: string): void {
    const pong = protocol.parsePong(msg);
    if (!pong) return;
    const dev: Device = this.devices.get(ip) ?? { ip, lastSeen: 0 };
    dev.name = pong.deviceName ?? dev.name;
    dev.address = pong.address ?? dev.address;
    dev.firmwareVersion = pong.firmwareVersion ?? dev.firmwareVersion;
    dev.lastSeen = Date.now();
    this.devices.set(ip, dev);
  }

  play(eventId: string, gain: number, target: string, targetTimeUs: number): void {
    this.send(protocol.buildPlay(this.nextSeq(), eventId, { target, targetTimeUs, gain }));
  }

  stop(eventId: string, target: string): void {
    this.send(protocol.buildStop(this.nextSeq(), eventId, target));
  }

  stopAll(target: string): void {
    this.send(protocol.buildStopAll(this.nextSeq(), target));
  }

  ping(): void {
    this.send(protocol.buildPing(this.nextSeq(), Date.now() * 1000));
  }

  streamBegin(meta: StreamMeta): void {
    this.send(
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
    this.send(protocol.buildStreamData(this.nextSeq(), offset, data));
  }

  streamEnd(): void {
    this.send(protocol.buildStreamEnd(this.nextSeq()));
  }

  private connectStatus(connected: boolean): void {
    this.send(
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
    this.socket?.close();
    this.socket = undefined;
  }
}
