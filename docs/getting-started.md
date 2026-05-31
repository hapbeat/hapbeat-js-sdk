# Getting Started (Web / Node)

Drive a Hapbeat device from JavaScript or TypeScript.

## Prerequisites

- A Hapbeat device on the **same Wi-Fi/LAN** as your machine.
- A **kit deployed to the device** via [Hapbeat Studio](https://devtools.hapbeat.com),
  defining the event ids you can play (e.g. `impact.hit`).
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
hb.play("impact.hit", { gain: 0.5 });
await hb.close();
```

`connect()` opens a UDP broadcast socket and runs a keep-alive so the device
OLED shows your `appName`.

## Browser (WebXR / three.js / p5.js)

```ts
import { connect } from "@hapbeat/sdk";

// helper must be running locally (ws://localhost:7703)
const hb = await connect({ appName: "MyWebXR" });
hb.play("impact.hit", { gain: 0.5 });
```

Your bundler (Vite, webpack, esbuild) automatically picks the browser build via
the package `exports` map.

## Keep intensities out of firing code

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("impact.hit");   // fires at the manifest's authored intensity
```

## Targeting

```ts
hb.play("impact.hit", { target: "player_1/chest" }); // one device
hb.play("impact.hit", { target: "*/chest" });         // all chest devices
hb.play("impact.hit");                                 // broadcast (all)
```

## Notes

- The Node transport is verified end-to-end. The browser transport relays through
  hapbeat-helper; if `connect()` rejects, check that helper is running.
