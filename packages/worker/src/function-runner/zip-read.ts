// Slice 4 X2: a minimal, bounded reader for a downloaded wheel (a zip). The archive is hostile until proved otherwise: every offset and size the file declares is checked
// against the bytes in hand and against hard limits, an entry is inflated with an output cap, its CRC is checked, and paths that could leave the package folder are refused.
// Supports stored and deflated entries, single-disk, non-zip64, unencrypted archives: what every wheel is.
import { crc32, inflateRawSync } from "node:zlib";

export type ZipErrorCode =
  | "not-a-zip" | "unsupported" | "bad-directory" | "too-many-entries" | "too-large" | "unsafe-path" | "duplicate-entry" | "bad-entry" | "bad-crc";

export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode) {
    super(code);
    this.name = "ZipError";
  }
}

export interface ZipLimits {
  readonly maxEntries: number;
  /** One entry's uncompressed size. */
  readonly maxEntryBytes: number;
  /** All entries' declared uncompressed sizes together. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 50_000, maxEntryBytes: 512 * 1024 * 1024, maxTotalBytes: 768 * 1024 * 1024 };

export interface ZipEntry {
  /** A safe relative POSIX path (no leading slash, no `..`, no backslash, no NUL, no control characters). */
  readonly name: string;
  readonly size: number;
  /** Unix permission bits from the entry's attributes (0 when the archive is not from a Unix tool). */
  readonly mode: number;
  readonly symlink: boolean;
  /** Inflates the entry (once per call), bounded by its declared size, and checks length and CRC. */
  read(): Uint8Array;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Whether a member name is a plain relative path inside the archive. */
export function isSafeMemberName(name: string): boolean {
  if (name === "" || name.length > 1024 || name.startsWith("/") || name.includes("\\") || /[\p{Cc}\p{Cf}]/u.test(name)) return false;
  if (/^[A-Za-z]:/u.test(name)) return false;
  return !name.split("/").some((part) => part === ".." || part === "." || part === "");
}

/** Opens a zip held in memory and lists its file entries (directories are skipped). Throws ZipError. */
export function openZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (bytes.length < 22) throw new ZipError("not-a-zip");
  // The end-of-central-directory record is within the last 22 + 65,535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("not-a-zip");
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported");
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== total) throw new ZipError("unsupported");
  if (total > limits.maxEntries) throw new ZipError("too-many-entries");
  if (cdOffset + cdSize > eocd) throw new ZipError("bad-directory");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > cdOffset + cdSize || u32(bytes, p) !== 0x02014b50) throw new ZipError("bad-directory");
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLength = u16(bytes, p + 28);
    const extraLength = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const attributes = u32(bytes, p + 38);
    const localOffset = u32(bytes, p + 42);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > cdOffset + cdSize) throw new ZipError("bad-directory");
    const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p = next;
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("unsupported");
    if (name.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new ZipError("unsupported");
    if (method !== 0 && method !== 8) throw new ZipError("unsupported");
    if (!isSafeMemberName(name)) throw new ZipError("unsafe-path");
    if (seen.has(name)) throw new ZipError("duplicate-entry");
    seen.add(name);
    if (size > limits.maxEntryBytes) throw new ZipError("too-large");
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError("too-large");
    const fileType = (attributes >>> 16) & 0o170000;
    entries.push({
      name,
      size,
      mode: (attributes >>> 16) & 0o777,
      symlink: fileType === 0o120000,
      read: (): Uint8Array => {
        if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) throw new ZipError("bad-entry");
        const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
        const end = start + compressedSize;
        if (end > cdOffset || end > bytes.length) throw new ZipError("bad-entry");
        const raw = bytes.subarray(start, end);
        let out: Uint8Array;
        if (method === 0) {
          if (compressedSize !== size) throw new ZipError("bad-entry");
          out = raw;
        } else {
          try { out = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }); } catch { throw new ZipError("bad-entry"); }
          if (out.length !== size) throw new ZipError("bad-entry");
        }
        if (crc32(out) !== crc) throw new ZipError("bad-crc");
        return out;
      },
    });
  }
  return entries;
}
