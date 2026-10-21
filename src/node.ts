/**
 * Node entry point. Uses the UDP (dgram) transport for direct LAN broadcast.
 * Resolved automatically via package.json "exports" → "node".
 */

export * from "./index.js";
export { NodeUdpTransport } from "./transport-node.js";

import { readFile } from "node:fs/promises";

import { Hapbeat, setClipFileReader } from "./hapbeat.js";
import { NodeUdpTransport } from "./transport-node.js";
import type { HapbeatOptions } from "./types.js";

/** Read a file (path or `file:` URL) as an ArrayBuffer. */
async function readFileBytes(ref: string | URL): Promise<ArrayBuffer> {
  const b = await readFile(ref);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// Enables Hapbeat.playClipFile() for every Hapbeat created in Node, including
// `new Hapbeat(new NodeUdpTransport())`. connect() registers it again, in case
// a bundler honouring `"sideEffects": false` skipped this module's top level.
setClipFileReader(readFileBytes);

/** Open a UDP-broadcast connection and return a ready Hapbeat. */
export async function connect(options: HapbeatOptions = {}): Promise<Hapbeat> {
  setClipFileReader(readFileBytes);
  const opts: HapbeatOptions = { ...options };
  // default clip loader: read WAV files from disk (clipBase = a directory path)
  opts.clipLoader ??= readFileBytes;
  const hb = new Hapbeat(new NodeUdpTransport(opts), opts);
  return hb.connect();
}
