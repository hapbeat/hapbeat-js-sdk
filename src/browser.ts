/**
 * Browser entry point. Relays to hapbeat-helper over WebSocket (browsers
 * cannot open raw UDP). Resolved automatically via package.json "exports" →
 * "browser" (and "default").
 */

export * from "./index.js";
export { BrowserWsTransport } from "./transport-browser.js";

import { Hapbeat } from "./hapbeat.js";
import { BrowserWsTransport } from "./transport-browser.js";
import type { HapbeatOptions } from "./types.js";

/** Open a helper-WebSocket connection and return a ready Hapbeat. */
export async function connect(options: HapbeatOptions = {}): Promise<Hapbeat> {
  const hb = new Hapbeat(new BrowserWsTransport(options), options);
  return hb.connect();
}
