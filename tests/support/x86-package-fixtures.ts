// Slice 4 X1/X2 test fixtures: tiny synthetic ELF headers, wheels (zips) and package file lists, all built at test time. No binary is committed.
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import type { PackageFileInput } from "../../packages/worker/src/function-runner/native-classify.js";

export interface ElfSpec { machine: number; elfClass?: 1 | 2; data?: 1 | 2; type?: number; version?: number; length?: number }

/** A 64-byte ELF-looking header (and nothing else) for a given machine. */
export function elf(spec: ElfSpec): Uint8Array {
  const out = new Uint8Array(spec.length ?? 64);
  const little = (spec.data ?? 1) === 1;
  out.set([0x7f, 0x45, 0x4c, 0x46, spec.elfClass ?? 2, spec.data ?? 1, spec.version ?? 1]);
  const put16 = (offset: number, value: number): void => {
    if (offset + 1 >= out.length) return;
    out[offset] = little ? value & 0xff : value >> 8;
    out[offset + 1] = little ? value >> 8 : value & 0xff;
  };
  put16(16, spec.type ?? 3);
  put16(18, spec.machine);
  return out;
}
export const X86 = (): Uint8Array => elf({ machine: 62 });
export const ARM = (): Uint8Array => elf({ machine: 183 });

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export function file(path: string, data: Uint8Array | string, declaredSize?: number): PackageFileInput {
  const bytes = typeof data === "string" ? text(data) : data;
  return {
    path,
    size: declaredSize ?? bytes.length,
    head: bytes.subarray(0, 64),
    read: (offset, length) => bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length)),
  };
}

export interface ZipMember { name: string; data: Uint8Array | string; mode?: number; store?: boolean; symlink?: boolean }

const le16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** A zip writer (stored or deflated members) for fixtures. `tamper` can edit the finished bytes to build hostile archives. */
export function zip(members: readonly ZipMember[], tamper?: (bytes: Uint8Array) => Uint8Array): Uint8Array {
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const member of members) {
    const data = typeof member.data === "string" ? text(member.data) : member.data;
    const name = [...text(member.name)];
    const method = member.store === true ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data);
    const crc = crc32(data);
    const local = [...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(crc), ...le32(body.length), ...le32(data.length), ...le16(name.length), ...le16(0), ...name];
    parts.push(local, [...body]);
    const mode = member.symlink === true ? 0o120777 : 0o100000 | (member.mode ?? 0o644);
    central.push([...le32(0x02014b50), ...le16(0x031e), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(crc), ...le32(body.length), ...le32(data.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32((mode << 16) >>> 0), ...le32(offset), ...name]);
    offset += local.length + body.length;
  }
  const cdOffset = offset;
  const cdSize = central.reduce((n, entry) => n + entry.length, 0);
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(members.length), ...le16(members.length), ...le32(cdSize), ...le32(cdOffset), ...le16(0)];
  const bytes = Uint8Array.from([...parts.flat(), ...central.flat(), ...eocd]);
  return tamper === undefined ? bytes : tamper(bytes);
}

export const sha256b64 = (data: Uint8Array | string): string => createHash("sha256").update(typeof data === "string" ? text(data) : data).digest("base64url");

export interface WheelSpec {
  name: string;
  version: string;
  tags: readonly string[];
  /** Package files (path inside the wheel to content). */
  files: Record<string, Uint8Array | string>;
  purelib?: boolean;
  /** Replaces the hash of one RECORD row (a tampered wheel). */
  badHashFor?: string;
  metadataName?: string;
  /** Members left out of RECORD (they are still in the zip). */
  recordOmit?: readonly string[];
  /** Members listed in RECORD with an empty hash. */
  recordEmptyHash?: readonly string[];
}

/** A wheel as a zip with a correct dist-info (METADATA, WHEEL, RECORD). */
export function wheel(spec: WheelSpec): Uint8Array {
  const info = `${spec.name.replace(/-/g, "_")}-${spec.version}.dist-info`;
  const all: Record<string, Uint8Array | string> = {
    ...spec.files,
    [`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${spec.metadataName ?? spec.name}\nVersion: ${spec.version}\n\nlong description\n`,
    [`${info}/WHEEL`]: `Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: ${spec.purelib === true ? "true" : "false"}\n${spec.tags.map((tag) => `Tag: ${tag}\n`).join("")}`,
  };
  const rows = Object.entries(all).filter(([path]) => spec.recordOmit?.includes(path) !== true).map(([path, data]) => {
    const bytes = typeof data === "string" ? text(data) : data;
    const hash = spec.recordEmptyHash?.includes(path) === true ? "" : path === spec.badHashFor ? "sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : `sha256=${sha256b64(bytes)}`;
    return `${path},${hash},${bytes.length}`;
  });
  rows.push(`${info}/RECORD,,`);
  const members: ZipMember[] = Object.entries(all).map(([name, data]) => ({ name, data }));
  members.push({ name: `${info}/RECORD`, data: `${rows.join("\n")}\n` });
  return zip(members);
}

export interface InstalledSpec {
  name: string;
  version: string;
  tags: readonly string[];
  files: Record<string, Uint8Array | string>;
  /** Folder holding the dist-info (default ""). */
  root?: string;
  /** Leave RECORD out. */
  noRecord?: boolean;
  /** Extra RECORD lines (hostile paths). */
  recordExtra?: readonly string[];
  purelib?: boolean;
}

/** The files `pip install -t` leaves for one distribution. */
export function installed(spec: InstalledSpec): PackageFileInput[] {
  const root = spec.root === undefined || spec.root === "" ? "" : `${spec.root}/`;
  const info = `${spec.name.replace(/-/g, "_")}-${spec.version}.dist-info`;
  const out: PackageFileInput[] = [];
  const rows: string[] = [];
  for (const [path, data] of Object.entries(spec.files)) {
    out.push(file(`${root}${path}`, data));
    rows.push(`${path},sha256=x,${typeof data === "string" ? data.length : data.length}`);
  }
  out.push(file(`${root}${info}/METADATA`, `Metadata-Version: 2.1\nName: ${spec.name}\nVersion: ${spec.version}\n`));
  out.push(file(`${root}${info}/WHEEL`, `Wheel-Version: 1.0\nRoot-Is-Purelib: ${spec.purelib === true ? "true" : "false"}\n${spec.tags.map((tag) => `Tag: ${tag}\n`).join("")}`));
  out.push(file(`${root}${info}/INSTALLER`, "pip\n"));
  rows.push(`${info}/METADATA,,`, `${info}/WHEEL,,`, `${info}/INSTALLER,,`, `${info}/RECORD,,`, ...(spec.recordExtra ?? []));
  if (spec.noRecord !== true) out.push(file(`${root}${info}/RECORD`, `${rows.join("\n")}\n`));
  return out;
}
