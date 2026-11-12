// The zip judge (slice 4, lane W2; ported from the parked s4-runner function-code.ts at 6a061898e, reviewed again, with one design change: links). A function package or a layer reaches the worker as a zip written by repository
// code, so the zip is hostile. This module reads the whole archive's structure and decides whether it may be unpacked at all; it writes nothing and runs no process.
//
// WHY THE WHOLE ARCHIVE IS JUDGED FIRST. A tool that skips an unsafe entry and keeps going leaves a half package behind. Here every entry is checked before the first byte is written, and one bad entry refuses the whole zip.
//
// What is refused, each with a test (tests/unit/function-runner/):
//   - any entry whose name is not a plain relative path: `..` or `.` segments, an empty segment, a leading slash, a drive letter, a backslash, a control or formatting character (a bidi override), a NUL, a name or depth past the caps;
//   - any entry that is not a regular file, a folder or a RELATIVE LINK INSIDE THE PACKAGE: a device, a pipe, a socket, a setuid or setgid bit, a Windows reparse point. (A zip cannot hold a hard link; the tar judge of the container-image lane refuses them.)
//   - a link whose target is absolute, empty, odd (control characters, a backslash, a drive letter), too long, or that leaves the package: the target is followed through the package's OTHER links too (`a -> b/..` with `b -> deep/sub` does
//     not stay where the words say), a `..` past the package root is an escape, and a chain of links longer than `maxLinkHops` is a loop. A link to a file that is not in the package (dangling) is allowed if it stays inside.
//     The follow is memoised and has a step budget (link-tree.ts), so thousands of links cannot cost more than a fixed amount of CPU. This judges ONE zip; a function's layers are judged again together, in order (code-store.ts);
//   - an entry written through a link or through a file (`l/x` where `l` is a link): a file or folder always sits in real folders, so nothing is ever created through a link;
//   - two entries with one name, or a file and a folder with one name;
//   - more entries than the cap, more expanded bytes than the cap (the sum of the declared sizes is checked before anything is inflated, and each entry's real size must equal its declared size);
//   - a zip that disagrees with itself (the local header's name, method or sizes against the central directory's, data that reaches past the central directory, two entries that share bytes, trailing bytes, a bad CRC found while writing);
//   - encryption, multi-disk archives, zip64 (a function package is far under 4 GiB), and any compression other than stored or deflate.
// The refusal is one fixed sentence per reason; an entry's name is never in it.
import { crc32, inflateRawSync } from "node:zlib";
import { FUNCTION_CODE_LIMITS, FunctionCodeError, type FunctionCodeLimits } from "./code-errors.js";
import { LinkTree } from "./link-tree.js";

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_FIXED = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const MAX_EOCD_COMMENT = 0xffff;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_ISUID_ISGID = 0o006000;
const DOS_DIRECTORY = 0x10;
const DOS_REPARSE_POINT = 0x400;

export type ZipEntryKind = "file" | "dir" | "symlink";

export interface ZipEntryPlan {
  /** The normalised relative path with no trailing slash. */
  path: string;
  kind: ZipEntryKind;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the entry's local record begins, and where its data starts and ends, in the zip. */
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  executable: boolean;
  /** For a link: the target path, already judged (relative, inside the package). */
  target?: string;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/** Control and format characters (bidi overrides, zero-width joiners, NUL included). */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A plain relative path from an entry's name bytes, or a refusal. `directory` is true for a name that ends with a slash. */
function plainPath(raw: Buffer): { path: string; directory: boolean } {
  if (raw.length === 0 || raw.length > FUNCTION_CODE_LIMITS.maxNameBytes) throw new FunctionCodeError("unsafe_entry");
  let name: string;
  try {
    name = strictUtf8.decode(raw);
  } catch {
    throw new FunctionCodeError("unsafe_entry");
  }
  if (HIDDEN.test(name) || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) throw new FunctionCodeError("unsafe_entry");
  const directory = name.endsWith("/");
  const segments = (directory ? name.slice(0, -1) : name).split("/");
  if (segments.length > FUNCTION_CODE_LIMITS.maxDepth) throw new FunctionCodeError("unsafe_entry");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || Buffer.byteLength(segment) > FUNCTION_CODE_LIMITS.maxSegmentBytes) throw new FunctionCodeError("unsafe_entry");
  }
  return { path: segments.join("/"), directory };
}

/**
 * Reads the whole zip's structure and judges every entry, writing nothing. Returns the entries in archive order or throws a `FunctionCodeError`. The checks are listed at the top of this file.
 */
export function inspectFunctionZip(zip: Buffer, limits: FunctionCodeLimits): ZipEntryPlan[] {
  if (zip.length < EOCD_FIXED || zip.length > FUNCTION_CODE_LIMITS.maxZipBytes) throw new FunctionCodeError(zip.length < EOCD_FIXED ? "corrupt" : "size");
  // The end-of-central-directory record: searched from the back, and it must END the file (no comment past its own length, no trailing bytes).
  let eocd = -1;
  for (let at = zip.length - EOCD_FIXED; at >= Math.max(0, zip.length - EOCD_FIXED - MAX_EOCD_COMMENT); at -= 1) {
    if (zip.readUInt32LE(at) === SIG_EOCD && at + EOCD_FIXED + zip.readUInt16LE(at + 20) === zip.length) { eocd = at; break; }
  }
  if (eocd < 0) throw new FunctionCodeError("corrupt");
  if (eocd >= 20 && zip.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw new FunctionCodeError("unsupported");
  const diskNumber = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const total = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== total) throw new FunctionCodeError("unsupported");
  if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new FunctionCodeError("unsupported");
  if (total > limits.maxEntries) throw new FunctionCodeError("too_many_entries");
  // The central directory sits exactly before the end record: no gap an attacker could hide a second directory in.
  if (centralOffset + centralSize !== eocd || centralSize < total * CENTRAL_FIXED) throw new FunctionCodeError("corrupt");

  const entries: ZipEntryPlan[] = [];
  const kinds = new Map<string, ZipEntryKind>();
  /** Every folder some entry's path passes through. */
  const implied = new Set<string>();
  let at = centralOffset;
  let expanded = 0;
  for (let index = 0; index < total; index += 1) {
    if (at + CENTRAL_FIXED > eocd || zip.readUInt32LE(at) !== SIG_CENTRAL) throw new FunctionCodeError("corrupt");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressedSize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const diskStart = zip.readUInt16LE(at + 34);
    const externalAttributes = zip.readUInt32LE(at + 38);
    const localOffset = zip.readUInt32LE(at + 42);
    const next = at + CENTRAL_FIXED + nameLength + extraLength + commentLength;
    if (next > eocd) throw new FunctionCodeError("corrupt");
    const nameBytes = zip.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLength);
    at = next;

    // A flag that changes how the data is read: bit 0 encrypted, bit 6 strong encryption, bit 13 masked local headers.
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0 || (flags & 0x2000) !== 0) throw new FunctionCodeError("unsupported");
    if (method !== 0 && method !== 8) throw new FunctionCodeError("unsupported");
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new FunctionCodeError("unsupported");
    const { path, directory } = plainPath(nameBytes);

    // The kind of entry: the Unix mode in the top 16 bits of the external attributes, whatever the "made by" byte claims, and the DOS bits.
    // Only a regular file, a folder or a link is ever created; a setuid or setgid bit is refused, not silently dropped.
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & S_IFMT;
    if (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR && unixType !== S_IFLNK) throw new FunctionCodeError("unsafe_entry");
    if ((unixMode & S_ISUID_ISGID) !== 0) throw new FunctionCodeError("unsafe_entry");
    if ((externalAttributes & DOS_REPARSE_POINT) !== 0) throw new FunctionCodeError("unsafe_entry");
    if (unixType === S_IFDIR && !directory) throw new FunctionCodeError("unsafe_entry");
    if (directory && unixType !== 0 && unixType !== S_IFDIR) throw new FunctionCodeError("unsafe_entry");
    if (directory && (uncompressedSize !== 0 || (method === 0 && compressedSize !== 0))) throw new FunctionCodeError("unsafe_entry");
    if (!directory && (externalAttributes & DOS_DIRECTORY) !== 0 && unixType !== S_IFREG) throw new FunctionCodeError("unsafe_entry");
    const kind: ZipEntryKind = directory ? "dir" : unixType === S_IFLNK ? "symlink" : "file";
    if (kind === "symlink" && (uncompressedSize < 1 || uncompressedSize > FUNCTION_CODE_LIMITS.maxLinkTargetBytes)) throw new FunctionCodeError("unsafe_link");
    if (method === 0 && compressedSize !== uncompressedSize) throw new FunctionCodeError("corrupt");
    expanded += uncompressedSize;
    if (expanded > limits.maxExpandedBytes) throw new FunctionCodeError("too_large");

    // Names: once each, a name is a file or a folder, not both, and nothing sits below a file or a link (an entry is never written through a link).
    if (kinds.has(path) || (kind !== "dir" && implied.has(path))) throw new FunctionCodeError("unsafe_entry");
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      const parentKind = kinds.get(parent);
      if (parentKind !== undefined && parentKind !== "dir") throw new FunctionCodeError("unsafe_entry");
      implied.add(parent);
    }
    kinds.set(path, kind);
    entries.push({ path, kind, method, crc32: crc, compressedSize, uncompressedSize, localOffset, dataStart: 0, dataEnd: 0, executable: kind === "file" && (unixMode & 0o100) !== 0 });

    // The local header must say the same thing as the central directory, or a program that reads one and a program that reads the other would see two archives.
    if (localOffset + LOCAL_FIXED > centralOffset || zip.readUInt32LE(localOffset) !== SIG_LOCAL) throw new FunctionCodeError("corrupt");
    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localMethod = zip.readUInt16LE(localOffset + 8);
    const localCrc = zip.readUInt32LE(localOffset + 14);
    const localCompressed = zip.readUInt32LE(localOffset + 18);
    const localUncompressed = zip.readUInt32LE(localOffset + 22);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + LOCAL_FIXED + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    // The flags must agree except for bit 3 (a data descriptor follows), which a writer may set in one header only.
    const flagsDisagree = ((localFlags ^ flags) & ~0x8) !== 0;
    if (localNameLength !== nameLength || dataEnd > centralOffset || flagsDisagree || localMethod !== method) throw new FunctionCodeError("corrupt");
    if (!zip.subarray(localOffset + LOCAL_FIXED, localOffset + LOCAL_FIXED + localNameLength).equals(nameBytes)) throw new FunctionCodeError("corrupt");
    if ((localFlags & 0x8) === 0 && (localCrc !== crc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize)) throw new FunctionCodeError("corrupt");
    const plan = entries[entries.length - 1]!;
    plan.dataStart = dataStart;
    plan.dataEnd = dataEnd;
  }
  if (at !== eocd) throw new FunctionCodeError("corrupt");

  // No two entries may share a byte (the overlapping-entries bomb): sorted by where they start, each must begin at or after the previous one's data end.
  const regions = entries.map((entry) => ({ start: entry.localOffset, end: entry.dataEnd })).sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index += 1) {
    if (regions[index]!.start < regions[index - 1]!.end) throw new FunctionCodeError("corrupt");
  }

  // Links last, when every name is known: read each target, then follow it through the package's own links.
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    entry.target = linkTargetOf(zip, entry);
    targets.set(entry.path, entry.target);
  }
  // Where each link really ends is decided on the whole tree at once (memoised and bounded: link-tree.ts), not link by link in words.
  if (targets.size > 0) LinkTree.fromPlan(entries).checkLinks();
  return entries;
}

/** A link's target text, read from the (declared-small) data: bounded inflate, exact size, exact CRC, then the plain-text rules. */
function linkTargetOf(zip: Buffer, entry: ZipEntryPlan): string {
  const stored = zip.subarray(entry.dataStart, entry.dataEnd);
  let raw: Buffer;
  if (entry.method === 0) raw = stored;
  else {
    try {
      raw = inflateRawSync(stored, { maxOutputLength: entry.uncompressedSize + 1 });
    } catch {
      throw new FunctionCodeError("corrupt");
    }
  }
  if (raw.length !== entry.uncompressedSize || crc32(raw) !== entry.crc32) throw new FunctionCodeError("corrupt");
  let text: string;
  try {
    text = strictUtf8.decode(raw);
  } catch {
    throw new FunctionCodeError("unsafe_link");
  }
  // Absolute (leading slash), a drive letter, a backslash, control or formatting characters (NUL, bidi) are never a link inside the package.
  if (text.length === 0 || HIDDEN.test(text) || text.includes("\\") || text.startsWith("/") || /^[A-Za-z]:/u.test(text)) throw new FunctionCodeError("unsafe_link");
  // A path segment past the file name limit can never name anything.
  if (text.split("/").some((segment) => Buffer.byteLength(segment) > FUNCTION_CODE_LIMITS.maxSegmentBytes)) throw new FunctionCodeError("unsafe_link");
  return text;
}
