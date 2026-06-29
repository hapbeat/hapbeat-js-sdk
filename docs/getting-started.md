# Getting Started (Web / Node)

Drive a Hapbeat device from JavaScript or TypeScript.

## Prerequisites

- A Hapbeat device on the **same Wi-Fi/LAN** as your machine.
- A **kit deployed to the device** via [Hapbeat Studio](https://devtools.hapbeat.com),
  defining the event ids you can play (e.g. `sample-kit.sine_100hz`).
- For **browser** use: [hapbeat-helper](https://github.com/hapbeat/hapbeat-helper)
  running locally (`pip install hapbeat-helper`), since browsers can't open raw UDP.

## Install

```bash
npm install @hapbeat/sdk
```

## Node / Electron

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" });
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
await hb.close();
```

`connect()` opens a UDP broadcast socket and runs a keep-alive so the device
OLED shows your `appName`.

## Browser (WebXR / three.js / p5.js)

```ts
import { connect } from "@hapbeat/sdk";

// helper must be running locally (ws://localhost:7703)
const hb = await connect({ appName: "MyWebXR" });
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
```

Your bundler (Vite, webpack, esbuild) automatically picks the browser build via
the package `exports` map.

## React Native (Android / iOS)

A phone isn't sandboxed like a browser, so it can open a real UDP socket and
broadcast straight over Wi-Fi — **no hapbeat-helper needed**. Same wire format
as Node.

```ts
import "fast-text-encoding";          // must be the FIRST import (before @hapbeat/sdk)
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" });
hb.play("sample-kit.sine_100hz", { gain: 0.5 });
```

App-side setup:

```bash
npm install react-native-udp fast-text-encoding
```

- `react-native-udp` is an **optional peer dependency** (autolinked) that backs
  the UDP socket.
- `fast-text-encoding` is a **required polyfill**: RN Hermes (incl. 0.86) ships
  `TextEncoder` but not `TextDecoder`, which the wire decoder needs. Import it
  before `@hapbeat/sdk` or you get `ReferenceError: Property 'TextDecoder'`.
- Enable package `exports` in `metro.config.js`:

  ```js
  config.resolver.unstable_enablePackageExports = true;
  config.resolver.unstable_conditionNames = ["react-native", "require", "default"];
  ```

- **iOS 14+** needs a local-network usage description (`NSLocalNetworkUsageDescription`).
  **Android** broadcasts work out of the box; PONG discovery may need a multicast lock.

See `examples/react-native/` for a runnable Android demo. Verified on a physical
Android device (RN 0.86, Hermes / New Architecture).

## Keep intensities out of firing code

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("sample-kit.sine_100hz");   // fires at the manifest's authored intensity
```

## Targeting

```ts
hb.play("sample-kit.sine_100hz", { target: "player_1/chest" }); // one device
hb.play("sample-kit.sine_100hz", { target: "*/chest" });         // all chest devices
hb.play("sample-kit.sine_100hz");                                 // broadcast (all)
```

## Fire vs. clip — two modes, one `play()`

The kit manifest decides how each event is delivered. `play(id)` is the same call
either way — the manifest branches it:

| Manifest bucket | Mode | What happens on `play(id)` |
|---|---|---|
| `events` | **fire** | a PLAY command is sent; the device plays the clip **installed on the device** (via Studio). |
| `stream_events` | **clip** | the SDK loads the event's **WAV (next to the manifest)** and **UDP-streams** it to the device (STREAM_BEGIN/DATA/END). |

So "fire" keeps content on the device; "clip" streams a WAV from the app side —
useful for content that changes often or isn't installed on the device.

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({
  eventMap: EventMap.fromManifest(manifest),
  // where the clip-mode WAVs live (the manifest's stream_events `clip` filenames
  // are resolved against this). Browser: a URL prefix; Node: a directory path.
  clipBase: "/my-kit/stream-clips/",
});

await hb.preloadClips();      // optional: decode clip WAVs up front (no first-play latency)

hb.play("sample-kit.sine_100hz");        // fire  → device plays its installed clip
hb.play("rumble.loop");       // clip  → SDK streams stream-clips/rumble_loop.wav over UDP
hb.stop("rumble.loop");       // stops the active stream
```

Manifest excerpt:

```jsonc
{
  "schema_version": "2.0.0",
  "events":        { "sample-kit.sine_100hz":  { "clip": "sine_100hz.wav",  "parameters": { "intensity": 0.5 } } },
  "stream_events": { "rumble.loop": { "clip": "rumble_loop.wav", "parameters": { "intensity": 0.6 } } }
}
```

Clip notes:
- WAVs must be **16-bit PCM, 16 kHz** (same as the kit-tools normalization). Stereo OK.
- Streaming is **session-level**: one clip at a time; a new clip cancels the previous.
- The device ring buffer is ~256 ms, so the SDK paces the stream in real time
  (tune with `streamSendAheadSec`, default 0.15).
- **Node** honours per-device `target` for clips (in-packet address). **Browser**
  clips reach all helper-known devices (the helper routes streams by IP), so run
  `discover()` first; per-device browser clip targeting is a later addition.
- Override clip loading with `clipLoader` (e.g. to stream from a bundle or IndexedDB).

## Notes

- The Node transport is verified end-to-end. The browser transport relays through
  hapbeat-helper; if `connect()` rejects, check that helper is running.
- Clip streaming over the browser requires devices to be in the helper's registry
  (call `discover()` after connecting).
