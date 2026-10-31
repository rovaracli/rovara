import { crc32 as zlibCrc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Proof and evidence B4: a Playwright trace is a ZIP of JSON-lines files (`trace.trace`, `trace.network`, ...) and blobs (`resources/`). Before one is kept, its network entries are rewritten so that no
 * cookie, `set-cookie` or `authorization` value survives, and every entry is scanned for the run's credentials. This is defence in depth: the accounts in a kept trace are already dead (run-scoped and revoked),
 * and the page's own text on screen cannot be scrubbed at all (design 3.4). Fail closed: a zip that cannot be read whole (encryption, zip64, an unknown method, a bad name, a bomb, a line that is not JSON)
 * is `null`, and the caller keeps no trace.
 */
export const TRACE_MAX_ENTRIES = 4_096;
export const TRACE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const TRACE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const TRACE_BLANKED = "<blanked>";

/** Header and cookie names whose values never survive. */
const BLANK_NAMES = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token"]);
const LINE_FILES = /(?:^|\/)[^/]*\.(?:trace|network|stacks)$|(?:^|\/)(?:trace|network)$/u;

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface ZipEntry { name: string; method: number; crc: number; compressedSize: number; size: number; localOffset: number; time: number; date: number }

function readEntries(zip: Uint8Array): ZipEntry[] | null {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.byteLength < 22) return null;
  let eocd = -1;
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 65_535); at -= 1) if (view.readUInt32LE(at) === SIG_EOCD) { eocd = at; break; }
  if (eocd < 0) return null;
  const count = view.readUInt16LE(eocd + 10);
  const cdSize = view.readUInt32LE(eocd + 12);
  const cdOffset = view.readUInt32LE(eocd + 16);
  // zip64 markers: not supported, so not scrubbed, so not kept.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || count === 0 || count > TRACE_MAX_ENTRIES) return null;
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.readUInt32LE(at) !== SIG_CD) return null;
    const flags = view.readUInt16LE(at + 8);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const compressedSize = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    if ((flags & 1) !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || size > TRACE_MAX_ENTRY_BYTES) return null;
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > view.byteLength) return null;
    const name = view.toString("utf8", at + 46, nameEnd);
    entries.push({ name, method: view.readUInt16LE(at + 10), time: view.readUInt16LE(at + 12), date: view.readUInt16LE(at + 14), crc: view.readUInt32LE(at + 16), compressedSize, size, localOffset: view.readUInt32LE(at + 42) });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function crc32(bytes: Uint8Array): number {
  if (typeof zlibCrc32 === "function") return zlibCrc32(bytes) >>> 0;
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function dataOf(zip: Uint8Array, entry: ZipEntry): Buffer | null {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.localOffset;
  if (at + 30 > view.byteLength || view.readUInt32LE(at) !== SIG_LOCAL) return null;
  const start = at + 30 + view.readUInt16LE(at + 26) + view.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > view.byteLength) return null;
  const raw = view.subarray(start, end);
  try {
    // The inflated bytes must be exactly the size and checksum the archive claims: a trace that disagrees with itself is not one we scrubbed.
    const out = entry.method === 0 ? Buffer.from(raw) : entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: TRACE_MAX_ENTRY_BYTES }) : null;
    return out !== null && out.byteLength === entry.size && crc32(out) === entry.crc ? out : null;
  } catch { /* a bomb or a broken stream */ }
  return null;
}

const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,255}$/u;

function blank(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blank);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const headerName = typeof record.name === "string" ? record.name.toLowerCase() : undefined;
  for (const [key, child] of Object.entries(record)) {
    const lower = key.toLowerCase();
    // A header held as an object key (`{"authorization": "..."}`): the value goes, whatever its shape.
    if (BLANK_NAMES.has(lower)) { out[key] = child === null ? null : Array.isArray(child) ? child.map(() => TRACE_BLANKED) : TRACE_BLANKED; continue; }
    if (key === "value" && headerName !== undefined && BLANK_NAMES.has(headerName)) { out[key] = TRACE_BLANKED; continue; }
    if (lower === "cookies" && Array.isArray(child)) { out[key] = (child as unknown[]).map((cookie): unknown => (cookie !== null && typeof cookie === "object" ? { ...(blank(cookie) as object), value: TRACE_BLANKED } : cookie)); continue; }
    out[key] = blank(child);
  }
  return out;
}

/** The lines of a JSON-lines file with their cookie, set-cookie and authorization values blanked, or null when a line is not JSON. */
export function scrubTraceLines(text: string): string | null {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") { out.push(line); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    out.push(JSON.stringify(blank(parsed)));
  }
  return out.join("\n");
}

/**
 * The trace with its network entries scrubbed, re-zipped, or null when it cannot be made safe. `contains` is the run's credential scan (every spelling): it runs over every entry's inflated bytes, scrubbed
 * ones included, because the compressed bytes of a zip hide a secret from a byte scan. A match is null too.
 */
export function scrubTraceZip(zip: Uint8Array, contains: (bytes: Uint8Array) => boolean): Uint8Array | null {
  const entries = readEntries(zip);
  if (entries === null) return null;
  const names = new Set<string>();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    if (!SAFE_NAME.test(entry.name) || names.has(entry.name) || (entry.method !== 0 && entry.method !== 8)) return null;
    names.add(entry.name);
    if (entry.name.endsWith("/")) return null;
    let data = dataOf(zip, entry);
    if (data === null) return null;
    total += data.byteLength;
    if (total > TRACE_MAX_TOTAL_BYTES) return null;
    if (LINE_FILES.test(entry.name)) {
      const text = (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return null; } })();
      if (text === null) return null;
      const scrubbed = scrubTraceLines(text);
      if (scrubbed === null) return null;
      data = Buffer.from(scrubbed, "utf8");
    }
    if (contains(data)) return null;
    const packed = deflateRawSync(data);
    const [stored, method] = packed.byteLength < data.byteLength ? [packed, 8] : [data, 0];
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(entry.time, 10); local.writeUInt16LE(entry.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18); local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(name.byteLength, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CD, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt16LE(entry.time, 12); header.writeUInt16LE(entry.date, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stored.byteLength, 20); header.writeUInt32LE(data.byteLength, 24); header.writeUInt16LE(name.byteLength, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, name, stored);
    central.push(header, name);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.byteLength, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}
