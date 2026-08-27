# Hapbeat JS/TS SDK

Drive [Hapbeat](https://hapbeat.com) haptic devices from JavaScript / TypeScript.
**One API, three transports:**

- **Node** (Electron, servers, CLIs, creative-coding) → direct Wi-Fi **UDP**.
- **React Native** (Android / iOS apps) → direct Wi-Fi **UDP** via the optional
  [`react-native-udp`](https://www.npmjs.com/package/react-native-udp) — a phone
  can open a real UDP socket, so **no helper** is needed.
- **Browser** (WebXR, three.js / Babylon.js / p5.js, React, jsPsych experiments) →
  relays through [hapbeat-helper](https://github.com/hapbeat/hapbeat-helper) over a
  local **WebSocket**, because browsers cannot open raw UDP sockets.

The bundler/runtime picks the right build automatically via the package `exports` map.

> **📚 Docs**: <https://devtools.hapbeat.com/docs/sdk-integration/> · **🤖 AI agents**: see [`AGENTS.md`](./AGENTS.md)

This is the **level-1** SDK: the **fire** side (`play` / `stop`) and the **tuning**
side (`EventMap`) are orthogonal and linked only by an **event id** — the same design
as the Hapbeat Unity SDK. You ship *instructions*; the haptic waveform lives in the
**kit** on the device (authored in [Hapbeat Studio](https://devtools.hapbeat.com)).

## Install

```bash
npm install @hapbeat/sdk
```

ESM-only (`"type": "module"`). The **browser** path also needs the helper daemon:
`pip install hapbeat-helper` → run `hapbeat-helper`.

## Quick start — Node

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" }); // opens the UDP socket + keep-alive
hb.play("sample-kit.sine_100hz", { gain: 0.3 });           // fire by event id (gain 0..1)
hb.play("sample-kit.sine_100hz");                          // gain omitted → kit/EventMap baseline
hb.stopAll();
await hb.close();
```

## Quick start — Browser (needs hapbeat-helper running)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyWebXR" }); // → ws://localhost:7703 (helper)
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
```

`"sample-kit.sine_100hz"` must be an event id in the **kit deployed to the device** (via Hapbeat
Studio). Use it in React the same way — `connect()` once (e.g. in an effect / a
module singleton), then `hb.play(...)` from event handlers.

## Quick start — React Native (Android / iOS, no helper)

```ts
import { connect } from "@hapbeat/sdk"; // resolves to the "react-native" build (Metro)

const hb = await connect({ appName: "MyApp" }); // direct UDP from the phone
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
```

Install the optional native module + the required polyfill: `npm install react-native-udp
fast-text-encoding` (RN Hermes — including 0.86 — ships `TextEncoder` but **not**
`TextDecoder`). Also add the `metro.config.js` resolver and `import 'fast-text-encoding'`
as the first import. Full setup + a runnable Android demo (command + streaming, verified
on a physical device) is in [`examples/react-native/`](./examples/react-native/).

## EventMap — the tuning side (optional)

Read per-event baseline intensities from the kit manifest so `play("id")` fires at the
authored strength without hard-coding gains:

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("sample-kit.sine_100hz"); // uses the manifest's intensity for this event
```

## command vs clip — two modes, one `play(id)`

The kit manifest decides the mode per event; your code never changes:

| manifest bucket | mode | what happens | needs kit on device? |
|---|---|---|---|
| `events` | **command** | SDK sends `PLAY`; the device plays its **installed** clip | yes (flash kit in Studio) |
| `stream_events` | **clip** | SDK loads the event's WAV (`clipBase` + `clipLoader`) and **streams** it over the wire | no |

- No `eventMap` → everything is command mode (gain defaults to `1.0`).
- Clip WAVs are PCM16 mono or stereo. The SDK normalizes every source to 16 kHz
  stereo before endpoint mixing.

## Continuous (live) streaming

For per-frame–modulated haptics (a directional tone in a game loop, a tightening
rumble), open a **persistent** stream instead of firing discrete clips:

```ts
const live = hb.openStream({ channels: 2, sampleRate: 16000 });
function frame(pcm /* Uint8Array, your synthesized chunk */) {
  if (!live.write(pcm)) {
    // No exact device endpoint is resolved, or the bounded live queue is full.
    // This input was dropped rather than queued as late haptics.
  }
}
// …later
live.close();
```

`hb.streamPcm(pcm, { channels: 2, target: "player_1" })` starts one finite logical
source and returns its handle. Multiple sources can play together. Sources aimed at
the same device endpoint are mixed; sources aimed at different endpoints use separate
wire sessions. `handle.stop()` stops only that source.

For a manifest `stream_events` clip whose source controls you need, use
`const playback = hb.playStream("my-kit.loop", { target: "player_1" })`.
The handle is returned immediately (Deferred while its first WAV load is pending),
so it can be adjusted or stopped before loading finishes. The ordinary `hb.play(id)`
remains fire-and-forget.

## Discovery & targeting

```ts
for (const d of await hb.discover(1500)) console.log(d.ip, d.address);

hb.play("sample-kit.sine_100hz", { target: "player_1/pos_neck" }); // one device
hb.play("sample-kit.sine_100hz", { target: "*/pos_neck" });        // every neck device
hb.play("sample-kit.sine_100hz", { target: "*/*/group_2" });       // every device in group 2
hb.play("sample-kit.sine_100hz", { target: "" });                  // all devices (default)
```

All events take `pan` (-1 = left only, 0 = centre, +1 = right only). Fire events apply
it on-device; streamed sources apply it before endpoint mixing:
`hb.play("sample-kit.sine_100hz", { pan: -1 })`.

Matching is **positional**: segment *i* of the target is compared with segment
*i* of the device address, `*` stands for one **whole** segment (`pos_*` is
compared literally — use `player_1/*`), and a short target front-matches.
Device addresses are always `player_<N>/<position>/group_<M>`, defaulting to
`player_1` / `group_1`, so a group has to be written `*/*/group_2`: plain
`group_2` is compared against the *player* slot and never matches.

### How packets are sent

The Node and React Native transports **unicast** commands to devices that answered
a PING, and commands broadcast only while no matching device is known. Wi-Fi
APs hold broadcast frames until their next DTIM beacon (100–300 ms) whenever
any client on the AP is power-saving, which is heard as late haptics and
stuttering streams; unicast is not batched that way. The 5-second keep-alive
PING is what keeps this table current, so leave `keepalive` on.

Streaming never broadcasts: `STREAM_DATA` and `STREAM_END` have no target field,
so the SDK creates one wire session per exact PONG-reported `(IP, address)` endpoint.
Until a matching endpoint is known, finite sources are `Deferred`; live writes return
`false`. `{ unicast: false }` affects commands only. The browser sends the same exact
endpoint IP on every helper WebSocket stream message.

Pass `{ unicast: false }` to always broadcast commands — worth it when many devices
must fire in lockstep, since one broadcast reaches them all at once while N unicasts
go out one after another.

## Project layout (where the kit lives)

```
your-app/
├── src/ …                         your code: connect() + play(id)
└── public/ (web) or a dir (node)
    └── my-kit/
        ├── my-kit-manifest.json   ← Hapbeat Studio output; fetched → EventMap.fromManifest
        └── stream-clips/*.wav      ← clip-mode WAVs, loaded via clipBase + clipLoader
```

Web: serve the kit as static assets; `clipBase` is a URL prefix. Node: `clipBase` is a
directory path (default `clipLoader` = `fs.readFile`). Override `clipLoader` to load
clips from a bundle / IndexedDB.

## Examples

The `examples/` folder is **not** in the npm package (only `dist` ships). Clone the repo
to use them: `git clone https://github.com/hapbeat/hapbeat-js-sdk`.

- [`examples/node-minimal.mjs`](./examples/node-minimal.mjs) — fire an event from Node.
- [`examples/browser-minimal.html`](./examples/browser-minimal.html) — fire from a page (helper).
- [`examples/react-native/`](./examples/react-native/) — an Android demo: button taps →
  command + streaming, direct UDP from the phone (**no helper**).
- [`examples/games/`](./examples/games/) — a browser **haptic-demo arcade** (FPS +
  mini-games) showing the EventMap / kit-manifest / file-vs-synth router pattern.
  Run `npm run dev` and open the printed URL. Also **hosted** —
  try it without cloning at <https://devtools.hapbeat.com/demos/arcade/>
  (haptics need `hapbeat-helper` running + a real Hapbeat device with the demo kit deployed).

## For AI coding agents

Hand your agent [`AGENTS.md`](./AGENTS.md) — a single self-contained reference. Or paste:

> Read https://raw.githubusercontent.com/hapbeat/hapbeat-js-sdk/master/AGENTS.md and use `@hapbeat/sdk` accordingly.

## License

MIT © Hapbeat
