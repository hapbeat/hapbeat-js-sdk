/**
 * Minimal RIFF/WAV parser for clip streaming. Extracts the raw PCM16 bytes and
 * the format header. Pure (ArrayBuffer in / typed arrays out) so it runs in
 * Node and the browser. Only uncompressed 16-bit PCM is accepted — the device
 * streams PCM16 (16 kHz expected, matching the kit-tools normalization).
 */

export interface WavPcm {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Raw interleaved PCM16 LE bytes (the WAV `data` chunk). */
  data: Uint8Array;
}

function fourcc(u8: Uint8Array, off: number): string {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

/** Parse a WAV file. Throws on non-WAV or non-PCM16 input. */
export function parseWav(buffer: ArrayBuffer | Uint8Array): WavPcm {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 12 || fourcc(u8, 0) !== "RIFF" || fourcc(u8, 8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Uint8Array | null = null;

  let off = 12;
  while (off + 8 <= u8.length) {
    const id = fourcc(u8, off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      const end = Math.min(body + size, u8.length);
      data = u8.subarray(body, end);
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV missing fmt chunk");
  if (!data) throw new Error("WAV missing data chunk");
  // audioFormat 1 = PCM. (Some encoders use 0xFFFE WAVE_FORMAT_EXTENSIBLE; not supported here.)
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`WAV must be uncompressed 16-bit PCM (got format=${fmt.audioFormat}, bits=${fmt.bitsPerSample})`);
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: 16,
    data,
  };
}
