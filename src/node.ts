/**
 * Node entry point. Uses the UDP (dgram) transport for direct LAN broadcast.
 * Resolved automatically via package.json "exports" → "node".
 */

export * from "./index.js";
export { NodeUdpTransport } from "./transport-node.js";

import { Hapbeat } from "./hapbeat.js";
import { NodeUdpTransport } from "./transport-node.js";
import type { HapbeatOptions } from "./types.js";

/** Open a UDP-broadcast connection and return a ready Hapbeat. */
export async function connect(options: HapbeatOptions = {}): Promise<Hapbeat> {
  const hb = new Hapbeat(new NodeUdpTransport(options), options);
  return hb.connect();
}
