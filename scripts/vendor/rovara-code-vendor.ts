// The pinned copy of public Rovara Code inside Cloud (convergence plan W0-1, owner decision 72 O1): what it holds, how it is hashed,
// how its `@rovara-code/*` workspace shims are generated, and how it is checked against the public repository.
// Shared by update-rovara-code.ts and verify-rovara-code.ts and by tests/contract/vendor-rovara-code*.test.ts.
// Node runs this file directly, so only erasable syntax (no enums, no parameter properties) and `.ts` import suffixes.
//
// Layout (all under vendor/, see vendor/README.md):
//   vendor/rovara-code/                    Code's files at the pinned sha, byte for byte, plus the one extra file PIN. Never edited by hand.
//   vendor/node_modules/@agentx/<pkg>      committed relative symlinks to vendor/rovara-code/packages/<pkg>, so Code's own `@agentx/*` imports resolve to Code, not to Cloud's packages of the same name.
//   vendor/rovara-code-shims/<pkg>/        generated npm workspace packages named `@rovara-code/<pkg>` that re-export Code's built files by relative path (every subpath of its `exports` map).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { posix } from "node:path";

export const PUBLIC_REPO_URL = "https://github.com/PrepLabsAI/Rovara.git";
/** The public branch a pin normally comes from. A pin is an exact sha; the branch name is only the default for `update`. */
export const DEFAULT_REF = "code/next";

/** Where the vendored files live, relative to the repository root. */
export const CODE_DIR = "vendor/rovara-code";
export const SHIMS_DIR = "vendor/rovara-code-shims";
export const PIN_FILE = `${CODE_DIR}/PIN`;
export const SHIM_SCOPE = "@rovara-code";
export const CODE_SCOPE = "@agentx";
/**
 * The npm scopes Code's packages are published under. Most are `@agentx/<folder>`; packages Code added after the rename to Rovara (aws-adapters) are `@rovara/<folder>`.
 * A vendored package must be named `<one of these>/<its folder>`, and vendor/node_modules links it under that name, so Code's imports of it reach the copy.
 */
export const CODE_SCOPES: readonly string[] = [CODE_SCOPE, "@rovara"];

/** The npm name of a vendored package folder, read from its package.json: `@agentx/<folder>` or `@rovara/<folder>`, else an error. */
export function vendoredPackageName(root: string, folder: string): string {
  const manifestPath = join(root, CODE_DIR, "packages", folder, "package.json");
  const name = (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }).name;
  if (name === undefined || !CODE_SCOPES.some((scope) => name === `${scope}/${folder}`)) throw new Error(`${manifestPath} is named ${name ?? "(nothing)"}, expected ${CODE_SCOPES.map((scope) => `${scope}/${folder}`).join(" or ")}`);
  return name;
}

/** True for a bare package name in one of Code's scopes (which Cloud may also publish under, so it must resolve to a vendored link). */
export function inCodeScope(pkg: string): boolean {
  return CODE_SCOPES.some((scope) => pkg.startsWith(`${scope}/`));
}

/**
 * Code's paths that are copied, as git paths in the public repository. Packages the plan has Cloud consume (the AWS adapters, contracts, the broker with
 * its core and ports, gateway, local-adapters, model-runtime, verifier, worker) plus the files the copy needs to build and to be read.
 * Code's tests live outside packages/ and are not copied, except `tests/support/ports` (wave 0 lane W0-5): the port conformance suites Cloud's adapters must pass
 * (tests/conformance/, docs/architecture/cloud-adapter-conformance.md). Their relative imports (`../../../packages/...`) reach the vendored packages unchanged.
 */
export const INCLUDE: readonly string[] = [
  "LICENSE",
  "LICENSE-APACHE",
  "RELICENSED.md",
  "docs/ports.md",
  "packages/aws-adapters",
  "packages/broker",
  "packages/contracts",
  "packages/gateway",
  "packages/local-adapters",
  "packages/model-runtime",
  "packages/verifier",
  "packages/worker",
  "tests/support/ports",
  "tsconfig.base.json",
];

/**
 * Code's broker holds the core (core/<module>/) and the in-memory ports (ports/) but its package.json exports only "." and a few more, so Cloud code could
 * not import them by name. The shim of such a package also re-exports each of these folders that has an index.ts, from the built files by relative path
 * (a path the package's `exports` map does not guard), as `@rovara-code/<pkg>/<folder>`. The proper fix is an upstream barrel and exports entry in Code
 * (core modules without an index.ts have no shim; branch-sync, ci-fix, decisions and proof today).
 */
export const DEEP_FOLDERS: Readonly<Record<string, readonly string[]>> = { broker: ["core/*", "ports"] };

/** Vendored packages that get a `@rovara-code/<name>` shim. The worker has no `exports` map (it runs as a process), so it has none. */
export const SHIMMED_PACKAGES: readonly string[] = ["aws-adapters", "broker", "contracts", "gateway", "local-adapters", "model-runtime", "verifier"];

/**
 * Build output that `tsc -b` writes inside the vendored packages, and nothing else: `packages/<pkg>/dist`, `packages/<pkg>/node_modules` and
 * `packages/<pkg>/tsconfig.tsbuildinfo`. They are git-ignored and are not part of the copy. A file of the same name anywhere else (src/dist/x.js,
 * src/x.tsbuildinfo, a nested node_modules) is a vendored file like any other and must match the public tree.
 */
const BUILD_DIRS: ReadonlySet<string> = new Set(["dist", "node_modules"]);
const BUILD_FILE = "tsconfig.tsbuildinfo";
const isPackageTop = (rel: string): boolean => /^packages\/[^/]+$/.test(rel);

export interface Layout {
  /** The Cloud repository root. */
  root: string;
  include: readonly string[];
  repoUrl: string;
  /** Packages that get a shim. Default SHIMMED_PACKAGES; the tests use a small fixture. */
  shimmed?: readonly string[];
  /** Undeclared imports the import check tolerates, per package. Default UNDECLARED_IMPORTS in verify-rovara-code.ts. */
  undeclaredImports?: Readonly<Record<string, readonly string[]>>;
  /** Default THIRD_PARTY_LINKS. */
  thirdPartyLinks?: Readonly<Record<string, string>>;
}

export function defaultLayout(root: string): Layout {
  // No environment override: the public repository is the only source, and verify refuses a PIN that names anything else.
  return { root, include: INCLUDE, repoUrl: PUBLIC_REPO_URL };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The tree manifest: one line per file, "<git mode> <git blob id> <path>", sorted by path. The local side computes the blob id the way
// `git hash-object` does and the public side reads it from `git ls-tree -r`, so the two are the same bytes if the hashes are equal.

export interface ManifestEntry { mode: string; oid: string; path: string }

export function blobId(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function manifestText(entries: readonly ManifestEntry[]): string {
  return [...entries].sort((a, b) => compareBytes(a.path, b.path)).map((e) => `${e.mode} ${e.oid} ${e.path}\n`).join("");
}

export function manifestDigest(entries: readonly ManifestEntry[]): string {
  return createHash("sha256").update(manifestText(entries)).digest("hex");
}

/** The entries of a directory that holds a copy: every file except build output, with git's mode (100644, 100755 or 120000 for a link). Anything else is an error. */
export function localManifest(dir: string, skipTop: ReadonlySet<string> = new Set()): { entries: ManifestEntry[]; problems: string[] } {
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const relPath = rel === "" ? name : `${rel}/${name}`;
      if (rel === "" && skipTop.has(name)) continue;
      const path = join(abs, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (BUILD_DIRS.has(name) && isPackageTop(rel)) continue;
        walk(path, relPath);
      } else if (name === BUILD_FILE && isPackageTop(rel) && stat.isFile()) {
        continue;
      } else if (stat.isSymbolicLink()) {
        entries.push({ mode: "120000", oid: blobId(Buffer.from(readlinkSync(path))), path: relPath });
      } else if (stat.isFile()) {
        entries.push({ mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644", oid: blobId(readFileSync(path)), path: relPath });
      } else {
        problems.push(`${relPath} is not a regular file or a link`);
      }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  else problems.push(`${dir} does not exist`);
  return { entries, problems };
}

/** The entries of `git ls-tree -r -z <sha> -- <include>` run in a repository that has the tree. */
export function remoteManifest(gitDir: string, sha: string, include: readonly string[]): ManifestEntry[] {
  const out = git(gitDir, ["ls-tree", "-r", "-z", sha, "--", ...include]);
  const entries: ManifestEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(record);
    if (match === null) throw new Error(`unexpected ls-tree record: ${JSON.stringify(record.slice(0, 80))}`);
    if (match[2] !== "blob") throw new Error(`${match[4]} is a ${match[2]} (a submodule?) in the public tree; the copy cannot hold it`);
    entries.push({ mode: match[1]!, oid: match[3]!, path: match[4]! });
  }
  return entries;
}

export interface ManifestDiff { missing: string[]; extra: string[]; changed: string[] }

/** What differs between the expected files and the files found. */
export function diffManifests(expected: readonly ManifestEntry[], actual: readonly ManifestEntry[]): ManifestDiff {
  const want = new Map(expected.map((e) => [e.path, e]));
  const have = new Map(actual.map((e) => [e.path, e]));
  const diff: ManifestDiff = { missing: [], extra: [], changed: [] };
  for (const [path, e] of want) {
    const a = have.get(path);
    if (a === undefined) diff.missing.push(path);
    else if (a.oid !== e.oid || a.mode !== e.mode) diff.changed.push(path);
  }
  for (const path of have.keys()) if (!want.has(path)) diff.extra.push(path);
  return diff;
}

export function describeDiff(diff: ManifestDiff, limit = 10): string[] {
  const lines: string[] = [];
  for (const [label, paths] of [["missing from the copy", diff.missing], ["not in the public tree", diff.extra], ["differs from the public tree", diff.changed]] as const) {
    if (paths.length === 0) continue;
    lines.push(`${paths.length} file(s) ${label}: ${paths.slice(0, limit).join(", ")}${paths.length > limit ? ", ..." : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PIN

export interface Pin { repo: string; sha: string; branch: string; include: string[]; files: number; manifestSha256: string }

export function formatPin(pin: Pin): string {
  return [
    "# The pinned copy of public Rovara Code in this folder. Written by scripts/vendor/update-rovara-code.ts; do not edit by hand.",
    "# Check it: node scripts/vendor/verify-rovara-code.ts [--remote]. Refresh it: node scripts/vendor/update-rovara-code.ts <sha>.",
    `repo=${pin.repo}`,
    `sha=${pin.sha}`,
    `branch=${pin.branch}`,
    `include=${pin.include.join(",")}`,
    `files=${pin.files}`,
    `manifest-sha256=${pin.manifestSha256}`,
    "",
  ].join("\n");
}

export function parsePin(text: string): { pin?: Pin; problems: string[] } {
  const problems: string[] = [];
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) { problems.push(`PIN line is not key=value: ${JSON.stringify(line.slice(0, 60))}`); continue; }
    const key = line.slice(0, eq);
    if (fields.has(key)) problems.push(`PIN repeats ${key}`);
    fields.set(key, line.slice(eq + 1));
  }
  const get = (key: string): string => fields.get(key) ?? "";
  if (!/^[0-9a-f]{40}$/.test(get("sha"))) problems.push("PIN sha must be a full 40-character lowercase hex sha");
  if (!/^[0-9a-f]{64}$/.test(get("manifest-sha256"))) problems.push("PIN manifest-sha256 must be 64 lowercase hex characters");
  if (!/^\d+$/.test(get("files"))) problems.push("PIN files must be a number");
  if (get("repo") === "") problems.push("PIN has no repo");
  if (get("include") === "") problems.push("PIN has no include list");
  if (problems.length > 0) return { problems };
  return {
    pin: { repo: get("repo"), sha: get("sha"), branch: get("branch"), include: get("include").split(","), files: Number(get("files")), manifestSha256: get("manifest-sha256") },
    problems,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// git

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
}

export interface Fetched { gitDir: string; cleanup(): void }

/** Fetches the tree of one sha (no history) into a throwaway bare repository. With `blobs: false` only trees are fetched, which is all a check needs. */
export function fetchSha(repoUrl: string, sha: string, options: { blobs: boolean }): Fetched {
  const gitDir = mkdtempSync(join(tmpdir(), "rovara-code-fetch-"));
  const cleanup = (): void => rmSync(gitDir, { recursive: true, force: true });
  try {
    git(gitDir, ["init", "-q", "--bare"]);
    git(gitDir, ["fetch", "-q", "--depth", "1", ...(options.blobs ? [] : ["--filter=blob:none"]), repoUrl, sha]);
    git(gitDir, ["cat-file", "-e", `${sha}^{tree}`]);
    return { gitDir, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(`could not fetch ${sha} from ${repoUrl}: ${firstLine(error)}`, { cause: error });
  }
}

/** A branch name or a sha to a full sha, through `git ls-remote`. */
export function resolveRef(repoUrl: string, ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (/^[0-9a-f]{4,39}$/.test(ref)) throw new Error("give the full 40-character sha: a short sha cannot be fetched");
  const lines = git(process.cwd(), ["ls-remote", repoUrl, `refs/heads/${ref}`]).split("\n").filter((line) => line !== "");
  const sha = lines.length === 1 ? lines[0]!.split("\t")[0] : undefined;
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repoUrl} has no branch ${ref}`);
  return sha;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? ((error as { stderr?: unknown }).stderr?.toString() || error.message) : String(error);
  return text.trim().split("\n")[0] ?? "";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The shims and the links

export interface PlannedFile { path: string; content: string }

interface ExportsMap { [subpath: string]: string | { types?: string; default?: string } }

/** The subpaths a vendored package exports ("." and "./catalog"), read from its package.json. */
export function exportedSubpaths(packageJson: { exports?: unknown }): string[] {
  const exp = packageJson.exports as ExportsMap | string | undefined;
  if (exp === undefined) return [];
  if (typeof exp === "string") return ["."];
  return Object.keys(exp).filter((key) => key === "." || key.startsWith("./"));
}

/** The files of every shim package, as paths relative to SHIMS_DIR. Pure: reads only the vendored package.json files under `root`. */
export function planShims(root: string, packages: readonly string[] = SHIMMED_PACKAGES): PlannedFile[] {
  const files: PlannedFile[] = [];
  for (const name of packages) {
    const manifestPath = join(root, CODE_DIR, "packages", name, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string; exports?: unknown };
    const target = vendoredPackageName(root, name);
    const subpaths = exportedSubpaths(manifest);
    if (subpaths.length === 0) throw new Error(`${target} has no exports map, so it cannot be shimmed`);
    const exportsOut: Record<string, { types: string; default: string }> = {};
    for (const subpath of subpaths) {
      const base = subpath === "." ? "index" : subpath.slice(2);
      if (!/^[a-z0-9][a-z0-9/-]*$/.test(base)) throw new Error(`${target} exports ${subpath}, which the shim generator does not handle`);
      const built = builtFile(manifest.exports, subpath);
      if (built === undefined || !/^\.\/dist\/[A-Za-z0-9/._-]+\.js$/.test(built) || built.includes("..")) throw new Error(`${target} exports ${subpath} to ${String(built)}, which is not a built .js file under dist/`);
      // A relative path into the vendored folder, not the bare `@agentx/<pkg>`: a shim copied somewhere else (into a plain node_modules, an image, a tarball) fails to load instead
      // of quietly resolving `@agentx/<pkg>` to Cloud's package of the same name.
      const specifier = relativeSpecifier(`${name}/${base}.js`, `../rovara-code/packages/${name}/${built.slice(2)}`);
      const header = `// Generated by scripts/vendor/update-rovara-code.ts: do not edit. Re-exports ${target}${subpath === "." ? "" : subpath.slice(1)} from the built files of the pinned copy of Rovara Code (vendor/rovara-code), by relative path.\n`;
      files.push({ path: `${name}/${base}.js`, content: `${header}export * from "${specifier}";\n` });
      files.push({ path: `${name}/${base}.d.ts`, content: `${header}export * from "${specifier}";\n` });
      exportsOut[subpath] = { types: `./${base}.d.ts`, default: `./${base}.js` };
    }
    for (const folder of deepFolders(root, name)) {
      const specifier = relativeSpecifier(`${name}/${folder}.js`, `../rovara-code/packages/${name}/dist/${folder}/index.js`);
      const header = `// Generated by scripts/vendor/update-rovara-code.ts: do not edit. Re-exports ${target}'s ${folder}/ from the built files of the pinned copy of Rovara Code (vendor/rovara-code).\n`;
      files.push({ path: `${name}/${folder}.js`, content: `${header}export * from "${specifier}";\n` });
      files.push({ path: `${name}/${folder}.d.ts`, content: `${header}export * from "${specifier}";\n` });
      exportsOut[`./${folder}`] = { types: `./${folder}.d.ts`, default: `./${folder}.js` };
    }
    const pkg = {
      name: `${SHIM_SCOPE}/${name}`,
      version: manifest.version ?? "0.1.0",
      private: true,
      type: "module",
      description: `Generated by scripts/vendor/update-rovara-code.ts. Re-exports ${target} from the pinned copy of Rovara Code in vendor/rovara-code.`,
      exports: exportsOut,
      types: "./index.d.ts",
    };
    files.push({ path: `${name}/package.json`, content: `${JSON.stringify(pkg, null, 2)}\n` });
  }
  return files;
}

/**
 * Third-party packages whose version Code pins differently from Cloud's root node_modules. Code's files resolve them from vendor/node_modules before
 * Cloud's root, so a committed link there points at the copy of the exact version Code asks for. The target is relative to the link's own folder.
 * The dependency check in verify-rovara-code.ts fails when a link's target is missing or at another version, and when any other Code dependency
 * resolves to another version.
 */
export const THIRD_PARTY_LINKS: Readonly<Record<string, string>> = {
  // Code's verifier wants playwright-core 1.63.0 (the version @e2e-dev/web uses); Cloud's root has 1.64.0 for its browser tests.
  "playwright-core": "../../node_modules/@e2e-dev/web/node_modules/playwright-core",
};

export interface Link { name: string; target: string }

/** The built .js file a package's `exports` map gives for a subpath ("." or "./catalog"): a string, or the `default` (else `import`) of a conditions object. */
function builtFile(exp: unknown, subpath: string): string | undefined {
  const entry = typeof exp === "string" ? exp : (exp as ExportsMap | undefined)?.[subpath];
  if (typeof entry === "string") return entry;
  return entry?.default;
}

/** The import specifier from one generated file to another path, both relative to SHIMS_DIR. */
function relativeSpecifier(fromFile: string, toPath: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The folders of a vendored package's src/ that DEEP_FOLDERS names and that have an index.ts, as "core/cost" and "ports". */
function deepFolders(root: string, name: string): string[] {
  const src = join(root, CODE_DIR, "packages", name, "src");
  const found: string[] = [];
  for (const pattern of DEEP_FOLDERS[name] ?? []) {
    const folders = pattern.endsWith("/*") ? readdirSync(join(src, pattern.slice(0, -2))).sort().map((d) => `${pattern.slice(0, -2)}/${d}`) : [pattern];
    for (const folder of folders) if (existsSync(join(src, folder, "index.ts"))) found.push(folder);
  }
  return found;
}

/** The links under vendor/node_modules: `@agentx/<pkg>` (or `@rovara/<pkg>`, its package.json name) for every vendored package (a relative symlink to the package folder), then THIRD_PARTY_LINKS. */
export function planLinks(root: string, thirdPartyLinks: Readonly<Record<string, string>> = THIRD_PARTY_LINKS): Link[] {
  const dir = join(root, CODE_DIR, "packages");
  const own = readdirSync(dir).filter((name) => existsSync(join(dir, name, "package.json"))).sort().map((name) => ({ name: vendoredPackageName(root, name), target: `../../rovara-code/packages/${name}` }));
  const third = Object.entries(thirdPartyLinks).map(([name, target]) => ({ name, target }));
  return [...own, ...third].sort((a, b) => compareBytes(a.name, b.name));
}

export function writePlanned(root: string, baseDir: string, files: readonly PlannedFile[]): void {
  rmSync(join(root, baseDir), { recursive: true, force: true });
  for (const file of files) {
    const path = join(root, baseDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

export function writeLinks(root: string, links: readonly Link[]): void {
  rmSync(join(root, "vendor/node_modules"), { recursive: true, force: true });
  for (const link of links) {
    const path = join(root, "vendor/node_modules", link.name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(link.target, path);
  }
}

/** What the shim folder holds on disk now, as the same planned-file list (so it can be compared with planShims). */
export function readPlanned(root: string, baseDir: string): PlannedFile[] {
  const files: PlannedFile[] = [];
  const walk = (abs: string): void => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const path = join(abs, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else files.push({ path: relative(join(root, baseDir), path).split("\\").join("/"), content: readFileSync(path, "utf8") });
    }
  };
  walk(join(root, baseDir));
  return files;
}

export function readLinks(root: string): Link[] {
  const found: Link[] = [];
  const walk = (abs: string, rel: string): void => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const path = join(abs, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) found.push({ name: relPath, target: readlinkSync(path) });
      else if (stat.isDirectory()) walk(path, relPath);
      else found.push({ name: relPath, target: "(not a link)" });
    }
  };
  walk(join(root, "vendor/node_modules"), "");
  return found.sort((a, b) => compareBytes(a.name, b.name));
}
