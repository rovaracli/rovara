import { record } from "./model-gateway-token.js";

/** Internal hold metadata, never forwarded to a provider or written as a new record kind. */
export interface InlineImageBound { tokens: number; dataBytes: number }
// Source packet dated 2026-11-22: https://platform.claude.com/docs/en/build-with-claude/vision
// and https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html
// ceil(w/28)*ceil(h/28), sides clamped to 8000; owner-approved high-res ceiling 4784.
// The fixed 256-token margin covers image overhead; actual usage still determines settlement.
// Use the conservative 200k-context count and Bedrock's stricter encoded-size limit on both Claude paths.
export const MAX_INLINE_IMAGES = 100;
const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const MAX_JPEG_HEADER_BYTES = 64 * 1024;
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const signature = (b: Buffer, at: number, hex: string): boolean => b.subarray(at, at + hex.length / 2).equals(Buffer.from(hex, "hex"));

function jpegDimensions(b: Buffer): [number, number] | undefined {
  if (!signature(b, 0, "ffd8")) return undefined;
  const end = Math.min(b.length, MAX_JPEG_HEADER_BYTES);
  let at = 2;
  while (at + 4 <= end) {
    if (b[at++] !== 0xff) return undefined;
    while (b[at] === 0xff) at++;
    const marker = b[at++]!;
    const size = b.readUInt16BE(at);
    if (size < 2 || at + size > end) return undefined;
    if (SOF.has(marker)) {
      // A complete SOF includes precision, dimensions and all component descriptors.
      if (size < 8 || size !== 8 + 3 * b[at + 7]!) return undefined;
      return [b.readUInt16BE(at + 5), b.readUInt16BE(at + 3)];
    }
    at += size;
  }
  return undefined;
}

function webpDimensions(b: Buffer): [number, number] | undefined {
  if (b.length < 20 || !signature(b, 0, "52494646") || !signature(b, 8, "57454250")) return undefined;
  if (b.readUInt32LE(4) + 8 !== b.length) return undefined;
  const size = b.readUInt32LE(16);
  if (size > b.length - 20) return undefined;
  switch (b.toString("latin1", 12, 16)) {
    case "VP8X":
      if (size !== 10) return undefined;
      return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    case "VP8L": {
      if (size < 5 || b[20] !== 0x2f) return undefined;
      const bits = b.readUInt32LE(21);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    case "VP8 ":
      if (size < 10 || !signature(b, 23, "9d012a")) return undefined;
      return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    default: return undefined;
  }
}

function dimensions(b: Buffer, mime: unknown): [number, number] | undefined {
  switch (mime) {
    case "image/png":
      if (b.length < 33 || !signature(b, 0, "89504e470d0a1a0a0000000d49484452")) return undefined;
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    case "image/gif":
      if (b.length < 13 || !/^GIF8[79]a$/u.test(b.toString("latin1", 0, 6))) return undefined;
      return [b.readUInt16LE(6), b.readUInt16LE(8)];
    case "image/jpeg": return jpegDimensions(b);
    case "image/webp": return webpDimensions(b);
    default: return undefined;
  }
}

/** Header inspection only: no decompression, pixels, remote reads or caller-supplied dimensions. */
export function inlineImageBound(block: Record<string, unknown>): InlineImageBound | undefined {
  const source = record(block.source);
  if (source?.type !== "base64" || typeof source.data !== "string" || source.data.length === 0 || source.data.length > MAX_BASE64_BYTES) return undefined;
  const data = Buffer.from(source.data, "base64");
  // Buffer's decoder accepts invalid suffixes/whitespace; require the exact canonical encoding.
  if (data.toString("base64") !== source.data) return undefined;
  let size: [number, number] | undefined;
  try { size = dimensions(data, source.media_type); } catch { return undefined; }
  if (size === undefined || size[0] === 0 || size[1] === 0) return undefined;
  const patches = Math.ceil(Math.min(size[0], 8000) / 28) * Math.ceil(Math.min(size[1], 8000) / 28);
  return { tokens: Math.min(patches, 4784) + 256, dataBytes: source.data.length };
}
