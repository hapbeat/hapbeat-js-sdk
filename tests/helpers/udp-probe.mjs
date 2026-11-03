// Shared fakes for the UDP transport tests: a transport that records every
// datagram instead of opening a socket, and the device replies it needs.
// Nothing here opens a socket or reaches a device.
import * as protocol from "../../dist/protocol.js";
import { NodeUdpTransport } from "../../dist/node.js";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function leaseTail({
  incarnation, bootId = 0xb007n, ticket = 3, flags = 1, highWater = 0,
  version = 1, reserved = 0, length = 32, marker = "HBS2",
}) {
  const out = new Uint8Array(Math.max(length, 32));
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(marker), 0);
  view.setUint8(4, version);
  view.setUint8(5, flags);
  view.setUint16(6, reserved, true);
  view.setBigUint64(8, incarnation, true);
  view.setBigUint64(16, bootId, true);
  view.setUint32(24, ticket, true);
  view.setUint32(28, highWater, true);
  return out.subarray(0, length);
}

export function makePong({ seq = 0, timestamp = 0n, address = "p1", name = "dev", firmware = "0.4.1", tail } = {}) {
  const strs = new TextEncoder().encode(`${name}\0${address}\0${firmware}\0`);
  const extra = tail ?? new Uint8Array(0);
  const payload = new Uint8Array(16 + strs.length + 2 + extra.length);
  new DataView(payload.buffer).setBigInt64(0, timestamp, true);
  payload.set(strs, 16);
  payload.set([5, 9], 16 + strs.length); // volume_level, volume_wiper
  payload.set(extra, 16 + strs.length + 2);
  return protocol.buildPacket(protocol.CMD_PONG, seq, payload);
}

/** A device ERROR (message-format.md §0xFF) with the 1.x reference fields. */
export function makeError(code, { detail = new Uint8Array(0), refCommand = protocol.CMD_STREAM_DATA, refSeq = 1, message = "err" } = {}) {
  const text = new TextEncoder().encode(`${message}\0`);
  const payload = new Uint8Array(2 + text.length + 4 + detail.length);
  const view = new DataView(payload.buffer);
  view.setUint16(0, code, true);
  payload.set(text, 2);
  view.setUint8(2 + text.length, refCommand);
  view.setUint16(3 + text.length, refSeq, true);
  view.setUint8(5 + text.length, detail.length);
  payload.set(detail, 6 + text.length);
  return protocol.buildPacket(protocol.CMD_ERROR, 7, payload);
}

// parsePacket accepts header version 1 only; Gen 2 stream packets are read here.
export function parsePacketAnyVersion(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const length = view.getUint16(6, true);
  return { version: raw[2], cmd: raw[3], seq: view.getUint16(4, true), payload: raw.subarray(8, 8 + length) };
}

export function envelopeOf(packet) {
  const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, 16);
  return { bootId: view.getBigUint64(0, true), ticket: view.getUint32(8, true), generation: view.getUint32(12, true) };
}

export class Probe extends NodeUdpTransport {
  constructor(opts = {}) { super({ keepalive: false, ...opts }); this.sends = []; }
  async openSocket() {}
  closeSocket() {}
  localSubnets() { return []; }
  sendBytesTo(pkt, ip) { this.sends.push([new Uint8Array(pkt), ip]); }
  /**
   * Send an extended PING to `ip` and return what the device would correlate
   * on. The device is made known first (lease PINGs are unicast to known
   * devices); everything this sends is dropped from `sends`.
   */
  pingNow(ip = "10.0.0.1", address = "p1") {
    const before = this.sends.length;
    if (!this.knownDevices.has(ip)) this.handleMessage(makePong({ address }), ip, 7700);
    this.sendLeasePing(ip);
    const pkt = protocol.parsePacket(this.sends.at(-1)[0]);
    this.sends.length = before;
    const view = new DataView(pkt.payload.buffer, pkt.payload.byteOffset, 16);
    return { seq: pkt.seq, timestamp: view.getBigInt64(0, true), incarnation: view.getBigUint64(8, true) };
  }
  /** A matched direct reply from a Stream Gen 2 device. */
  replyV2(ip, ping, { address = "p1", bootId = 0xb007n, ticket = 3, flags = 1, incarnation, firmware } = {}) {
    this.handleMessage(makePong({
      seq: ping.seq, timestamp: ping.timestamp, address, firmware,
      tail: leaseTail({ incarnation: incarnation ?? ping.incarnation, bootId, ticket, flags }),
    }), ip, 7700);
  }
  /** A matched direct reply from Stream Gen 1 firmware (no tail). */
  replyLegacy(ip, ping, address = "p1") {
    this.handleMessage(makePong({ seq: ping.seq, timestamp: ping.timestamp, address }), ip, 7700);
  }
  epoch(ip) { return this.streamEndpoints().find((e) => e.ip === ip)?.wireEpoch; }
  streamPackets() {
    return this.sends
      .map(([pkt, ip]) => ({ pkt: parsePacketAnyVersion(pkt), raw: pkt, ip }))
      .filter(({ raw }) => raw[3] >= protocol.CMD_STREAM_BEGIN && raw[3] <= protocol.CMD_STREAM_END);
  }
  /** Every datagram of one command, with its destination. */
  packets(cmd) {
    return this.sends.filter(([pkt]) => pkt[3] === cmd).map(([pkt, ip]) => ({ pkt: parsePacketAnyVersion(pkt), ip }));
  }
}

export function monoPcm(value, frames) {
  const data = new Uint8Array(frames * 2);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame++) view.setInt16(frame * 2, value, true);
  return data;
}

export const begins = (t, ip) => t.streamPackets().filter(({ pkt, ip: to }) =>
  pkt.cmd === protocol.CMD_STREAM_BEGIN && (ip === undefined || to === ip));
export const ends = (t, ip) => t.streamPackets().filter(({ pkt, ip: to }) =>
  pkt.cmd === protocol.CMD_STREAM_END && (ip === undefined || to === ip));
/** The distinct Gen 2 generations among BEGIN packets (a repeated BEGIN is the same tuple). */
export const generations = (packets) => [...new Set(packets.map(({ pkt }) => envelopeOf(pkt).generation))];
