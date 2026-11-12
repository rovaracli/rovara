// Slice 4 X1: the header of a native object file, read from a few bytes and nothing else. Pure: no I/O, no allocation beyond the result.
// Only the first 20 bytes of an ELF file matter (e_ident, e_type, e_machine), so the caller never needs more than ELF_HEAD_BYTES of any file, and nothing here
// believes a size, an offset or a count that the file itself declares.

/** How many leading bytes of a file the classifier looks at. Callers read this many (or fewer, for a short file). */
export const ELF_HEAD_BYTES = 64;

export const EM_386 = 3;
export const EM_ARM = 40;
export const EM_X86_64 = 62;
export const EM_AARCH64 = 183;
export const EM_RISCV = 243;

const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;
const ET_REL = 1;
const ET_CORE = 4;

export type ElfArch = "arm64" | "x86_64" | "other";

export interface ElfInfo {
  readonly format: "elf";
  /** ELFCLASS32 or ELFCLASS64 as 32 / 64. */
  readonly elfClass: 32 | 64;
  readonly endian: "le" | "be";
  /** e_type (1 relocatable, 2 executable, 3 shared object, 4 core). */
  readonly type: number;
  /** e_machine as the file says it. */
  readonly machine: number;
  /**
   * arm64 and x86_64 only for a little-endian 64-bit object of that machine. An x32 object (EM_X86_64 with ELFCLASS32), an ILP32 or big-endian aarch64 object
   * is "other": it does not run as the arm64 or x86-64 code Lambda means.
   */
  readonly arch: ElfArch;
}

export type MalformedElfReason = "truncated" | "bad-class" | "bad-data" | "bad-version" | "bad-type";

export type HeaderInspection =
  | { readonly kind: "elf"; readonly info: ElfInfo }
  | { readonly kind: "malformed-elf"; readonly reason: MalformedElfReason }
  | { readonly kind: "foreign"; readonly format: "macho" | "pe" }
  | { readonly kind: "not-native" };

const isElfMagic = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

/** Mach-O thin magics, both byte orders (a fat header, 0xCAFEBABE, is also a Java class, so the caller decides from the file name). */
const isMachOThin = (b: Uint8Array): boolean =>
  b.length >= 4 &&
  ((b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) || (b[3] === 0xfe && b[2] === 0xed && b[1] === 0xfa && (b[0] === 0xce || b[0] === 0xcf)));
const isMachOFat = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe;

/**
 * Classifies the leading bytes of one file. `nameLooksNative` (from the file name: .node, .so, .dylib, .dll, .exe, .pyd) only widens what counts as a foreign
 * binary (a PE "MZ" or a fat Mach-O header is too short or too common a signature to trust on any file).
 */
export function inspectHeader(head: Uint8Array, nameLooksNative: boolean): HeaderInspection {
  if (isElfMagic(head)) {
    if (head.length < 20) return { kind: "malformed-elf", reason: "truncated" };
    const klass = head[4];
    const data = head[5];
    if (klass !== ELFCLASS32 && klass !== ELFCLASS64) return { kind: "malformed-elf", reason: "bad-class" };
    if (data !== ELFDATA2LSB && data !== ELFDATA2MSB) return { kind: "malformed-elf", reason: "bad-data" };
    if (head[6] !== 1) return { kind: "malformed-elf", reason: "bad-version" };
    const little = data === ELFDATA2LSB;
    const u16 = (offset: number): number => (little ? head[offset]! | (head[offset + 1]! << 8) : (head[offset]! << 8) | head[offset + 1]!);
    const type = u16(16);
    const machine = u16(18);
    // ET_NONE (0) and the values between ET_CORE and the OS-specific range are not objects any loader accepts.
    if (type < ET_REL || (type > ET_CORE && type < 0xfe00)) return { kind: "malformed-elf", reason: "bad-type" };
    const elfClass = klass === ELFCLASS64 ? 64 : 32;
    let arch: ElfArch = "other";
    if (elfClass === 64 && little) {
      if (machine === EM_X86_64) arch = "x86_64";
      else if (machine === EM_AARCH64) arch = "arm64";
    }
    return { kind: "elf", info: { format: "elf", elfClass, endian: little ? "le" : "be", type, machine, arch } };
  }
  if (isMachOThin(head) || (nameLooksNative && isMachOFat(head))) return { kind: "foreign", format: "macho" };
  if (nameLooksNative && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { kind: "foreign", format: "pe" };
  return { kind: "not-native" };
}
