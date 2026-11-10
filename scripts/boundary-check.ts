// Cloud's side of the public/private boundary (convergence lane W0-4, owner decisions 71 and 72). Cloud consumes a pinned copy of Rovara Code
// (vendor/rovara-code), so nothing may leak either way: Code's copy must be exactly what was pinned, Code must not hold Cloud, and nothing Cloud-only
// may be published. The Code side is scripts/port-guard.ts in the public repository, which reads the same data file as this check
// (scripts/boundary-allowlist.json, kept byte-identical in both repositories). Four checks, each printed with its problems:
//
//   vendor-pin          vendor/rovara-code is the pinned public Code, byte for byte. W0-1 owns the pin (vendor/rovara-code/PIN) and its verifier
//                       (scripts/vendor/verify-rovara-code.ts); this check runs that verifier offline and reports its answer, so there is one definition of
//                       "matches the pin". A missing PIN, or a missing verifier, fails once vendor/rovara-code exists. Skipped while the folder does not exist.
//   vendor-clean        nothing in the vendored copy imports a Cloud-only package or sits in a nested vendor/ folder (Code never imports Cloud). W0-1's
//                       generated shims (vendor/rovara-code-shims, which re-export Code's packages) and the vendor/node_modules links are Cloud's own layer: the
//                       shims are not read as Code, and every link must point into vendor/rovara-code and never at a Cloud-only package.
//   published-packages  Cloud-only packages (the data's names and patterns, and the web, UI and audit-verifier directories) are private with no publish config;
//                       no workspace package is publishable unless the data lists it; the only npm publish in a workflow is the packed CLI tarball, from
//                       a job that runs only in the public repository; and what the published CLI bundles reaches no Cloud-only package, except the
//                       one the public repository's own CLI does not have (a ratchet: GRANDFATHERED_PUBLISH_CLOSURE).
//   aws-allow-list      the data names exactly the four generic AWS adapters (DynamoDB, SQS, S3, Secrets Manager: decision 72, O2); the vendored copy of the data
//                       file is identical to ours; and the public adapters package (if it exists here or in the vendored copy) holds only those four, and
//                       imports no AWS client for any other service. Every other AWS adapter lives in a cloud-* package.
//
// Exit status: 0 no problem (a skipped check is not a problem), 1 problems, 2 the check could not run. Node runs this file directly; it imports Node's own
// modules and `yaml` (a workspace dependency, present in CI after `npm ci`).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import YAML from "yaml";

export interface Problem { where: string; message: string }
export interface CheckResult {
  check: "vendor-pin" | "vendor-clean" | "published-packages" | "aws-allow-list";
  /** "skipped" when there was nothing to check (the vendor folder does not exist yet). */
  status: "ok" | "failed" | "skipped";
  note?: string;
  problems: Problem[];
}

export class CheckError extends Error {}

export const BOUNDARY_FILE = "scripts/boundary-allowlist.json";
export const VENDOR_DIR = "vendor/rovara-code";
/** W0-1's pin file and its offline verifier (the interface this check codes against: exit 0 when the copy matches, else 1 with the problems on stderr). */
export const PIN_FILE = "vendor/rovara-code/PIN";
export const VERIFY_SCRIPT = "scripts/vendor/verify-rovara-code.ts";
/** W0-1's generated layer: shims that re-export Code's packages, and the links Code's own imports resolve through. */
export const SHIMS_DIR = "vendor/rovara-code-shims";
export const LINKS_DIR = "vendor/node_modules";
/** A job that publishes must run only in the public repository (the Cloud repository's CI is off, and its copy rovaracli/rovara is not this name). */
export const PUBLIC_REPO_GUARD = "github.repository == 'PrepLabsAI/Rovara'";
/** The four generic adapters the owners made public (decision 72, O2). A different list needs both owners, not just a data edit. */
export const EXPECTED_PUBLIC_ADAPTERS: readonly string[] = ["dynamodb", "s3", "secrets-manager", "sqs"];
/**
 * Cloud-only packages that the published CLI's workspace package reaches in THIS repository, each with why it is allowed. Cloud's CLI carries the
 * Cloud flavour; the npm publish job is gated to the public repository, whose own CLI does not have these dependencies. A new entry needs the
 * controller's eyes, and an entry that stops being true must be removed (the check fails on a stale one).
 */
export const GRANDFATHERED_PUBLISH_CLOSURE: Readonly<Record<string, string>> = {
  "@preplabsai/rovara-code -> @rovara/audit-verifier": "the Cloud CLI's audit export; publish runs only from the public repository (PUBLIC_REPO_GUARD), whose CLI has no such dependency",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The shared data.

export interface BoundaryData {
  cloudOnlyPackages: string[];
  cloudOnlyPackagePatterns: string[];
  publicAwsAdapters: { package: string; dir: string; adapters: Array<{ id: string; port: string; sdk: string[] }> };
  awsSdkPublicPaths: string[];
  publicNpmPackages: Array<{ name: string; source: string }>;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseBoundary(text: string, from: string): BoundaryData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CheckError(`${from} is not valid JSON`);
  }
  const data = raw as Partial<BoundaryData> | null;
  const adapters = data?.publicAwsAdapters;
  const ok =
    data !== null && typeof data === "object" &&
    isStrings(data.cloudOnlyPackages) && isStrings(data.cloudOnlyPackagePatterns) && isStrings(data.awsSdkPublicPaths) &&
    Array.isArray(data.publicNpmPackages) &&
    data.publicNpmPackages.every((entry) => typeof entry?.name === "string" && typeof entry?.source === "string") &&
    adapters !== undefined && typeof adapters.package === "string" && typeof adapters.dir === "string" && Array.isArray(adapters.adapters) &&
    adapters.adapters.every((a) => typeof a?.id === "string" && typeof a.port === "string" && isStrings(a.sdk));
  if (!ok) throw new CheckError(`${from} does not have the shape both guards read (cloudOnlyPackages, cloudOnlyPackagePatterns, publicAwsAdapters, awsSdkPublicPaths, publicNpmPackages)`);
  for (const pattern of data.cloudOnlyPackagePatterns!) {
    try {
      new RegExp(pattern);
    } catch {
      throw new CheckError(`${from} holds a package pattern that is not a regular expression`);
    }
  }
  return data as BoundaryData;
}

export function readBoundary(root: string): BoundaryData {
  const path = join(root, BOUNDARY_FILE);
  if (!existsSync(path)) throw new CheckError(`${BOUNDARY_FILE} is missing; both guards read it`);
  return parseBoundary(readFileSync(path, "utf8"), BOUNDARY_FILE);
}

/** The Cloud-only package a name is, by the data's names and patterns. */
export function isCloudOnlyName(data: BoundaryData, name: string): boolean {
  return data.cloudOnlyPackages.includes(name) || data.cloudOnlyPackagePatterns.some((pattern) => new RegExp(pattern, "i").test(name));
}

/** A Cloud-only package directory, whatever its name says (the web app, its UI, the audit verifier, any cloud-*). */
const CLOUD_ONLY_DIR = /^(?:vendor\/rovara-code\/)?packages\/(?:ui|web|audit-verifier|cloud-[^/]+)$/i;

// ---------------------------------------------------------------------------------------------------------------------------------
// Files.

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface Walked { files: string[]; symlinks: string[] }

/** Every file under `dir` (posix paths relative to it), without node_modules and .git; symlinks are listed apart and never followed. */
export function walk(dir: string): Walked {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path);
      } else files.push(path);
    }
  };
  visit("");
  return { files: files.sort(), symlinks: symlinks.sort() };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Check 1: vendor/rovara-code equals its pin (W0-1's verifier decides).

/** The vendored copy's files (without W0-1's PIN file) with their bytes, and any symlinks in it. */
export function readVendor(root: string): { entries: Map<string, Buffer>; symlinks: string[] } {
  const base = join(root, VENDOR_DIR);
  const { files, symlinks } = walk(base);
  const entries = new Map<string, Buffer>();
  for (const file of files) {
    if (`${VENDOR_DIR}/${file}` === PIN_FILE) continue;
    entries.set(file, readFileSync(join(base, file)));
  }
  return { entries, symlinks };
}

export function checkVendorPin(root: string): CheckResult {
  const result: CheckResult = { check: "vendor-pin", status: "ok", problems: [] };
  if (!existsSync(join(root, VENDOR_DIR))) {
    return { ...result, status: "skipped", note: `${VENDOR_DIR} does not exist yet (lane W0-1 builds it); nothing to compare with a pin` };
  }
  if (!existsSync(join(root, PIN_FILE))) {
    result.problems.push({ where: PIN_FILE, message: "the vendored copy has no PIN file; a copy with no pin cannot be checked" });
  }
  if (!existsSync(join(root, VERIFY_SCRIPT))) {
    result.problems.push({ where: VERIFY_SCRIPT, message: "the vendor verifier is missing, so the copy cannot be compared with its pin" });
  }
  if (result.problems.length > 0) return { ...result, status: "failed" };
  // The verifier finds the repository from its working directory; offline (no --remote), so this check needs no network. CI's own step adds --remote.
  const run = spawnSync(process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.error !== undefined) throw new CheckError(`could not run ${VERIFY_SCRIPT}: ${run.error.message}`);
  if (run.status !== 0) {
    const detail = (run.stderr ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (detail.length === 0) detail.push(`the verifier exited ${String(run.status)} with no message`);
    for (const line of detail) result.problems.push({ where: VENDOR_DIR, message: line });
  }
  return { ...result, status: result.problems.length === 0 ? "ok" : "failed" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Imports.

const SPECIFIER = /\bfrom\s*(['"`])([^'"`\n$]+)\1|\bimport\s*\(\s*(['"`])([^'"`\n$]+)\3|\brequire(?:\.resolve)?\s*\(\s*(['"`])([^'"`\n$]+)\5|(?:^|[\s;{}])import\s+(['"`])([^'"`\n$]+)\7/g;
const CODE = /\.[cm]?[jt]sx?$/i;

export function specifiers(source: string): Array<{ specifier: string; line: number }> {
  const out: Array<{ specifier: string; line: number }> = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? match[4] ?? match[6] ?? match[8];
    if (specifier === undefined) continue;
    out.push({ specifier, line: source.slice(0, match.index + match[0].lastIndexOf(specifier)).split("\n").length });
  }
  return out;
}

const packageBase = (specifier: string): string => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? ""));

// ---------------------------------------------------------------------------------------------------------------------------------
// Check 2: the vendored copy holds no Cloud.

export function checkVendorClean(root: string): CheckResult {
  const result: CheckResult = { check: "vendor-clean", status: "ok", problems: [] };
  if (!existsSync(join(root, VENDOR_DIR))) return { ...result, status: "skipped", note: `${VENDOR_DIR} does not exist yet (lane W0-1 builds it)` };
  const data = readBoundary(root);
  const { entries } = readVendor(root);
  for (const [path, bytes] of entries) {
    const where = `${VENDOR_DIR}/${path}`;
    if (path.split("/").includes("vendor")) result.problems.push({ where, message: "a vendor/ folder inside the vendored copy (Code holds none)" });
    if (/^packages\/(?:ui|web|audit-verifier|cloud-[^/]+)(\/|$)/i.test(path)) result.problems.push({ where, message: "a Cloud-only package inside the vendored copy of Code" });
    if (!CODE.test(path)) continue;
    for (const { specifier, line } of specifiers(bytes.toString("utf8"))) {
      if (!specifier.startsWith(".") && isCloudOnlyName(data, packageBase(specifier))) {
        result.problems.push({ where: `${where}:${line}`, message: `Code imports a Cloud-only package (${packageBase(specifier)}); Code never imports Cloud` });
      }
    }
  }
  result.problems.push(...vendorLinkProblems(root));
  return { ...result, status: result.problems.length === 0 ? "ok" : "failed" };
}

/**
 * The links W0-1 commits under vendor/node_modules (so Code's own `@agentx/*` imports reach Code's packages) are Cloud's layer, not Code: each must
 * point inside vendor/rovara-code, and not at a Cloud-only package. A link anywhere else could pull Cloud code into what Code's files resolve.
 */
export function vendorLinkProblems(root: string): Problem[] {
  const problems: Problem[] = [];
  const base = join(root, LINKS_DIR);
  if (!existsSync(base)) return problems;
  const vendorRoot = join(root, VENDOR_DIR);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const where = `${LINKS_DIR}/${full.slice(base.length + 1)}`;
      if (entry.isSymbolicLink()) {
        const target = resolve(dir, readlinkSync(full));
        const relative = target.startsWith(`${root}${sep}`) ? target.slice(root.length + 1).split(sep).join("/") : target;
        if (target === vendorRoot || target.startsWith(`${vendorRoot}${sep}`)) {
          if (CLOUD_ONLY_DIR.test(relative)) problems.push({ where, message: "a link that points at a Cloud-only package" });
        } else if (!relative.split("/").includes("node_modules")) {
          // Outside the copy only another installed npm package may be linked (W0-1's THIRD_PARTY_LINKS, Code's own dependency pins).
          problems.push({ where, message: `a link that points outside ${VENDOR_DIR} and is not an installed npm package (${relative})` });
        }
      } else if (entry.isDirectory()) visit(full);
    }
  };
  visit(base);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Check 3: nothing Cloud-only is published.

interface Manifest {
  name?: string;
  private?: boolean;
  publishConfig?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The workspace package folders: the root's `workspaces` (a folder, or `folder/*`). */
export function workspaceDirs(root: string): string[] {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) throw new CheckError("there is no package.json at the root");
  const globs = ((JSON.parse(readFileSync(manifestPath, "utf8")) as { workspaces?: unknown }).workspaces ?? []) as string[];
  const dirs: string[] = [];
  // Only Cloud's own workspaces: the vendored copy is not an npm workspace (its package names repeat Cloud's), and W0-1's shims are listed in `workspaces`.
  for (const prefix of [""]) {
    for (const glob of globs) {
      const pattern = `${prefix}${glob}`;
      if (pattern.endsWith("/*")) {
        const parent = pattern.slice(0, -2);
        if (!existsSync(join(root, parent))) continue;
        for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) dirs.push(`${parent}/${entry.name}`);
        }
      } else if (existsSync(join(root, pattern, "package.json"))) dirs.push(pattern);
    }
  }
  return dirs.sort();
}

interface WorkflowJob { if?: string; steps?: Array<{ run?: string }> }

/** A publish command at the start of a command (a line, or after `;`, `&&`, `||`, `|`, then, do, else), so that an echo or a comment that names one is not read as one. */
const COMMAND_START = "(?:^|[;&|]\\s*|\\b(?:then|do|else)\\s+)";
const PUBLISH_COMMAND = new RegExp(`${COMMAND_START}(?:(?:npm|pnpm|yarn)\\s+(?:publish|release)|(?:npx\\s+)?changeset\\s+publish|lerna\\s+publish|npx\\s+(?:semantic-release|release-it))\\b`);

/** Problems in the workflows: any publish must be the packed CLI tarball, from a job that runs only in the public repository. */
export function workflowPublishProblems(file: string, text: string): Problem[] {
  const problems: Problem[] = [];
  let parsed: { jobs?: Record<string, WorkflowJob> };
  try {
    parsed = YAML.parse(text) as { jobs?: Record<string, WorkflowJob> };
  } catch {
    return [{ where: file, message: "the workflow is not valid YAML, so what it publishes cannot be read" }];
  }
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    const runs = (job.steps ?? []).map((step) => step.run ?? "");
    const publishing = runs.filter((run) => run.split("\n").some((row) => !row.trim().startsWith("#") && PUBLISH_COMMAND.test(row.trim())));
    if (publishing.length === 0) continue;
    const where = `${file} job ${jobName}`;
    const guard = String(job.if ?? "");
    if (!(guard === PUBLIC_REPO_GUARD || guard.startsWith(`${PUBLIC_REPO_GUARD} `))) {
      problems.push({ where, message: `a job that publishes must run only in the public repository (its "if" must start with ${PUBLIC_REPO_GUARD})` });
    }
    for (const run of publishing) {
      for (const line of run.split("\n").filter((row) => !row.trim().startsWith("#") && PUBLISH_COMMAND.test(row.trim()))) {
        const npmPublish = new RegExp(`${COMMAND_START}npm\\s+publish\\b`).test(line.trim());
        if (!npmPublish) problems.push({ where, message: `publishes with something other than "npm publish" of the packed CLI (${line.trim().split(/\s+/).slice(0, 2).join(" ")})` });
        else if (/\s(?:-w|--workspaces?)(?:\s|=|$)/.test(line)) problems.push({ where, message: "npm publish of workspace packages would publish Cloud-only ones" });
        else if (!/\.tgz\b/.test(line)) problems.push({ where, message: "npm publish must name the tarball that release:pack-cli builds, not a folder" });
      }
      if (!runs.some((r) => r.includes("release:pack-cli"))) problems.push({ where, message: "npm publish without release:pack-cli in the same job (the only package that may be published is the packed CLI)" });
    }
  }
  return problems;
}

export function checkPublishedPackages(root: string): CheckResult {
  const result: CheckResult = { check: "published-packages", status: "ok", problems: [] };
  const data = readBoundary(root);
  const publicNames = new Set(data.publicNpmPackages.map((entry) => entry.name));
  const byName = new Map<string, { dir: string; manifest: Manifest }>();
  const manifests: Array<{ dir: string; manifest: Manifest }> = [];
  for (const dir of workspaceDirs(root)) {
    const file = `${dir}/package.json`;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, file), "utf8")) as Manifest;
    } catch {
      result.problems.push({ where: file, message: "not valid JSON" });
      continue;
    }
    manifests.push({ dir, manifest });
    if (manifest.name !== undefined) byName.set(manifest.name, { dir, manifest });
  }
  for (const { dir, manifest } of manifests) {
    const file = `${dir}/package.json`;
    const name = manifest.name ?? "";
    const cloudOnly = isCloudOnlyName(data, name) || CLOUD_ONLY_DIR.test(dir);
    if (cloudOnly) {
      if (manifest.private !== true) result.problems.push({ where: file, message: `${name || dir} is Cloud-only and must have "private": true so npm refuses to publish it` });
      if (manifest.publishConfig !== undefined) result.problems.push({ where: file, message: `${name || dir} is Cloud-only and must have no publishConfig` });
    } else if (manifest.private !== true && !publicNames.has(name)) {
      result.problems.push({ where: file, message: `${name || dir} is publishable but the boundary data does not list it as public; mark it private, or list it (both owners)` });
    }
  }
  const workflows = join(root, ".github/workflows");
  if (existsSync(workflows)) {
    for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
      result.problems.push(...workflowPublishProblems(`.github/workflows/${file}`, readFileSync(join(workflows, file), "utf8")));
    }
  }
  // What the published CLI reaches through workspace dependencies. Cloud-only packages are reached only through the grandfathered, public-repo-gated route.
  const reached = new Set<string>();
  for (const published of data.publicNpmPackages) {
    const start = [...byName.values()].find((entry) => entry.dir === published.source);
    if (start === undefined) continue;
    const seen = new Set<string>();
    const queue = [start.manifest.name ?? ""];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = byName.get(name);
      if (entry === undefined) continue;
      const deps = { ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies, ...entry.manifest.peerDependencies };
      for (const dep of Object.keys(deps)) {
        if (isCloudOnlyName(data, dep) || (byName.has(dep) && CLOUD_ONLY_DIR.test(byName.get(dep)!.dir))) reached.add(`${published.name} -> ${dep}`);
        else if (byName.has(dep)) queue.push(dep);
      }
    }
  }
  for (const edge of [...reached].sort()) {
    if (!(edge in GRANDFATHERED_PUBLISH_CLOSURE)) result.problems.push({ where: "published packages", message: `the published package reaches a Cloud-only package (${edge}); remove the dependency, or its publish would carry Cloud` });
  }
  for (const edge of Object.keys(GRANDFATHERED_PUBLISH_CLOSURE)) {
    if (!reached.has(edge)) result.problems.push({ where: "published packages", message: `GRANDFATHERED_PUBLISH_CLOSURE lists "${edge}" but nothing reaches it any more; remove the entry` });
  }
  return { ...result, status: result.problems.length === 0 ? "ok" : "failed" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Check 4: the four generic AWS adapters are the only public AWS code.

/** Problems in a public adapters package at `dir` (a path relative to the root): only the four adapters, and no client for any other service. */
export function adaptersPackageProblems(root: string, dir: string, data: BoundaryData): Problem[] {
  const problems: Problem[] = [];
  const base = join(root, dir);
  if (!existsSync(base) || !lstatSync(base).isDirectory()) return problems;
  const allowedIds = new Set(data.publicAwsAdapters.adapters.map((adapter) => adapter.id));
  const allowedSdk = new Set(data.publicAwsAdapters.adapters.flatMap((adapter) => adapter.sdk));
  const { files, symlinks } = walk(base);
  for (const link of symlinks) problems.push({ where: `${dir}/${link}`, message: "a symlink in the public adapters package" });
  for (const file of files) {
    const where = `${dir}/${file}`;
    if (file.toLowerCase().startsWith("src/")) {
      const stem = (file.slice(4).split("/")[0] ?? "").split(".")[0]!.toLowerCase();
      if (stem !== "index" && !allowedIds.has(stem)) {
        problems.push({ where, message: "a private adapter inside the public AWS adapters package (only DynamoDB, SQS, S3 and Secrets Manager may be public; others belong in a cloud-* package)" });
      }
    }
    if (!CODE.test(file)) continue;
    for (const { specifier, line } of specifiers(readFileSync(join(base, file), "utf8"))) {
      const pkg = packageBase(specifier);
      if (/^@aws-sdk\/(client|lib)-/.test(pkg) && !allowedSdk.has(pkg)) {
        problems.push({ where: `${where}:${line}`, message: `the public adapters package imports ${pkg}, an AWS service that is not one of the four public adapters` });
      } else if (pkg === "aws-cdk-lib" || pkg.startsWith("@aws-cdk/") || pkg === "constructs") {
        problems.push({ where: `${where}:${line}`, message: "the public adapters package imports the AWS CDK (Cloud's infrastructure code)" });
      } else if (!specifier.startsWith(".") && isCloudOnlyName(data, pkg)) {
        problems.push({ where: `${where}:${line}`, message: `the public adapters package imports a Cloud-only package (${pkg})` });
      }
    }
  }
  return problems;
}

export function checkAwsAllowList(root: string): CheckResult {
  const result: CheckResult = { check: "aws-allow-list", status: "ok", problems: [] };
  const data = readBoundary(root);
  const ids = data.publicAwsAdapters.adapters.map((adapter) => adapter.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_PUBLIC_ADAPTERS)) {
    result.problems.push({ where: BOUNDARY_FILE, message: `the public AWS adapters must be exactly ${EXPECTED_PUBLIC_ADAPTERS.join(", ")} (decision 72, O2); the data names ${ids.join(", ") || "none"}. Changing the list needs both owners` });
  }
  const vendored = join(root, VENDOR_DIR, BOUNDARY_FILE);
  if (existsSync(vendored)) {
    if (!readFileSync(vendored).equals(readFileSync(join(root, BOUNDARY_FILE)))) {
      result.problems.push({ where: BOUNDARY_FILE, message: `differs from the copy in ${VENDOR_DIR}; the two guards must read the same data (copy Code's file, never edit one side)` });
    }
  } else if (existsSync(join(root, VENDOR_DIR))) {
    result.note = `${VENDOR_DIR} holds no ${BOUNDARY_FILE}, so the two copies of the data were not compared`;
  }
  for (const dir of [data.publicAwsAdapters.dir, `${VENDOR_DIR}/${data.publicAwsAdapters.dir}`]) {
    result.problems.push(...adaptersPackageProblems(root, dir, data));
  }
  return { ...result, status: result.problems.length === 0 ? "ok" : "failed" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Command line.

export function runAll(root: string): CheckResult[] {
  return [checkVendorPin(root), checkVendorClean(root), checkPublishedPackages(root), checkAwsAllowList(root)];
}

export function formatResult(result: CheckResult): string[] {
  const lines = [`boundary-check: ${result.check}: ${result.status}${result.note === undefined ? "" : ` (${result.note})`}`];
  for (const problem of result.problems) lines.push(`  ${problem.where}  ${problem.message}`);
  return lines;
}

export function main(argv: readonly string[]): number {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("boundary-check: --root needs a folder");
        return 2;
      }
      root = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/boundary-check.ts [--root <repository>]");
      return 0;
    } else {
      console.error(`boundary-check: unknown argument ${arg}`);
      return 2;
    }
  }
  try {
    const results = runAll(root);
    for (const result of results) for (const line of formatResult(result)) (result.problems.length > 0 ? console.error : console.log)(line);
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length > 0) {
      console.error(`boundary-check: ${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed.map((r) => r.check).join(", ")}`);
      return 1;
    }
    console.log("boundary-check: clean.");
    return 0;
  } catch (error) {
    console.error(`boundary-check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1]?.endsWith("boundary-check.ts")) process.exitCode = main(process.argv.slice(2));
