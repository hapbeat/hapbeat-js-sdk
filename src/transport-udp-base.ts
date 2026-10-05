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

/**
 * Whether two routes are the same local network.
 *
 * Network and mask rather than the address alone, because the question is
 * whether the network a lock was taken on still exists.
 * Contract: hapbeat-contracts `specs/message-format.md` §2.1.
 */
export function sameSubnet(a: BroadcastRoute, b: BroadcastRoute): boolean {
  return a.limited === b.limited && a.network === b.network && a.mask === b.mask;
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
/**
 * Re-enumerating the host's interfaces is a system call, so it happens only on
 * discovery sends and at most once per this many ms (the keep-alive period is
 * 5 s, well above it).
 */
const ROUTE_REFRESH_MIN_INTERVAL_MS = 1000;

// --- Stream session v2 + legacy fallback (contracts stream-session-v2.md) ---

/**
 * A broadcast PING is answered by every device, so a pending request is not
 * consumed by its first reply; it ages out instead.
 */
const PENDING_PING_TTL_MS = 15_000;
const MAX_GENERATION = 0xffffffff;

/**
 * Per-device stream receiver class, decided ONLY from matched direct replies
 * to this transport's own extended PING ("Legacy receiver fallback (SDK)").
 * unknown: no matched reply yet, streams defer. v2: valid HBS2 tail, lease
 * rules apply. legacy: no HBS2 marker, v1 stream + 300 ms END -> BEGIN guard.
 */
type StreamClass = "unknown" | "v2" | "legacy";

interface EndpointStreamState {
  cls: StreamClass;
  /** v2 only: the lease the device issued for clientIncarnation. */
  bootId: bigint;
  ticket: number;
  leaseValid: boolean;
  leaseSuperseded: boolean;
  /** Incarnation of the PING whose matched reply produced this state. */
  clientIncarnation: bigint;
  /**
   * Echoed timestamp of the last accepted matched reply, across both classes.
   * A reply to an older-or-equal request never changes the class or lease
   * again, so a late PONG cannot roll the device back to an older boot.
   */
  lastAcceptedTimestampUs: bigint;
}

interface PendingPing {
  /** Timestamp written on the wire; a matched PONG echoes it exactly. */
  timestampUs: bigint;
  clientIncarnation: bigint;
  sentAt: number;
}

/** Wire state of one endpoint session, fixed when it begins. */
export type StreamWire =
  | { format: "legacy" }
  | { format: "v2"; identity: protocol.StreamSessionIdentity };

/** wireEpoch of an alive endpoint whose streams must defer (see streamEndpoints). */
const DEFERRED_EPOCH = "deferred";

/**
 * What a PONG may do to its device's stream state: `null` = nothing (ordinary
 * discovery; unsolicited, unmatched, late and malformed-HBS2 replies),
 * `"discard"` = drop the whole PONG (a structurally valid HBS2 reply for a
 * retired request or a previous incarnation must not refresh the device
 * either), otherwise the device's new state.
 *
 * Correlation: the seq maps to a pending request whose timestamp equals the
 * echoed one, issued by the current incarnation, newer than the last accepted
 * reply for this device. Mirrors the Unity / Unreal SDKs.
 */
function evaluatePongLease(
  pong: protocol.Pong,
  pending: PendingPing | undefined,
  currentIncarnation: bigint,
  existing: EndpointStreamState | undefined,
): EndpointStreamState | "discard" | null {
  if (pong.leaseTail === "malformed") return null; // neither a lease nor proof of old firmware

  if (pong.leaseTail === "valid") {
    if (currentIncarnation === 0n || pong.echoedClientIncarnation !== currentIncarnation) return "discard";
    if (
      pong.timestamp === 0n || !pending
      || pending.timestampUs !== pong.timestamp
      || pending.clientIncarnation !== pong.echoedClientIncarnation
    ) return "discard";
    if (existing && pong.timestamp <= existing.lastAcceptedTimestampUs) return "discard";
    // A superseded writer must not turn a later periodic reply into an
    // implicit takeover; only a fresh incarnation clears the latch.
    const keepSuperseded = existing?.cls === "v2"
      && existing.leaseSuperseded
      && existing.clientIncarnation === pending.clientIncarnation;
    return {
      cls: "v2",
      bootId: keepSuperseded ? existing.bootId : pong.bootId ?? 0n,
      ticket: keepSuperseded ? existing.ticket : pong.leaseTicket ?? 0,
      leaseValid: keepSuperseded ? false : Boolean(pong.leaseValid),
      leaseSuperseded: keepSuperseded ? true : Boolean(pong.leaseSuperseded),
      clientIncarnation: pending.clientIncarnation,
      lastAcceptedTimestampUs: pong.timestamp,
    };
  }

  // No HBS2 marker. Pre-v2 firmware cannot echo the incarnation, so the
  // request itself must belong to the current incarnation.
  if (pong.timestamp === 0n) return null; // unsolicited identity PONG
  if (
    currentIncarnation === 0n || !pending
    || pending.timestampUs !== pong.timestamp
    || pending.clientIncarnation !== currentIncarnation
  ) return null; // a reply to some other request
  if (existing && pong.timestamp <= existing.lastAcceptedTimestampUs) return null; // late reply
  return {
    cls: "legacy",
    bootId: 0n,
    ticket: 0,
    leaseValid: false,
    leaseSuperseded: false,
    clientIncarnation: pending.clientIncarnation,
    lastAcceptedTimestampUs: pong.timestamp,
  };
}

/** A fresh nonzero u64 client incarnation. */
function newClientIncarnation(): bigint {
  const words = new Uint32Array(2);
  const crypto = (globalThis as { crypto?: { getRandomValues?(a: Uint32Array): Uint32Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(words);
  else for (let i = 0; i < words.length; i++) words[i] = Math.floor(Math.random() * 0x1_0000_0000);
  const value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
  return value === 0n ? 1n : value;
}

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
   * Candidate broadcast destinations, rebuilt on connect() and again on
   * discovery sends (refreshRoutes) — a host's interfaces change when a laptop
   * is docked, a VPN comes up or Wi-Fi moves to another network, and none of
   * that closes the socket.
   */
  private routes: BroadcastRoute[] = [];
  private routesEnumeratedAt = 0;
  /**
   * The route a device actually answered on; null until the first PONG, and
   * again once the lock is released (see refreshRoutes).
   */
  private lockedRoute: BroadcastRoute | null = null;
  /** When a PONG last came from inside the locked route's subnet. */
  private lockedRouteSeenAt = 0;
  /**
   * An explicit `broadcastAddr` is the caller naming the destination, so it is
   * honoured verbatim: no enumeration, no fan-out, no route locking. That
   * doubles as the escape hatch for pinning the destination by hand, which is
   * why there is no separate setting.
   */
  private readonly autoRoutes: boolean;
  /** Destinations currently in a failed state, so each outage is logged once. */
  private readonly failedDestinations = new Set<string>();

  /** Sent in every PING; renewed on connect() and reacquireStreamOwnership(). */
  private clientIncarnation = 0n;
  /** PING timestamps are strictly increasing, across incarnations too. */
  private lastPingTimestampUs = 0n;
  private readonly pendingPings = new Map<number, PendingPing>();
  /** Stream class / lease per device ip (the device's, not the route's). */
  private readonly streamStates = new Map<string, EndpointStreamState>();
  /** Last generation used per lease ("boot:ticket"); never reused. */
  private readonly lastGenerations = new Map<string, number>();

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
    this.refreshRoutes();
    // Already pinned to a subnet, or nothing enumerated to fan out over.
    if (this.lockedRoute !== null || this.routes.length === 0) {
      return this.sendBytes(packet);
    }
    for (const route of this.routes) this.sendBytesTo(packet, route.addr, true);
  }

  /**
   * Pin broadcasts to the subnet a device actually replied from.
   *
   * Called for every PONG. First reply wins, and later replies from the same
   * subnet keep the lock fresh. With devices on two subnets at once this
   * settles on whichever answered first; broadcasts do not cross subnets
   * anyway, so the alternative is not reaching both, it is reaching neither
   * reliably. refreshRoutes releases the lock again.
   */
  private lockRouteFor(ip: string): void {
    const locked = this.lockedRoute;
    if (locked !== null) {
      if (routeContains(locked, ip)) this.lockedRouteSeenAt = Date.now();
      return;
    }
    for (const route of this.routes) {
      if (!routeContains(route, ip)) continue;
      this.lockedRouteSeenAt = Date.now();
      this.lockedRoute = route;
      console.info(`[hapbeat] broadcasting to ${route.addr} (a device answered from ${ip}).`);
      return;
    }
  }

  /**
   * Follow the host's networks, and let go of a lock that went stale.
   *
   * A lock that lasted until the next connect() broke a session for good when
   * the PC moved to another Wi-Fi network: every PING still went to the old
   * subnet, devices on the new one were never found, and only a restart
   * recovered (contracts message-format.md §2.1).
   *
   * The lock is released when its network is no longer among the host's
   * interfaces, or when no device has answered from it for `deviceTtlMs` — the
   * latter catches a switch the interface list cannot show, such as a new
   * network that reuses the old subnet number. The next PING then fans out
   * again and the first PONG locks anew. Discovery sends only: never on the
   * PLAY / STOP / STREAM path.
   */
  private refreshRoutes(): void {
    if (!this.autoRoutes) return;
    const now = Date.now();
    if (now - this.routesEnumeratedAt >= ROUTE_REFRESH_MIN_INTERVAL_MS) {
      const routes = computeBroadcastRoutes(this.localSubnets());
      this.routesEnumeratedAt = now;
      const addrs = routes.map((r) => r.addr);
      if (addrs.join(",") !== this.routes.map((r) => r.addr).join(",")) {
        console.info(`[hapbeat] local networks changed; discovery now goes to ${addrs.join(", ")}.`);
      }
      this.routes = routes;
    }
    const locked = this.lockedRoute;
    if (locked === null) return;
    let reason: string;
    if (!this.routes.some((route) => sameSubnet(route, locked))) {
      reason = "that network is gone";
    } else if (now - this.lockedRouteSeenAt > this.deviceTtlMs) {
      reason = `no device answered from it for ${Math.round(this.deviceTtlMs / 1000)} s`;
    } else {
      return;
    }
    this.lockedRoute = null;
    console.info(
      `[hapbeat] no longer broadcasting to ${locked.addr} only (${reason}); ` +
      "probing every local network again.",
    );
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
    // A device can obtain a new DHCP address while the previous PONG entry is
    // still inside the TTL. Treat the stable PONG name+address pair as one
    // identity so StreamHub sees an atomic route replacement instead of two
    // endpoints (which would otherwise start a second session at cursor zero).
    const previousIps: string[] = [];
    if (pong.deviceName && pong.address) {
      for (const [knownIp, known] of this.devices) {
        if (knownIp === ip) continue;
        if (known.name === pong.deviceName && known.address === pong.address) previousIps.push(knownIp);
      }
    }
    // The stream class / lease belongs to the device, not to the route it
    // answered from, so a moved device keeps it. Classified BEFORE anything is
    // updated: a discarded reply must not refresh the device either.
    const existing = this.streamStates.get(ip)
      ?? previousIps.map((knownIp) => this.streamStates.get(knownIp)).find((state) => state !== undefined);
    const decision = evaluatePongLease(pong, this.pendingPings.get(pong.seq), this.clientIncarnation, existing);
    if (decision === "discard") return;

    // A reply proves which subnet the device is really on. Until this happens a
    // broadcast still goes out limited, which on a multi-homed host may be
    // leaving through an interface with no Hapbeat behind it.
    this.lockRouteFor(ip);
    for (const knownIp of previousIps) {
      this.devices.delete(knownIp);
      this.streamStates.delete(knownIp);
    }
    if (decision !== null) this.noteStreamClass(ip, existing, decision);
    const state = decision ?? existing;
    if (state) this.streamStates.set(ip, state);
    const dev: Device = this.devices.get(ip) ?? { ip, lastSeen: 0 };
    dev.name = pong.deviceName ?? dev.name;
    dev.address = pong.address ?? dev.address;
    dev.firmwareVersion = pong.firmwareVersion ?? dev.firmwareVersion;
    dev.lastSeen = Date.now();
    this.devices.set(ip, dev);
  }

  /** Log a class change, and a lease newly superseded by another writer, once. */
  private noteStreamClass(ip: string, previous: EndpointStreamState | undefined, next: EndpointStreamState): void {
    if (previous?.cls !== next.cls) {
      console.info(
        `[hapbeat] stream receiver ${ip} classified as ` +
        `${next.cls === "v2" ? "stream session v2" : "legacy (pre-v2 firmware)"}.`,
      );
    }
    if (next.leaseSuperseded && !previous?.leaseSuperseded) {
      console.warn(
        `[hapbeat] stream lease at ${ip} was superseded by another writer; streams to it are deferred. ` +
        "Call Hapbeat.reacquireStreamOwnership() after the other writer has stopped.",
      );
    }
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
    this.routesEnumeratedAt = Date.now();
    this.lockedRoute = null;
    this.failedDestinations.clear();
    this.renewIncarnation();
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
    if (this.clientIncarnation === 0n) this.clientIncarnation = newClientIncarnation();
    const seq = this.nextSeq();
    // Strictly increasing: class / lease adoption is ordered by the echoed
    // timestamp, and two immediate PINGs may read the same clock value.
    let timestampUs = BigInt(Date.now()) * 1000n;
    if (timestampUs <= this.lastPingTimestampUs) timestampUs = this.lastPingTimestampUs + 1n;
    this.lastPingTimestampUs = timestampUs;
    const now = Date.now();
    for (const [pendingSeq, pending] of this.pendingPings) {
      if (now - pending.sentAt > PENDING_PING_TTL_MS) this.pendingPings.delete(pendingSeq);
    }
    this.pendingPings.set(seq, { timestampUs, clientIncarnation: this.clientIncarnation, sentAt: now });
    // Extended (16-byte) PING: v2 receivers answer with an HBS2 lease tail,
    // pre-v2 firmware ignores the extra bytes and answers an ordinary PONG.
    this.sendDiscovery(protocol.buildPing(seq, Number(timestampUs), this.clientIncarnation));
  }

  /**
   * Take stream ownership back after another writer superseded this one
   * (stream-session-v2.md): a fresh client incarnation, so every v2 device
   * issues a new lease on the next matched reply. A superseded lease is never
   * taken over automatically, to avoid two applications fighting over a
   * device; call this once the other writer has stopped. Running v2 sessions
   * end under the identity just relinquished; legacy devices are unaffected.
   */
  reacquireStreamOwnership(): void {
    this.renewIncarnation();
    this.ping();
  }

  /**
   * A new incarnation, no outstanding requests of the old one, and no v2 lease
   * of the old one. Legacy devices keep their class (pre-v2 firmware has no
   * lease). lastAcceptedTimestampUs is kept: PING timestamps keep increasing,
   * so a late reply to an old request still cannot roll anything back.
   */
  private renewIncarnation(): void {
    this.clientIncarnation = newClientIncarnation();
    this.pendingPings.clear();
    for (const [ip, state] of this.streamStates) {
      if (state.cls === "legacy") continue;
      this.streamStates.set(ip, {
        cls: "unknown", bootId: 0n, ticket: 0, leaseValid: false, leaseSuperseded: false,
        clientIncarnation: 0n, lastAcceptedTimestampUs: state.lastAcceptedTimestampUs,
      });
    }
  }

  /** The device may carry a session now: legacy, or a usable v2 lease. */
  private isStreamable(state: EndpointStreamState | undefined): state is EndpointStreamState {
    if (!state) return false;
    if (state.cls === "legacy") return true;
    return state.cls === "v2" && state.leaseValid && !state.leaseSuperseded
      && state.clientIncarnation === this.clientIncarnation
      && state.bootId !== 0n && state.ticket !== 0;
  }

  private wireEpoch(state: EndpointStreamState | undefined): string {
    if (!this.isStreamable(state)) return DEFERRED_EPOCH;
    return state.cls === "legacy" ? "legacy" : `v2:${state.bootId}:${state.ticket}`;
  }

  /** Exact PONG-reported endpoints available for WifiUdp streaming.
   *
   * There is intentionally no broadcast fallback. STREAM_DATA and STREAM_END
   * contain no target, so one independent wire session is required per device
   * endpoint to keep concurrent targets isolated.
   *
   * An alive device whose class is still unknown, or whose v2 lease is invalid
   * or superseded, is listed with the "deferred" wire epoch: StreamHub then
   * ends a running session there in its old format, and streamBeginEndpoint
   * refuses to start a new one, so its sources defer.
   */
  streamEndpoints(): StreamEndpoint[] {
    const cutoff = Date.now() - this.deviceTtlMs;
    return [...this.devices.values()]
      .filter((device) => device.lastSeen >= cutoff && Boolean(device.address))
      .map((device) => {
        const state = this.streamStates.get(device.ip);
        return {
          ip: device.ip,
          address: device.address!,
          port: this.port,
          legacy: state?.cls === "legacy",
          wireEpoch: this.wireEpoch(state),
        };
      });
  }

  /**
   * Begin a session in the device's current format. v2: a fresh generation
   * under its lease, never reused; exhaustion fails closed until the lease is
   * renewed. Returns false (sources defer) when the device cannot stream now
   * or its state moved on since `endpoint` was listed.
   */
  streamBeginEndpoint(endpoint: StreamEndpoint): StreamWire | false {
    const state = this.streamStates.get(endpoint.ip);
    if (!this.isStreamable(state) || this.wireEpoch(state) !== endpoint.wireEpoch) return false;
    const begin: protocol.StreamBeginOptions = {
      sampleRate: 16000,
      channels: 2,
      format: protocol.STREAM_FORMAT_PCM16,
      totalSamples: 0,
      gain: 1,
      target: endpoint.address,
    };
    if (state.cls === "legacy") {
      this.sendBytesTo(protocol.buildStreamBegin(this.nextSeq(), begin), endpoint.ip);
      return { format: "legacy" };
    }
    const leaseKey = `${state.bootId}:${state.ticket}`;
    const last = this.lastGenerations.get(leaseKey) ?? 0;
    if (last >= MAX_GENERATION) {
      console.warn(`[hapbeat] stream generation exhausted for ${endpoint.ip}; waiting for a new lease.`);
      return false;
    }
    const identity = { bootId: state.bootId, ticket: state.ticket, generation: last + 1 };
    this.lastGenerations.set(leaseKey, identity.generation);
    this.sendBytesTo(protocol.buildStreamBeginV2(this.nextSeq(), identity, begin), endpoint.ip);
    return { format: "v2", identity };
  }

  /** DATA in the format and identity its session began with. */
  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array, wire?: unknown): void {
    const session = wire as StreamWire | undefined;
    const packet = session?.format === "v2"
      ? protocol.buildStreamDataV2(this.nextSeq(), session.identity, offset, data)
      : protocol.buildStreamData(this.nextSeq(), offset, data);
    this.sendBytesTo(packet, endpoint.ip);
  }

  /** END in the format and identity its session began with. */
  streamEndEndpoint(endpoint: StreamEndpoint, wire?: unknown): void {
    const session = wire as StreamWire | undefined;
    const packet = session?.format === "v2"
      ? protocol.buildStreamEndV2(this.nextSeq(), session.identity)
      : protocol.buildStreamEnd(this.nextSeq());
    this.sendBytesTo(packet, endpoint.ip);
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
