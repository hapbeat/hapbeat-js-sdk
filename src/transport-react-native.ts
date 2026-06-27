/**
 * React Native transport: direct UDP broadcast over the `react-native-udp`
 * native module. A phone is NOT sandboxed like a browser — it can open a real
 * UDP socket — so it talks to Hapbeat over Wi-Fi directly, with no
 * hapbeat-helper. Same wire format as the Node transport (all in
 * UdpTransportBase); only the socket plumbing differs.
 *
 * `react-native-udp` is an OPTIONAL peer dependency — install it in the RN app.
 * This file is imported only by the React Native entry point, so Node/browser
 * bundles never pull it in.
 */

import dgram from "react-native-udp";

import { UdpTransportBase } from "./transport-udp-base.js";
import type { HapbeatOptions } from "./types.js";

export class ReactNativeUdpTransport extends UdpTransportBase {
  private socket?: ReturnType<typeof dgram.createSocket>;

  constructor(options: HapbeatOptions = {}) {
    super(options);
  }

  protected openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bind = (port: number, isFallback: boolean): void => {
        const sock = dgram.createSocket({ type: "udp4" });
        const onBindError = (err: Error): void => {
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          // Port busy -> ephemeral fallback (a phone usually has 7700 free).
          if (!isFallback) bind(0, true);
          else reject(err);
        };
        sock.once("error", onBindError);
        sock.bind(port, () => {
          sock.removeAllListeners("error");
          sock.on("error", (e: Error) => console.warn("[hapbeat] udp error:", e?.message ?? e));
          sock.on("message", (msg, rinfo) =>
            // Normalize to a plain Uint8Array (react-native-udp delivers a Buffer
            // whose byteOffset may be non-zero) before protocol parsing.
            this.handleMessage(Uint8Array.from(msg), rinfo.address),
          );
          sock.setBroadcast(true);
          this.socket = sock;
          resolve();
        });
      };
      bind(this.port, false);
    });
  }

  protected sendBytes(packet: Uint8Array): void {
    // react-native-udp wants explicit (offset, length); it accepts a Uint8Array.
    this.socket?.send(packet, 0, packet.length, this.port, this.broadcastAddr, (err) => {
      if (err) console.warn("[hapbeat] udp send failed:", err.message);
    });
  }

  protected closeSocket(): void {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
  }
}
