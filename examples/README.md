# `@hapbeat/sdk` examples

Runnable references, smallest first.

| Example | For | Shows | Needs |
|---|---|---|---|
| [`node-minimal.mjs`](./node-minimal.mjs) | Node | `connect()` → `play(id)` → `close()` over UDP | a Hapbeat on the LAN + a deployed kit (for sound) |
| [`browser-minimal.html`](./browser-minimal.html) | Browser | the same call over the helper WebSocket | `hapbeat-helper` running + HTTP server |
| [`games/`](./games/) | Browser | the full pattern: `EventMap` + kit manifest + the file-first/synth router, across an FPS and 3 mini-games | served over HTTP; helper for haptics |

## Before you run

1. **A Hapbeat device on the same Wi-Fi** (for actual haptics). The demos also run
   with audio + visuals only if no device/helper is present.
2. **Browser examples need the helper**: `pip install hapbeat-helper` → run
   `hapbeat-helper` (it bridges the page's WebSocket to UDP).
3. **Serve over HTTP, not `file://`** — ES modules + import maps don't load from the
   filesystem. From the repo root: `npm run dev` (build + watch + serve) and open the
   printed `http://localhost:8170/...` URL.

## Run

```bash
# Node
node examples/node-minimal.mjs

# Browser (from the repo root)
npm run dev
# → open http://localhost:8170/examples/browser-minimal.html
#   or  http://localhost:8170/examples/games/
```

## Troubleshooting

- **Nothing buzzes but the page loads** → start `hapbeat-helper`; confirm the device
  is on the LAN (`discover()`); confirm the event id is in the deployed kit. With no
  device, audio still plays — that's expected.
- **`connect()` rejects in the browser** → the helper isn't reachable at
  `ws://localhost:7703`.
- **Blank page / module errors** → you opened it from `file://`; serve over HTTP.
- **Node fires but the device is silent** → multi-homed PC may broadcast out the wrong
  NIC; ensure the Hapbeat LAN's interface has the route.
