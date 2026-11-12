// Slice 4 X1/X2: Python wheel metadata, read as untrusted text. A `*.dist-info/WHEEL` file (tags), `METADATA` (name, version), a wheel's file name (PEP 427) and
// the compatibility of a wheel's tags with a Lambda base image. Pure functions; every input is capped and every parse fails closed (undefined, never a guess).

/** The glibc of the Lambda Python base images. python3.12 and later are Amazon Linux 2023 (glibc 2.34); python3.9 to 3.11 images are Amazon Linux 2 (glibc 2.26), from memory: X5 proves it on a live image. */
export function lambdaGlibc(pythonMinor: number): readonly [number, number] {
  return pythonMinor >= 12 ? [2, 34] : [2, 26];
}

/** PEP 503 normalisation: lower case, runs of `-`, `_` and `.` become one `-`. */
export const normalizeProjectName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** What the project names in a METADATA file or a wheel file name may look like (PEP 508): a letter or digit first, then letters, digits, `.`, `_`, `-`. */
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
export const isProjectName = (name: string): boolean => PROJECT_NAME.test(name);

/** A version as the index and a file name spell it: the characters PEP 440 allows, nothing else. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,63}$/u;
export const isVersionText = (version: string): boolean => VERSION.test(version);

/** Two spellings of one version: case, `-`/`_` and a leading `v` do not matter; a local part (`+cpu`) and every release number do. */
export const normalizeVersion = (version: string): string => version.toLowerCase().replace(/^v/u, "").replace(/[-_]/g, ".");

const MAX_TEXT_LINES = 500;

/** The headers of a METADATA file (RFC 822 style): the first value of each name, lower-cased, up to the first blank line. */
export function parseMetadataHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = text.split("\n", MAX_TEXT_LINES);
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") break;
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
}

export interface WheelFileInfo {
  readonly tags: readonly string[];
  /** `Root-Is-Purelib: true` / `false`; undefined when the file does not say. */
  readonly rootIsPurelib: boolean | undefined;
}

const MAX_TAG_LINES = 256;
const TAG = /^[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+$/u;

/** The `Tag:` lines (each a compressed `python-abi-platform` triple) and `Root-Is-Purelib` of a `*.dist-info/WHEEL` file. Malformed tag lines are dropped. */
export function parseWheelFile(text: string): WheelFileInfo {
  const tags: string[] = [];
  let rootIsPurelib: boolean | undefined;
  for (const raw of text.split("\n", MAX_TEXT_LINES)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "tag" && tags.length < MAX_TAG_LINES && TAG.test(value)) tags.push(value);
    else if (key === "root-is-purelib") rootIsPurelib = value.toLowerCase() === "true" ? true : value.toLowerCase() === "false" ? false : undefined;
  }
  return { tags, rootIsPurelib };
}

export interface WheelTriple { readonly python: string; readonly abi: string; readonly platform: string }

const MAX_TRIPLES = 512;

/** `py2.py3-none-any` and `cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64` expand to one triple per combination (PEP 425 compressed tag sets). Capped, so a hostile tag cannot multiply. */
export function expandTags(compressed: string): WheelTriple[] {
  const parts = compressed.split("-");
  if (parts.length !== 3) return [];
  const [pythons, abis, platforms] = parts.map((part) => part.split(".")) as [string[], string[], string[]];
  const out: WheelTriple[] = [];
  for (const python of pythons) for (const abi of abis) for (const platform of platforms) {
    if (python === "" || abi === "" || platform === "") return [];
    if (out.length >= MAX_TRIPLES) return out;
    out.push({ python, abi, platform });
  }
  return out;
}

export interface WheelFilename {
  readonly name: string;
  readonly version: string;
  readonly build: string | undefined;
  readonly pythonTags: readonly string[];
  readonly abiTags: readonly string[];
  readonly platformTags: readonly string[];
}

/** A wheel's file name, `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl` (PEP 427). Undefined when it is anything else. */
export function parseWheelFilename(filename: string): WheelFilename | undefined {
  if (filename.length > 300 || !filename.endsWith(".whl") || /[/\\\0]/u.test(filename)) return undefined;
  const parts = filename.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return undefined;
  const build = parts.length === 6 ? parts[2] : undefined;
  if (build !== undefined && !/^\d/u.test(build)) return undefined;
  const [name, version] = parts as [string, string];
  const [py, abi, plat] = parts.slice(-3) as [string, string, string];
  if (!isProjectName(name.replace(/_/g, "-")) || !isVersionText(version)) return undefined;
  if (!TAG.test(`${py}-${abi}-${plat}`)) return undefined;
  return { name, version, build, pythonTags: py.split("."), abiTags: abi.split("."), platformTags: plat.split(".") };
}

export type PlatformFamily = "manylinux" | "musllinux" | "linux" | "any" | "other";
export type PlatformArch = "x86_64" | "aarch64" | "i686" | "other";

export interface PlatformInfo {
  readonly family: PlatformFamily;
  readonly arch: PlatformArch;
  /** The glibc a manylinux tag needs. */
  readonly glibc: readonly [number, number] | undefined;
}

const LEGACY_MANYLINUX: Record<string, readonly [number, number]> = { manylinux1: [2, 5], manylinux2010: [2, 12], manylinux2014: [2, 17] };

const archOf = (text: string): PlatformArch => {
  if (text === "x86_64" || text === "amd64") return "x86_64";
  if (text === "aarch64" || text === "arm64") return "aarch64";
  if (text === "i686" || text === "i386") return "i686";
  return "other";
};

/** One platform tag: `manylinux_2_28_aarch64`, `manylinux2014_x86_64`, `musllinux_1_2_x86_64`, `linux_aarch64`, `any`; anything else (macosx, win) is family "other". */
export function parsePlatformTag(tag: string): PlatformInfo {
  if (tag === "any") return { family: "any", arch: "other", glibc: undefined };
  let m = /^(manylinux1|manylinux2010|manylinux2014)_(.+)$/u.exec(tag);
  if (m) return { family: "manylinux", arch: archOf(m[2]!), glibc: LEGACY_MANYLINUX[m[1]!] };
  m = /^manylinux_(\d+)_(\d+)_(.+)$/u.exec(tag);
  if (m) return { family: "manylinux", arch: archOf(m[3]!), glibc: [Number(m[1]), Number(m[2])] };
  if (/^musllinux_\d+_\d+_/u.test(tag)) return { family: "musllinux", arch: archOf(tag.replace(/^musllinux_\d+_\d+_/u, "")), glibc: undefined };
  m = /^linux_(.+)$/u.exec(tag);
  if (m) return { family: "linux", arch: archOf(m[1]!), glibc: undefined };
  return { family: "other", arch: "other", glibc: undefined };
}

/** `cp312` is [3, 12]; `py3` is [3]; `py39` is [3, 9]. Undefined for anything else. */
export function pythonTagVersion(tag: string): { readonly kind: "cp" | "py"; readonly version: readonly number[] } | undefined {
  const m = /^(cp|py)(\d)(\d*)$/u.exec(tag);
  if (!m) return undefined;
  return { kind: m[1] === "cp" ? "cp" : "py", version: m[3] === "" ? [Number(m[2])] : [Number(m[2]), Number(m[3])] };
}

export interface SwapTarget {
  /** The Python of the function runtime: 3.12 is { major: 3, minor: 12 }. */
  readonly python: { readonly major: number; readonly minor: number };
  readonly glibc: readonly [number, number];
}

export interface WheelFit {
  /** Higher is better. Compare with compareFit. */
  readonly score: readonly [number, number, number];
  /** The wheel is a pure-Python one (platform `any`): it works, but it is not the native build the x86 package had. */
  readonly pure: boolean;
}

const geVersion = (a: readonly number[], b: readonly number[]): boolean => (a[0]! !== b[0]! ? a[0]! > b[0]! : (a[1] ?? 0) >= (b[1] ?? 0));

/**
 * Whether a wheel can be installed on the target (aarch64 Linux, the given CPython and glibc) and how well. Best fit scores highest: the exact CPython build
 * (`cp312-cp312`) over a stable-ABI build (`cp39-abi3`, newer first) over a `py3-none` build; then, inside a platform, the newest glibc level the image still meets.
 * A pure-Python wheel fits last. Undefined when no tag triple of the wheel fits.
 */
export function wheelFit(wheel: WheelFilename, target: SwapTarget): WheelFit | undefined {
  let best: WheelFit | undefined;
  for (const python of wheel.pythonTags) for (const abi of wheel.abiTags) for (const platform of wheel.platformTags) {
    const plat = parsePlatformTag(platform);
    const pyTag = pythonTagVersion(python);
    if (pyTag === undefined) continue;
    let pyScore: number;
    let minor = 0;
    if (pyTag.kind === "cp" && abi === `cp${pyTag.version.join("")}`) {
      if (pyTag.version[0] !== target.python.major || pyTag.version[1] !== target.python.minor) continue;
      pyScore = 3;
    } else if (pyTag.kind === "cp" && abi === "abi3") {
      if (!geVersion([target.python.major, target.python.minor], pyTag.version)) continue;
      pyScore = 2;
      minor = pyTag.version[1] ?? 0;
    } else if (pyTag.kind === "py" && abi === "none") {
      if (pyTag.version[0] !== target.python.major || (pyTag.version.length > 1 && !geVersion([target.python.major, target.python.minor], pyTag.version))) continue;
      pyScore = 1;
    } else continue;
    let platScore: number;
    let pure = false;
    if (plat.family === "any") { platScore = 0; pure = true; }
    else if (plat.arch !== "aarch64") continue;
    else if (plat.family === "manylinux") {
      if (plat.glibc === undefined || !geVersion(target.glibc, plat.glibc)) continue;
      platScore = 10 + plat.glibc[0] * 100 + plat.glibc[1];
    } else if (plat.family === "linux") platScore = 5;
    else continue;
    const fit: WheelFit = { score: [pure ? 0 : 1, pyScore * 1000 + minor, platScore], pure };
    if (best === undefined || compareFit(fit, best) > 0) best = fit;
  }
  return best;
}

export function compareFit(a: WheelFit, b: WheelFit): number {
  for (let i = 0; i < 3; i += 1) if (a.score[i]! !== b.score[i]!) return a.score[i]! - b.score[i]!;
  return 0;
}

/** A minimal CSV reader for RECORD files (RFC 4180 quoting). Bounded: at most `maxRows` rows. */
export function parseRecord(text: string, maxRows = 200_000): { readonly path: string; readonly hash: string; readonly size: string }[] {
  const rows: { path: string; hash: string; size: string }[] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const endField = (): void => { row.push(field); field = ""; };
  const endRow = (): void => {
    endField();
    if (row.length >= 1 && row[0] !== "" && rows.length < maxRows) rows.push({ path: row[0]!, hash: row[1] ?? "", size: row[2] ?? "" });
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") field += ch;
    if (rows.length >= maxRows) break;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
