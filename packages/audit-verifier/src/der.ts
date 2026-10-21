/**
 * A small ASN.1 DER reader and writer, enough for RFC 3161 time-stamp messages, CMS SignedData
 * (RFC 5652) and the parts of X.509 certificates that the trust checks read.
 *
 * The reader accepts definite lengths only (the signed parts of a time-stamp token are DER) and
 * refuses anything that overruns its buffer. Every failure is a DerError, never an out-of-range read.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(`der: ${message}`);
    this.name = "DerError";
  }
}

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

/** The tag byte of a context-specific tag: `[n]`, constructed or primitive. Only tag numbers below 31. */
export function contextTag(n: number, constructed: boolean): number {
  return 0x80 | (constructed ? 0x20 : 0) | n;
}

/** One parsed element. `raw` is the whole TLV, `content` the value bytes; both view the input buffer. */
export interface DerNode {
  readonly tag: number;
  readonly raw: Uint8Array;
  readonly content: Uint8Array;
  /** How many constructed elements enclose this one (0 for the outermost). */
  readonly depth: number;
}

const MAX_DEPTH = 64;

/** Reads the element at the start of `bytes`; returns it and how many bytes it used. `depth` is its nesting level. */
export function readNode(bytes: Uint8Array, depth = 0): { node: DerNode; length: number } {
  if (bytes.length < 2) throw new DerError("truncated header");
  const tag = bytes[0] as number;
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags are not supported");
  const first = bytes[1] as number;
  let headerLength = 2;
  let contentLength: number;
  if (first < 0x80) {
    contentLength = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new DerError("indefinite length");
    if (count > 4) throw new DerError("length too large");
    if (bytes.length < 2 + count) throw new DerError("truncated length");
    contentLength = 0;
    for (let i = 0; i < count; i += 1) contentLength = contentLength * 256 + (bytes[2 + i] as number);
    headerLength = 2 + count;
  }
  const total = headerLength + contentLength;
  if (total > bytes.length) throw new DerError("element overruns its buffer");
  return {
    node: { tag, raw: bytes.subarray(0, total), content: bytes.subarray(headerLength, total), depth },
    length: total,
  };
}

/** Parses `bytes` as exactly one element: trailing bytes are an error. */
export function parseDer(bytes: Uint8Array): DerNode {
  const { node, length } = readNode(bytes);
  if (length !== bytes.length) throw new DerError("trailing bytes after the element");
  return node;
}

/** The elements inside a constructed node, in order. */
export function children(node: DerNode): DerNode[] {
  if (node.depth >= MAX_DEPTH) throw new DerError("nesting too deep");
  if ((node.tag & 0x20) === 0) throw new DerError("not a constructed element");
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, length } = readNode(node.content.subarray(offset), node.depth + 1);
    out.push(child);
    offset += length;
  }
  return out;
}

/** The children of a node that must carry `tag` and have between `min` and `max` children. */
export function expectSequence(node: DerNode, tag: number, min: number, max = Number.POSITIVE_INFINITY): DerNode[] {
  if (node.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}, found 0x${node.tag.toString(16)}`);
  const list = children(node);
  if (list.length < min || list.length > max) throw new DerError("unexpected number of members");
  return list;
}

export function expectTag(node: DerNode | undefined, tag: number): DerNode {
  if (node === undefined) throw new DerError("missing element");
  if (node.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}, found 0x${node.tag.toString(16)}`);
  return node;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new DerError("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** INTEGER as a signed bigint. */
export function integerValue(node: DerNode): bigint {
  expectTag(node, TAG.integer);
  const bytes = node.content;
  if (bytes.length === 0) throw new DerError("empty integer");
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (((bytes[0] as number) & 0x80) !== 0) value -= 1n << BigInt(8 * bytes.length);
  return value;
}

export function booleanValue(node: DerNode): boolean {
  expectTag(node, TAG.boolean);
  if (node.content.length !== 1) throw new DerError("boolean must be one byte");
  return node.content[0] !== 0;
}

export function oidValue(node: DerNode): string {
  expectTag(node, TAG.oid);
  const bytes = node.content;
  if (bytes.length === 0) throw new DerError("empty object identifier");
  const arcs: string[] = [];
  let value = 0n;
  let started = false;
  for (const byte of bytes) {
    if (!started && byte === 0x80) throw new DerError("object identifier has a padded arc");
    started = true;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (arcs.length === 0) {
        const top = value < 80n ? value / 40n : 2n;
        arcs.push(top.toString(), (value - top * 40n).toString());
      } else {
        arcs.push(value.toString());
      }
      value = 0n;
      started = false;
    }
  }
  if (started) throw new DerError("object identifier ends inside an arc");
  return arcs.join(".");
}

/** UTCTime or GeneralizedTime as a Date (UTC, whole seconds plus any fraction). */
export function timeValue(node: DerNode): Date {
  const text = new TextDecoder("ascii").decode(node.content);
  let match: RegExpExecArray | null;
  let year: number;
  if (node.tag === TAG.utcTime) {
    match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (match === null) throw new DerError("bad UTCTime");
    const yy = Number(match[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (node.tag === TAG.generalizedTime) {
    match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(text);
    if (match === null) throw new DerError("bad GeneralizedTime");
    year = Number(match[1]);
  } else {
    throw new DerError("not a time");
  }
  const [, , month, day, hour, minute, second, fraction] = match;
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const date = new Date(
    Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis),
  );
  if (
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    throw new DerError("time is not a real date");
  }
  return date;
}

/** BIT STRING content without the unused-bits byte. */
export function bitStringBytes(node: DerNode): { bytes: Uint8Array; unusedBits: number } {
  expectTag(node, TAG.bitString);
  if (node.content.length === 0) throw new DerError("empty bit string");
  const unusedBits = node.content[0] as number;
  if (unusedBits > 7) throw new DerError("bad bit string padding");
  return { bytes: node.content.subarray(1), unusedBits };
}

// ---- writer (just what the request needs) ----

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function encodeNode(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), lengthBytes(content.length), content]);
}

export function encodeSequence(...members: readonly Uint8Array[]): Uint8Array {
  return encodeNode(TAG.sequence, concat(members));
}

export function encodeInteger(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError("der: negative integers are not needed here");
  const bytes: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 8n) bytes.unshift(Number(rest & 0xffn));
  if (bytes.length === 0 || (bytes[0] as number) >= 0x80) bytes.unshift(0);
  return encodeNode(TAG.integer, Uint8Array.from(bytes));
}

export function encodeBoolean(value: boolean): Uint8Array {
  return encodeNode(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
}

export function encodeOctetString(value: Uint8Array): Uint8Array {
  return encodeNode(TAG.octetString, value);
}

export function encodeNull(): Uint8Array {
  return encodeNode(TAG.null, new Uint8Array(0));
}

export function encodeOid(oid: string): Uint8Array {
  const arcs = oid.split(".").map((part) => BigInt(part));
  if (arcs.length < 2) throw new RangeError("der: object identifier needs two arcs");
  const bytes: number[] = [];
  const pushArc = (arc: bigint): void => {
    const group: number[] = [Number(arc & 0x7fn)];
    for (let rest = arc >> 7n; rest > 0n; rest >>= 7n) group.unshift(Number(rest & 0x7fn) | 0x80);
    bytes.push(...group);
  };
  pushArc((arcs[0] as bigint) * 40n + (arcs[1] as bigint));
  for (const arc of arcs.slice(2)) pushArc(arc);
  return encodeNode(TAG.oid, Uint8Array.from(bytes));
}
