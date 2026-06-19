/**
 * Hapbeat Layer 1 (SDK -> device) UDP protocol.
 *
 * Pure, dependency-free packet builders/parsers. Works in Node and the
 * browser (TextEncoder / DataView only). This module is the byte-for-byte
 * source of truth for the wire format inside the Web SDK and must stay
 * compatible with `hapbeat-contracts/specs/message-format.md`.
 *
 * Reference implementations: HapbeatProtocol.cs (Unity), protocol.py (helper).
 * Every multi-byte field is little-endian.
 */

export const MAGIC = 0x4842; // "HB"
export const VERSION = 0x01;
export const HEADER_SIZE = 8;
export const MAX_PACKET_SIZE = 512; // command packets
export const MAX_STREAM_PACKET_SIZE = 1472; // 1500 MTU - 20 IP - 8 UDP

// App name shown on device OLED is capped to the display grid width
// (contracts/specs/display-layout.md, 16 chars).
export const MAX_APP_NAME_LEN = 16;

// Command types (SDK -> device)
export const CMD_PLAY = 0x01;
export const CMD_STOP = 0x02;
export const CMD_STOP_ALL = 0x03;
export const CMD_PING = 0x10;
export const CMD_CONNECT_STATUS = 0x20;
export const CMD_STREAM_BEGIN = 0x30;
export const CMD_STREAM_DATA = 0x31;
export const CMD_STREAM_END = 0x32;

// Response types (device -> SDK)
export const CMD_PONG = 0x11;
export const CMD_ERROR = 0xff;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cstr(s: string): Uint8Array {
  const body = encoder.encode(s);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  return out; // trailing 0 from zero-init
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Build the 8-byte common header (little-endian). */
export function buildHeader(commandType: number, seq: number, payloadLength: number): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, MAGIC, true);
  dv.setUint8(2, VERSION);
  dv.setUint8(3, commandType);
  dv.setUint16(4, seq & 0xffff, true);
  dv.setUint16(6, payloadLength, true);
  return buf;
}

/** Assemble a full command packet and enforce the 512-byte cap. */
export function buildPacket(commandType: number, seq: number, payload: Uint8Array): Uint8Array {
  const total = HEADER_SIZE + payload.length;
  if (total > MAX_PACKET_SIZE) {
    throw new Error(`packet size ${total} exceeds maximum ${MAX_PACKET_SIZE} bytes`);
  }
  return concat([buildHeader(commandType, seq, payload.length), payload]);
}

export interface PlayOptions {
  target?: string;
  targetTimeUs?: number;
  gain?: number;
}

/**
 * PLAY (0x01). Payload (contracts/specs/device-addressing.md §5.1):
 *   event_id(null-term) + target(null-term) + target_time(i64) + gain(f32)
 * `target=""` broadcasts to every device.
 */
export function buildPlay(seq: number, eventId: string, opts: PlayOptions = {}): Uint8Array {
  const { target = "", targetTimeUs = 0, gain = 1.0 } = opts;
  const tail = new Uint8Array(12);
  const dv = new DataView(tail.buffer);
  dv.setBigInt64(0, BigInt(Math.round(targetTimeUs)), true);
  dv.setFloat32(8, gain, true);
  return buildPacket(CMD_PLAY, seq, concat([cstr(eventId), cstr(target), tail]));
}

/** STOP (0x02). Payload: event_id(null-term) + target(null-term). */
export function buildStop(seq: number, eventId: string, target = ""): Uint8Array {
  return buildPacket(CMD_STOP, seq, concat([cstr(eventId), cstr(target)]));
}

/** STOP_ALL (0x03). Payload: target(null-term). */
export function buildStopAll(seq: number, target = ""): Uint8Array {
  return buildPacket(CMD_STOP_ALL, seq, cstr(target));
}

/** PING (0x10). Payload: timestamp(i64, microseconds). */
export function buildPing(seq: number, timestampUs: number): Uint8Array {
  const p = new Uint8Array(8);
  new DataView(p.buffer).setBigInt64(0, BigInt(Math.round(timestampUs)), true);
  return buildPacket(CMD_PING, seq, p);
}

// Audio formats for STREAM_BEGIN (contracts message-format.md §0x30).
export const STREAM_FORMAT_PCM16 = 0;
export const STREAM_FORMAT_ADPCM = 1;

/** Assemble a streaming packet, enforcing the larger 1472-byte stream cap. */
function buildStreamPacket(commandType: number, seq: number, payload: Uint8Array): Uint8Array {
  const total = HEADER_SIZE + payload.length;
  if (total > MAX_STREAM_PACKET_SIZE) {
    throw new Error(`stream packet size ${total} exceeds maximum ${MAX_STREAM_PACKET_SIZE} bytes`);
  }
  return concat([buildHeader(commandType, seq, payload.length), payload]);
}

export interface StreamBeginOptions {
  sampleRate?: number;
  channels?: number;
  /** 0 = PCM16, 1 = IMA ADPCM. */
  format?: number;
  totalSamples?: number;
  gain?: number;
  target?: string;
}

/**
 * STREAM_BEGIN (0x30). Payload (contracts/specs/message-format.md §0x30):
 *   sample_rate(u16) + channels(u8) + format(u8) + total_samples(u32) + gain(f32)
 *   + target(null-term, optional). No event_id — a stream is session-level.
 */
export function buildStreamBegin(seq: number, opts: StreamBeginOptions = {}): Uint8Array {
  const {
    sampleRate = 16000,
    channels = 1,
    format = STREAM_FORMAT_PCM16,
    totalSamples = 0,
    gain = 1.0,
    target = "",
  } = opts;
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, sampleRate & 0xffff, true);
  dv.setUint8(2, channels & 0xff);
  dv.setUint8(3, format & 0xff);
  dv.setUint32(4, totalSamples >>> 0, true);
  dv.setFloat32(8, gain, true);
  const payload = target ? concat([head, cstr(target)]) : head;
  return buildStreamPacket(CMD_STREAM_BEGIN, seq, payload);
}

/** STREAM_DATA (0x31). Payload: offset(u32) + raw audio bytes (PCM16/ADPCM). */
export function buildStreamData(seq: number, offset: number, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, offset >>> 0, true);
  return buildStreamPacket(CMD_STREAM_DATA, seq, concat([head, data]));
}

/** STREAM_END (0x32). No payload. */
export function buildStreamEnd(seq: number): Uint8Array {
  return buildStreamPacket(CMD_STREAM_END, seq, new Uint8Array(0));
}

export interface ConnectStatusOptions {
  connected?: boolean;
  group?: number;
  appName?: string;
  deviceName?: string;
}

/**
 * CONNECT_STATUS (0x20). Periodic keep-alive shown on the device OLED.
 * Wire layout matches the proven Unity implementation
 * (HapbeatProtocol.cs), which is what the firmware parses:
 *   connected(u8) + group(u8) + app_name(null-term) + device_name(null-term)
 */
export function buildConnectStatus(seq: number, opts: ConnectStatusOptions = {}): Uint8Array {
  const { connected = true, group = 0, appName = "", deviceName = "" } = opts;
  const head = new Uint8Array([connected ? 1 : 0, group & 0xff]);
  return buildPacket(CMD_CONNECT_STATUS, seq, concat([head, cstr(appName), cstr(deviceName)]));
}

export interface ParsedPacket {
  commandType: number;
  seq: number;
  payload: Uint8Array;
}

/** Parse a packet into its parts, or null on bad magic/version/length. */
export function parsePacket(data: Uint8Array): ParsedPacket | null {
  if (data.length < HEADER_SIZE) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint16(0, true) !== MAGIC) return null;
  if (dv.getUint8(2) !== VERSION) return null;
  const commandType = dv.getUint8(3);
  const seq = dv.getUint16(4, true);
  const payloadLength = dv.getUint16(6, true);
  if (data.length < HEADER_SIZE + payloadLength) return null;
  return { commandType, seq, payload: data.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength) };
}

function readCString(buf: Uint8Array, start: number): [string, number] {
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return [decoder.decode(buf.subarray(start, end)), end + 1];
}

export interface Pong {
  seq: number;
  timestamp: bigint;
  serverTime: bigint;
  deviceName?: string;
  address?: string;
  firmwareVersion?: string;
  volumeLevel?: number;
  volumeWiper?: number;
  volumeSteps?: number;
}

/** Parse a PONG (0x11). Bridge form is 16 bytes; devices append extended fields. */
export function parsePong(data: Uint8Array): Pong | null {
  const pkt = parsePacket(data);
  if (!pkt || pkt.commandType !== CMD_PONG) return null;
  const p = pkt.payload;
  if (p.length < 16) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const out: Pong = {
    seq: pkt.seq,
    timestamp: dv.getBigInt64(0, true),
    serverTime: dv.getBigInt64(8, true),
  };
  let off = 16;
  if (off < p.length) [out.deviceName, off] = readCString(p, off);
  if (off < p.length) [out.address, off] = readCString(p, off);
  if (off < p.length) [out.firmwareVersion, off] = readCString(p, off);
  if (off < p.length) out.volumeLevel = p[off++];
  if (off < p.length) out.volumeWiper = p[off++];
  if (off < p.length) out.volumeSteps = p[off++];
  return out;
}
