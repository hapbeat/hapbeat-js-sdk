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
/**
 * Header protocol_version of STREAM_BEGIN/DATA/END in Stream Gen 2 (session
 * stream, contracts stream-session.md). Every other command, and Stream Gen 1
 * (sessionless) kept for firmware 0.4.x and earlier, stays at VERSION. The
 * export keeps its name (a public API; versioning.md §3.5).
 */
export const STREAM_V2_VERSION = 0x02;
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
export const CMD_CAPS_REQ = 0x12;
export const CMD_CONNECT_STATUS = 0x20;
export const CMD_STREAM_BEGIN = 0x30;
export const CMD_STREAM_DATA = 0x31;
export const CMD_STREAM_END = 0x32;

// Response types (device -> SDK)
export const CMD_PONG = 0x11;
export const CMD_CAPS = 0x13;
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
export function buildHeader(
  commandType: number,
  seq: number,
  payloadLength: number,
  version: number = VERSION,
): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, MAGIC, true);
  dv.setUint8(2, version);
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
  /** Left/right balance: -1 = left only, 0 = centre, +1 = right only. */
  pan?: number;
}

/** Clamp a pan value into the wire range (contracts message-format.md §0x01). */
function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return pan < -1 ? -1 : pan > 1 ? 1 : pan;
}

/**
 * PLAY (0x01). Payload (contracts/specs/message-format.md §0x01):
 *   event_id(null-term) + target(null-term) + target_time(i64) + gain(f32) + pan(f32)
 * `target=""` broadcasts to every device.
 *
 * `pan` is the trailing optional field (DEC-055): older firmware that stops
 * parsing after `gain` plays centred, and the sender always writes it.
 */
export function buildPlay(seq: number, eventId: string, opts: PlayOptions = {}): Uint8Array {
  const { target = "", targetTimeUs = 0, gain = 1.0, pan = 0 } = opts;
  const tail = new Uint8Array(16);
  const dv = new DataView(tail.buffer);
  dv.setBigInt64(0, BigInt(Math.round(targetTimeUs)), true);
  dv.setFloat32(8, gain, true);
  dv.setFloat32(12, clampPan(pan), true);
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

/**
 * PING (0x10). Payload: timestamp(i64, microseconds), optionally followed by a
 * nonzero client_incarnation(u64). The 16-byte form asks a Stream Gen 2 device
 * for a stream lease and is sent by unicast only (contracts stream-session.md
 * "Discovery lease"); Stream Gen 1 firmware ignores the extra bytes. The
 * 8-byte form is discovery only. PING is frozen: no other length is sent.
 */
export function buildPing(seq: number, timestampUs: number, clientIncarnation?: bigint): Uint8Array {
  const p = new Uint8Array(clientIncarnation === undefined ? 8 : 16);
  const dv = new DataView(p.buffer);
  dv.setBigInt64(0, BigInt(Math.round(timestampUs)), true);
  if (clientIncarnation !== undefined) dv.setBigUint64(8, clientIncarnation, true);
  return buildPacket(CMD_PING, seq, p);
}

/**
 * CAPS_REQ (0x12). Payload: caps_version(u8), the CAPS layout this reader
 * understands (contracts message-format.md §0x12). Sent by exact unicast.
 */
export function buildCapsReq(seq: number, capsVersion = 1): Uint8Array {
  return buildPacket(CMD_CAPS_REQ, seq, new Uint8Array([capsVersion & 0xff]));
}

// Audio formats for STREAM_BEGIN (contracts message-format.md §0x30).
export const STREAM_FORMAT_PCM16 = 0;
export const STREAM_FORMAT_ADPCM = 1;

/** Assemble a streaming packet, enforcing the larger 1472-byte stream cap. */
function buildStreamPacket(
  commandType: number,
  seq: number,
  payload: Uint8Array,
  version: number = VERSION,
): Uint8Array {
  const total = HEADER_SIZE + payload.length;
  if (total > MAX_STREAM_PACKET_SIZE) {
    throw new Error(`stream packet size ${total} exceeds maximum ${MAX_STREAM_PACKET_SIZE} bytes`);
  }
  return concat([buildHeader(commandType, seq, payload.length, version), payload]);
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
  return buildStreamPacket(CMD_STREAM_BEGIN, seq, streamBeginBody(opts));
}

/** STREAM_BEGIN body shared by Stream Gen 1 and Stream Gen 2. */
function streamBeginBody(opts: StreamBeginOptions): Uint8Array {
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
  return target ? concat([head, cstr(target)]) : head;
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

// --- Stream Gen 2 (contracts stream-session.md) ---

export const STREAM_ENVELOPE_SIZE = 16;

/**
 * Who a Stream Gen 2 packet belongs to: the device boot and the lease it issued
 * (from the PONG HBS2 tail), plus the sender's per-session generation.
 */
export interface StreamSessionIdentity {
  /** device_boot_id, nonzero u64. */
  bootId: bigint;
  /** lease_ticket, nonzero u32. */
  ticket: number;
  /** generation, nonzero u32, increased per session within a lease. */
  generation: number;
}

/** The 16-byte envelope every Stream Gen 2 payload begins with. */
export function buildStreamEnvelope(identity: StreamSessionIdentity): Uint8Array {
  const out = new Uint8Array(STREAM_ENVELOPE_SIZE);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, identity.bootId, true);
  dv.setUint32(8, identity.ticket >>> 0, true);
  dv.setUint32(12, identity.generation >>> 0, true);
  return out;
}

/** Stream Gen 2 BEGIN: envelope + the Gen 1 BEGIN body, header protocol_version=2. */
export function buildStreamBeginV2(
  seq: number,
  identity: StreamSessionIdentity,
  opts: StreamBeginOptions = {},
): Uint8Array {
  return buildStreamPacket(
    CMD_STREAM_BEGIN, seq,
    concat([buildStreamEnvelope(identity), streamBeginBody(opts)]),
    STREAM_V2_VERSION,
  );
}

/** Stream Gen 2 DATA: envelope + offset(u32) + audio bytes. */
export function buildStreamDataV2(
  seq: number,
  identity: StreamSessionIdentity,
  offset: number,
  data: Uint8Array,
): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, offset >>> 0, true);
  return buildStreamPacket(
    CMD_STREAM_DATA, seq,
    concat([buildStreamEnvelope(identity), head, data]),
    STREAM_V2_VERSION,
  );
}

/** Stream Gen 2 END: exactly the envelope, no body. */
export function buildStreamEndV2(seq: number, identity: StreamSessionIdentity): Uint8Array {
  return buildStreamPacket(CMD_STREAM_END, seq, buildStreamEnvelope(identity), STREAM_V2_VERSION);
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

/** HBS2 stream lease tail of a PONG (contracts stream-session.md). */
export const STREAM_LEASE_TAIL_SIZE = 32;
const STREAM_LEASE_MARKER = [0x48, 0x42, 0x53, 0x32]; // "HBS2"

/**
 * What follows volume_wiper (stream-session.md "Receiver classification", 1.x
 * rules):
 * - `absent`: nothing (the PONG ends at volume_wiper); on a matched reply this
 *   identifies Stream Gen 1 (sessionless) firmware;
 * - `ignored`: anything that is not a Stream Gen 2 tail (fewer than 32 bytes,
 *   another extension_version, bytes not starting with HBS2, a cut marker such
 *   as "HB"); it changes neither the class nor the lease;
 * - `valid`: at least 32 bytes starting with HBS2 and extension_version 1. Only
 *   the first 32 bytes are read; later bytes, the reserved field and flag bits
 *   3-7 are ignored (a later major may use them).
 */
export type PongLeaseTail = "absent" | "ignored" | "valid";

export interface Pong {
  seq: number;
  timestamp: bigint;
  serverTime: bigint;
  deviceName?: string;
  address?: string;
  firmwareVersion?: string;
  volumeLevel?: number;
  volumeWiper?: number;
  leaseTail: PongLeaseTail;
  /** The fields below are set only when leaseTail is "valid". */
  echoedClientIncarnation?: bigint;
  bootId?: bigint;
  leaseTicket?: number;
  highWaterTicket?: number;
  /** flags bit 0, and only with a nonzero boot id and ticket. */
  leaseValid?: boolean;
  /** flags bit 1: another writer holds a newer ticket. */
  leaseSuperseded?: boolean;
  /** flags bit 2: the device re-issued this ticket (it clears a superseded deferral). */
  leaseReissued?: boolean;
}

function parseLeaseTail(p: Uint8Array, off: number, out: Pong): void {
  const remaining = p.length - off;
  if (remaining <= 0) {
    out.leaseTail = "absent";
    return;
  }
  out.leaseTail = "ignored";
  if (remaining < STREAM_LEASE_TAIL_SIZE) return;
  for (let i = 0; i < STREAM_LEASE_MARKER.length; i++) {
    if (p[off + i] !== STREAM_LEASE_MARKER[i]) return;
  }
  const dv = new DataView(p.buffer, p.byteOffset + off, STREAM_LEASE_TAIL_SIZE);
  if (dv.getUint8(4) !== 1) return;
  const flags = dv.getUint8(5);
  out.leaseTail = "valid";
  out.echoedClientIncarnation = dv.getBigUint64(8, true);
  out.bootId = dv.getBigUint64(16, true);
  out.leaseTicket = dv.getUint32(24, true);
  out.highWaterTicket = dv.getUint32(28, true);
  out.leaseValid = (flags & 0x01) !== 0 && out.bootId !== 0n && out.leaseTicket !== 0;
  out.leaseSuperseded = (flags & 0x02) !== 0;
  out.leaseReissued = (flags & 0x04) !== 0;
}

/**
 * Parse a PONG (0x11). Bridge form is 16 bytes; devices append extended
 * fields, and a direct reply to a 16-byte PING appends the HBS2 lease tail
 * after volume_wiper. Firmware never sends volume_steps in a PONG (it comes
 * from get_info), so no byte after volume_wiper is read as one.
 */
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
    leaseTail: "absent",
  };
  let off = 16;
  if (off < p.length) [out.deviceName, off] = readCString(p, off);
  if (off < p.length) [out.address, off] = readCString(p, off);
  if (off < p.length) [out.firmwareVersion, off] = readCString(p, off);
  if (off < p.length) out.volumeLevel = p[off++];
  if (off < p.length) out.volumeWiper = p[off++];
  parseLeaseTail(p, off, out);
  return out;
}

// --- CAPS (0x13) and ERROR (0xFF), contracts message-format.md ---

const CAPS_FORMATS = ["pcm16", "adpcm", "opus"];
const CAPS_FEATURES = ["play_pan", "error_reply"];
/** Defined value lengths of caps_version 1 (type 0x02 is a string of any length). */
const CAPS_VALUE_SIZES: Record<number, number> = { 0x01: 1, 0x03: 1, 0x04: 1, 0x05: 4, 0x06: 1, 0x07: 1, 0x08: 4 };

/**
 * A device's capability report (CAPS, 0x13). Fields the device did not send,
 * or sent too short, are absent. The Stream Gen is never decided from this
 * (versioning.md §5.3): the PONG classification is.
 */
export interface DeviceCaps {
  capsVersion: number;
  /** Firmware major (versioning.md §3.2). */
  generation?: number;
  firmwareVersion?: string;
  /** Stream generations the device accepts; [] for a node that takes no stream. */
  streamGens?: number[];
  streamFormats?: string[];
  leaseTtlS?: number;
  leaseSlots?: number;
  inactivityTimeoutS?: number;
  /** Number of motors: 1 = mono (PLAY pan ignored, stereo streams downmixed). */
  hapticChannels?: number;
  addressMaxLen?: number;
  features?: string[];
}

function bitNames(value: number, names: readonly string[]): string[] {
  return names.filter((_, index) => (value & (1 << index)) !== 0);
}

/**
 * Parse a CAPS packet (header included), or null. TLV rules: an unknown type is
 * skipped by its length, a known type longer than defined is read for its
 * defined prefix and a shorter one ignored, the first long-enough entry of a
 * type wins, an entry cut by the end of the payload is ignored, and the
 * experimental range 0x80-0xFF is ignored like any unknown type.
 */
export function parseCaps(data: Uint8Array): DeviceCaps | null {
  const pkt = parsePacket(data);
  if (!pkt || pkt.commandType !== CMD_CAPS || pkt.payload.length < 2) return null;
  const p = pkt.payload;
  const caps: DeviceCaps = { capsVersion: p[0] };
  const seen = new Set<number>();
  let off = 2;
  while (off + 2 <= p.length) {
    const type = p[off];
    const size = p[off + 1];
    const value = p.subarray(off + 2, off + 2 + size);
    off += 2 + size;
    if (value.length < size || seen.has(type)) continue;
    if (type === 0x02) {
      seen.add(type);
      caps.firmwareVersion = decoder.decode(value);
      continue;
    }
    const need = CAPS_VALUE_SIZES[type];
    if (need === undefined || value.length < need) continue;
    seen.add(type);
    switch (type) {
      case 0x01: caps.generation = value[0]; break;
      case 0x03: caps.streamGens = [1, 2].filter((gen) => (value[0] & (1 << (gen - 1))) !== 0); break;
      case 0x04: caps.streamFormats = bitNames(value[0], CAPS_FORMATS); break;
      case 0x05:
        caps.leaseTtlS = value[0];
        caps.leaseSlots = value[1];
        caps.inactivityTimeoutS = value[2];
        break;
      case 0x06: caps.hapticChannels = value[0]; break;
      case 0x07: caps.addressMaxLen = value[0]; break;
      case 0x08:
        caps.features = bitNames(new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true), CAPS_FEATURES);
        break;
    }
  }
  return caps;
}

// ERROR codes (contracts message-format.md §0xFF).
export const ERR_UNSUPPORTED_VERSION = 0x0001;
export const ERR_UNKNOWN_COMMAND = 0x0002;
export const ERR_MALFORMED = 0x0003;
export const ERR_STREAM_GEN_UNSUPPORTED = 0x0010;
export const ERR_STREAM_LEASE_INVALID = 0x0011;
export const ERR_STREAM_SUPERSEDED = 0x0012;
export const ERR_STREAM_NOT_STARTED = 0x0013;
export const ERR_STREAM_TIMED_OUT = 0x0014;
export const ERR_STREAM_STOPPED = 0x0015;
export const ERR_STREAM_ENDED = 0x0016;
export const ERR_STREAM_TARGET_MISMATCH = 0x0017;

export interface DeviceError {
  seq: number;
  errorCode: number;
  /** For people only; never decide on it. */
  message: string;
  /** The rejected packet's command_type and seq (1.x firmware appends them). */
  refCommand?: number;
  refSeq?: number;
  /** Codes 0x0011-0x0017: the rejected packet's 16-byte envelope; otherwise empty. */
  detail?: Uint8Array;
}

/** Parse an ERROR packet (header included), or null. */
export function parseError(data: Uint8Array): DeviceError | null {
  const pkt = parsePacket(data);
  if (!pkt || pkt.commandType !== CMD_ERROR || pkt.payload.length < 3) return null;
  const p = pkt.payload;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const [message, off] = readCString(p, 2);
  const out: DeviceError = { seq: pkt.seq, errorCode: dv.getUint16(0, true), message };
  if (p.length >= off + 4) {
    out.refCommand = dv.getUint8(off);
    out.refSeq = dv.getUint16(off + 1, true);
    out.detail = p.slice(off + 4, off + 4 + dv.getUint8(off + 3));
  }
  return out;
}

/**
 * Does `deviceAddress` accept a packet aimed at `target`?
 *
 * A port of the firmware's `addressMatch()`
 * (hapbeat-device-firmware/src/address_match.cpp), which is the authority: the
 * device re-applies this filter on receipt, so the SDK only uses it to pick
 * unicast destinations, never to decide what plays.
 *
 * Rules (contracts/specs/device-addressing.md §4.3):
 * - an empty target matches every address;
 * - both strings are split on `/` and compared **positionally**, so `group_2`
 *   alone is compared against the *player* slot and never matches — write
 *   `* /* /group_2` (no spaces);
 * - a `*` segment matches any single segment, but only when the whole segment
 *   is `*` (`pos_*` is compared literally);
 * - fewer target segments than address segments is a front-match;
 * - more target segments than address segments is a mismatch;
 * - a single trailing `/` is ignored (`"player_1/" === "player_1"`), because
 *   firmware walks pointers and exits at the terminator rather than producing
 *   an empty segment. Splitting naively would drop a device the firmware
 *   *would* have accepted.
 */
export function addressMatches(target: string | undefined, deviceAddress: string | undefined): boolean {
  if (!target) return true;

  const targetSegments = target.split("/");
  const addressSegments = (deviceAddress ?? "").split("/");

  // Only the last empty segment is dropped, and only once: "a//" really does
  // compare an empty segment in firmware, and still mismatches.
  let count = targetSegments.length;
  if (count > 1 && targetSegments[count - 1] === "") count--;

  for (let i = 0; i < count; i++) {
    if (i >= addressSegments.length) return false; // target longer = mismatch
    if (targetSegments[i] !== "*" && targetSegments[i] !== addressSegments[i]) return false;
  }
  return true; // front-match or exact match
}
