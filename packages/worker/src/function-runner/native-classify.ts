// The native-code hook (slice 4, lane W2 exposes it, lane X1 implements it). After a function's package and layers are unpacked, the store hands the final list of regular files to `classifyNative`, which says whether any of them
// is compiled code (an ELF file: `.so`, `.node`, a bundled binary) and for which machine. The slice 4 design uses the answer to decide that a function is "heavy" and to word the evidence (x86_64 code on an arm64 worker).
//
// STUB. Until X1 lands this answers "no native code" for everything, so a caller MUST NOT treat `native: false` as proof yet. `NATIVE_CLASSIFIER_IS_STUB` is true for the stub and lets a caller (and a test) tell. X1 replaces the body of
// `classifyNative` (or passes its own function as the store's `classify` option) and flips the constant.

export type NativeArch = "arm64" | "x86_64" | "mixed" | "none";

export interface NativeClassification {
  native: boolean;
  arch: NativeArch;
}

/** One unpacked regular file. `path` is the package-relative path (display text only, never a host path); `head` reads the first bytes from disk without following a link. */
export interface ClassifiableFile {
  path: string;
  size: number;
  executable: boolean;
  head(bytes: number): Promise<Buffer>;
}

export type ClassifyNative = (files: readonly ClassifiableFile[]) => Promise<NativeClassification>;

export const NATIVE_CLASSIFIER_IS_STUB = true;

/** The stub: nothing is native. Lane X1 replaces it (ELF machine type per file; arm64, x86_64, mixed or none). */
export const classifyNative: ClassifyNative = () => Promise.resolve({ native: false, arch: "none" });
