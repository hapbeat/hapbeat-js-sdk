/**
 * Minimal ambient types for the OPTIONAL peer dependency `react-native-udp`,
 * so this package type-checks/builds without it installed. The RN app provides
 * the real module at runtime (Metro resolves the "react-native" export
 * condition). Only the surface used by transport-react-native.ts is declared.
 */
declare module "react-native-udp" {
  export interface RnUdpRInfo {
    address: string;
    port: number;
    family?: string;
    size?: number;
  }

  export interface RnUdpSocket {
    bind(port: number, callback?: () => void): void;
    bind(port: number, address: string, callback?: () => void): void;
    send(
      msg: Uint8Array | string,
      offset: number,
      length: number,
      port: number,
      address: string,
      callback?: (err?: Error) => void,
    ): void;
    setBroadcast(flag: boolean): void;
    on(event: "message", cb: (msg: Uint8Array, rinfo: RnUdpRInfo) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
    on(event: "listening", cb: () => void): void;
    once(event: "error", cb: (err: Error) => void): void;
    once(event: "listening", cb: () => void): void;
    removeAllListeners(event?: string): void;
    close(callback?: () => void): void;
  }

  export interface RnUdpStatic {
    createSocket(options: {
      type: "udp4" | "udp6";
      reusePort?: boolean;
      debug?: boolean;
    }): RnUdpSocket;
  }

  const dgram: RnUdpStatic;
  export default dgram;
}
