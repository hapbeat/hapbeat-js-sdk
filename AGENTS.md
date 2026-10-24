# Hapbeat JS/TS SDK — context for AI coding agents

Single self-contained reference so an AI coding agent can drive Hapbeat haptic
devices from JS/TS correctly from one file. Package name: `@hapbeat/sdk`.

- last-verified-against: 0.1.0
- Source of truth is the code: public surface in `src/index.ts`, the facade in
  `src/hapbeat.ts`, options/types in `src/types.ts`, the tuning side in
  `src/eventmap.ts`, endpoint-scoped mixing/pacing in `src/stream.ts`, the wire
  layer in `src/protocol.ts`, and the three `connect()`
  entries in `src/node.ts` / `src/browser.ts`. If this file disagrees with the
  code, the code wins.
- Canonical docs: https://devtools.hapbeat.com/docs/sdk-integration/

## What it is

A thin SDK to fire haptic events on Hapbeat devices over the LAN. One API, three
transports, chosen automatically by the package `exports` map:

- **Node** (Electron, servers, CLIs, creative-coding) → direct Wi-Fi UDP.
- **React Native** (Android / iOS) → direct Wi-Fi UDP via the optional
  peer dep **`react-native-udp`**. A phone is not sandboxed like a browser, so it
  opens a real UDP socket — **no helper**. Same wire format as Node.
- **Browser** (WebXR, three.js / Babylon.js, p5.js, jsPsych) → relays through
  **hapbeat-helper** over WebSocket (`ws://localhost:7703`), because browsers
  cannot open raw UDP sockets.

Entries: `src/node.ts` (dgram), `src/react-native.ts` (`react-native-udp`),
`src/browser.ts` (helper WS); all three share `src/transport-udp-base.ts` /
`src/protocol.ts`.

It does **not** author haptics or run a cloud. The waveform lives in the kit or
is supplied as PCM; streamed logical sources are normalized and mixed per exact
device endpoint.

## Core model: fire vs tuning, linked by event id

- **Fire side** (your code): *when/where* to play — `play` / `stop` / `stopAll`.
- **Tuning side** (`EventMap` = the kit manifest): *what/how strong* — intensity,
  loop, command-vs-clip, which WAV.
- They are linked only by **event id**. Keep intensities out of firing code; put
  them in the kit (authored in Hapbeat Studio). Event id and wire format are
  defined by **hapbeat-contracts** (kit manifest schema 2.0.0) — follow it, don't
  redefine.

## Install

```bash
npm install @hapbeat/sdk
```

## Quick start — Node (make it vibrate)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" }); // opens the UDP socket + keep-alive
hb.play("sample-kit.sine_100hz", { gain: 0.3 });           // gain 0..1; fire by event id
hb.play("sample-kit.sine_100hz");                          // gain omitted -> EventMap/kit baseline
hb.stopAll();
await hb.close();
```

`"sample-kit.sine_100hz"` must be an event id present in the **kit deployed to the device**
(via Hapbeat Studio). The SDK sends the instruction; the waveform is on the device.

## Quick start — Browser (needs hapbeat-helper running locally)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyWebXR" }); // -> ws://localhost:7703 (helper)
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
```

Bundlers pick the browser build automatically. The helper (`pip install
hapbeat-helper`) sends the UDP on the page's behalf, and decides unicast vs
broadcast itself.

## Public API (verbatim signatures)

```ts
// Node:    src/node.ts     — direct UDP transport
// Browser: src/browser.ts  — helper WebSocket transport
connect(options?: HapbeatOptions): Promise<Hapbeat>
```

`HapbeatOptions` (all optional):

```ts
port?: number;             // UDP port (Node). Default 7700.
broadcastAddr?: string;    // Node. Default "255.255.255.255".
helperUrl?: string;        // Browser. Default "ws://localhost:7703".
appName?: string;          // OLED app name (Node keep-alive). Max 16 chars.
deviceName?: string;
group?: number;            // group id this sender targets
defaultTarget?: string;    // device-addressing target; "" = every device
onConnectionLost?: () => void;   // Browser: helper WS dropped
connectTimeoutMs?: number;       // Browser. Default 4000.
eventMap?: EventMap;       // tuning catalog for default gains
keepalive?: boolean;       // PING (+CONNECT_STATUS) keep-alive + stream lease refresh (Node/RN). Default true; keep it on when streaming.
unicast?: boolean;         // Node/RN: unicast to PONGing devices. Default true.
deviceTtlMs?: number;      // Node/RN: destination liveness window. Default 15000.
clipBase?: string;         // base URL prefix (Browser) / dir path (Node) for clip WAVs
clipLoader?: (ref: string) => Promise<ArrayBuffer | Uint8Array>;
streamSendAheadSec?: number;     // clip send-ahead (< 0.256). Default 0.15.
onStreamLost?: (e: { playbackId: string; ip: string; reason: string }) => void;
                                 // a Playback lost a device for good ("stopped" = STOP_ALL, "displaced" = another helper client)
onStreamEndpointChanged?: (e: StreamEndpointInfo) => void;   // Node/RN: class / lease changed
```

`Hapbeat` (the facade — `src/hapbeat.ts`):

```ts
play(eventId: string, opts?: PlayOpts): void
playStream(eventId: string, opts?: PlayOpts): StreamPlayback | null
stop(eventId: string, target?: string): void
stopAll(target?: string): void
ping(): void
discover(timeoutMs?: number /* = 1500 */): Promise<Device[]>
devices(): Device[]                      // known devices now, no PING
streamEndpoints(): StreamEndpointInfo[]  // per-device stream class and lease
reacquireStreamOwnership(): boolean      // retake devices another app superseded (Node/RN)
streamPcm(pcm: Uint8Array, opts?: { sampleRate?: number; channels?: number; gain?: number; pan?: number; loop?: boolean; target?: string }): StreamPlayback
openStream(opts?: { sampleRate?: number; channels?: number; gain?: number; pan?: number; target?: string }): LiveStreamHandle
preloadClips(): Promise<void>
connect(): Promise<this>   // connect() already calls this for you
close(): Promise<void>
```

```ts
type PlaybackStatus = "Deferred" | "Active" | "Stopped";
interface StreamPlayback {
  readonly id: string; readonly status: PlaybackStatus;
  readonly deferredReason?: "NoResolvedEndpoint" | "UnknownClass" | "LeaseUnavailable" | "Superseded";
  readonly lostReason?: string;   // last reason a device was lost for good
  gain: number; pan: number; loop: boolean; stop(): void;
}
interface StreamEndpointInfo {
  ip: string; address: string;
  streamClass?: "gen1" | "gen2" | "unknown";            // undefined behind hapbeat-helper
  leaseState?: "valid" | "unavailable" | "superseded" | "none";
}
interface LiveStreamHandle extends StreamPlayback {
  write(pcm: Uint8Array): boolean; close(): void; readonly closed: boolean;
}
```

```ts
interface PlayOpts { gain?: number; target?: string; targetTimeUs?: number; pan?: number; }
// pan: -1 = left only, 0 = centre (default), +1 = right only.
// Fire events apply it on-device; streamed sources apply it in the endpoint mixer.
interface Device {
  ip: string; name?: string; address?: string; firmwareVersion?: string; lastSeen: number;
  streamClass?: "gen1" | "gen2" | "unknown"; leaseState?: "valid" | "unavailable" | "superseded" | "none";
  caps?: DeviceCaps;   // capability report (firmware 1.x; Node/RN): generation, firmwareVersion,
                       // streamGens, streamFormats, leaseTtlS, hapticChannels, features, ...
}
```

Note: `play` / `stop` / `stopAll` / `ping` are fire-and-forget. `streamPcm`
and `playStream` returns a source handle immediately. An uncached manifest WAV
keeps that handle Deferred (without an endpoint defer reason) until loading
finishes, so it remains controllable during the load. `discover`, `connect`,
`close`, `preloadClips` are async.

## EventMap — the tuning side (optional, `src/eventmap.ts`)

```ts
EventMap.fromManifest(manifest: KitManifest): EventMap      // a parsed kit manifest (schema 2.0.0)
EventMap.fromGains(gains: Record<string, number>): EventMap // { eventId: gain } by hand
new EventMap(events?: Record<string, EventDef> | Map<string, EventDef>)

// instance: get(id) gainFor(id) has(id) ids() size
```

```ts
import { connect, EventMap } from "@hapbeat/sdk";
const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("sample-kit.sine_100hz"); // uses the manifest's intensity for this event
```

`EventDef`: `eventId`, `intensity`, `loop`, `deviceWiper?`, `streaming`, `clip?`,
`note`. The manifest has two buckets: `events` (command mode) and `stream_events`
(clip mode → `streaming: true`). The JS `EventMap` is **manifest-only** — it carries
per-event default intensity/clip; it does **not** have a per-call haptic-file overlay
or a targeting layer (the Python SDK's `HapticFile` has those; in JS pass `target`
at the call site or via `defaultTarget`).

## command vs clip (same `play(id)`, branches on the manifest)

| manifest bucket | mode | what happens | pre-deploy |
|---|---|---|---|
| `events` | command | SDK sends PLAY; the device plays its installed clip | yes (flash kit in Studio) |
| `stream_events` | clip | SDK loads the WAV (via `clipLoader` + `clipBase`) and streams it over UDP | no |

- No `eventMap` → everything is command mode (gain defaults to `1.0`).
- Clip WAVs must be PCM16 mono or stereo. The SDK resamples and normalizes every
  source to canonical 16 kHz stereo before mixing.

## Continuous / live streaming (`streamPcm` vs `openStream` vs clip)

Three ways to create logical haptic PCM sources. The deep `StreamHub` module owns
target resolution, normalization, mixing, pacing and endpoint wire sessions:

- **clip** `play(streamEventId)` — the SDK loads a WAV and **paces** it out
  (`streamSendAheadSec`, ring ≈ 256 ms), deferring STREAM_END until drained.
- **`streamPcm(pcm, opts)`** — a single ad-hoc PCM16 buffer, paced like a clip.
  Use for a one-shot synthesized cue. `channels: 2` carries L/R direction (fire
  events use `play(id, { pan })` instead).
- **`openStream(opts) → handle`** — a live logical source. Feed
  `handle.write(pcm)` in approximately real time and `handle.close()` at the end.
  `write()` returns `false` and drops input while Deferred or when the bounded
  queue is full, preventing unbounded late haptics.

Sources for the same exact device endpoint are mixed into one canonical 16 kHz
stereo PCM16 wire session. Different endpoints have independent sessions and
cursors. A source handle owns gain/pan/loop/status and `stop()` affects only that
source. Empty sessions linger for at least 300 ms so rapid cues reuse the session
without an unsafe `STREAM_END` → `STREAM_BEGIN` pair.

## Discovery & targeting

```ts
for (const d of await hb.discover(1500)) console.log(d.ip, d.address);

hb.play("sample-kit.sine_100hz", { target: "player_1/pos_neck" }); // one device
hb.play("sample-kit.sine_100hz", { target: "*/pos_neck" });        // that position, every player
hb.play("sample-kit.sine_100hz", { target: "*/*/group_2" });       // group 2
```

Target resolution: call-site `target` > `defaultTarget`. `""` = every device.

Device addresses are always `player_<N>/<position>/group_<M>` (defaults
`player_1` / `group_1`) and matching is **positional** — segment *i* vs segment
*i*, `*` covers one **whole** segment, a short target front-matches. So
**`group_2` alone never matches** (compared against the player slot; write
`*/*/group_2`) and **`pos_*` is not a wildcard** (compared literally; write
`player_1/*`). `protocol.addressMatches(target, address)` is the same check the
device runs.

Sending: Node/RN unicast commands to devices that answered a recent PING and fall
back to broadcast while none matches. Streaming has no broadcast fallback because
DATA/END carry no target; it requires an exact PONG-reported `(IP, address)` endpoint.
`{ unicast: false }` affects commands only. The discovery PING and CONNECT_STATUS stay
broadcast; the stream lease request is unicast to the devices this app may stream to.

Deferred streams: `deferredReason` is `NoResolvedEndpoint` (no device matches),
`UnknownClass` (the device has not answered yet), `LeaseUnavailable` (no usable
lease; renewed automatically) or `Superseded` (another app streams to it; call
`hb.reacquireStreamOwnership()` once it stopped — never automatically). A device
STOP_ALL during a stream drops that Playback from that device for good
(`onStreamLost`, `lostReason`); a new Playback joins again.

Browser caveat (helper WS): every stream BEGIN/DATA/END carries the exact endpoint
IP, so per-device clip targeting is supported. `targetTimeUs` is ignored over the
helper (immediate playback only).

## Patterns / gotchas

- **Browser needs the helper**: `connect()` rejects if `ws://localhost:7703` is not
  reachable. Tell users to `pip install hapbeat-helper` and start it. Use
  `onConnectionLost` to react to a dropped helper.
- **Node UDP broadcast on a multi-homed PC** may exit the wrong NIC; ensure the
  Hapbeat LAN's NIC has the route.
- **Nothing buzzes but `discover` finds the device** → the event id is not in the
  deployed kit (#1 cause), or `target` doesn't match (try `""`).
- **`gain` is absolute 0..1** and is clamped on the SDK side.
- **Lifecycle**: always `await hb.close()` — it tells the device the app left and
  stops all logical sources and closes endpoint sessions.
- **clipBase + clipLoader**: clip mode needs `clipBase` pointing at the WAVs (Node:
  a directory path, Browser: a URL prefix). The default loader is `fs.readFile`
  (Node) / `fetch` (Browser); override `clipLoader` to load from a bundle.
- **`streamPcm`** sends an ad-hoc PCM16 buffer (e.g. a synthesized stereo
  directional cue — `channels: 2` is how you get L/R; fire events use
  `play(id, { pan })`).

## Not implemented (don't reach for these)

- **Built-in mic capture** — pass captured PCM to `openStream`; device endpoint
  resolution, mixing and bounded buffering are provided, capture itself is not.
- **Authoring / cloud / a kit format** — kits are authored in Hapbeat Studio; the
  manifest schema is owned by hapbeat-contracts. Don't invent a manifest.
- **mDNS discovery** — discovery is broadcast PING/PONG (`discover()`), not mDNS.
- **`targetTimeUs` over the helper** — see the browser caveat above.
- **OSC bridge / CLI / launchpad** — those live in the Python SDK, not here.

## More detail

When this single file is not enough, an agent can fetch:

- **Runnable examples in this repo:** `examples/` (browser demos + Node)
- **Concepts** (shared by every SDK): event id <-> kit https://devtools.hapbeat.com/docs/concepts/event-id-and-kit/ - command vs clip https://devtools.hapbeat.com/docs/concepts/fire-vs-clip/ - targeting https://devtools.hapbeat.com/docs/concepts/group-player-addressing/
- Human docs: https://devtools.hapbeat.com/docs/sdk-integration/ - Portal: https://devtools.hapbeat.com/
