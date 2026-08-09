/**
 * Node transport: direct UDP (unicast to known devices, broadcast otherwise)
 * over `node:dgram`.
 *
 * Imported only by the Node entry point so the `node:dgram` dependency never
 * leaks into browser/RN bundles. All protocol logic lives in UdpTransportBase;
 * this only provides the dgram socket.
 */

import * as dgram from "node:dgram";
import * as os from "node:os";

import { UdpTransportBase } from "./transport-udp-base.js";
import type { LocalSubnet } from "./transport-udp-base.js";
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

  /**
   * Local IPv4 interfaces, so broadcasts can be addressed to a subnet rather
   * than to 255.255.255.255 (see computeBroadcastRoutes for why that matters on
   * a host running Hyper-V / WSL2 / Docker). `os.networkInterfaces` reports the
   * real netmask, so nothing here has to assume a /24.
   */
  protected override localSubnets(): LocalSubnet[] {
    const out: LocalSubnet[] = [];
    try {
      for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) {
          // Node <18.4 reports family as the number 4; newer versions use "IPv4".
          const isIpv4 = info.family === "IPv4" || (info.family as unknown) === 4;
          if (!isIpv4 || info.internal) continue;
          out.push({ address: info.address, netmask: info.netmask });
        }
      }
    } catch {
      // Best effort: the limited broadcast still covers us.
    }
    return out;
  }

  protected sendBytesTo(packet: Uint8Array, ip: string, bestEffort = false): void {
    this.socket?.send(packet, this.port, ip, (err) => {
      // One unreachable destination (a device powered off since its last PONG,
      // or an adapter that cannot carry a broadcast) must not stop the packet
      // reaching the others, so this only reports.
      if (err) this.noteSendFailed(ip, err.message, bestEffort);
      else this.noteSendOk(ip);
    });
  }

  protected closeSocket(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
