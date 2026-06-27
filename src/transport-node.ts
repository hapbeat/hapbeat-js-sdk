/**
 * Node transport: direct UDP broadcast over `node:dgram`.
 *
 * Imported only by the Node entry point so the `node:dgram` dependency never
 * leaks into browser/RN bundles. All protocol logic lives in UdpTransportBase;
 * this only provides the dgram socket.
 */

import * as dgram from "node:dgram";

import { UdpTransportBase } from "./transport-udp-base.js";
import type { HapbeatOptions } from "./types.js";

export class NodeUdpTransport extends UdpTransportBase {
  private socket?: dgram.Socket;

  constructor(options: HapbeatOptions = {}) {
    super(options);
  }

  protected openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bind = (port: number, isFallback: boolean): void => {
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const onBindError = (err: Error): void => {
          sock.removeListener("error", onBindError);
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          // Port busy (e.g. hapbeat-helper holds 7700) -> ephemeral fallback.
          if (!isFallback) bind(0, true);
          else reject(err);
        };
        sock.once("error", onBindError);
        sock.bind(port, () => {
          sock.removeListener("error", onBindError);
          sock.on("error", (e) => console.warn("[hapbeat] udp error:", e.message));
          sock.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo.address));
          sock.setBroadcast(true);
          this.socket = sock;
          resolve();
        });
      };
      bind(this.port, false);
    });
  }

  protected sendBytes(packet: Uint8Array): void {
    this.socket?.send(packet, this.port, this.broadcastAddr, (err) => {
      if (err) console.warn("[hapbeat] udp send failed:", err.message);
    });
  }

  protected closeSocket(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
