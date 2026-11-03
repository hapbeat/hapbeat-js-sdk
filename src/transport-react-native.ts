/**
 * React Native transport: direct UDP (unicast to known devices, broadcast
 * otherwise) over the `react-native-udp` native module. A phone is NOT
 * sandboxed like a browser — it can open a real UDP socket — so it talks to
 * Hapbeat over Wi-Fi directly, with no hapbeat-helper. Same wire format as the
 * Node transport (all in UdpTransportBase); only the socket plumbing differs.
 *
 * `react-native-udp` is an OPTIONAL peer dependency — install it in the RN app.
 * This file is imported only by the React Native entry point, so Node/browser
 * bundles never pull it (or `react-native`) in.
 *
 * Coming back to the foreground renews the client incarnation and asks for new
 * stream leases at once (contracts stream-session.md "Incarnation and
 * takeover": a fresh incarnation on foreground resume).
 */

import { AppState } from "react-native";
import dgram from "react-native-udp";

import { UdpTransportBase } from "./transport-udp-base.js";
import type { HapbeatOptions } from "./types.js";

export class ReactNativeUdpTransport extends UdpTransportBase {
  private socket?: ReturnType<typeof dgram.createSocket>;
  private appStateSubscription?: { remove(): void };
  private appState?: string;

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
          // bindPort busy -> ephemeral fallback (a phone usually has it free).
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
            this.handleMessage(Uint8Array.from(msg), rinfo.address, rinfo.port),
          );
          sock.setBroadcast(true);
          this.socket = sock;
          this.watchAppState();
          resolve();
        });
      };
      // Receive on bindPort (ephemeral by default per DEC-036); send to this.port.
      bind(this.bindPort, false);
    });
  }

  // localSubnets() is deliberately not overridden: React Native has no
  // `node:os`, and a phone or headset has one usable Wi-Fi interface anyway —
  // the multi-homed case this guards against is a desktop with a virtual
  // switch. The base class returns [], so this transport keeps sending to the
  // limited broadcast exactly as before.

  protected sendBytesTo(packet: Uint8Array, ip: string, bestEffort = false): void {
    // react-native-udp wants explicit (offset, length); it accepts a Uint8Array.
    this.socket?.send(packet, 0, packet.length, this.port, ip, (err) => {
      // One unreachable device (powered off since its last PONG) must not stop
      // the packet reaching the others, so this only reports.
      if (err) this.noteSendFailed(ip, err.message, bestEffort);
      else this.noteSendOk(ip);
    });
  }

  /** background / inactive -> active: the app resumed. */
  private watchAppState(): void {
    this.appStateSubscription?.remove();
    this.appState = AppState.currentState;
    this.appStateSubscription = AppState.addEventListener("change", (next) => {
      const previous = this.appState;
      this.appState = next;
      if (next === "active" && previous !== undefined && previous !== "active") this.resumeFromBackground();
    });
  }

  protected closeSocket(): void {
    this.appStateSubscription?.remove();
    this.appStateSubscription = undefined;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
  }
}
