/**
 * Shared, environment-agnostic exports. Most apps import from the package
 * root ("@hapbeat/sdk"), which resolves to the Node or Browser entry (each
 * re-exports everything here plus an environment-specific `connect`).
 */

export { Hapbeat } from "./hapbeat.js";
export type { PlayOpts } from "./hapbeat.js";
export { EventMap } from "./eventmap.js";
export type { EventDef, KitManifest } from "./eventmap.js";
export { parseWav } from "./wav.js";
export type { WavPcm } from "./wav.js";
export { ClipStreamer } from "./clip.js";
export type { StreamMeta, StreamSink, ClipPlayOpts, ClipHandle } from "./clip.js";
export { LiveStream } from "./live-stream.js";
export type { LiveStreamHandle } from "./live-stream.js";
export type { Device, HapbeatOptions, Transport } from "./types.js";
// Re-export the wire layer as a namespace. Written as import+export (not
// `export * as protocol`) so React Native's Metro/babel can transform it
// without the @babel/plugin-transform-export-namespace-from plugin.
import * as protocol from "./protocol.js";
export { protocol };
