// A small zip writer for tests that need archives a real tool would never write: names with `..`, links, lies about sizes, overlapping entries, lies in the end record. Nothing here is shipped.
import { crc32, deflateRawSync } from "node:zlib";

export interface TestZipEntry {
  name: string;
  data?: Buffer | string;
  /** 0 stored, 8 deflate. */
  method?: 0 | 8;
  /** Unix mode written in the top 16 bits of the external attributes (for example 0o120777 for a link). */
  mode?: number;
  /** The "made by" host byte (3 = Unix). */
  host?: number;
  flags?: number;
  /** Written in the central directory instead of the real value. */
  declaredUncompressed?: number;
  declaredCompressed?: number;
  declaredCrc?: number;
  /** The name in the local header, when it should differ from the central directory's. */
  localName?: string;
  /** Raw bytes to use as the compressed data instead of the real ones. */
  rawCompressed?: Buffer;
  /** Point the central directory at another entry's local header (overlap). */
  shareLocalWith?: number;
  /** The whole external-attributes word, instead of one built from `mode`. */
  externalAttributes?: number;
  /** Extra bytes after the name in the central directory and in the local header. */
  extra?: Buffer;
  /** The disk number in the central directory. */
  diskStart?: number;
}

export interface ZipOptions {
  comment?: string;
  trailing?: Buffer;
  zip64Locator?: boolean;
  /** Lies in the end-of-central-directory record. */
  eocd?: Partial<{ total: number; entriesOnDisk: number; centralSize: number; centralOffset: number; commentLength: number; disk: number }>;
}

/** A zip of a symbolic link entry: the target is the entry's data. */
export function linkEntry(name: string, target: string, extra: Partial<TestZipEntry> = {}): TestZipEntry {
  return { name, data: target, mode: 0o120777, ...extra };
}

export function buildZip(entries: TestZipEntry[], options: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const compressed = entry.rawCompressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = entry.declaredCrc ?? crc32(data);
    const csize = entry.declaredCompressed ?? compressed.length;
    const usize = entry.declaredUncompressed ?? data.length;
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const flags = entry.flags ?? 0;
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(extra.length, 28);
    offsets[index] = offset;
    parts.push(local, localName, extra, compressed);
    offset += 30 + localName.length + extra.length + compressed.length;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(((entry.host ?? 3) << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(csize, 20);
    header.writeUInt32LE(usize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(entry.diskStart ?? 0, 34);
    header.writeUInt32LE(entry.externalAttributes ?? ((entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.push(header, name, extra);
  });
  entries.forEach((entry, index) => {
    const header = central[index * 3]!;
    header.writeUInt32LE(entry.shareLocalWith !== undefined ? offsets[entry.shareLocalWith]! : offsets[index]!, 42);
  });
  const directory = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? "");
  const lies = options.eocd ?? {};
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(lies.disk ?? 0, 4);
  end.writeUInt16LE(lies.entriesOnDisk ?? entries.length, 8);
  end.writeUInt16LE(lies.total ?? entries.length, 10);
  end.writeUInt32LE(lies.centralSize ?? directory.length, 12);
  end.writeUInt32LE(lies.centralOffset ?? offset, 16);
  end.writeUInt16LE(lies.commentLength ?? comment.length, 20);
  const locator = options.zip64Locator === true ? Buffer.alloc(20) : Buffer.alloc(0);
  if (locator.length > 0) locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([...parts, directory, locator, end, comment, options.trailing ?? Buffer.alloc(0)]);
}
