// Slice 4 X1: is this function package (or layer) native code, and for which CPU? A pure library: it is handed a list of files with their first bytes (or a bounded
// reader) and returns a verdict. Nothing is read from disk here, and nothing a package declares is believed: a file's size is reported, never used to read; a header
// that is cut short, an ELF of an odd class, a Mach-O or PE binary, a `.node` that is not an object and a file the reader cannot read all count as native and as NOT
// a clean arm64 or x86_64 file, so a doubtful package is never called pure. Lane W2 calls `classifyNative`.
import { ELF_HEAD_BYTES, inspectHeader, type ElfInfo } from "./elf.js";
import { expandTags, parsePlatformTag, parseWheelFile } from "./wheel-meta.js";

/** One file of a package. `head` is its first bytes (ELF_HEAD_BYTES is enough); `read` is a bounded synchronous reader for the few text files (WHEEL, METADATA, package.json) that need more. */
export interface PackageFileInput {
  /** Package-relative POSIX path. */
  readonly path: string;
  /** The size the container declares. Informational only. */
  readonly size: number;
  readonly head?: Uint8Array | undefined;
  readonly read?: ((offset: number, length: number) => Uint8Array) | undefined;
}

export type NativeArch = "arm64" | "x86_64" | "mixed" | "none";

export type OffenderKind = "x86_64" | "other-machine" | "malformed-elf" | "foreign-binary" | "not-an-object" | "unreadable";

export interface NativeOffender {
  /** The path with control and format characters replaced by [U+XXXX] and capped at 300 characters. */
  readonly path: string;
  readonly kind: OffenderKind;
  /** The declared size, when it is a sane non-negative integer. */
  readonly declaredSize: number | null;
  /** ELF facts, when the header parsed. */
  readonly elf?: Pick<ElfInfo, "elfClass" | "endian" | "machine" | "type">;
  /** Why an ELF header was rejected, or the foreign format ("macho", "pe"). */
  readonly detail?: string;
}

export interface WheelTagInfo {
  /** Sanitised path of the `*.dist-info/WHEEL` file. */
  readonly path: string;
  /** The compressed tags it lists (`cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64`). */
  readonly tags: readonly string[];
  /** Distinct CPU families the tags name: "x86_64", "aarch64", "i686", "other" (macOS, Windows), and "any" for pure-Python. */
  readonly platforms: readonly string[];
  readonly rootIsPurelib: boolean | undefined;
}

export type NodeAddonFramework = "prebuildify" | "napi-rs" | "node-pre-gyp" | "unknown";

export interface NodeAddon {
  readonly path: string;
  /** From the file's header; "unknown" when it is not a clean 64-bit little-endian ELF. */
  readonly arch: "arm64" | "x86_64" | "unknown";
  readonly framework: NodeAddonFramework;
}

export interface NativeClassification {
  /** Any native file or a platform-specific wheel was found. */
  readonly native: boolean;
  /**
   * The one CPU family everything native is built for, "none" when nothing is native, and "mixed" when the package holds more than one family OR any native file
   * that is not clean arm64 or x86_64 (a malformed, foreign or unreadable file): it cannot be run as either, and the offenders say why.
   */
  readonly arch: NativeArch;
  /** Native files that are not clean arm64: every x86_64 file and every doubtful one. Capped; see `offenderCount`. */
  readonly offenders: readonly NativeOffender[];
  readonly offenderCount: number;
  /** Clean native files by CPU family. */
  readonly counts: { readonly arm64: number; readonly x86_64: number; readonly other: number };
  readonly wheels: readonly WheelTagInfo[];
  readonly nodeAddons: readonly NodeAddon[];
  /** False when the file list was longer than the bound and the rest was not looked at. Never "pure" then: `native` is true. */
  readonly complete: boolean;
}

export interface ClassifyOptions {
  /** Files looked at; the rest are not, and `complete` is false. Default 500,000. */
  readonly maxFiles?: number;
  /** Offenders listed. Default 100. */
  readonly maxOffenders?: number;
  /** Wheel tag files read. Default 2,000. */
  readonly maxWheels?: number;
}

const NATIVE_NAME = /\.(?:so(?:\.\d+)*|node|dylib|dll|exe|pyd)$/iu;
const WHEEL_FILE = /(?:^|\/)[^/]+\.dist-info\/WHEEL$/u;
const WHEEL_TEXT_BYTES = 16 * 1024;

/** A path made safe to show: control and format characters (`\p{Cc}\p{Cf}`) become [U+XXXX], and it is cut at 300 characters. Package paths are user content. */
export function displayPath(path: string): string {
  let out = "";
  for (const ch of path) {
    if (/[\p{Cc}\p{Cf}]/u.test(ch)) out += `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`;
    else out += ch;
    if (out.length >= 300) return `${out.slice(0, 300)}...`;
  }
  return out;
}

/** The bytes of `file` from `offset`, at most `length` of them: from the reader when it has one, else from `head`. Never more than asked, whatever the callback returns. */
export function readFileBytes(file: PackageFileInput, offset: number, length: number): Uint8Array | undefined {
  try {
    if (file.read !== undefined) {
      const bytes = file.read(offset, length);
      return bytes.length > length ? bytes.subarray(0, length) : bytes;
    }
    if (file.head !== undefined) return file.head.subarray(Math.min(offset, file.head.length), Math.min(offset + length, file.head.length));
  } catch {
    return undefined;
  }
  return undefined;
}

/** The first bytes of a file (at most ELF_HEAD_BYTES), preferring the pre-read `head`. Undefined when they cannot be read. */
export function headOf(file: PackageFileInput): Uint8Array | undefined {
  if (file.head !== undefined) return file.head.length > ELF_HEAD_BYTES ? file.head.subarray(0, ELF_HEAD_BYTES) : file.head;
  return readFileBytes(file, 0, ELF_HEAD_BYTES);
}

/** The whole text of a small file (WHEEL, METADATA, RECORD, package.json), capped. Undefined when it cannot be read. */
export function readSmallText(file: PackageFileInput, cap: number): string | undefined {
  const bytes = readFileBytes(file, 0, cap);
  return bytes === undefined ? undefined : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const saneSize = (size: number): number | null => (Number.isSafeInteger(size) && size >= 0 ? size : null);

function nodeFramework(path: string): NodeAddonFramework {
  if (/(?:^|\/)prebuilds\/[^/]+\/[^/]+\.node$/u.test(path)) return "prebuildify";
  if (/\.(?:linux|darwin|win32|android|freebsd)-[a-z0-9]+(?:-[a-z0-9]+)*\.node$/u.test(path)) return "napi-rs";
  if (/(?:^|\/)lib\/binding\//u.test(path)) return "node-pre-gyp";
  return "unknown";
}

/**
 * Classifies the native code in a package. Synchronous and bounded: it looks at ELF_HEAD_BYTES of each file and at one WHEEL file per Python distribution.
 * The shape `{ native, arch }` is what lane W2's `classifyNative` hook consumes; the other fields extend it.
 */
export function classifyNative(files: readonly PackageFileInput[], options: ClassifyOptions = {}): NativeClassification {
  const maxFiles = options.maxFiles ?? 500_000;
  const maxOffenders = options.maxOffenders ?? 100;
  const maxWheels = options.maxWheels ?? 2_000;
  const offenders: NativeOffender[] = [];
  let offenderCount = 0;
  const counts = { arm64: 0, x86_64: 0, other: 0 };
  const wheels: WheelTagInfo[] = [];
  const nodeAddons: NodeAddon[] = [];
  const families = new Set<string>();
  let unknownNative = false;
  let nativeFiles = 0;
  const complete = files.length <= maxFiles;
  const limit = Math.min(files.length, maxFiles);

  const offend = (offender: NativeOffender): void => {
    offenderCount += 1;
    if (offenders.length < maxOffenders) offenders.push(offender);
  };

  for (let i = 0; i < limit; i += 1) {
    const file = files[i]!;
    const path = typeof file.path === "string" ? file.path : "";
    const shown = displayPath(path);
    const nameNative = NATIVE_NAME.test(path);
    const isNode = path.toLowerCase().endsWith(".node");
    const declaredSize = saneSize(file.size);

    if (WHEEL_FILE.test(path) && wheels.length < maxWheels) {
      const text = readSmallText(file, WHEEL_TEXT_BYTES);
      if (text !== undefined) {
        const info = parseWheelFile(text);
        const platforms = new Set<string>();
        for (const tag of info.tags) for (const triple of expandTags(tag)) {
          const p = parsePlatformTag(triple.platform);
          platforms.add(p.family === "any" ? "any" : p.arch);
        }
        wheels.push({ path: shown, tags: info.tags, platforms: [...platforms].sort(), rootIsPurelib: info.rootIsPurelib });
        for (const platform of platforms) {
          if (platform === "any") continue;
          nativeFiles += 1;
          families.add(platform === "x86_64" ? "x86_64" : platform === "aarch64" ? "arm64" : "unknown");
          if (platform !== "x86_64" && platform !== "aarch64") unknownNative = true;
        }
      }
    }

    const head = headOf(file);
    if (head === undefined) {
      // Cannot look: a file that would be native by name is doubtful; any other file is not looked for.
      if (nameNative) { nativeFiles += 1; unknownNative = true; families.add("unknown"); offend({ path: shown, kind: "unreadable", declaredSize }); if (isNode) nodeAddons.push({ path: shown, arch: "unknown", framework: nodeFramework(path) }); }
      continue;
    }
    const result = inspectHeader(head, nameNative);
    if (result.kind === "not-native") {
      if (nameNative) {
        // A `.so` or `.node` that is not an object file (an empty placeholder, a linker script, a download that failed): not loadable, but never "pure".
        nativeFiles += 1; unknownNative = true; families.add("unknown");
        offend({ path: shown, kind: "not-an-object", declaredSize });
        if (isNode) nodeAddons.push({ path: shown, arch: "unknown", framework: nodeFramework(path) });
      }
      continue;
    }
    nativeFiles += 1;
    if (result.kind === "malformed-elf") {
      unknownNative = true; families.add("unknown");
      offend({ path: shown, kind: "malformed-elf", declaredSize, detail: result.reason });
      if (isNode) nodeAddons.push({ path: shown, arch: "unknown", framework: nodeFramework(path) });
    } else if (result.kind === "foreign") {
      unknownNative = true; families.add("unknown");
      offend({ path: shown, kind: "foreign-binary", declaredSize, detail: result.format });
      if (isNode) nodeAddons.push({ path: shown, arch: "unknown", framework: nodeFramework(path) });
    } else {
      const { info } = result;
      const elf = { elfClass: info.elfClass, endian: info.endian, machine: info.machine, type: info.type };
      if (info.arch === "arm64") { counts.arm64 += 1; families.add("arm64"); }
      else if (info.arch === "x86_64") { counts.x86_64 += 1; families.add("x86_64"); offend({ path: shown, kind: "x86_64", declaredSize, elf }); }
      else { counts.other += 1; unknownNative = true; families.add("unknown"); offend({ path: shown, kind: "other-machine", declaredSize, elf }); }
      if (isNode) nodeAddons.push({ path: shown, arch: info.arch === "other" ? "unknown" : info.arch, framework: nodeFramework(path) });
    }
  }

  const native = nativeFiles > 0 || !complete;
  let arch: NativeArch;
  if (!native) arch = "none";
  else if (!complete || unknownNative || families.size !== 1) arch = "mixed";
  else arch = families.has("arm64") ? "arm64" : "x86_64";
  return { native, arch, offenders, offenderCount, counts, wheels, nodeAddons, complete };
}
