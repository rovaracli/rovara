// The keyword index segment (lane K2, DECISIONS 145, design option (f)): an immutable binary file that holds the words of a range of one project's rows, so the keyword side of a search can rank ALL hot rows by BM25 over
// the best passage (the passage rule of search-fusion.ts) without reading their text. It holds NO text: a sorted dictionary of terms, per-term postings over PASSAGES (the unit the passage rule scores), and a table of the
// rows (id, time, kind, source, audience kind, expiries, how many passages each has). Pure code: no I/O, no clock.
//
// Passages: a row has the "full" passages of its text and structured fields (keywordDocumentOf), and, when its text has an expiry, a second set, the "structured-only" passages (what the row scores from the moment the
// text expires). Which set counts is decided at READ time from the row's text expiry, so expired text never matches even before a night's rebuild removes its words.
import { keywordTokens, passageRanges, PASSAGE_TOKENS } from "./search-fusion.js";

/** A term longer than this many UTF-8 bytes is not indexed (a base64 blob or a hash without separators); every ordinary word is far shorter. */
export const MAX_TERM_BYTES = 1_024;

const MAGIC = Buffer.from("RKW1", "latin1");

export interface SegmentDocInput {
  /** The row's uuid. */
  id: string;
  occurredAtMs: number;
  kind: string;
  source: string;
  /** True for a restricted audience (a coarse cut for a shared reader; the reader's real right is decided on the reloaded row). */
  restricted: boolean;
  /** Epoch seconds. Present only when the row holds raw text that expires: the row then also gets the structured-only passages. */
  textExpiresAt?: number;
  hotExpiresAt: number;
  /** The tokens of `keywordDocumentOf` (text, if it still counts, then the structured fields). */
  tokens: readonly string[];
  /** Required with `textExpiresAt`: the tokens of the structured fields alone. */
  structTokens?: readonly string[];
}

export interface PassageUnit { length: number; counts: Map<string, number> }

/** The passages of a token list under the passage rule, each with its length (all tokens) and the counts of the words that can be queried (two characters or more, at most MAX_TERM_BYTES). */
export function passageUnits(tokens: readonly string[], size: number = PASSAGE_TOKENS): PassageUnit[] {
  return passageRanges(tokens.length, size).map(([from, to]) => {
    const counts = new Map<string, number>();
    for (let at = from; at < to; at += 1) {
      const token = tokens[at] as string;
      if (token.length >= 2 && Buffer.byteLength(token, "utf8") <= MAX_TERM_BYTES) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return { length: to - from, counts };
  });
}

class ByteWriter {
  private buffer = Buffer.allocUnsafe(1 << 16);
  private length = 0;
  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buffer.length * 2, this.length + extra));
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }
  get size(): number { return this.length; }
  u8(value: number): void { this.ensure(1); this.buffer[this.length] = value; this.length += 1; }
  u32(value: number): void { this.ensure(4); this.buffer.writeUInt32BE(value, this.length); this.length += 4; }
  u48(value: number): void { this.ensure(6); this.buffer.writeUIntBE(value, this.length, 6); this.length += 6; }
  varint(value: number): void {
    if (!Number.isInteger(value) || value < 0) throw new Error("a varint is a whole number of 0 or more");
    let rest = value;
    while (rest >= 0x80) { this.u8((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
    this.u8(rest);
  }
  bytes(value: Uint8Array): void { this.ensure(value.length); this.buffer.set(value, this.length); this.length += value.length; }
  string(value: string): void { const bytes = Buffer.from(value, "utf8"); this.varint(bytes.length); this.bytes(bytes); }
  finish(): Buffer { return Buffer.from(this.buffer.subarray(0, this.length)); }
}

class ByteReader {
  at = 0;
  constructor(readonly buffer: Buffer) {}
  u8(): number { if (this.at >= this.buffer.length) throw new Error("segment: truncated"); const value = this.buffer[this.at] as number; this.at += 1; return value; }
  u32(): number { const value = this.buffer.readUInt32BE(this.at); this.at += 4; return value; }
  u48(): number { const value = this.buffer.readUIntBE(this.at, 6); this.at += 6; return value; }
  varint(): number {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 8; count += 1) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 0x80;
    }
    throw new Error("segment: bad varint");
  }
  bytes(length: number): Buffer { if (this.at + length > this.buffer.length) throw new Error("segment: truncated"); const out = this.buffer.subarray(this.at, this.at + length); this.at += length; return out; }
  string(): string { return this.bytes(this.varint()).toString("utf8"); }
}

const hexToBytes = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface EncodedSegment {
  bytes: Buffer;
  docs: number;
  units: number;
  /** The soonest raw-text expiry among the rows that hold expiring text (epoch seconds), if any. */
  textExpiresMin?: number;
  hotExpiresMin?: number;
}

/** Encodes rows (any order) into a segment. Rows are stored by time then id, so a row can be found by both. */
export function encodeSegment(input: readonly SegmentDocInput[]): EncodedSegment {
  const docs = [...input].sort((left, right) => left.occurredAtMs - right.occurredAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const kinds = [...new Set(docs.map((doc) => doc.kind))];
  const sources = [...new Set(docs.map((doc) => doc.source))];
  const postings = new Map<string, number[]>();
  const unitLengths: number[] = [];
  const writer = new ByteWriter();
  let textExpiresMin: number | undefined;
  let hotExpiresMin: number | undefined;
  const docWriter = new ByteWriter();
  for (const doc of docs) {
    const full = passageUnits(doc.tokens);
    const structured = doc.textExpiresAt === undefined ? [] : passageUnits(doc.structTokens ?? []);
    for (const unit of [...full, ...structured]) {
      const id = unitLengths.length;
      unitLengths.push(unit.length);
      for (const [term, count] of unit.counts) {
        const list = postings.get(term);
        if (list === undefined) postings.set(term, [id, count]); else list.push(id, count);
      }
    }
    docWriter.bytes(hexToBytes(doc.id));
    docWriter.u48(doc.occurredAtMs);
    docWriter.varint(kinds.indexOf(doc.kind));
    docWriter.varint(sources.indexOf(doc.source));
    docWriter.u8(doc.restricted ? 1 : 0);
    docWriter.varint(doc.textExpiresAt ?? 0);
    docWriter.varint(doc.hotExpiresAt);
    docWriter.varint(full.length);
    docWriter.varint(structured.length);
    if (doc.textExpiresAt !== undefined) textExpiresMin = Math.min(textExpiresMin ?? Number.POSITIVE_INFINITY, doc.textExpiresAt);
    hotExpiresMin = Math.min(hotExpiresMin ?? Number.POSITIVE_INFINITY, doc.hotExpiresAt);
  }
  const terms = [...postings.keys()].map((term) => Buffer.from(term, "utf8")).sort((left, right) => Buffer.compare(left, right));
  const termsBlob = new ByteWriter();
  const postingsBlob = new ByteWriter();
  const offsets: number[] = [];
  for (const term of terms) {
    const list = postings.get(term.toString("utf8")) as number[];
    const start = postingsBlob.size;
    let previous = 0;
    for (let at = 0; at < list.length; at += 2) {
      postingsBlob.varint((list[at] as number) - previous);
      previous = list[at] as number;
      postingsBlob.varint(list[at + 1] as number);
    }
    offsets.push(termsBlob.size);
    termsBlob.varint(term.length);
    termsBlob.bytes(term);
    termsBlob.varint(start);
    termsBlob.varint(postingsBlob.size - start);
    termsBlob.varint(list.length / 2);
  }
  writer.bytes(MAGIC);
  writer.varint(docs.length);
  writer.varint(unitLengths.length);
  writer.varint(terms.length);
  writer.varint(kinds.length);
  for (const kind of kinds) writer.string(kind);
  writer.varint(sources.length);
  for (const source of sources) writer.string(source);
  writer.bytes(docWriter.finish());
  for (const length of unitLengths) writer.u8(length);
  const termsBytes = termsBlob.finish();
  const postingsBytes = postingsBlob.finish();
  writer.u32(termsBytes.length);
  writer.u32(postingsBytes.length);
  for (const offset of offsets) writer.u32(offset);
  writer.bytes(termsBytes);
  writer.bytes(postingsBytes);
  return { bytes: writer.finish(), docs: docs.length, units: unitLengths.length, ...(textExpiresMin === undefined ? {} : { textExpiresMin }), ...(hotExpiresMin === undefined ? {} : { hotExpiresMin }) };
}

export interface PostingList { units: Uint32Array; counts: Uint8Array }

/** A segment read into typed arrays. The dictionary and the postings stay in the file's bytes and are decoded for the words of a query only. */
export class SegmentReader {
  readonly docs: number;
  readonly units: number;
  private readonly kinds: string[];
  private readonly sources: string[];
  private readonly ids: Buffer;
  readonly occurredAtMs: Float64Array;
  private readonly kindIndex: Uint32Array;
  private readonly sourceIndex: Uint32Array;
  readonly restricted: Uint8Array;
  readonly textExpiresAt: Uint32Array;
  readonly hotExpiresAt: Uint32Array;
  readonly fullStart: Uint32Array;
  readonly fullCount: Uint32Array;
  readonly structStart: Uint32Array;
  readonly structCount: Uint32Array;
  readonly unitLength: Uint8Array;
  readonly unitDoc: Uint32Array;
  readonly unitIsStruct: Uint8Array;
  /** The docs that hold expiring text (the others never change which passages count). */
  readonly expiring: Uint32Array;
  private readonly termCount: number;
  private readonly offsets: Buffer;
  private readonly termsBlob: Buffer;
  private readonly postingsBlob: Buffer;
  /** All the segment's passages counted as "full": the figures a reader starts from before it takes the expired rows out. */
  readonly fullUnits: number;
  readonly fullLength: number;
  readonly byteLength: number;

  constructor(bytes: Uint8Array) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.byteLength = buffer.length;
    if (buffer.length < 4 || !buffer.subarray(0, 4).equals(MAGIC)) throw new Error("segment: bad magic");
    const reader = new ByteReader(buffer);
    reader.at = 4;
    this.docs = reader.varint();
    this.units = reader.varint();
    this.termCount = reader.varint();
    this.kinds = Array.from({ length: reader.varint() }, () => reader.string());
    this.sources = Array.from({ length: reader.varint() }, () => reader.string());
    this.ids = Buffer.allocUnsafe(this.docs * 16);
    this.occurredAtMs = new Float64Array(this.docs);
    this.kindIndex = new Uint32Array(this.docs);
    this.sourceIndex = new Uint32Array(this.docs);
    this.restricted = new Uint8Array(this.docs);
    this.textExpiresAt = new Uint32Array(this.docs);
    this.hotExpiresAt = new Uint32Array(this.docs);
    this.fullStart = new Uint32Array(this.docs);
    this.fullCount = new Uint32Array(this.docs);
    this.structStart = new Uint32Array(this.docs);
    this.structCount = new Uint32Array(this.docs);
    this.unitDoc = new Uint32Array(this.units);
    this.unitIsStruct = new Uint8Array(this.units);
    const expiring: number[] = [];
    let unit = 0;
    for (let doc = 0; doc < this.docs; doc += 1) {
      reader.bytes(16).copy(this.ids, doc * 16);
      this.occurredAtMs[doc] = reader.u48();
      this.kindIndex[doc] = reader.varint();
      this.sourceIndex[doc] = reader.varint();
      this.restricted[doc] = reader.u8();
      this.textExpiresAt[doc] = reader.varint();
      this.hotExpiresAt[doc] = reader.varint();
      this.fullCount[doc] = reader.varint();
      this.structCount[doc] = reader.varint();
      this.fullStart[doc] = unit;
      this.structStart[doc] = unit + (this.fullCount[doc] as number);
      for (let count = 0; count < (this.fullCount[doc] as number); count += 1) { this.unitDoc[unit] = doc; unit += 1; }
      for (let count = 0; count < (this.structCount[doc] as number); count += 1) { this.unitDoc[unit] = doc; this.unitIsStruct[unit] = 1; unit += 1; }
      if ((this.structCount[doc] as number) > 0) expiring.push(doc);
    }
    if (unit !== this.units) throw new Error("segment: unit count");
    this.expiring = Uint32Array.from(expiring);
    this.unitLength = new Uint8Array(this.units);
    let fullLength = 0;
    let fullUnits = 0;
    for (let at = 0; at < this.units; at += 1) {
      this.unitLength[at] = reader.u8();
      if (this.unitIsStruct[at] === 0) { fullLength += this.unitLength[at] as number; fullUnits += 1; }
    }
    this.fullLength = fullLength;
    this.fullUnits = fullUnits;
    const termsLength = reader.u32();
    const postingsLength = reader.u32();
    this.offsets = reader.bytes(this.termCount * 4);
    this.termsBlob = reader.bytes(termsLength);
    this.postingsBlob = reader.bytes(postingsLength);
  }

  docId(doc: number): string { return bytesToUuid(this.ids.subarray(doc * 16, doc * 16 + 16)); }
  kindOf(doc: number): string { return this.kinds[this.kindIndex[doc] as number] as string; }
  sourceOf(doc: number): string { return this.sources[this.sourceIndex[doc] as number] as string; }

  /** The doc with this time and id, or undefined (docs are stored by time then id). */
  find(occurredAtMs: number, id: string): number | undefined {
    let low = 0;
    let high = this.docs;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.occurredAtMs[middle] as number) < occurredAtMs) low = middle + 1; else high = middle;
    }
    for (let doc = low; doc < this.docs && this.occurredAtMs[doc] === occurredAtMs; doc += 1) if (this.docId(doc) === id) return doc;
    return undefined;
  }

  /** The postings of a term, or undefined. Units ascend; the counts are the word's frequency in each passage. */
  postings(term: string): PostingList | undefined {
    const wanted = Buffer.from(term, "utf8");
    let low = 0;
    let high = this.termCount;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const reader = new ByteReader(this.termsBlob);
      reader.at = this.offsets.readUInt32BE(middle * 4);
      const length = reader.varint();
      const found = reader.bytes(length);
      const order = Buffer.compare(found, wanted);
      if (order === 0) {
        const start = reader.varint();
        const size = reader.varint();
        const df = reader.varint();
        const list = new ByteReader(this.postingsBlob.subarray(start, start + size));
        const units = new Uint32Array(df);
        const counts = new Uint8Array(df);
        let unit = 0;
        for (let at = 0; at < df; at += 1) { unit += list.varint(); units[at] = unit; counts[at] = list.varint(); }
        return { units, counts };
      }
      if (order < 0) low = middle + 1; else high = middle;
    }
    return undefined;
  }

  /** Every term of the dictionary (tests and the erase proof read it; no search path does). */
  allTerms(): string[] {
    const terms: string[] = [];
    for (let at = 0; at < this.termCount; at += 1) {
      const reader = new ByteReader(this.termsBlob);
      reader.at = this.offsets.readUInt32BE(at * 4);
      terms.push(reader.bytes(reader.varint()).toString("utf8"));
    }
    return terms;
  }
}

/** The text of `keywordTokens`, for callers that hold a document string. */
export const tokensOfDocument = (document: string): string[] => keywordTokens(document);
