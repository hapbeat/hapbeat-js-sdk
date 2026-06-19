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
export type { Device, HapbeatOptions, Transport } from "./types.js";
export * as protocol from "./protocol.js";
