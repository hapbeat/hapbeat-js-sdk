# Hapbeat Web SDK — context for AI coding agents

Single self-contained reference so an AI coding agent can drive Hapbeat haptic
devices from JS/TS correctly from one file. Package name: `@hapbeat/sdk`.

- last-verified-against: 0.1.0
- Source of truth is the code: public surface in `src/index.ts`, the facade in
  `src/hapbeat.ts`, options/types in `src/types.ts`, the tuning side in
  `src/eventmap.ts`, and the two `connect()` entries in `src/node.ts` /
  `src/browser.ts`. If this file disagrees with the code, the code wins.
- Canonical docs: https://devtools.hapbeat.com/docs/sdk-integration/

## What it is

A thin SDK to fire haptic events on Hapbeat devices over the LAN. One API, two
transports, chosen automatically by the package `exports` map:

- **Node** (Electron, servers, CLIs, creative-coding) → direct Wi-Fi UDP broadcast.
- **Browser** (WebXR, three.js / Babylon.js, p5.js, jsPsych) → relays through
  **hapbeat-helper** over WebSocket (`ws://localhost:7703`), because browsers
  cannot open raw UDP sockets.

It does **not** author haptics, run a cloud, mix multiple sources, or modulate
gain/pan mid-clip. The waveform lives in the kit on the device; the SDK sends the
instruction.

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

(npm publish pending; until then `npm install && npm run build`, then `npm link`,
or use a git dependency.)

## Quick start — Node (make it vibrate)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" }); // opens UDP broadcast + keep-alive
hb.play("impact.hit", { gain: 0.3 });           // gain 0..1; fire by event id
hb.play("impact.hit");                          // gain omitted -> EventMap/kit baseline
hb.stopAll();
await hb.close();
```

`"impact.hit"` must be an event id present in the **kit deployed to the device**
(via Hapbeat Studio). The SDK sends the instruction; the waveform is on the device.

## Quick start — Browser (needs hapbeat-helper running locally)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyWebXR" }); // -> ws://localhost:7703 (helper)
hb.play("impact.hit", { gain: 0.5 });
```

Bundlers pick the browser build automatically. The helper (`pip install
hapbeat-helper`) does the UDP broadcast on the page's behalf.

## Public API (verbatim signatures)

```ts
// Node:    src/node.ts     — UDP broadcast transport
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
defaultTarget?: string;    // device-addressing target; "" = broadcast
onConnectionLost?: () => void;   // Browser: helper WS dropped
connectTimeoutMs?: number;       // Browser. Default 4000.
eventMap?: EventMap;       // tuning catalog for default gains
keepalive?: boolean;       // CONNECT_STATUS keep-alive (Node). Default true.
clipBase?: string;         // base URL prefix (Browser) / dir path (Node) for clip WAVs
clipLoader?: (ref: string) => Promise<ArrayBuffer | Uint8Array>;
streamSendAheadSec?: number;     // clip send-ahead (< 0.256). Default 0.15.
```

`Hapbeat` (the facade — `src/hapbeat.ts`):

```ts
play(eventId: string, opts?: PlayOpts): void
stop(eventId: string, target?: string): void
stopAll(target?: string): void
ping(): void
discover(timeoutMs?: number /* = 1500 */): Promise<Device[]>
streamPcm(pcm: Uint8Array, opts?: { sampleRate?: number; channels?: number; gain?: number; target?: string }): void
preloadClips(): Promise<void>
connect(): Promise<this>   // connect() already calls this for you
close(): Promise<void>
```

```ts
interface PlayOpts { gain?: number; target?: string; targetTimeUs?: number; }
interface Device { ip: string; name?: string; address?: string; firmwareVersion?: string; lastSeen: number; }
```

Note: `play` / `stop` / `stopAll` / `ping` / `streamPcm` are **fire-and-forget**
(return `void`). Only `discover`, `connect`, `close`, `preloadClips` are async.

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
hb.play("impact.hit"); // uses the manifest's intensity for this event
```

`EventDef`: `eventId`, `intensity`, `loop`, `deviceWiper?`, `streaming`, `clip?`,
`note`. The manifest has two buckets: `events` (command mode) and `stream_events`
(clip mode → `streaming: true`).

## command vs clip (same `play(id)`, branches on the manifest)

| manifest bucket | mode | what happens | pre-deploy |
|---|---|---|---|
| `events` | command | SDK sends PLAY; the device plays its installed clip | yes (flash kit in Studio) |
| `stream_events` | clip | SDK loads the WAV (via `clipLoader` + `clipBase`) and streams it over UDP | no |

- No `eventMap` → everything is command mode (gain defaults to `1.0`).
- Clip WAVs must be **16 kHz mono PCM16**; the SDK does not resample (non-16 kHz
  warns). One stream at a time — a new clip cancels the previous.

## Discovery & targeting

```ts
for (const d of await hb.discover(1500)) console.log(d.ip, d.address);

hb.play("impact.hit", { target: "player_1/chest" }); // one device
hb.play("impact.hit", { target: "*/chest" });         // all chest devices
```

Target resolution: call-site `target` > `defaultTarget`. `""` = broadcast.
Target syntax is device-addressing (hapbeat-contracts): `player_1/chest`,
`*/chest`, `group_<N>` suffix.

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
  cancels any active clip stream.
- **clipBase + clipLoader**: clip mode needs `clipBase` pointing at the WAVs (Node:
  a directory path, Browser: a URL prefix). The default loader is `fs.readFile`
  (Node) / `fetch` (Browser); override `clipLoader` to load from a bundle.
- **`streamPcm`** sends an ad-hoc PCM16 buffer (e.g. a synthesized stereo
  directional cue — `channels: 2` is how you get L/R, since PLAY has no pan).

## More detail

- SDK integration guide: https://devtools.hapbeat.com/docs/sdk-integration/
- Docs portal: https://devtools.hapbeat.com/
