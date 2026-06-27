/**
 * React Native entry point. Direct Wi-Fi UDP broadcast over `react-native-udp`
 * (no hapbeat-helper — a phone can open a real UDP socket). Resolved
 * automatically via package.json "exports" -> "react-native" (Metro).
 *
 * Requires the optional peer dependency `react-native-udp` in the app, plus a
 * `TextEncoder`/`TextDecoder` polyfill on RN runtimes that lack them (and
 * `BigInt` on pre-0.70 runtimes). See the example app at examples/react-native/.
 */

export * from "./index.js";
export { ReactNativeUdpTransport } from "./transport-react-native.js";

import { Hapbeat } from "./hapbeat.js";
import { ReactNativeUdpTransport } from "./transport-react-native.js";
import type { HapbeatOptions } from "./types.js";

/** Open a direct UDP-broadcast connection (React Native) and return a ready Hapbeat. */
export async function connect(options: HapbeatOptions = {}): Promise<Hapbeat> {
  const opts: HapbeatOptions = { ...options };
  // Default clip loader: fetch WAV bytes over HTTP (clipBase = a URL prefix).
  // RN has a global fetch; command mode and streamPcm() need no loader at all.
  opts.clipLoader ??= async (ref) => {
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`clip fetch ${r.status}: ${ref}`);
    return r.arrayBuffer();
  };
  const hb = new Hapbeat(new ReactNativeUdpTransport(opts), opts);
  return hb.connect();
}
