// Slice 4 X2: the arm64 wheel swap for a Python function package or layer. For every installed distribution that carries x86_64 native code, find the wheel of the SAME
// name and version built for aarch64 (right CPython, a manylinux level the Lambda image meets), fetch it through a WheelIndex, verify it (the index's SHA-256, then every
// RECORD hash inside the wheel), replace the distribution's files, and run the classifier on the result. Nothing is applied to a distribution that cannot be fully swapped:
// the report says why, and the package falls back to the qemu path (lane X3). Pure planning and in-memory editing: the caller materialises `edits` (or `files`).
//
// Trust: the package is the customer's, the wheel is from the index; a METADATA/RECORD/WHEEL file in either is hostile text. Names and versions are validated before they
// go to the index; RECORD paths that leave the package folder are ignored; a wheel that would overwrite a file it does not own, ship a symlink, list a file it lacks, or
// disagree with its own RECORD is refused. Every reason in a report is a fixed code, never text from a file.
import { createHash } from "node:crypto";
import {
  classifyNative, displayPath, headOf, readSmallText, type NativeClassification, type PackageFileInput,
} from "./native-classify.js";
import { inspectHeader } from "./elf.js";
import { WheelIndexError, sha256Hex, type IndexFile, type WheelIndex } from "./wheel-index.js";
import {
  compareFit, isProjectName, isVersionText, lambdaGlibc, normalizeProjectName, normalizeVersion, parseMetadataHeaders, parseRecord, parseWheelFile,
  parseWheelFilename, pythonTagVersion, expandTags, wheelFit, type SwapTarget, type WheelFit,
} from "./wheel-meta.js";
import { ZipError, openZip, type ZipEntry } from "./zip-read.js";

export type SwapStatus =
  | "swapped"
  | "no-arm64-wheel"
  | "source-only"
  | "index-error"
  | "hash-mismatch"
  | "unsafe"
  | "verify-failed"
  | "unplannable";

export interface SwapOptions {
  /** The function's CPython. Default: read from the wheel tags of the package's own native wheels. */
  readonly python?: { readonly major: number; readonly minor: number };
  /** The glibc of the Lambda image. Default: lambdaGlibc(python.minor). */
  readonly glibc?: readonly [number, number];
  /** Largest wheel downloaded. Default 300 MiB. */
  readonly maxWheelBytes?: number;
  /** Largest total of replacement files. Default 512 MiB. */
  readonly maxTotalAddedBytes?: number;
  /** Most distributions swapped in one package. Default 200. */
  readonly maxPackages?: number;
}

export interface PackageSwapReport {
  /** The distribution's name and version, as METADATA (or the dist-info folder) says; sanitised for display. */
  readonly name: string;
  readonly version: string;
  readonly distInfo: string;
  readonly status: SwapStatus;
  /** What the function does next: "none" after a swap, "qemu" (lane X3) for every other status. */
  readonly fallback: "none" | "qemu";
  /** A fixed code that says why (for example "no-compatible-tag", "sdist-only", "record-missing"). */
  readonly detail: string;
  /** The x86_64 wheel tags the package carried. */
  readonly fromTags: readonly string[];
  /** The aarch64 wheel installed instead. */
  readonly wheel?: string;
  readonly removed: number;
  readonly added: number;
  /** The replacement is a yanked release (still the exact version the package had). */
  readonly yanked: boolean;
  /** The replacement is a pure-Python wheel (platform `any`), not a native build: slower or different. */
  readonly pureFallback: boolean;
}

export interface AddedFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

export interface SwapResult {
  readonly reports: readonly PackageSwapReport[];
  /** x86_64 (or doubtful) native files that belong to no distribution (a vendored `.so`, a bundled binary): never swapped, so the package needs the qemu path. */
  readonly unowned: readonly { readonly path: string; readonly kind: string }[];
  readonly edits: { readonly remove: readonly string[]; readonly add: readonly AddedFile[] };
  /** The package after the edits, ready for classifyNative or for the caller to pack. */
  readonly files: readonly PackageFileInput[];
  readonly before: NativeClassification;
  readonly after: NativeClassification;
  /** The package after the swap holds no x86_64 or doubtful native code. */
  readonly fullyArm64: boolean;
  /** Anything is left that only qemu can run: !fullyArm64. */
  readonly needsQemu: boolean;
}

interface Distribution {
  readonly distInfo: string;
  readonly root: string;
  readonly name: string;
  readonly version: string;
  /** Resolved package-relative paths its RECORD lists that exist in the package. */
  readonly owned: readonly string[];
  readonly fromTags: readonly string[];
  readonly pythonTag: { readonly major: number; readonly minor: number } | undefined;
  readonly problem: string | undefined;
}

const META_BYTES = 256 * 1024;
const RECORD_BYTES = 16 * 1024 * 1024;

const dirName = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const joinPath = (root: string, rest: string): string => (root === "" ? rest : `${root}/${rest}`);

/** A RECORD path resolved against the folder that holds the dist-info folder; undefined when it would leave it or is not a plain path. */
function resolveRecordPath(root: string, raw: string): string | undefined {
  if (raw === "" || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0") || /[\p{Cc}\p{Cf}]/u.test(raw)) return undefined;
  const parts: string[] = root === "" ? [] : root.split("/");
  const floor = parts.length;
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length <= floor) return undefined; parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length > floor ? parts.join("/") : undefined;
}

function pythonFromTags(tags: readonly string[]): { major: number; minor: number } | undefined {
  for (const tag of tags) for (const triple of expandTags(tag)) {
    const py = pythonTagVersion(triple.python);
    if (py !== undefined && py.kind === "cp" && py.version.length === 2 && triple.abi === triple.python && triple.platform !== "any") return { major: py.version[0]!, minor: py.version[1]! };
  }
  return undefined;
}

function inventory(files: readonly PackageFileInput[], index: ReadonlyMap<string, PackageFileInput>): Distribution[] {
  const out: Distribution[] = [];
  for (const file of files) {
    if (!/(?:^|\/)[^/]+\.dist-info\/WHEEL$/u.test(file.path)) continue;
    const distInfo = dirName(file.path);
    const root = dirName(distInfo);
    const folder = distInfo.slice(distInfo.lastIndexOf("/") + 1, -".dist-info".length);
    const wheelText = readSmallText(file, META_BYTES);
    const tags = wheelText === undefined ? [] : parseWheelFile(wheelText).tags;
    const meta = index.get(`${distInfo}/METADATA`);
    const headers = meta === undefined ? undefined : parseMetadataHeaders(readSmallText(meta, META_BYTES) ?? "");
    const folderMatch = /^(.+?)-([^-]+)$/u.exec(folder);
    let name = headers?.get("name") ?? folderMatch?.[1] ?? "";
    let version = headers?.get("version") ?? folderMatch?.[2] ?? "";
    let problem: string | undefined;
    if (!isProjectName(name) || !isVersionText(version)) problem = "metadata-unreadable";
    else if (folderMatch !== null && headers !== undefined && (normalizeProjectName(folderMatch[1]!) !== normalizeProjectName(name) || normalizeVersion(folderMatch[2]!) !== normalizeVersion(version))) problem = "metadata-mismatch";
    if (problem !== undefined) { name = displayPath(name).slice(0, 100); version = displayPath(version).slice(0, 64); }

    const recordFile = index.get(`${distInfo}/RECORD`);
    const owned: string[] = [];
    if (recordFile === undefined) problem ??= "record-missing";
    else {
      const text = readSmallText(recordFile, RECORD_BYTES);
      if (text === undefined) problem ??= "record-missing";
      else for (const row of parseRecord(text)) {
        const resolved = resolveRecordPath(root, row.path);
        if (resolved !== undefined && index.has(resolved)) owned.push(resolved);
      }
    }
    out.push({ distInfo, root, name, version, owned, fromTags: tags, pythonTag: pythonFromTags(tags), problem });
  }
  return out;
}

const toInput = (path: string, data: Uint8Array): PackageFileInput => ({
  path,
  size: data.length,
  head: data.subarray(0, 64),
  read: (offset, length) => data.subarray(Math.min(offset, data.length), Math.min(offset + length, data.length)),
});

const isSdistFor = (filename: string, name: string, version: string): boolean => {
  const lower = filename.toLowerCase();
  const prefixes = new Set([normalizeProjectName(name), normalizeProjectName(name).replace(/-/g, "_"), name.toLowerCase()]);
  for (const prefix of prefixes) {
    for (const ext of [".tar.gz", ".zip", ".tar.bz2", ".tar.xz"]) if (lower === `${prefix}-${version.toLowerCase()}${ext}`) return true;
  }
  return false;
};

const buildNumber = (build: string | undefined): number => (build === undefined ? -1 : Number.parseInt(build, 10));

/** Where a wheel member lands in a `pip install -t` folder (the `.data` layout of PEP 427). Undefined: the member is not installed. */
function destination(member: string): string | undefined {
  const m = /^[^/]+\.data\/([^/]+)\/(.+)$/u.exec(member);
  if (m === null) return member.includes(".data/") && /^[^/]+\.data\//u.test(member) ? undefined : member;
  switch (m[1]) {
    case "purelib": case "platlib": case "data": return m[2]!;
    case "scripts": return `bin/${m[2]!}`;
    default: return undefined;
  }
}

class Refusal extends Error {
  constructor(readonly status: SwapStatus, readonly detail: string) { super(detail); }
}

interface Chosen { readonly file: IndexFile; readonly fit: WheelFit }

function chooseWheel(listing: readonly IndexFile[], dist: Distribution, target: SwapTarget): Chosen {
  const matching = listing.filter((file) => {
    const parsed = parseWheelFilename(file.filename);
    return parsed !== undefined && normalizeProjectName(parsed.name) === normalizeProjectName(dist.name) && normalizeVersion(parsed.version) === normalizeVersion(dist.version);
  });
  if (matching.length === 0) {
    if (listing.some((file) => isSdistFor(file.filename, dist.name, dist.version))) throw new Refusal("source-only", "sdist-only");
    throw new Refusal("no-arm64-wheel", listing.length === 0 ? "project-not-on-index" : "version-not-on-index");
  }
  let best: (Chosen & { build: number }) | undefined;
  for (const file of matching) {
    const parsed = parseWheelFilename(file.filename)!;
    const fit = wheelFit(parsed, target);
    if (fit === undefined) continue;
    const build = buildNumber(parsed.build);
    if (best === undefined) { best = { file, fit, build }; continue; }
    const byFit = compareFit(fit, best.fit);
    const better = byFit !== 0 ? byFit > 0 : file.yanked !== best.file.yanked ? !file.yanked : build > best.build;
    if (better) best = { file, fit, build };
  }
  if (best === undefined) throw new Refusal("no-arm64-wheel", "no-compatible-tag");
  return best;
}

interface Verified { readonly adds: { path: string; data: Uint8Array; executable: boolean }[] }

function verifyAndExtract(bytes: Uint8Array, dist: Distribution): Verified {
  let entries: ZipEntry[];
  try { entries = openZip(bytes); } catch (error) { throw new Refusal("unsafe", error instanceof ZipError ? `zip-${error.code}` : "zip-unreadable"); }
  const infoDirs = new Set<string>();
  for (const entry of entries) {
    const m = /^([^/]+\.dist-info)\//u.exec(entry.name);
    if (m !== null) infoDirs.add(m[1]!);
    if (entry.symlink) throw new Refusal("unsafe", "wheel-symlink");
  }
  if (infoDirs.size !== 1) throw new Refusal("unsafe", "wheel-dist-info-count");
  const info = [...infoDirs][0]!;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const metadata = byName.get(`${info}/METADATA`);
  const record = byName.get(`${info}/RECORD`);
  if (metadata === undefined || record === undefined) throw new Refusal("unsafe", "wheel-metadata-missing");
  const headers = parseMetadataHeaders(new TextDecoder().decode(metadata.read().subarray(0, META_BYTES)));
  if (normalizeProjectName(headers.get("name") ?? "") !== normalizeProjectName(dist.name) || normalizeVersion(headers.get("version") ?? "") !== normalizeVersion(dist.version)) throw new Refusal("unsafe", "wheel-metadata-mismatch");
  if (record.size > RECORD_BYTES) throw new Refusal("unsafe", "wheel-record-too-large");
  const rows = parseRecord(new TextDecoder().decode(record.read()));
  const listed = new Set<string>();
  for (const row of rows) {
    listed.add(row.path);
    const entry = byName.get(row.path);
    if (row.hash === "") continue;
    const m = /^sha256=([A-Za-z0-9_-]+)$/u.exec(row.hash);
    if (entry === undefined) throw new Refusal("unsafe", "record-lists-missing-file");
    if (m === null) throw new Refusal("hash-mismatch", "record-hash-algorithm");
    const digest = createHash("sha256").update(entry.read()).digest("base64url");
    if (digest !== m[1]) throw new Refusal("hash-mismatch", "record");
  }
  const adds: Verified["adds"] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const dest = destination(entry.name);
    if (dest === undefined) continue;
    if (seen.has(dest)) throw new Refusal("unsafe", "wheel-duplicate-destination");
    seen.add(dest);
    adds.push({ path: dest, data: entry.read(), executable: (entry.mode & 0o111) !== 0 });
  }
  return { adds };
}

/**
 * Plans and performs the swap, in memory. `files` is the package (or layer) as the classifier sees it; the result holds the edits, the new file list, a report per
 * distribution that had x86_64 code, and the classification before and after.
 */
export async function swapToArm64(files: readonly PackageFileInput[], index: WheelIndex, options: SwapOptions = {}): Promise<SwapResult> {
  const byPath = new Map<string, PackageFileInput>();
  for (const file of files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  const before = classifyNative(files);
  const dists = inventory(files, byPath);

  const ownerCount = new Map<string, number>();
  for (const dist of dists) for (const path of new Set(dist.owned)) ownerCount.set(path, (ownerCount.get(path) ?? 0) + 1);
  const ownedAnywhere = new Set(ownerCount.keys());

  const sharedPython = options.python ?? dists.map((dist) => dist.pythonTag).find((tag) => tag !== undefined);
  const reports: PackageSwapReport[] = [];
  const remove = new Set<string>();
  const added = new Map<string, AddedFile>();
  let addedBytes = 0;
  const listings = new Map<string, readonly IndexFile[]>();
  const maxPackages = options.maxPackages ?? 200;
  const maxWheel = options.maxWheelBytes ?? 300 * 1024 * 1024;
  const maxAdded = options.maxTotalAddedBytes ?? 512 * 1024 * 1024;
  let swappedCount = 0;

  for (const dist of dists) {
    const prefix = `${dist.distInfo}/`;
    const ownedFiles = [...new Set([...dist.owned, ...files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path)])];
    const classes = classifyNative(ownedFiles.map((path) => byPath.get(path)!));
    const x86 = classes.counts.x86_64 > 0 || classes.wheels.some((wheel) => wheel.platforms.includes("x86_64"));
    if (!x86) continue;

    const report = (status: SwapStatus, detail: string, extra: Partial<PackageSwapReport> = {}): void => {
      reports.push({
        name: dist.name, version: dist.version, distInfo: displayPath(dist.distInfo), status, fallback: status === "swapped" ? "none" : "qemu", detail,
        fromTags: dist.fromTags, removed: 0, added: 0, yanked: false, pureFallback: false, ...extra,
      });
    };

    try {
      if (dist.problem !== undefined) throw new Refusal("unplannable", dist.problem);
      if (swappedCount >= maxPackages) throw new Refusal("unplannable", "too-many-packages");
      const python = sharedPython;
      if (python === undefined) throw new Refusal("unplannable", "python-version-unknown");
      const target: SwapTarget = { python, glibc: options.glibc ?? lambdaGlibc(python.minor) };
      const dropped = ownedFiles;
      for (const path of dist.owned) if ((ownerCount.get(path) ?? 0) > 1) throw new Refusal("unplannable", "shared-files");

      const key = normalizeProjectName(dist.name);
      let listing = listings.get(key);
      if (listing === undefined) {
        try { listing = await index.listFiles(dist.name); } catch (error) { throw new Refusal("index-error", error instanceof WheelIndexError ? error.code : "unavailable"); }
        listings.set(key, listing);
      }
      const chosen = chooseWheel(listing, dist, target);
      if (chosen.file.sha256 === undefined) throw new Refusal("unsafe", "index-hash-missing");
      let bytes: Uint8Array;
      try { bytes = await index.download(chosen.file, maxWheel); } catch (error) { throw new Refusal("index-error", error instanceof WheelIndexError ? error.code : "unavailable"); }
      if (bytes.length > maxWheel) throw new Refusal("index-error", "too-large");
      if (sha256Hex(bytes) !== chosen.file.sha256) throw new Refusal("hash-mismatch", "index");
      const verified = verifyAndExtract(bytes, dist);

      const droppedSet = new Set(dropped);
      const adds: AddedFile[] = [];
      let total = 0;
      for (const add of verified.adds) {
        const path = joinPath(dist.root, add.path);
        if ((byPath.has(path) && !droppedSet.has(path)) || (added.has(path) && !droppedSet.has(path))) throw new Refusal("unsafe", "would-overwrite");
        total += add.data.length;
        adds.push({ path, data: add.data, executable: add.executable });
      }
      if (addedBytes + total > maxAdded) throw new Refusal("unsafe", "too-large");
      const check = classifyNative(adds.map((add) => toInput(add.path, add.data)));
      const pure = chosen.fit.pure;
      if (!(check.arch === "arm64" || (pure && check.arch === "none"))) throw new Refusal("verify-failed", "not-arm64-after-swap");

      for (const path of dropped) remove.add(path);
      for (const add of adds) added.set(add.path, add);
      addedBytes += total;
      swappedCount += 1;
      report("swapped", pure ? "pure-python-fallback" : "arm64-wheel", { wheel: displayPath(chosen.file.filename), removed: dropped.length, added: adds.length, yanked: chosen.file.yanked, pureFallback: pure });
    } catch (error) {
      if (error instanceof Refusal) report(error.status, error.detail);
      else throw error;
    }
  }

  // Native code no distribution owns cannot be swapped: it stays, and the classifier below reports it.
  const unowned: { path: string; kind: string }[] = [];
  for (const file of files) {
    if (ownedAnywhere.has(file.path) || /(?:^|\/)[^/]+\.dist-info\//u.test(file.path)) continue;
    const head = headOf(file);
    if (head === undefined) continue;
    const result = inspectHeader(head, /\.(?:so(?:\.\d+)*|node|dylib|dll|exe|pyd)$/iu.test(file.path));
    if ((result.kind === "elf" && result.info.arch !== "arm64") || result.kind === "malformed-elf" || result.kind === "foreign") {
      if (unowned.length < 100) unowned.push({ path: displayPath(file.path), kind: result.kind === "elf" ? result.info.arch : result.kind });
    }
  }

  const newFiles: PackageFileInput[] = files.filter((file) => !remove.has(file.path));
  for (const add of added.values()) newFiles.push(toInput(add.path, add.data));
  const after = classifyNative(newFiles);
  const fullyArm64 = after.complete && (after.arch === "arm64" || after.arch === "none");
  return {
    reports, unowned,
    edits: { remove: [...remove].filter((path) => !added.has(path)).sort(), add: [...added.values()] },
    files: newFiles, before, after, fullyArm64, needsQemu: !fullyArm64,
  };
}
