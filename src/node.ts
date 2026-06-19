/**
 * Node entry point. Uses the UDP (dgram) transport for direct LAN broadcast.
 * Resolved automatically via package.json "exports" → "node".
 */

export * from "./index.js";
export { NodeUdpTransport } from "./transport-node.js";

import { readFile } from "node:fs/promises";

import { Hapbeat } from "./hapbeat.js";
import { NodeUdpTransport } from "./transport-node.js";
import type { HapbeatOptions } from "./types.js";

/** Open a UDP-broadcast connection and return a ready Hapbeat. */
export async function connect(options: HapbeatOptions = {}): Promise<Hapbeat> {
  const opts: HapbeatOptions = { ...options };
  // default clip loader: read WAV files from disk (clipBase = a directory path)
  opts.clipLoader ??= async (ref) => {
    const b = await readFile(ref);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const hb = new Hapbeat(new NodeUdpTransport(opts), opts);
  return hb.connect();
}
