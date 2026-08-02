/**
 * Shared UDP transport: builds raw Layer 1 packets (via `protocol`) and sends
 * them over a datagram socket, either straight to a known device (unicast) or
 * to the broadcast address. The platform-specific socket plumbing (open / send
 * / close) is left abstract so the Node (`node:dgram`) and React Native
 * (`react-native-udp`) transports stay byte-for-byte identical on the wire and
 * share all protocol logic, keepalive, discovery, and device tracking.
 */

import * as protocol from "./protocol.js";
import type { StreamMeta } from "./clip.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

export const DEFAULT_UDP_PORT = 7700;
export const DEFAULT_BROADCAST = "255.255.255.255";
const KEEPALIVE_MS = 5000;
/**
 * How long a device stays a unicast destination after its last PONG. Three
 * keep-alive PINGs' worth — long enough to ride out a couple of lost replies,
 * short enough that a device powered off mid-session stops being written to
 * (and, once the set empties, that we fall back to broadcast again).
 */
const DEFAULT_DEVICE_TTL_MS = KEEPALIVE_MS * 3;

export abstract class UdpTransportBase implements Transport {
  protected readonly port: number;
  /** Local receive-bind port. 0 = ephemeral (DEC-036 default). */
  protected readonly bindPort: number;
  protected readonly broadcastAddr: string;
  protected readonly appName: string;
  protected readonly deviceName: string;
  protected readonly group: number;
  protected readonly keepalive: boolean;
  protected readonly unicast: boolean;
  protected readonly deviceTtlMs: number;

  private seq = 0;
  private readonly devices = new Map<string, Device>();
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  /**
   * Destinations for the active stream session, snapshotted in streamBegin
   * (STREAM_DATA/END carry no target of their own). `null` = broadcast the
   * session; `[]` = the snapshot matched nobody, so send nothing.
   */
  private streamDests: string[] | null = null;

  constructor(options: HapbeatOptions = {}) {
    this.port = options.port ?? DEFAULT_UDP_PORT;
    this.bindPort = options.bindPort ?? 0; // ephemeral by default (DEC-036)
    this.broadcastAddr = options.broadcastAddr ?? DEFAULT_BROADCAST;
    this.appName = (options.appName ?? "").slice(0, protocol.MAX_APP_NAME_LEN);
    this.deviceName = options.deviceName ?? "";
    this.group = options.group ?? 0;
    this.keepalive = options.keepalive ?? true;
    this.unicast = options.unicast ?? true;
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
  }

  // --- platform hooks (implemented per environment) ---

  /** Open the socket, enable broadcast, and route each datagram to handleMessage. */
  protected abstract openSocket(): Promise<void>;
  /** Send raw bytes to (broadcastAddr, port). */
  protected abstract sendBytes(packet: Uint8Array): void;
  /** Send raw bytes to one device (ip, port). */
  protected abstract sendBytesTo(packet: Uint8Array, ip: string): void;
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

  // --- Send routing (unicast vs broadcast) ---
  //
  // Wi-Fi broadcast is held back by the AP: whenever any client on it is
  // power-saving, group-addressed frames are buffered until the next DTIM
  // beacon (100-300 ms). That is a late haptic on a one-shot command and
  // periodic dropouts in a clip stream, and the device cannot avoid it (the
  // delay is caused by *other* clients). Unicast frames are not batched, and
  // get MAC-level ACK/retry as a bonus. Measured on the Unity SDK first.

  /** Alive devices whose address accepts `target`.
   *
   * A device that has not reported an address (older firmware, or no PONG
   * parsed yet) is kept — fail open. Worst case is one extra unicast packet
   * that the device filters out itself; the opposite mistake silently drops a
   * command the device would have accepted. */
  private matchingIps(target: string): string[] {
    const cutoff = Date.now() - this.deviceTtlMs;
    const ips: string[] = [];
    for (const dev of this.devices.values()) {
      if (dev.lastSeen < cutoff) continue;
      if (!dev.address || protocol.addressMatches(target, dev.address)) ips.push(dev.ip);
    }
    return ips;
  }

  /** Send one PLAY/STOP/STOP_ALL, unicast when we can.
   *
   * Falls back to broadcast when unicast is off, when no device has PONGed
   * recently, *and* when every alive device's address mismatches — never
   * skipping the send. The device re-applies the same target filter on
   * receipt, so a broadcast can never fire a device the target did not
   * address; whereas skipping would silently lose the packet whenever our
   * cached address is stale (a STOP lost that way leaves a loop running).
   * Never both: firmware older than the (src ip, seq) dedupe would fire the
   * same PLAY twice. */
  private sendRouted(packet: Uint8Array, target: string): void {
    if (!this.unicast) return this.sendBytes(packet);
    const ips = this.matchingIps(target);
    if (ips.length === 0) return this.sendBytes(packet);
    for (const ip of ips) this.sendBytesTo(packet, ip);
  }

  /** Pick destinations for one stream session (see `streamDests`).
   *
   * Unlike a one-shot command, a filtered-to-empty result means *send nothing*
   * rather than broadcast: a stream is hundreds of packets, and blasting all
   * of them at devices the target excluded wastes far more airtime than a lost
   * stream costs (the device just stays silent — nothing gets stuck, unlike a
   * lost STOP). */
  private snapshotStreamDests(target: string | undefined): void {
    if (!this.unicast) {
      this.streamDests = null;
      return;
    }
    const cutoff = Date.now() - this.deviceTtlMs;
    const alive = [...this.devices.values()].filter((d) => d.lastSeen >= cutoff);
    this.streamDests = alive.length === 0
      ? null // nobody known yet -> broadcast
      : alive.filter((d) => !d.address || protocol.addressMatches(target, d.address)).map((d) => d.ip);
  }

  private sendStream(packet: Uint8Array): void {
    const dests = this.streamDests;
    if (dests === null) return this.sendBytes(packet);
    for (const ip of dests) this.sendBytesTo(packet, ip);
  }

  // --- Transport surface (shared) ---

  async connect(): Promise<void> {
    await this.openSocket();
    if (this.keepalive) this.startKeepalive();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  play(eventId: string, gain: number, target: string, targetTimeUs: number): void {
    this.sendRouted(protocol.buildPlay(this.nextSeq(), eventId, { target, targetTimeUs, gain }), target);
  }

  stop(eventId: string, target: string): void {
    this.sendRouted(protocol.buildStop(this.nextSeq(), eventId, target), target);
  }

  stopAll(target: string): void {
    this.sendRouted(protocol.buildStopAll(this.nextSeq(), target), target);
  }

  /** Always broadcast: discovery has to reach devices we have not heard from. */
  ping(): void {
    this.sendBytes(protocol.buildPing(this.nextSeq(), Date.now() * 1000));
  }

  streamBegin(meta: StreamMeta): void {
    this.snapshotStreamDests(meta.target);
    this.sendStream(
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
    this.sendStream(protocol.buildStreamData(this.nextSeq(), offset, data));
  }

  streamEnd(): void {
    this.sendStream(protocol.buildStreamEnd(this.nextSeq()));
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

  /**
   * Periodic PING (+ CONNECT_STATUS when an app name is set).
   *
   * The PING is what keeps unicast working: the device answers PONG *only* to
   * a PING (CONNECT_STATUS gets no reply), so without this every device would
   * age out of the destination table after `deviceTtlMs` and the session would
   * silently fall back to broadcast forever. It doubles as discovery for
   * devices that join late.
   */
  private startKeepalive(): void {
    this.tick();
    this.keepaliveTimer = setInterval(() => this.tick(), KEEPALIVE_MS);
  }

  private tick(): void {
    this.ping();
    if (this.appName) this.connectStatus(true);
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
