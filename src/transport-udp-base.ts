/**
 * Shared UDP transport: builds raw Layer 1 packets (via `protocol`) and sends
 * them over a datagram socket, either straight to a known device (unicast) or
 * to the broadcast address. The platform-specific socket plumbing (open / send
 * / close) is left abstract so the Node (`node:dgram`) and React Native
 * (`react-native-udp`) transports stay byte-for-byte identical on the wire and
 * share all protocol logic, keepalive, discovery, and device tracking.
 */

import * as protocol from "./protocol.js";
import type {
  DeferredReason,
  StreamClass,
  StreamEndpoint,
  StreamEndpointInfo,
  StreamLeaseState,
  StreamSessionEvent,
} from "./stream.js";
import type { Device, HapbeatOptions, Transport } from "./types.js";
import { warnIfNewerGeneration } from "./version.js";

export const DEFAULT_UDP_PORT = 7700;
export const DEFAULT_BROADCAST = "255.255.255.255";
/** Discovery PING period; also the longest lease refresh interval (a 15 s TTL / 3). */
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

// --- Stream Gen 2 + Gen 1 fallback (contracts stream-session.md) ---

/** Lease TTL a device without CAPS stream_limits is assumed to use. */
const DEFAULT_LEASE_TTL_S = 15;
/**
 * How often due lease refreshes are looked for. An endpoint is refreshed once
 * its last extended PING is at least (interval - this) old, so the refresh
 * interval stays within min(5 s, TTL / 3) (Discovery lease, 1.x).
 */
const LEASE_CHECK_MS = 1000;
/** On-demand extended PINGs (a new source, an error) go to one ip at most this often. */
const LEASE_REQUEST_MIN_GAP_MS = 500;
/**
 * An extended PING is unicast, but a reply may still be late; a pending
 * request is kept this long, then ages out.
 */
const PENDING_PING_TTL_MS = 15_000;
const MAX_GENERATION = 0xffffffff;
/** CAPS_REQ: three tries, 500 ms apart (message-format.md §0x12). */
const CAPS_ATTEMPTS = 3;
const CAPS_RETRY_MS = 500;
/** BEGIN repetition (Sender requirement 2): before the first DATA blocks, then every 500 ms. */
const BEGIN_REPEAT_FIRST_DATA = 3;
const BEGIN_REPEAT_INTERVAL_MS = 500;
/** Codes that carry the rejected packet's envelope in `detail`. */
const STREAM_ERROR_FIRST = protocol.ERR_STREAM_LEASE_INVALID;
const STREAM_ERROR_LAST = protocol.ERR_STREAM_TARGET_MISMATCH;

/**
 * Per-device stream receiver class, decided ONLY from matched direct replies
 * to this transport's own extended PING ("Receiver classification").
 * unknown: no matched reply yet, streams defer. gen2: a Stream Gen 2 tail,
 * lease rules apply. gen1: no tail, Stream Gen 1 + 300 ms END -> BEGIN guard.
 */
type WireClass = StreamClass;

interface EndpointStreamState {
  cls: WireClass;
  /** Gen 2 only: the lease the device issued for clientIncarnation. */
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
  /** The extended PING was unicast here; a reply from elsewhere does not match. */
  ip: string;
}

const BEGIN_BODY: protocol.StreamBeginOptions = {
  sampleRate: 16000,
  channels: 2,
  format: protocol.STREAM_FORMAT_PCM16,
  totalSamples: 0,
  gain: 1,
};

/** A Stream Gen 2 session as this transport tracks it. */
interface Gen2Wire {
  format: "gen2";
  identity: protocol.StreamSessionIdentity;
  envelope: Uint8Array;
  /** Where the session's packets go now, and the address its BEGIN carries. */
  endpoint: StreamEndpoint;
  dataSent: number;
  lastBeginAt: number;
}

/** Wire state of one endpoint session, fixed when it begins. */
export type StreamWire = { format: "gen1" } | Gen2Wire;

/** What this transport keeps per device besides the class / lease. */
interface EndpointExtra {
  /**
   * Restart count, part of the Gen 2 wire epoch: raised when the device ended
   * or rejected the session (TIMED_OUT, LEASE_INVALID, TARGET_MISMATCH), so
   * StreamHub begins a new generation even when the ticket did not change.
   */
  restart: number;
  /** Last extended PING sent to this ip (0 = never). */
  lastLeaseRequestAt: number;
  /** Last session END sent here: the lease is kept for one TTL after it. */
  lastEndAt: number;
  ignoredTailWarned: boolean;
  caps?: protocol.DeviceCaps;
  /** idle: not asked; pending: CAPS_REQ outstanding; done; none: no answer (0.x). */
  capsStatus: "idle" | "pending" | "done" | "none";
  /** firmware_version | boot id the CAPS state belongs to. */
  capsKey: string;
  capsSeq: number;
  capsAttempts: number;
  capsTimer?: ReturnType<typeof setTimeout>;
  /** Command types the device answered with UNKNOWN_COMMAND. */
  unsupportedCommands: Set<number>;
  /** ERROR codes already logged for this device. */
  loggedErrors: Set<number>;
  currentWire?: Gen2Wire;
  endedWire?: Gen2Wire;
}

function newExtra(): EndpointExtra {
  return {
    restart: 0, lastLeaseRequestAt: 0, lastEndAt: Number.NEGATIVE_INFINITY, ignoredTailWarned: false,
    capsStatus: "idle", capsKey: "", capsSeq: -1, capsAttempts: 0,
    unsupportedCommands: new Set(), loggedErrors: new Set(),
  };
}

/** wireEpoch of an alive endpoint whose streams must defer (see streamEndpoints). */
const DEFERRED_EPOCH = "deferred";

/**
 * What a PONG may do to its device's stream state: `null` = nothing (ordinary
 * discovery; unsolicited, unmatched and late replies), `"ignored"` = a matched
 * reply whose tail this SDK cannot read (warn once, change nothing),
 * `"discard"` = drop the whole PONG (a Stream Gen 2 reply for a retired
 * request or a previous incarnation must not refresh the device either),
 * otherwise the device's new state.
 *
 * Correlation: the seq maps to a pending request sent to this ip whose
 * timestamp equals the echoed one, issued by the current incarnation, newer
 * than the last accepted reply for this device. Mirrors the other SDKs.
 */
function evaluatePongLease(
  pong: protocol.Pong,
  pending: PendingPing | undefined,
  ip: string,
  currentIncarnation: bigint,
  existing: EndpointStreamState | undefined,
): EndpointStreamState | "ignored" | "discard" | null {
  const matchesRequest = pong.timestamp !== 0n && pending !== undefined
    && pending.ip === ip && pending.timestampUs === pong.timestamp;

  if (pong.leaseTail === "ignored") {
    // Neither a lease nor proof of Stream Gen 1 firmware.
    return matchesRequest && pending.clientIncarnation === currentIncarnation ? "ignored" : null;
  }

  if (pong.leaseTail === "valid") {
    if (currentIncarnation === 0n || pong.echoedClientIncarnation !== currentIncarnation) return "discard";
    if (!matchesRequest || pending.clientIncarnation !== pong.echoedClientIncarnation) return "discard";
    if (existing && pong.timestamp <= existing.lastAcceptedTimestampUs) return "discard";
    // A superseded writer must not turn a later periodic reply into an
    // implicit takeover. Only a fresh incarnation, or a ticket the device
    // re-issued to us (lease_reissued, the other writer left), clears it.
    const reissued = Boolean(pong.leaseValid && !pong.leaseSuperseded && pong.leaseReissued);
    const keepSuperseded = existing?.cls === "gen2"
      && existing.leaseSuperseded
      && existing.clientIncarnation === pending.clientIncarnation
      && !reissued;
    return {
      cls: "gen2",
      bootId: keepSuperseded ? existing.bootId : pong.bootId ?? 0n,
      ticket: keepSuperseded ? existing.ticket : pong.leaseTicket ?? 0,
      leaseValid: keepSuperseded ? false : Boolean(pong.leaseValid),
      leaseSuperseded: keepSuperseded ? true : Boolean(pong.leaseSuperseded),
      clientIncarnation: pending.clientIncarnation,
      lastAcceptedTimestampUs: pong.timestamp,
    };
  }

  // No tail. Stream Gen 1 firmware cannot echo the incarnation, so the request
  // itself must belong to the current incarnation.
  if (!matchesRequest || currentIncarnation === 0n || pending.clientIncarnation !== currentIncarnation) {
    return null; // unsolicited, or a reply to some other request (an 8-byte discovery PING)
  }
  if (existing && pong.timestamp <= existing.lastAcceptedTimestampUs) return null; // late reply
  return {
    cls: "gen1",
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ERROR_NAMES: Record<number, string> = {
  [protocol.ERR_UNSUPPORTED_VERSION]: "UNSUPPORTED_VERSION",
  [protocol.ERR_UNKNOWN_COMMAND]: "UNKNOWN_COMMAND",
  [protocol.ERR_MALFORMED]: "MALFORMED",
  [protocol.ERR_STREAM_GEN_UNSUPPORTED]: "STREAM_GEN_UNSUPPORTED",
  [protocol.ERR_STREAM_LEASE_INVALID]: "STREAM_LEASE_INVALID",
  [protocol.ERR_STREAM_SUPERSEDED]: "STREAM_SUPERSEDED",
  [protocol.ERR_STREAM_NOT_STARTED]: "STREAM_NOT_STARTED",
  [protocol.ERR_STREAM_TIMED_OUT]: "STREAM_TIMED_OUT",
  [protocol.ERR_STREAM_STOPPED]: "STREAM_STOPPED",
  [protocol.ERR_STREAM_ENDED]: "STREAM_ENDED",
  [protocol.ERR_STREAM_TARGET_MISMATCH]: "STREAM_TARGET_MISMATCH",
};

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
  /** The app's default target: the endpoints it matches get stream leases. */
  private readonly defaultTarget: string;
  private readonly onStreamEndpointChanged?: (info: StreamEndpointInfo) => void;

  private seq = 0;
  private readonly knownDevices = new Map<string, Device>();
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setInterval>;
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

  /** Sent in every extended PING; renewed on connect(), resume and reacquireStreamOwnership(). */
  private clientIncarnation = 0n;
  /** PING timestamps are strictly increasing, across incarnations too. */
  private lastPingTimestampUs = 0n;
  private readonly pendingPings = new Map<number, PendingPing>();
  /** Stream class / lease per device ip (the device's, not the route's). */
  private readonly streamStates = new Map<string, EndpointStreamState>();
  private readonly extras = new Map<string, EndpointExtra>();
  /** Last generation used per lease ("boot:ticket"); never reused. */
  private readonly lastGenerations = new Map<string, number>();
  /** Leases whose generations ran out (warned once each). */
  private readonly exhaustedLeases = new Set<string>();
  /** What onStreamEndpointChanged last reported per ip. */
  private readonly reportedEndpoints = new Map<string, string>();
  private streamInterest?: () => readonly string[];
  private sessionListener?: (event: StreamSessionEvent) => void;

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
    this.defaultTarget = options.defaultTarget ?? "";
    this.onStreamEndpointChanged = options.onStreamEndpointChanged;
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
   * Reserved for the 8-byte discovery PING and CONNECT_STATUS. Both are
   * idempotent, so a device reachable on two destinations simply receives the
   * message twice with no visible effect — whereas duplicating PLAY would fire
   * the haptic twice on firmware that predates sequence de-duplication. This
   * fan-out is what reaches a device the limited broadcast never gets to, and
   * the PONG it provokes is what pins playback to the right subnet.
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

  // --- Receiving ---

  /** Subclasses call this for every received datagram, with its source ip and UDP port. */
  protected handleMessage(msg: Uint8Array, ip: string, port: number): void {
    if (msg.length < protocol.HEADER_SIZE) return;
    switch (msg[3]) {
      case protocol.CMD_PONG: return this.handlePong(msg, ip);
      case protocol.CMD_CAPS: return this.handleCaps(msg, ip, port);
      case protocol.CMD_ERROR: return this.handleError(msg, ip, port);
      default: return; // unknown and SDK-bound commands are ignored (versioning.md §7.1)
    }
  }

  private extraFor(ip: string): EndpointExtra {
    let extra = this.extras.get(ip);
    if (!extra) {
      extra = newExtra();
      this.extras.set(ip, extra);
    }
    return extra;
  }

  private handlePong(msg: Uint8Array, ip: string): void {
    const pong = protocol.parsePong(msg);
    if (!pong) return;
    // A device can obtain a new DHCP address while the previous PONG entry is
    // still inside the TTL. Treat the stable PONG name+address pair as one
    // identity so StreamHub sees an atomic route replacement instead of two
    // endpoints (which would otherwise start a second session at cursor zero).
    const previousIps: string[] = [];
    if (pong.deviceName && pong.address) {
      for (const [knownIp, known] of this.knownDevices) {
        if (knownIp === ip) continue;
        if (known.name === pong.deviceName && known.address === pong.address) previousIps.push(knownIp);
      }
    }
    // The stream class / lease belongs to the device, not to the route it
    // answered from, so a moved device keeps it. Classified BEFORE anything is
    // updated: a discarded reply must not refresh the device either.
    const existing = this.streamStates.get(ip)
      ?? previousIps.map((knownIp) => this.streamStates.get(knownIp)).find((state) => state !== undefined);
    const pending = this.pendingPings.get(pong.seq);
    const decision = evaluatePongLease(pong, pending, ip, this.clientIncarnation, existing);
    if (decision === "discard") return;
    if (decision !== null && pending?.ip === ip) this.pendingPings.delete(pong.seq); // unicast: one reply

    // A reply proves which subnet the device is really on. Until this happens a
    // broadcast still goes out limited, which on a multi-homed host may be
    // leaving through an interface with no Hapbeat behind it.
    this.lockRouteFor(ip);
    const wasAlive = this.isAlive(this.knownDevices.get(ip)) || previousIps.some((knownIp) => this.isAlive(this.knownDevices.get(knownIp)));
    let extra = this.extras.get(ip);
    for (const knownIp of previousIps) {
      const moved = this.extras.get(knownIp);
      if (moved && !extra) {
        extra = moved;
        this.extras.set(ip, moved);
      } else if (moved?.capsTimer) clearTimeout(moved.capsTimer);
      this.knownDevices.delete(knownIp);
      this.streamStates.delete(knownIp);
      this.extras.delete(knownIp);
      this.reportedEndpoints.delete(knownIp);
    }
    extra ??= this.extraFor(ip);
    if (decision === "ignored") {
      if (!extra.ignoredTailWarned) {
        extra.ignoredTailWarned = true;
        console.warn(
          `[hapbeat] the PONG from ${ip} carries a stream tail this SDK cannot read ` +
          "(a newer firmware major?); streams to it stay deferred.",
        );
      }
    } else if (decision !== null) {
      this.noteStreamClass(ip, existing, decision);
    }
    const state = decision !== null && decision !== "ignored" ? decision : existing;
    if (state) this.streamStates.set(ip, state);
    const dev: Device = this.knownDevices.get(ip) ?? { ip, lastSeen: 0 };
    dev.name = pong.deviceName ?? dev.name;
    dev.address = pong.address ?? dev.address;
    dev.firmwareVersion = pong.firmwareVersion ?? dev.firmwareVersion;
    dev.lastSeen = Date.now();
    this.knownDevices.set(ip, dev);

    if (decision !== null && decision !== "ignored") {
      // CAPS after the first matched reply, and again once the firmware or the
      // device boot changed (message-format.md §0x12).
      this.requestCapsIfNew(ip, extra, `${pong.firmwareVersion ?? ""}|${decision.cls === "gen2" ? decision.bootId : ""}`);
    } else if (!wasAlive && state?.cls !== "gen1" && !this.isStreamable(state) && this.isInterest(dev)) {
      // A device just found by discovery that this app may stream to: ask for
      // its lease now rather than at the next refresh.
      this.sendLeasePing(ip, extra);
    }
    this.emitEndpointChanges();
  }

  /** Log a class change, a lease newly superseded by another writer, and one taken back, once. */
  private noteStreamClass(ip: string, previous: EndpointStreamState | undefined, next: EndpointStreamState): void {
    if (previous?.cls !== next.cls) {
      console.info(
        `[hapbeat] stream receiver ${ip} classified as ` +
        `${next.cls === "gen2" ? "Stream Gen 2" : "Stream Gen 1 (sessionless)"}.`,
      );
    }
    if (next.leaseSuperseded && !previous?.leaseSuperseded) {
      console.warn(
        `[hapbeat] stream lease at ${ip} was superseded by another writer; streams to it are deferred. ` +
        "Call Hapbeat.reacquireStreamOwnership() after the other writer has stopped.",
      );
    } else if (previous?.cls === "gen2" && previous.leaseSuperseded && next.cls === "gen2"
      && !next.leaseSuperseded && next.clientIncarnation === previous.clientIncarnation) {
      console.info(`[hapbeat] ${ip} re-issued this client's stream lease (the other writer left); streams resume.`);
    }
  }

  private isAlive(device: Device | undefined): device is Device {
    return device !== undefined && device.lastSeen >= Date.now() - this.deviceTtlMs;
  }

  // --- CAPS (message-format.md §0x12 / §0x13) ---

  private requestCapsIfNew(ip: string, extra: EndpointExtra, key: string): void {
    if (extra.capsKey === key && extra.capsStatus !== "idle") return;
    if (extra.capsTimer) clearTimeout(extra.capsTimer);
    extra.capsKey = key;
    extra.caps = undefined;
    extra.capsStatus = "pending";
    extra.capsAttempts = 0;
    this.sendCapsReq(ip, extra);
  }

  private sendCapsReq(ip: string, extra: EndpointExtra): void {
    const seq = this.nextSeq();
    extra.capsSeq = seq;
    extra.capsAttempts++;
    this.sendBytesTo(protocol.buildCapsReq(seq), ip);
    const timer = setTimeout(() => {
      if (extra.capsTimer !== timer) return;
      extra.capsTimer = undefined;
      if (extra.capsStatus !== "pending" || extra.capsSeq !== seq) return;
      if (extra.capsAttempts < CAPS_ATTEMPTS) this.sendCapsReq(ip, extra);
      else extra.capsStatus = "none"; // 0.x firmware: no capability report this boot
    }, CAPS_RETRY_MS);
    (timer as { unref?: () => void }).unref?.();
    extra.capsTimer = timer;
  }

  private handleCaps(msg: Uint8Array, ip: string, port: number): void {
    if (port !== this.port || !this.knownDevices.has(ip)) return;
    const extra = this.extras.get(ip);
    const pkt = protocol.parsePacket(msg);
    const caps = protocol.parseCaps(msg);
    if (!extra || !pkt || !caps || extra.capsStatus !== "pending" || pkt.seq !== extra.capsSeq) return;
    if (extra.capsTimer) clearTimeout(extra.capsTimer);
    extra.capsTimer = undefined;
    extra.caps = caps;
    extra.capsStatus = "done";
    warnIfNewerGeneration("device", caps.generation, `The Hapbeat at ${ip}`);
  }

  // --- ERROR (message-format.md §0xFF, stream-session.md Sender requirement 5) ---

  private handleError(msg: Uint8Array, ip: string, port: number): void {
    // Only from a device this transport talks to, and from its port 7700: an
    // ERROR from anywhere else could be another sender's spoof.
    if (port !== this.port || !this.knownDevices.has(ip)) return;
    const error = protocol.parseError(msg);
    const extra = this.extras.get(ip);
    if (!error || !extra) return;
    const code = error.errorCode;

    if (code >= STREAM_ERROR_FIRST && code <= STREAM_ERROR_LAST) {
      // Only about a session this transport still tracks for that device.
      const detail = error.detail;
      if (!detail) return;
      const current = extra.currentWire && sameBytes(extra.currentWire.envelope, detail) ? extra.currentWire : undefined;
      if (!current && !(extra.endedWire && sameBytes(extra.endedWire.envelope, detail))) return;
      this.logErrorOnce(ip, extra, error);
      // An error about the session just ended needs nothing more: it is over.
      if (!current) return;
      const state = this.streamStates.get(ip);
      switch (code) {
        case protocol.ERR_STREAM_LEASE_INVALID:
          // Renew the lease and begin a new generation (a new restart count
          // makes it a new one even if the device returns the same ticket).
          if (state?.cls === "gen2") state.leaseValid = false;
          extra.restart++;
          this.sendLeasePing(ip, extra);
          break;
        case protocol.ERR_STREAM_SUPERSEDED:
          // Defer the endpoint; never take it back automatically.
          if (state?.cls === "gen2" && !state.leaseSuperseded) {
            this.noteStreamClass(ip, { ...state }, { ...state, leaseSuperseded: true });
            state.leaseSuperseded = true;
            state.leaseValid = false;
          }
          break;
        case protocol.ERR_STREAM_NOT_STARTED:
          this.sendBegin(current); // the BEGIN was lost: resend it at once
          break;
        case protocol.ERR_STREAM_TIMED_OUT:
          extra.restart++; // the device timed it out: begin a new generation
          break;
        case protocol.ERR_STREAM_STOPPED:
          this.sessionListener?.({ endpoint: current.endpoint, wire: current, kind: "stopped", reason: "stopped" });
          break;
        case protocol.ERR_STREAM_TARGET_MISMATCH:
          // Re-resolve: a new PONG brings the current address, and the new
          // generation's BEGIN carries it.
          extra.restart++;
          this.sendLeasePing(ip, extra);
          break;
        default: // STREAM_ENDED: logged above (a sender bug)
          break;
      }
      this.emitEndpointChanges();
      return;
    }

    this.logErrorOnce(ip, extra, error);
    if (code === protocol.ERR_STREAM_GEN_UNSUPPORTED) {
      // The class is stale (the device was updated): classify it again. The
      // device sends this at most once a second, so no rate limit here.
      this.sendLeasePing(ip, extra);
    } else if (code === protocol.ERR_UNKNOWN_COMMAND && error.refCommand !== undefined) {
      // Do not use that command on this device again.
      extra.unsupportedCommands.add(error.refCommand);
      if (error.refCommand === protocol.CMD_CAPS_REQ && extra.capsStatus === "pending") {
        if (extra.capsTimer) clearTimeout(extra.capsTimer);
        extra.capsTimer = undefined;
        extra.capsStatus = "none";
      }
    }
  }

  /** One log line per device and code: a rejected stream gets one ERROR a second. */
  private logErrorOnce(ip: string, extra: EndpointExtra, error: protocol.DeviceError): void {
    if (extra.loggedErrors.has(error.errorCode)) return;
    extra.loggedErrors.add(error.errorCode);
    const name = ERROR_NAMES[error.errorCode] ?? `0x${error.errorCode.toString(16).padStart(4, "0")}`;
    const text = `[hapbeat] ${ip} reported ${name}${error.message ? ` ("${error.message}")` : ""}.`;
    const warn = error.errorCode === protocol.ERR_STREAM_ENDED
      || error.errorCode === protocol.ERR_UNSUPPORTED_VERSION
      || error.errorCode === protocol.ERR_MALFORMED;
    if (warn) console.warn(`${text} This is likely an SDK bug; please report it.`);
    else console.info(text);
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
    for (const dev of this.knownDevices.values()) {
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
   * Discovery plus lease refresh, now: an 8-byte PING over the broadcast
   * fan-out (it has to reach devices we have not heard from, and finds a
   * Hapbeat the limited broadcast cannot reach on a multi-homed host), and an
   * extended PING by unicast to each endpoint this app may stream to.
   */
  ping(): void {
    this.discoveryPing();
    this.refreshLeases(true);
  }

  /** The 8-byte PING: discovery only, no lease, never correlated for classification. */
  private discoveryPing(): void {
    this.sendDiscovery(protocol.buildPing(this.nextSeq(), Date.now() * 1000));
  }

  /**
   * One extended (16-byte) PING to one device, by unicast. Stream Gen 2
   * receivers answer with the lease tail; Stream Gen 1 firmware ignores the
   * extra bytes and answers an ordinary PONG.
   */
  private sendLeasePing(ip: string, extra: EndpointExtra = this.extraFor(ip)): void {
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
    this.pendingPings.set(seq, { timestampUs, clientIncarnation: this.clientIncarnation, sentAt: now, ip });
    extra.lastLeaseRequestAt = now;
    this.sendBytesTo(protocol.buildPing(seq, Number(timestampUs), this.clientIncarnation), ip);
  }

  /** An on-demand extended PING, at most every 500 ms per ip. */
  private requestLease(ip: string, extra: EndpointExtra = this.extraFor(ip)): void {
    if (Date.now() - extra.lastLeaseRequestAt < LEASE_REQUEST_MIN_GAP_MS) return;
    this.sendLeasePing(ip, extra);
  }

  /** StreamHub: these endpoints defer for lack of a class or a lease. */
  requestLeases(endpoints: readonly StreamEndpoint[]): void {
    for (const endpoint of endpoints) {
      if (this.isAlive(this.knownDevices.get(endpoint.ip))) this.requestLease(endpoint.ip);
    }
  }

  setStreamInterest(provider: () => readonly string[]): void {
    this.streamInterest = provider;
  }

  setSessionListener(listener: (event: StreamSessionEvent) => void): void {
    this.sessionListener = listener;
  }

  /**
   * An endpoint this app may stream to: it matches the target of a Deferred
   * or Active Playback or the default target ("" matches every device), or a
   * session there ended within one lease TTL.
   */
  private isInterest(device: Device): boolean {
    if (!device.address) return false;
    const extra = this.extras.get(device.ip);
    if (extra && Date.now() - extra.lastEndAt < this.leaseTtlMs(extra)) return true;
    const targets = [this.defaultTarget, ...(this.streamInterest?.() ?? [])];
    return targets.some((target) => protocol.addressMatches(target, device.address));
  }

  private leaseTtlMs(extra: EndpointExtra | undefined): number {
    return (extra?.caps?.leaseTtlS || DEFAULT_LEASE_TTL_S) * 1000;
  }

  /**
   * Refresh the lease of every endpoint of interest whose last extended PING
   * is due: at most every min(5 s, TTL / 3) (Discovery lease, 1.x). `force`
   * sends to all of them now.
   */
  private refreshLeases(force: boolean): void {
    const now = Date.now();
    for (const device of this.knownDevices.values()) {
      if (!this.isAlive(device) || !this.isInterest(device)) continue;
      const extra = this.extraFor(device.ip);
      const interval = Math.min(KEEPALIVE_MS, this.leaseTtlMs(extra) / 3);
      if (force || now - extra.lastLeaseRequestAt >= interval - LEASE_CHECK_MS) this.sendLeasePing(device.ip, extra);
    }
  }

  /**
   * Take stream ownership back after another writer superseded this one
   * (stream-session.md): a fresh client incarnation, so every Stream Gen 2
   * device issues a new lease on the next matched reply, asked for at once by
   * unicast. A superseded lease is never taken over automatically, to avoid
   * two applications fighting over a device; call this once the other writer
   * has stopped. Running Gen 2 sessions end under the identity just
   * relinquished; Gen 1 devices are unaffected.
   */
  reacquireStreamOwnership(): void {
    this.renewIncarnation();
    this.refreshLeases(true);
  }

  /**
   * The app came back to the foreground (React Native): a fresh incarnation,
   * as the spec asks of a resume, and new leases at once.
   */
  protected resumeFromBackground(): void {
    this.renewIncarnation();
    this.refreshLeases(true);
  }

  /**
   * A new incarnation, no outstanding requests of the old one, and no Gen 2
   * lease of the old one. Gen 1 devices keep their class (that firmware has no
   * lease). lastAcceptedTimestampUs is kept: PING timestamps keep increasing,
   * so a late reply to an old request still cannot roll anything back.
   */
  private renewIncarnation(): void {
    this.clientIncarnation = newClientIncarnation();
    this.pendingPings.clear();
    for (const [ip, state] of this.streamStates) {
      if (state.cls === "gen1") continue;
      this.streamStates.set(ip, {
        cls: "unknown", bootId: 0n, ticket: 0, leaseValid: false, leaseSuperseded: false,
        clientIncarnation: 0n, lastAcceptedTimestampUs: state.lastAcceptedTimestampUs,
      });
    }
    this.emitEndpointChanges();
  }

  /** The device may carry a session now: Gen 1, or a usable Gen 2 lease. */
  private isStreamable(state: EndpointStreamState | undefined): state is EndpointStreamState {
    if (!state) return false;
    return state.cls === "gen1" || (state.cls === "gen2" && this.leaseUsable(state));
  }

  /** A Gen 2 lease of the current incarnation that is valid and not superseded. */
  private leaseUsable(state: EndpointStreamState): boolean {
    return state.leaseValid && !state.leaseSuperseded
      && state.clientIncarnation === this.clientIncarnation
      && state.bootId !== 0n && state.ticket !== 0;
  }

  private wireEpoch(state: EndpointStreamState | undefined, extra: EndpointExtra | undefined): string {
    if (!this.isStreamable(state)) return DEFERRED_EPOCH;
    return state.cls === "gen1" ? "gen1" : `gen2:${state.bootId}:${state.ticket}:${extra?.restart ?? 0}`;
  }

  private leaseState(state: EndpointStreamState | undefined): StreamLeaseState {
    if (state?.cls !== "gen2") return "none";
    if (state.leaseSuperseded) return "superseded";
    return this.leaseUsable(state) ? "valid" : "unavailable";
  }

  private deferredReason(state: EndpointStreamState | undefined): DeferredReason | undefined {
    if (!state || state.cls === "unknown") return "UnknownClass";
    if (state.cls === "gen1" || this.leaseUsable(state)) return undefined;
    return state.leaseSuperseded ? "Superseded" : "LeaseUnavailable";
  }

  /** Exact PONG-reported endpoints available for WifiUdp streaming.
   *
   * There is intentionally no broadcast fallback. STREAM_DATA and STREAM_END
   * contain no target, so one independent wire session is required per device
   * endpoint to keep concurrent targets isolated.
   *
   * An alive device whose class is still unknown, or whose Gen 2 lease is
   * invalid or superseded, is listed with the "deferred" wire epoch and the
   * reason: StreamHub then ends a running session there in its old format,
   * and streamBeginEndpoint refuses to start a new one, so its sources defer.
   */
  streamEndpoints(): StreamEndpoint[] {
    return [...this.knownDevices.values()]
      .filter((device) => this.isAlive(device) && Boolean(device.address))
      .map((device) => {
        const state = this.streamStates.get(device.ip);
        const extra = this.extras.get(device.ip);
        const endpoint: StreamEndpoint = {
          ip: device.ip,
          address: device.address!,
          port: this.port,
          legacy: state?.cls === "gen1",
          wireEpoch: this.wireEpoch(state, extra),
          streamClass: state?.cls ?? "unknown",
          leaseState: this.leaseState(state),
        };
        if (state?.cls === "gen1") endpoint.wireLineage = "gen1";
        else if (state?.cls === "gen2") endpoint.wireLineage = `gen2:${state.bootId}`;
        const reason = this.deferredReason(state);
        if (reason) endpoint.deferredReason = reason;
        if (extra?.caps?.hapticChannels !== undefined) endpoint.hapticChannels = extra.caps.hapticChannels;
        return endpoint;
      });
  }

  /** The known devices (alive within the TTL), without sending a PING. */
  devices(): Device[] {
    return [...this.knownDevices.values()]
      .filter((device) => this.isAlive(device))
      .map((device) => {
        const state = this.streamStates.get(device.ip);
        const caps = this.extras.get(device.ip)?.caps;
        const copy: Device = { ...device, streamClass: state?.cls ?? "unknown", leaseState: this.leaseState(state) };
        if (caps) copy.caps = { ...caps };
        return copy;
      });
  }

  /** Report class / lease changes once each (sdk-multi-stream.md §3). */
  private emitEndpointChanges(): void {
    if (!this.onStreamEndpointChanged) return;
    for (const endpoint of this.streamEndpoints()) {
      const info: StreamEndpointInfo = {
        ip: endpoint.ip, address: endpoint.address,
        streamClass: endpoint.streamClass, leaseState: endpoint.leaseState,
      };
      const reported = `${info.address}\0${info.streamClass}\0${info.leaseState}`;
      if (this.reportedEndpoints.get(info.ip) === reported) continue;
      this.reportedEndpoints.set(info.ip, reported);
      try {
        this.onStreamEndpointChanged(info);
      } catch (error) {
        console.warn("[hapbeat] onStreamEndpointChanged threw:", error);
      }
    }
  }

  /**
   * Begin a session in the device's current format. Gen 2: a fresh generation
   * under its lease, never reused; exhaustion warns once and renews the
   * incarnation for a new ticket. Returns false (sources defer) when the device
   * cannot stream now or its state moved on since `endpoint` was listed.
   */
  streamBeginEndpoint(endpoint: StreamEndpoint): StreamWire | false {
    const state = this.streamStates.get(endpoint.ip);
    const extra = this.extraFor(endpoint.ip);
    if (!this.isStreamable(state) || this.wireEpoch(state, extra) !== endpoint.wireEpoch) return false;
    if (state.cls === "gen1") {
      this.sendBytesTo(protocol.buildStreamBegin(this.nextSeq(), { ...BEGIN_BODY, target: endpoint.address }), endpoint.ip);
      return { format: "gen1" };
    }
    const leaseKey = `${state.bootId}:${state.ticket}`;
    const last = this.lastGenerations.get(leaseKey) ?? 0;
    if (last >= MAX_GENERATION) {
      if (!this.exhaustedLeases.has(leaseKey)) {
        this.exhaustedLeases.add(leaseKey);
        console.warn(`[hapbeat] stream generation exhausted for ${endpoint.ip}; renewing the lease.`);
        // A sender that reaches it obtains a new ticket (fresh incarnation).
        this.renewIncarnation();
        this.refreshLeases(true);
      }
      return false;
    }
    const identity = { bootId: state.bootId, ticket: state.ticket, generation: last + 1 };
    this.lastGenerations.set(leaseKey, identity.generation);
    const wire: Gen2Wire = {
      format: "gen2", identity, envelope: protocol.buildStreamEnvelope(identity),
      endpoint, dataSent: 0, lastBeginAt: 0,
    };
    this.sendBegin(wire);
    extra.currentWire = wire;
    return wire;
  }

  /** (Re)send a Gen 2 session's BEGIN: the same tuple, the endpoint's current address. */
  private sendBegin(wire: Gen2Wire): void {
    wire.lastBeginAt = Date.now();
    this.sendBytesTo(
      protocol.buildStreamBeginV2(this.nextSeq(), wire.identity, { ...BEGIN_BODY, target: wire.endpoint.address }),
      wire.endpoint.ip,
    );
  }

  /**
   * DATA in the format and identity its session began with. A Gen 2 session
   * repeats its BEGIN before each of its first three DATA and then every
   * 500 ms (an equal BEGIN is idempotent; it recovers a lost first BEGIN).
   * Gen 1 firmware restarts on every BEGIN, so it gets none.
   */
  streamDataEndpoint(endpoint: StreamEndpoint, offset: number, data: Uint8Array, wire?: unknown): void {
    const session = wire as StreamWire | undefined;
    if (session?.format === "gen2") {
      session.endpoint = endpoint;
      if (session.dataSent < BEGIN_REPEAT_FIRST_DATA || Date.now() - session.lastBeginAt >= BEGIN_REPEAT_INTERVAL_MS) {
        this.sendBegin(session);
      }
      session.dataSent++;
      this.sendBytesTo(protocol.buildStreamDataV2(this.nextSeq(), session.identity, offset, data), endpoint.ip);
      return;
    }
    this.sendBytesTo(protocol.buildStreamData(this.nextSeq(), offset, data), endpoint.ip);
  }

  /** END in the format and identity its session began with. */
  streamEndEndpoint(endpoint: StreamEndpoint, wire?: unknown): void {
    const session = wire as StreamWire | undefined;
    const extra = this.extraFor(endpoint.ip);
    extra.lastEndAt = Date.now();
    if (session?.format === "gen2") {
      if (extra.currentWire === session) extra.currentWire = undefined;
      extra.endedWire = session;
      this.sendBytesTo(protocol.buildStreamEndV2(this.nextSeq(), session.identity), endpoint.ip);
      return;
    }
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
   * Periodic discovery PING (+ CONNECT_STATUS when an app name is set), and the
   * lease refresh of the endpoints this app may stream to.
   *
   * The PING is what keeps unicast working: the device answers PONG *only* to
   * a PING (CONNECT_STATUS gets no reply), so without this every device would
   * age out of the destination table after `deviceTtlMs` and the session would
   * silently fall back to broadcast forever. It doubles as discovery for
   * devices that join late.
   */
  private startKeepalive(): void {
    this.tick();
    this.refreshLeases(true);
    this.keepaliveTimer = setInterval(() => this.tick(), KEEPALIVE_MS);
    this.leaseTimer = setInterval(() => this.refreshLeases(false), LEASE_CHECK_MS);
  }

  private tick(): void {
    this.discoveryPing();
    if (this.appName) this.connectStatus(true);
  }

  async discover(timeoutMs: number): Promise<Device[]> {
    const before = Date.now();
    this.discoveryPing();
    await new Promise((r) => setTimeout(r, Math.max(0, timeoutMs)));
    return this.devices().filter((d) => d.lastSeen >= before - 50);
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
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.keepaliveTimer = this.leaseTimer = undefined;
    for (const extra of this.extras.values()) {
      if (extra.capsTimer) clearTimeout(extra.capsTimer);
      extra.capsTimer = undefined;
    }
    this.closeSocket();
  }
}
