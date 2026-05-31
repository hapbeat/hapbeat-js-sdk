# Hapbeat Web SDK

Drive [Hapbeat](https://hapbeat.com) haptic devices from JavaScript / TypeScript.
One API, two transports:

- **Node** (Electron, servers, CLIs, creative-coding runtimes) → direct Wi-Fi UDP broadcast.
- **Browser** (WebXR, three.js / Babylon.js, p5.js, jsPsych experiments) → relays through
  [hapbeat-helper](https://github.com/hapbeat/hapbeat-helper) over WebSocket, because
  browsers cannot open raw UDP sockets.

> **📚 Docs**: <https://devtools.hapbeat.com/docs/sdk-integration/>

This is the **level-1** SDK. The fire side (`play` / `stop`) and the tuning side
(`EventMap`) are kept orthogonal and linked only by event id — the same design as the
Hapbeat Unity SDK.

## Install

```bash
npm install @hapbeat/sdk
```

> npm publish is pending; until then install from a checkout (`npm install && npm run build`,
> then `npm link`) or a git dependency.

## Node

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyApp" });   // opens UDP broadcast + keep-alive
hb.play("impact.hit", { gain: 0.3 });             // fire by event id
hb.play("impact.hit");                            // gain omitted -> kit baseline
hb.stopAll();
await hb.close();
```

## Browser (requires hapbeat-helper running locally)

```ts
import { connect } from "@hapbeat/sdk";

const hb = await connect({ appName: "MyWebXR" });  // -> ws://localhost:7703
hb.play("impact.hit", { gain: 0.5 });
```

Bundlers pick the browser build automatically via the package `exports` map.

`"impact.hit"` must be an event id present in the **kit deployed to the device**
(via [Hapbeat Studio](https://devtools.hapbeat.com)). The SDK sends the *instruction*;
the waveform lives in the kit on the device.

## EventMap — the tuning side (optional)

```ts
import { connect, EventMap } from "@hapbeat/sdk";

const manifest = await fetch("/my-kit/my-kit-manifest.json").then((r) => r.json());
const hb = await connect({ eventMap: EventMap.fromManifest(manifest) });
hb.play("impact.hit");   // uses the kit manifest's intensity for this event
```

## Discovery & targeting

```ts
for (const d of await hb.discover(1500)) console.log(d.ip, d.address);

hb.play("impact.hit", { target: "player_1/chest" });  // one device
hb.play("impact.hit", { target: "*/chest" });          // all chest devices
```

## License

MIT © Hapbeat
