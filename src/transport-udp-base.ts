/**
 * Shared UDP transport: builds raw Layer 1 packets (via `protocol`) and sends
 * them over a datagram socket, either straight to a known device (unicast) or
 * to the broadcast address. The platform-specific socket plumbing (open / send
 * / close) is left abstract so the Node (`node:dgram`) and React Native
 * (`react-native-udp`) transports stay byte-for-byte identical on the wire and
 * share all protocol logic, keepalive, discovery, and device tracking.
 */

import * as protocol from "./protocol.js";
import type { StreamEndpoint } from "./stream.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";

export const DEFAULT_UDP_PORT = 7700;
export const DEFAULT_BROADCAST = "255.255.255.255";
const KEEPALIVE_MS = 5000;

/** A local IPv4 address with its netmask, as reported by the platform. */
export interface LocalSubnet {
  address: string;
  netmask: string;
}

/**
 * One address the SDK can broadcast to.
 *
 * `255.255.255.255` leaves a multi-homed host through the single interface with
 * the lowest metric. On a machine running Hyper-V / WSL2 / Docker that is often
 * an always-up virtual switch with no Hapbeat behind it — and no Ethernet cable
 * is needed for that to happen, which is why the symptom looks nothing like
 * "multi-homed". A subnet-directed address (`192.168.0.255`) resolves through
 * the directly-connected route for its subnet instead, so the metric never
 * applies. That is also why hapbeat-helper kept working on such a host: it
 * finds devices over mDNS and unicasts, which resolves the same way.
 */
export interface BroadcastRoute {
  addr: string;
  /** Host-order network and mask; both 0 for the limited-broadcast catch-all. */
  network: number;
  mask: number;
  limited: boolean;
}

function toUint32(dotted: string): number | null {
  const parts = dotted.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = (value * 256) + byte;
  }
  return value;
}

function toDotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

/** Whether `ip` sits on this route's subnet. */
export function routeContains(route: BroadcastRoute, ip: string): boolean {
  if (route.limited || route.mask === 0) return false;
  const value = toUint32(ip);
  if (value === null) return false;
  return ((value & route.mask) >>> 0) === route.network;
}

/**
 * One destination per local IPv4 subnet, plus the limited broadcast.
 *
 * The address comes from each interface's real mask rather than being assumed
 * to end in `.255`: a /16 broadcasts to `x.y.255.255` and a /25 to
 * `x.y.z.127`, and the subnet itself is whatever the router hands out.
 * Deduplicated by address — two interfaces on one subnet (a laptop docked over
 * Ethernet while Wi-Fi is still up) would otherwise deliver every packet twice.
 *
 * The limited broadcast is always kept as a catch-all, so SoftAP setups and
 * platforms whose interfaces cannot be enumerated (React Native) behave exactly
 * as before.
 */
export function computeBroadcastRoutes(subnets: readonly LocalSubnet[]): BroadcastRoute[] {
  const routes: BroadcastRoute[] = [];
  const seen = new Set<string>();

  for (const { address, netmask } of subnets) {
    const ip = toUint32(address);
    const mask = toUint32(netmask);
    if (ip === null || mask === null || mask === 0) continue;
    if (address.startsWith("127.")) continue;
    // Reject a non-contiguous mask rather than guess at it: the broadcast
    // address it produced would reach the wrong hosts.
    const inverted = (~mask) >>> 0;
    if ((inverted & (inverted + 1)) !== 0) continue;

    const addr = toDotted(((ip & mask) | inverted) >>> 0);
    if (seen.has(addr)) continue;
    seen.add(addr);
    routes.push({ addr, network: (ip & mask) >>> 0, mask, limited: false });
  }

  routes.push({ addr: DEFAULT_BROADCAST, network: 0, mask: 0, limited: true });
  return routes;
}
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
   * Candidate broadcast destinations, rebuilt on every connect() — a host's
   * interfaces change when a laptop is docked, a VPN comes up or Wi-Fi moves to
   * another network.
   */
  private routes: BroadcastRoute[] = [];
  /** The route a device actually answered on; null until the first PONG. */
  private lockedRoute: BroadcastRoute | null = null;
  /**
   * An explicit `broadcastAddr` is the caller naming the destination, so it is
   * honoured verbatim: no enumeration, no fan-out, no route locking. That
   * doubles as the escape hatch for pinning the destination by hand, which is
   * why there is no separate setting.
   */
  private readonly autoRoutes: boolean;
  /** Destinations currently in a failed state, so each outage is logged once. */
  private readonly failedDestinations = new Set<string>();

  constructor(options: HapbeatOptions = {}) {
    this.port = options.port ?? DEFAULT_UDP_PORT;
    this.bindPort = options.bindPort ?? 0; // ephemeral by default (DEC-036)
    this.broadcastAddr = options.broadcastAddr ?? DEFAULT_BROADCAST;
    this.autoRoutes = this.broadcastAddr === DEFAULT_BROADCAST;
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
  /**
   * Send raw bytes to one destination (ip, port).
   *
   * `bestEffort` marks one leg of a discovery fan-out, where a failure is
   * routine rather than newsworthy — see `noteSendFailed`.
   */
  protected abstract sendBytesTo(packet: Uint8Array, ip: string, bestEffort?: boolean): void;
  /** Close the socket. */
  protected abstract closeSocket(): void;

  /**
   * Local IPv4 addresses with masks, used to derive subnet-directed broadcast
   * destinations. Empty by default: a platform that cannot enumerate its
   * interfaces (React Native) keeps the limited-broadcast behaviour it had.
   */
  protected localSubnets(): LocalSubnet[] {
    return [];
  }

  // --- Broadcast destinations ---

  /**
   * The single address a broadcast currently goes to. Once a device has
   * answered this is its subnet's broadcast address; before that (and whenever
   * the caller named `broadcastAddr`) it is the limited broadcast, exactly as
   * it has always been.
   */
  protected broadcastDestination(): string {
    return this.lockedRoute?.addr ?? this.broadcastAddr;
  }

  /** Send to the single current broadcast destination. */
  protected sendBytes(packet: Uint8Array): void {
    this.sendBytesTo(packet, this.broadcastDestination());
  }

  /**
   * Send on every candidate broadcast destination.
   *
   * Reserved for PING and CONNECT_STATUS. Both are idempotent, so a device
   * reachable on two destinations simply receives the message twice with no
   * visible effect — whereas duplicating PLAY would fire the haptic twice on
   * firmware that predates sequence de-duplication. This fan-out is what
   * reaches a device the limited broadcast never gets to, and the PONG it
   * provokes is what pins playback to the right subnet.
   */
  private sendDiscovery(packet: Uint8Array): void {
    // Already pinned to a subnet, or nothing enumerated to fan out over.
    if (this.lockedRoute !== null || this.routes.length === 0) {
      return this.sendBytes(packet);
    }
    for (const route of this.routes) this.sendBytesTo(packet, route.addr, true);
  }

  /**
   * Pin broadcasts to the subnet a device actually replied from.
   *
   * First reply wins, and the choice lasts until the next connect(). With
   * devices on two subnets at once this settles on whichever answered first;
   * broadcasts do not cross subnets anyway, so the alternative is not reaching
   * both, it is reaching neither reliably.
   */
  private lockRouteFor(ip: string): void {
    if (this.lockedRoute !== null || this.routes.length === 0) return;
    for (const route of this.routes) {
      if (!routeContains(route, ip)) continue;
      this.lockedRoute = route;
      console.info(`[hapbeat] broadcasting to ${route.addr} (a device answered from ${ip}).`);
      return;
    }
  }

  // --- Send failure reporting ---

  /**
   * Report a failed send at most once per destination, per outage.
   *
   * A link that fails keeps failing, and stream chunks go out roughly 100 times
   * a second — logging every one would bury the very lines an operator needs.
   * Tracked per destination rather than globally: a host normally has an
   * adapter that can never carry a broadcast (Bluetooth PAN, Wi-Fi Direct, an
   * idle virtual switch), and one shared flag would flip between "failed" and
   * "recovered" on every fan-out.
   *
   * `bestEffort` legs stay silent: trying a destination that turns out to be
   * dead and letting the others through is exactly what the fan-out is for, and
   * a failure there is not evidence that anything is wrong. Failures on the
   * single destination that carries playback are reported.
   */
  protected noteSendFailed(dst: string, message: string, bestEffort = false): void {
    if (this.failedDestinations.has(dst)) return;
    this.failedDestinations.add(dst);
    if (bestEffort) return;
    console.warn(
      `[hapbeat] udp send to ${dst} failed: ${message}. The socket stays open; ` +
      "further send errors to this destination are silenced until it recovers.",
    );
  }

  /**
   * Note that a destination works again, once. Without this an unattended
   * installation's log shows when haptics broke but never whether they
   * came back.
   */
  protected noteSendOk(dst: string): void {
    if (!this.failedDestinations.delete(dst)) return;
    console.info(`[hapbeat] udp sending to ${dst} recovered.`);
  }

  /** Subclasses call this for every received datagram. */
  protected handleMessage(msg: Uint8Array, ip: string): void {
    const pong = protocol.parsePong(msg);
    if (!pong) return;
    // A reply proves which subnet the device is really on. Until this happens a
    // broadcast still goes out limited, which on a multi-homed host may be
    // leaving through an interface with no Hapbeat behind it.
    this.lockRouteFor(ip);
    // A device can obtain a new DHCP address while the previous PONG entry is
    // still inside the TTL. Treat the stable PONG name+address pair as one
    // identity so StreamHub sees an atomic route replacement instead of two
    // endpoints (which would otherwise start a second session at cursor zero).
    if (pong.deviceName && pong.address) {
      for (const [knownIp, known] of this.devices) {
        if (knownIp === ip) continue;
        if (known.name === pong.deviceName && known.address === pong.address) {
          this.devices.delete(knownIp);
        }
      }
    }
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

  // --- Transport surface (shared) ---

  async connect(): Promise<void> {
    this.routes = this.autoRoutes ? computeBroadcastRoutes(this.localSubnets()) : [];
    this.lockedRoute = null;
    this.failedDestinations.clear();
    await this.openSocket();
    if (this.keepalive) this.startKeepalive();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  play(eventId: string, gain: number, target: string, targetTimeUs: number, pan = 0): void {
    this.sendRouted(protocol.buildPlay(this.nextSeq(), eventId, { target, targetTimeUs, gain, pan }), target);
  }

  stop(eventId: string, target: string): void {
    this.sendRouted(protocol.buildStop(this.nextSeq(), eventId, target), target);
  }

  stopAll(target: string): void {
    this.sendRouted(protocol.buildStopAll(this.nextSeq(), target), target);
  }

  /**
   * Discovery has to reach devices we have not heard from, so this fans out
   * across every local subnet until one answers — which is what finds a Hapbeat
   * the limited broadcast cannot reach on a multi-homed host.
   */
  ping(): void {
    this.sendDiscovery(protocol.buildPing(this.nextSeq(), Date.now() * 1000));
  }

  /** Exact PONG-reported endpoints available for WifiUdp streaming.
   *
   * There is intentionally no broadcast fallback. STREAM_DATA and STREAM_END
   * contain no target, so one independent wire session is required per device
   * endpoint to keep concurrent targets isolated.
   */
  streamEndpoints(): StreamEndpoint[] {
    const cutoff = Date.now() - this.deviceTtlMs;
    return [...this.devices.values()]
      .filter((device) => device.lastSeen >= cutoff && Boolean(device.address))
      .map((device) => ({ ip: device.ip, address: device.address!, port: this.port }));
  }

  streamBeginEndpoint(endpoint: StreamEndpoint): void {
    this.sendBytesTo(
      protocol.buildStreamBegin(this.nextSeq(), {
        sampleRate: 16000,
        channels: 2,
        format: protocol.STREAM_FORMAT_PCM16,
        totalSamples: 0,
        gain: 1,
        target: endpoint.address,
      }),
      endpoint.ip,
    );
  }

  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array): void {
    this.sendBytesTo(protocol.buildStreamData(this.nextSeq(), offset, data), endpoint.ip);
  }

  streamEndEndpoint(endpoint: StreamEndpoint): void {
    this.sendBytesTo(protocol.buildStreamEnd(this.nextSeq()), endpoint.ip);
  }

  private connectStatus(connected: boolean): void {
    // Idempotent display state, so it can share the discovery fan-out and clear
    // "app not connected" without waiting for a PONG first.
    this.sendDiscovery(
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
