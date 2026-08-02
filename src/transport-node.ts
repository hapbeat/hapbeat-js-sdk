/**
 * Node transport: direct UDP (unicast to known devices, broadcast otherwise)
 * over `node:dgram`.
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
          // bindPort busy (e.g. another listener on it) -> ephemeral fallback.
          if (!isFallback) bind(0, true);
          else reject(err);
        };
        sock.once("error", onBindError);
        sock.bind(port, () => {
          sock.removeListener("error", onBindError);
          // Log only — never close the socket, and never make this a `once`
          // listener. Unicasting at a device that is off/rebooting makes ICMP
          // port-unreachable routine (Windows surfaces it here as ECONNRESET);
          // tearing the socket down on that would leave the SDK permanently
          // deaf to PONGs — the exact bug the Unity SDK and hapbeat-helper
          // each had to fix.
          sock.on("error", (e) => console.warn("[hapbeat] udp error:", e.message));
          sock.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo.address));
          sock.setBroadcast(true);
          this.socket = sock;
          resolve();
        });
      };
      // Receive on bindPort (ephemeral by default per DEC-036); send to this.port.
      bind(this.bindPort, false);
    });
  }

  protected sendBytes(packet: Uint8Array): void {
    this.sendBytesTo(packet, this.broadcastAddr);
  }

  protected sendBytesTo(packet: Uint8Array, ip: string): void {
    this.socket?.send(packet, this.port, ip, (err) => {
      // One unreachable device (powered off since its last PONG) must not stop
      // the packet reaching the others, so this only logs.
      if (err) console.warn(`[hapbeat] udp send to ${ip} failed:`, err.message);
    });
  }

  protected closeSocket(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
