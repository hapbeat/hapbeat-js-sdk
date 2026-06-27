# Hapbeat React Native demo (Android)

A minimal phone app that drives Hapbeat **directly over Wi‑Fi UDP — no
`hapbeat-helper`**. A phone is not sandboxed like a browser, so React Native can
open a real UDP socket (via `react-native-udp`) and broadcast straight to the
device. Button taps send a command (`play`) and a 1‑second synthesized
streaming buffer.

> This example ships only `App.tsx` (drop it into a bare RN app). It is not a
> full project — follow the steps below. **Verified on a physical Android device
> with React Native 0.86** (Hermes / New Architecture): the UDP socket binds, a
> Hapbeat is discovered, and command + streaming both fire — all without a helper.

## Prerequisites

- Android Studio + an Android device or emulator, and the React Native
  environment set up (https://reactnative.dev/docs/environment-setup).
- A **Hapbeat on the same Wi‑Fi LAN** as the phone, with the **sample‑kit
  deployed** in Hapbeat Studio (so `sample-kit.sine_100hz` makes sound).

## Setup

```bash
# 1. Scaffold a bare RN app (skip if you already have one)
npx @react-native-community/cli@latest init HapbeatRnDemo
cd HapbeatRnDemo

# 2. Install: the UDP native module (autolinked), the TextDecoder polyfill, the SDK
npm install react-native-udp fast-text-encoding

# 2a. Until @hapbeat/sdk >= 0.2.0 is on npm, install the local build:
#     in the SDK repo:  npm run build && npm pack   → hapbeat-sdk-0.2.0.tgz
#     then here:        npm install /path/to/hapbeat-sdk-0.2.0.tgz
#   (after publish:     npm install @hapbeat/sdk )

# 3. Drop in this App.tsx (replace the generated one)
cp /path/to/hapbeat-js-sdk/examples/react-native/App.tsx ./App.tsx

# 4. Tell Metro to honor the package "react-native" export condition (see below)

# 5. Run on Android
npx react-native run-android
```

### metro.config.js

So `@hapbeat/sdk` resolves to its `react-native` build (UDP), add to the resolver:

```js
const config = {
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ['react-native', 'require', 'default'],
  },
};
```

## Polyfill: TextDecoder (required)

The wire protocol uses `TextEncoder`/`TextDecoder`. RN's Hermes — **including
0.86** — ships `TextEncoder` but **not** `TextDecoder`, so `npm i
fast-text-encoding` is required and `import 'fast-text-encoding';` must be the
**first import** (it is, at the top of `App.tsx`). Without it you get
`ReferenceError: Property 'TextDecoder' doesn't exist` on connect.

(An ASCII `appName` like `"RN Demo"` is used here; `fast-text-encoding` also
covers a Japanese `appName` for the OLED.)

The protocol also uses `BigInt` / `DataView.setBigInt64` (timestamps). Hermes has
supported `BigInt` since RN 0.70, so no action is needed on any modern RN; only a
very old JSC runtime would need a `BigInt` polyfill (the failure is a clean throw,
surfaced in the `App.tsx` catch).

## Android specifics

- **`INTERNET` permission** is in the default RN manifest — no change needed for
  sending UDP broadcast.
- To **receive** PONG/discovery on some networks/devices you may need a
  multicast lock; for just *sending* commands it is usually unnecessary.
- **AP / client isolation**: guest Wi‑Fi and some routers block broadcast
  between clients. If `discover()` finds nothing and nothing buzzes, try a
  normal LAN / mobile hotspot.

## How it works

`import { connect } from '@hapbeat/sdk'` resolves to the **`react-native`**
build via the package `exports` map, which uses `ReactNativeUdpTransport`
(`react-native-udp`). It speaks the exact same Layer‑1 wire format as the Node
transport — only the socket differs. No helper, no cloud: the phone broadcasts
on UDP `255.255.255.255:7700` and the Hapbeat self‑filters by target.

## Troubleshooting

- **`connect()` throws / `react-native-udp` not found** → run `npx react-native
  run-android` again after installing (native autolink needs a rebuild).
- **`TextEncoder is not defined`** → add the polyfill (above).
- **Nothing buzzes** → confirm same Wi‑Fi, the sample‑kit is deployed, and the
  network is not isolating broadcast. Try `target=""` (broadcast).

## iOS (later)

The same transport works on iOS, but iOS 14+ requires the **Local Network**
permission (`NSLocalNetworkUsageDescription` in `Info.plist`); UDP to the LAN is
blocked until the user allows it. Not covered by this Android‑first demo.
