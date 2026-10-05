// Subnet-directed broadcast: route maths, fan-out, and the discovery split.
//
// `255.255.255.255` leaves a multi-homed host through the single interface with
// the lowest metric, which on a machine running Hyper-V / WSL2 / Docker is often
// a virtual switch with no Hapbeat behind it — no Ethernet cable required for
// that to happen. Discovery therefore fans out over every local subnet, and
// playback is pinned to the one a device answered on.
//
// The rule these tests exist to protect: ONLY PING and CONNECT_STATUS may take
// the fan-out. Firmware older than v0.3.0 does not de-duplicate PLAY/STOP by
// sequence number, so a device reachable on two destinations would fire twice.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as protocol from "../dist/protocol.js";
import { NodeUdpTransport } from "../dist/node.js";
import {
  UdpTransportBase,
  computeBroadcastRoutes,
  routeContains,
} from "../dist/transport-udp-base.js";

// A device's PONG reply (contracts §5.4): two int64s then the extended
// null-terminated strings. The SDK only builds SDK->device packets, so the
// reply is assembled here.
function makePong({ address = "player_1/pos_neck" } = {}) {
  const strs = new TextEncoder().encode(`dev\0${address}\0 0.3.1\0`);
  const payload = new Uint8Array(16 + strs.length);
  new DataView(payload.buffer).setBigInt64(0, 0n, true);
  new DataView(payload.buffer).setBigInt64(8, 0n, true);
  payload.set(strs, 16);
  return protocol.buildPacket(protocol.CMD_PONG, 1, payload);
}

// Records the real destination of every datagram instead of opening a socket.
class BroadcastProbe extends NodeUdpTransport {
  constructor(subnets, opts = {}) {
    super({ keepalive: false, ...opts });
    this.subnets = subnets;
    this.sends = [];
  }
  async openSocket() {}
  closeSocket() {}
  localSubnets() { return this.subnets; }
  sendBytesTo(pkt, ip, bestEffort = false) { this.sends.push([ip, bestEffort]); }
  dests() { return this.sends.map(([ip]) => ip); }
  saw(ip) { this.handleMessage(makePong(), ip); }
}

const TWO_SUBNETS = [
  { address: "192.168.0.205", netmask: "255.255.255.0" },
  { address: "172.17.192.1", netmask: "255.255.0.0" },   // a Hyper-V switch
];

// ── Route maths ────────────────────────────────────────────────────────────

test("broadcast routes: address comes from the real mask, not an assumed .255", () => {
  const cases = [
    [{ address: "192.168.0.205", netmask: "255.255.255.0" }, "192.168.0.255"],
    [{ address: "10.1.2.3", netmask: "255.0.0.0" }, "10.255.255.255"],
    [{ address: "172.17.192.1", netmask: "255.255.0.0" }, "172.17.255.255"],
    [{ address: "192.168.1.10", netmask: "255.255.255.128" }, "192.168.1.127"],
    [{ address: "192.168.1.200", netmask: "255.255.255.128" }, "192.168.1.255"],
    [{ address: "192.168.1.10", netmask: "255.255.255.252" }, "192.168.1.11"],
  ];
  for (const [subnet, expected] of cases) {
    assert.deepEqual(
      computeBroadcastRoutes([subnet]).map((r) => r.addr),
      [expected, "255.255.255.255"],
      `${subnet.address} / ${subnet.netmask}`,
    );
  }
});

test("broadcast routes: limited broadcast is always kept as a catch-all", () => {
  // SoftAP setups and platforms that cannot report a mask (React Native)
  // depend on it, and dropping it would regress every single-NIC user.
  const routes = computeBroadcastRoutes([]);
  assert.deepEqual(routes.map((r) => r.addr), ["255.255.255.255"]);
  assert.equal(routes[0].limited, true);
});

test("broadcast routes: same-subnet interfaces collapse to one destination", () => {
  // A docked laptop has Ethernet and Wi-Fi on one subnet; without dedup the
  // device receives every discovery packet twice.
  const routes = computeBroadcastRoutes([
    { address: "192.168.0.67", netmask: "255.255.255.0" },
    { address: "192.168.0.223", netmask: "255.255.255.0" },
  ]);
  assert.deepEqual(routes.map((r) => r.addr), ["192.168.0.255", "255.255.255.255"]);
});

test("broadcast routes: loopback and unusable masks are skipped", () => {
  const routes = computeBroadcastRoutes([
    { address: "127.0.0.1", netmask: "255.0.0.0" },
    { address: "192.168.1.5", netmask: "255.0.255.0" },   // non-contiguous
    { address: "192.168.1.5", netmask: "0.0.0.0" },
    { address: "not-an-ip", netmask: "255.255.255.0" },
  ]);
  assert.deepEqual(routes.map((r) => r.addr), ["255.255.255.255"]);
});

test("broadcast routes: membership decides which route a reply pins", () => {
  const [subnet, limited] = computeBroadcastRoutes([TWO_SUBNETS[0]]);
  assert.equal(routeContains(subnet, "192.168.0.42"), true);
  assert.equal(routeContains(subnet, "192.168.1.42"), false);
  assert.equal(routeContains(subnet, "nonsense"), false);
  // The catch-all must never win the lock, or playback would go back to the
  // limited broadcast that failed to reach the device in the first place.
  assert.equal(routeContains(limited, "192.168.0.42"), false);
});

// ── Transport behaviour ────────────────────────────────────────────────────

test("UDP transport: discovery fans out, playback never does", async () => {
  const t = new BroadcastProbe(TWO_SUBNETS);
  await t.connect();

  t.ping();
  assert.deepEqual(t.dests(), ["192.168.0.255", "172.17.255.255", "255.255.255.255"]);
  // Every leg is best-effort: an adapter that cannot carry a broadcast is
  // normal and must not be reported as a fault.
  assert.ok(t.sends.every(([, bestEffort]) => bestEffort === true));

  // One PLAY produces exactly one datagram. This is the critical rule.
  t.sends.length = 0;
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), ["255.255.255.255"]);
});

test("UDP transport: a PONG pins the broadcast fallback to that subnet", async () => {
  const t = new BroadcastProbe(TWO_SUBNETS);
  await t.connect();
  t.saw("192.168.0.42");

  // With the device known, playback unicasts (unchanged behaviour).
  t.sends.length = 0;
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), ["192.168.0.42"]);

  // Once it ages out, the fallback broadcast now goes to the right subnet
  // instead of 255.255.255.255.
  t.sends.length = 0;
  t.devices.clear();
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), ["192.168.0.255"]);
});

test("UDP transport: pinning stops discovery probing the other subnets", async () => {
  const t = new BroadcastProbe(TWO_SUBNETS);
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  t.sends.length = 0;
  t.ping();
  assert.deepEqual(t.dests(), ["192.168.0.255"]);
});

test("UDP transport: first reply wins, and an unknown subnet keeps the catch-all", async () => {
  const t = new BroadcastProbe(TWO_SUBNETS);
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  t.lockRouteFor("172.17.0.9");
  assert.equal(t.broadcastDestination(), "192.168.0.255");

  // A device reached through a route we did not enumerate: falling back to the
  // limited broadcast is the pre-existing behaviour, not a failure.
  const other = new BroadcastProbe(TWO_SUBNETS);
  await other.connect();
  other.lockRouteFor("10.9.9.9");
  assert.equal(other.broadcastDestination(), "255.255.255.255");
});

test("UDP transport: an explicit broadcastAddr is honoured verbatim", async () => {
  // Naming a destination is also the escape hatch for pinning it by hand,
  // which is why no extra setting exists.
  const t = new BroadcastProbe(TWO_SUBNETS, { broadcastAddr: "192.168.5.255" });
  await t.connect();
  t.ping();
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), ["192.168.5.255", "192.168.5.255"]);
});

test("UDP transport: a single-NIC host is unchanged", async () => {
  // Regression guard: one interface must behave as it did before.
  const t = new BroadcastProbe([{ address: "192.168.0.205", netmask: "255.255.255.0" }]);
  await t.connect();
  t.ping();
  assert.deepEqual(t.dests(), ["192.168.0.255", "255.255.255.255"]);
});

test("UDP transport: React Native keeps the limited broadcast", async () => {
  // The base class reports no subnets, so a platform without `node:os` sends
  // exactly where it always did.
  class RnLike extends BroadcastProbe {
    localSubnets() { return UdpTransportBase.prototype.localSubnets.call(this); }
  }
  const t = new RnLike([]);
  await t.connect();
  t.ping();
  t.play("kit.evt", 1, "", 0);
  assert.deepEqual(t.dests(), ["255.255.255.255", "255.255.255.255"]);
});

// ── Releasing the lock (contracts message-format.md §2.1) ──────────────────
// The lock used to last until the next connect(). After the PC moved to
// another Wi-Fi network every PING still went to the old subnet, devices on the
// new network were never found, and only a process restart recovered.

// Drives Date.now(), the clock the transport uses for device and route TTLs.
// console.info is silenced: lock / unlock / network-change lines are expected.
async function withClock(fn) {
  const realNow = Date.now;
  const realInfo = console.info;
  const clock = { now: 1_000_000 };
  Date.now = () => clock.now;
  console.info = () => {};
  try {
    await fn(clock);
  } finally {
    Date.now = realNow;
    console.info = realInfo;
  }
}

// Counts interface enumerations, and lets a test switch the host's networks.
class CountingProbe extends BroadcastProbe {
  constructor(subnets, opts) {
    super(subnets, opts);
    this.enumerations = 0;
  }
  localSubnets() {
    this.enumerations++;
    return this.subnets;
  }
}

const HOME = [{ address: "192.168.0.205", netmask: "255.255.255.0" }];

test("route lock: released when its network is gone", () => withClock(async (clock) => {
  const t = new BroadcastProbe(HOME);
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  assert.equal(t.broadcastDestination(), "192.168.0.255");

  // Wi-Fi moves to another network: the old subnet disappears.
  t.subnets = [{ address: "192.168.11.7", netmask: "255.255.255.0" }];
  clock.now += 2000;
  t.sends.length = 0;
  t.ping();
  assert.deepEqual(t.dests(), ["192.168.11.255", "255.255.255.255"]);
  assert.equal(t.broadcastDestination(), "255.255.255.255");

  // The first device on the new network locks again.
  t.lockRouteFor("192.168.11.30");
  assert.equal(t.broadcastDestination(), "192.168.11.255");
}));

test("route lock: released when nobody answers for the device TTL", () => withClock(async (clock) => {
  // The interface list cannot show a switch to a network that reuses the old
  // subnet number, or devices that all went away: silence has to do it.
  const t = new BroadcastProbe(TWO_SUBNETS, { deviceTtlMs: 15_000 });
  await t.connect();
  t.lockRouteFor("192.168.0.42");

  clock.now += 15_500;
  t.sends.length = 0;
  t.ping();
  assert.deepEqual(t.dests(), ["192.168.0.255", "172.17.255.255", "255.255.255.255"]);
  assert.equal(t.broadcastDestination(), "255.255.255.255");
}));

test("route lock: PONGs from the locked subnet keep it", () => withClock(async (clock) => {
  const t = new BroadcastProbe(TWO_SUBNETS, { deviceTtlMs: 15_000 });
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  for (let i = 0; i < 5; i++) {
    clock.now += 10_000;
    t.lockRouteFor("192.168.0.42");   // keep-alive PONG
    t.sends.length = 0;
    t.ping();
    assert.deepEqual(t.dests(), ["192.168.0.255"]);
  }
}));

test("route lock: PONGs from another subnet do not keep it", () => withClock(async (clock) => {
  const t = new BroadcastProbe(TWO_SUBNETS, { deviceTtlMs: 15_000 });
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  clock.now += 10_000;
  t.lockRouteFor("172.17.0.9");
  assert.equal(t.broadcastDestination(), "192.168.0.255");
  clock.now += 10_000;
  t.sends.length = 0;
  t.ping();
  assert.equal(t.broadcastDestination(), "255.255.255.255");
  assert.equal(t.dests().length, 3);
}));

test("route lock: fan-out follows a network change before any lock", () => withClock(async (clock) => {
  const t = new BroadcastProbe(HOME);
  await t.connect();
  t.subnets = [{ address: "10.0.0.5", netmask: "255.255.255.0" }];
  clock.now += 2000;
  t.ping();
  assert.deepEqual(t.dests(), ["10.0.0.255", "255.255.255.255"]);
}));

test("route lock: a new extra interface keeps a live lock", () => withClock(async (clock) => {
  // Docking Ethernet while the devices are still on Wi-Fi changes nothing.
  const t = new BroadcastProbe(HOME);
  await t.connect();
  t.lockRouteFor("192.168.0.42");
  t.subnets = [...HOME, { address: "172.17.192.1", netmask: "255.255.0.0" }];
  clock.now += 2000;
  t.ping();
  assert.deepEqual(t.dests(), ["192.168.0.255"]);
}));

test("route lock: enumeration is rate-limited and off the playback path", () => withClock(async (clock) => {
  const t = new CountingProbe(TWO_SUBNETS);
  await t.connect();
  t.enumerations = 0;

  clock.now += 500;
  t.ping();
  assert.equal(t.enumerations, 0);
  clock.now += 600;
  t.ping();
  t.ping();
  assert.equal(t.enumerations, 1);

  // Long past the interval, playback still never enumerates.
  clock.now += 5000;
  for (let i = 0; i < 50; i++) t.play("kit.evt", 1, "", 0);
  t.stop("kit.evt", "");
  t.stopAll("");
  assert.equal(t.enumerations, 1);
}));

test("route lock: an explicit broadcastAddr never enumerates", () => withClock(async (clock) => {
  const t = new CountingProbe(TWO_SUBNETS, { broadcastAddr: "192.168.5.255" });
  await t.connect();
  clock.now += 5000;
  t.ping();
  t.lockRouteFor("192.168.5.9");
  assert.equal(t.enumerations, 0);
  assert.deepEqual(t.dests(), ["192.168.5.255"]);
  assert.equal(t.broadcastDestination(), "192.168.5.255");
}));

test("UDP transport: send failures are reported once per destination", async () => {
  const t = new BroadcastProbe(TWO_SUBNETS);
  await t.connect();
  const warnings = [];
  const realWarn = console.warn;
  const realInfo = console.info;
  console.warn = (m) => warnings.push(String(m));
  console.info = () => {};
  try {
    // A stream sends ~100 packets a second; without suppression an outage
    // buries the log an operator needs.
    for (let i = 0; i < 50; i++) t.noteSendFailed("192.168.0.42", "EHOSTUNREACH");
    assert.equal(warnings.length, 1);

    // A best-effort discovery leg stays silent: most hosts carry an adapter
    // that can never take a broadcast (Bluetooth PAN, Wi-Fi Direct).
    t.noteSendFailed("169.254.255.255", "ENETUNREACH", true);
    assert.equal(warnings.length, 1);

    // A later, unrelated outage on the same destination is still reported.
    t.noteSendOk("192.168.0.42");
    t.noteSendFailed("192.168.0.42", "EHOSTUNREACH");
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = realWarn;
    console.info = realInfo;
  }
});
