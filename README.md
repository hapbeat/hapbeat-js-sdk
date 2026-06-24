# Hapbeat JS/TS SDK

Drive [Hapbeat](https://hapbeat.com) haptic devices from JavaScript / TypeScript.
**One API, two transports:**

- **Node** (Electron, servers, CLIs, creative-coding) → direct Wi-Fi **UDP** broadcast.
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

> npm publish is pending. Until then, install from a checkout
> (`npm install && npm run build`, then `npm link`) or a git dependency.

## Quick start — Node

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" }); // opens UDP broadcast + keep-alive
hb.play("impact.hit", { gain: 0.3 });           // fire by event id (gain 0..1)
hb.play("impact.hit");                          // gain omitted → kit/EventMap baseline
hb.stopAll();
await hb.close();
```

## Quick start — Browser (needs hapbeat-helper running)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyWebXR" }); // → ws://localhost:7703 (helper)
hb.play("impact.hit", { gain: 0.5 });
```

`"impact.hit"` must be an event id in the **kit deployed to the device** (via Hapbeat
Studio). Use it in React the same way — `connect()` once (e.g. in an effect / a
module singleton), then `hb.play(...)` from event handlers.

## EventMap — the tuning side (optional)

Read per-event baseline intensities from the kit manifest so `play("id")` fires at the
authored strength without hard-coding gains:

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("impact.hit"); // uses the manifest's intensity for this event
```

## command vs clip — two modes, one `play(id)`

The kit manifest decides the mode per event; your code never changes:

| manifest bucket | mode | what happens | needs kit on device? |
|---|---|---|---|
| `events` | **command** | SDK sends `PLAY`; the device plays its **installed** clip | yes (flash kit in Studio) |
| `stream_events` | **clip** | SDK loads the event's WAV (`clipBase` + `clipLoader`) and **streams** it over the wire | no |

- No `eventMap` → everything is command mode (gain defaults to `1.0`).
- Clip WAVs are **16 kHz PCM16**; the SDK does not resample. One stream at a time.

## Continuous (live) streaming

For per-frame–modulated haptics (a directional tone in a game loop, a tightening
rumble), open a **persistent** stream instead of firing discrete clips:

```ts
const live = hb.openStream({ channels: 2, sampleRate: 16000 });
function frame(pcm /* Uint8Array, your synthesized chunk */) {
  live.write(pcm);   // STREAM_BEGIN once, then chunks — no per-chunk teardown
}
// …later
live.close();
```

`hb.streamPcm(pcm, { channels: 2 })` sends a single ad-hoc PCM16 buffer (stereo = L/R
direction, since `PLAY` has no pan). One session at a time: a clip, `streamPcm`, or a
new `openStream` ends the previous live stream.

## Discovery & targeting

```ts
for (const d of await hb.discover(1500)) console.log(d.ip, d.address);

hb.play("impact.hit", { target: "player_1/chest" }); // one device
hb.play("impact.hit", { target: "*/chest" });         // all chest devices
hb.play("impact.hit", { target: "" });                // broadcast (default)
```

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

- [`examples/node-minimal.mjs`](./examples/node-minimal.mjs) — fire an event from Node.
- [`examples/browser-minimal.html`](./examples/browser-minimal.html) — fire from a page (helper).
- [`examples/games/`](./examples/games/) — a browser **haptic-demo arcade** (FPS +
  mini-games) showing the EventMap / kit-manifest / file-vs-synth router pattern.
  Run `npm run dev` and open the printed URL.

## For AI coding agents

Hand your agent [`AGENTS.md`](./AGENTS.md) — a single self-contained reference. Or paste:

> Read https://raw.githubusercontent.com/hapbeat/hapbeat-js-sdk/master/AGENTS.md and use `@hapbeat/sdk` accordingly.

## License

MIT © Hapbeat
