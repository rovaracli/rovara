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
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, posix, sep } from "node:path";
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
/** The scope folders W0-1 links vendored packages under: `@agentx/<pkg>`, and `@rovara/<pkg>` for the packages Code names that way (aws-adapters). */
export const LINK_SCOPES: readonly string[] = ["@agentx", "@rovara"];
/**
 * The only links W0-1 puts under vendor/node_modules besides the `@agentx/<pkg>` ones (its THIRD_PARTY_LINKS): name -> the exact link text. Any other link, or
 * a real file or folder there, is refused. If W0-1 adds one, this list changes with it (the check fails closed until it does).
 */
export const ALLOWED_THIRD_PARTY_LINKS: Readonly<Record<string, string>> = {
  "playwright-core": "../../node_modules/@e2e-dev/web/node_modules/playwright-core",
};
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
  "@preplabsai/rovara-code -> @agentx/design-tokens": "the Cloud broker's server-rendered pages use the design tokens; publish runs only from the public repository (PUBLIC_REPO_GUARD), whose CLI has no such dependency",
  "@preplabsai/rovara-code -> @agentx/cloud-contracts": "the Cloud CLI's own contracts (W0-3: what its deploy, upgrade and bundle commands read of Cloud's contracts, formerly the one @agentx/contracts); publish runs only from the public repository (PUBLIC_REPO_GUARD), whose CLI imports Rovara Code's contracts alone",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The shared data.

export interface BoundaryData {
  cloudOnlyPackages: string[];
  cloudOnlyPackagePatterns: string[];
  publicAwsAdapters: { package: string; dir: string; adapters: Array<{ id: string; port: string; sdk: string[] }> };
  awsSdkPublicPaths: string[];
  /** Keys the Code guard also reads (sanctioned plug-in clients, fixture paths, known history); this check does not use them. */
  awsSdkSanctioned?: unknown;
  awsImportFixturePaths?: unknown;
  knownHistory?: unknown;
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
const CLOUD_ONLY_DIR = /^(?:vendor\/rovara-code\/)?packages\/(?:ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[^/]+)?)$/i;
/** The same, for a path that may go on below the package folder. */
const CLOUD_ONLY_PATH = /^(?:vendor\/rovara-code\/)?packages\/(?:ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[^/]+)?)(\/|$)/i;

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

export function checkVendorPin(root: string, options: { node?: string } = {}): CheckResult {
  const result: CheckResult = { check: "vendor-pin", status: "ok", problems: [] };
  if (!existsSync(join(root, VENDOR_DIR))) return absentVendor(root, result, `${VENDOR_DIR} does not exist yet (lane W0-1 builds it); nothing to compare with a pin`);
  if (!existsSync(join(root, PIN_FILE))) {
    result.problems.push({ where: PIN_FILE, message: "the vendored copy has no PIN file; a copy with no pin cannot be checked" });
  }
  if (!existsSync(join(root, VERIFY_SCRIPT))) {
    result.problems.push({ where: VERIFY_SCRIPT, message: "the vendor verifier is missing, so the copy cannot be compared with its pin" });
  }
  if (result.problems.length > 0) return { ...result, status: "failed" };
  // The verifier finds the repository from its working directory; offline (no --remote), so this check needs no network. CI's own step adds --remote.
  const run = spawnSync(options.node ?? process.execPath, [VERIFY_SCRIPT], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.error !== undefined) throw new CheckError(`could not run ${VERIFY_SCRIPT}: ${run.error.message}`);
  if (run.signal !== null) {
    result.problems.push({ where: VENDOR_DIR, message: `the vendor verifier was stopped by ${run.signal} before it answered, so the copy was not checked` });
  } else if (run.status !== 0) {
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

export function specifiers(source: string): Array<{ specifier: string; line: number; inString: boolean }> {
  const out: Array<{ specifier: string; line: number; inString: boolean }> = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? match[4] ?? match[6] ?? match[8];
    if (specifier === undefined) continue;
    const at = match.index + match[0].lastIndexOf(specifier);
    const before = source.slice(source.lastIndexOf("\n", match.index - 1) + 1, match.index);
    out.push({ specifier, line: source.slice(0, at).split("\n").length, inString: (before.match(/['"`]/g)?.length ?? 0) % 2 === 1 });
  }
  return out;
}

const packageBase = (specifier: string): string => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? ""));

// ---------------------------------------------------------------------------------------------------------------------------------
// Check 2: the vendored copy holds no Cloud.

export function checkVendorClean(root: string): CheckResult {
  const result: CheckResult = { check: "vendor-clean", status: "ok", problems: [] };
  if (!existsSync(join(root, VENDOR_DIR))) return absentVendor(root, result, `${VENDOR_DIR} does not exist yet (lane W0-1 builds it)`);
  const data = readBoundary(root);
  const { entries, symlinks } = readVendor(root);
  // Code holds no symlinks: one inside the copy could point anywhere, and a link chain through it would hide where vendor/node_modules really leads.
  for (const link of symlinks) result.problems.push({ where: `${VENDOR_DIR}/${link}`, message: "a symlink inside the vendored copy (Code holds none; a link can point outside it)" });
  for (const [path, bytes] of entries) {
    const where = `${VENDOR_DIR}/${path}`;
    if (path.split("/").includes("vendor")) result.problems.push({ where, message: "a vendor/ folder inside the vendored copy (Code holds none)" });
    if (/^packages\/(?:ui|web|audit-verifier|model-proxy|design-tokens|cloud(?:-[^/]+)?)(\/|$)/i.test(path)) result.problems.push({ where, message: "a Cloud-only package inside the vendored copy of Code" });
    if (!CODE.test(path)) continue;
    const testFile = /(^|\/)(tests?|__tests__)\//i.test(path) || /\.test\.[cm]?[jt]sx?$/i.test(path);
    for (const { specifier, line, inString } of specifiers(bytes.toString("utf8"))) {
      if (!specifier.startsWith(".") && isCloudOnlyName(data, packageBase(specifier))) {
        result.problems.push({ where: `${where}:${line}`, message: `Code imports a Cloud-only package (${packageBase(specifier)}); Code never imports Cloud` });
      } else if (specifier.startsWith(".") && !inString && !testFile && posix.normalize(posix.join(posix.dirname(path), specifier)).startsWith("..")) {
        // Resolved from where the copy sits, a path that climbs out of it lands in Cloud's own code.
        result.problems.push({ where: `${where}:${line}`, message: "a relative import that leaves the vendored copy (it would reach Cloud's own code)" });
      }
    }
  }
  result.problems.push(...vendorLinkProblems(root));
  return { ...result, status: result.problems.length === 0 ? "ok" : "failed" };
}

/**
 * vendor/node_modules is W0-1's layer, not Code: it holds the scope folders in LINK_SCOPES with one relative link per vendored package, and the links in
 * ALLOWED_THIRD_PARTY_LINKS; nothing else. Each `@agentx/<pkg>` (or `@rovara/<pkg>`) link must resolve (realpath, through any chain) to exactly vendor/rovara-code/packages/<pkg>;
 * a link anywhere else (Cloud's node_modules/@agentx/*, a Cloud package, another link), a real file or folder, or a third-party link with other text, is refused.
 */
export function vendorLinkProblems(root: string): Problem[] {
  const problems: Problem[] = [];
  const base = join(root, LINKS_DIR);
  if (!existsSync(base)) return problems;
  const vendorReal = existsSync(join(root, VENDOR_DIR)) ? realpathSync(join(root, VENDOR_DIR)) : join(root, VENDOR_DIR);
  const rootReal = realpathSync(root);
  const relativeToRoot = (path: string): string => (path.startsWith(`${rootReal}${sep}`) ? path.slice(rootReal.length + 1).split(sep).join("/") : path);
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const where = `${LINKS_DIR}/${entry.name}`;
    if (LINK_SCOPES.includes(entry.name) && entry.isDirectory()) {
      for (const inner of readdirSync(join(base, entry.name), { withFileTypes: true })) {
        const innerWhere = `${where}/${inner.name}`;
        const full = join(base, entry.name, inner.name);
        if (!inner.isSymbolicLink()) {
          problems.push({ where: innerWhere, message: `not a link: only links to vendored packages belong under vendor/node_modules/${entry.name} (a real folder could hold code that is not Code)` });
          continue;
        }
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          problems.push({ where: innerWhere, message: "a link that does not resolve" });
          continue;
        }
        const wanted = join(vendorReal, "packages", inner.name);
        if (real !== wanted) {
          const note = CLOUD_ONLY_PATH.test(relativeToRoot(real)) ? "a Cloud-only package" : relativeToRoot(real);
          problems.push({ where: innerWhere, message: `a link that does not resolve to ${VENDOR_DIR}/packages/${inner.name} (it resolves to ${note})` });
        } else if (readlinkSync(full) !== `../../rovara-code/packages/${inner.name}`) {
          problems.push({ where: innerWhere, message: "a link that reaches the vendored package by a chain or a roundabout path (W0-1 writes one direct relative link)" });
        }
      }
    } else if (entry.isSymbolicLink() && ALLOWED_THIRD_PARTY_LINKS[entry.name] !== undefined) {
      if (readlinkSync(join(base, entry.name)) !== ALLOWED_THIRD_PARTY_LINKS[entry.name]) {
        problems.push({ where, message: "a third-party link whose target is not the one W0-1 records" });
      } else {
        try {
          const real = relativeToRoot(realpathSync(join(base, entry.name)));
          if (CLOUD_ONLY_PATH.test(real)) problems.push({ where, message: "a third-party link that resolves into a Cloud-only package" });
        } catch {
          // not installed here (a checkout before npm ci): the link text is the check
        }
      }
    } else {
      problems.push({ where, message: entry.isSymbolicLink() ? "a link that is not one W0-1 creates (only the vendored @agentx and @rovara packages and its recorded third-party links)" : "a real file or folder under vendor/node_modules (only W0-1's links belong there)" });
    }
  }
  return problems;
}

/** The vendored folder is absent: skipped while W0-1 has not landed, a failure once its verifier is here (deleting the copy must not pass). */
function absentVendor(root: string, result: CheckResult, note: string): CheckResult {
  if (existsSync(join(root, VERIFY_SCRIPT))) {
    return { ...result, status: "failed", problems: [{ where: VENDOR_DIR, message: `${VENDOR_DIR} is missing, but the vendor verifier (${VERIFY_SCRIPT}) is here, so the pinned copy must be too` }] };
  }
  return { ...result, status: "skipped", note };
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

interface WorkflowStep { run?: string; uses?: string }
interface WorkflowJob { if?: unknown; uses?: string; steps?: WorkflowStep[] }

/** A publish by any of the usual tools, wherever it sits on a line (in a `bash -c "..."`, after an `env X=y` prefix, inside `node -e`). `npm pack` is read as one too. */
// The verb may follow flags (`npm -w pkg publish`, `npm --prefix x publish`, `pnpm -r publish`, `pnpm --filter web publish`), so any word `publish` after the tool on a
// command line counts; so does `npx np` (a publisher), and a shell variable standing for the tool (`$NPM publish`).
const PUBLISH_ANYWHERE =
  /\b(?:npm|pnpm|yarn)\b[^\n;&|]*\s(?:publish|release)(?=\s|$)|\$\{?\w+\}?\s+publish\b|\bchangeset\s+publish\b|\blerna\s+publish\b|\bnpx\s+(?:-\S+\s+)*np\b|\b(?:semantic-release|release-it)\b/;
const PACK_ANYWHERE = /\b(?:npm|pnpm|yarn)\b[^\n;&|]*\spack(?=\s|$)/;
const RUN_SCRIPT = /\b(?:npm|pnpm)\s+(?:run|run-script)\s+(?:--\s+)?([^\s;&|]+)|\byarn\s+(?:run\s+)?([a-z][^\s;&|]*)/g;
/** The one publish line allowed: `npm publish <tarball> [--access public] [--provenance] [--tag x]`, nothing before it and no other flag. */
const PUBLISH_SHAPE = /^npm\s+publish\s+(\S+\.tgz)(?:\s+--access\s+public|\s+--provenance|\s+--tag\s+\S+)*$/;

/** The lines of a run block that count, without comments, and without the text inside quotes on an echo or printf line (the real workflow echoes "skipping npm publish"). */
function commandLines(run: string): string[] {
  return run
    .replace(/\\\r?\n\s*/g, " ") // a line that ends in a backslash continues on the next one
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "" && !row.startsWith("#"))
    .map((row) => (/^(?:echo|printf)\b/.test(row) ? row.replace(/"[^"]*"|'[^']*'/g, '""') : row));
}

/** True when a command line publishes: a publish command anywhere, or `npm run <script>` of a script whose name or body publishes. */
function linePublishes(line: string, scripts: Readonly<Record<string, string>>): boolean {
  if (PUBLISH_ANYWHERE.test(line)) return true;
  for (const match of line.matchAll(RUN_SCRIPT)) {
    const name = match[1] ?? match[2] ?? "";
    const body = scripts[name] ?? "";
    if (/publish/i.test(name) || PUBLISH_ANYWHERE.test(body)) return true;
  }
  return false;
}

/** The guard a publishing job must carry: exactly the public-repository test, or that test and more with `&&` (never an `||`, which `|| true` would open). */
function guardHolds(raw: unknown): boolean {
  const guard = (typeof raw === "string" ? raw : "").replace(/^\s*\$\{\{/, "").replace(/\}\}\s*$/, "").trim();
  // No `||` anywhere: `G && x || true` and `G && (a || b)` both run the job outside the public repository.
  if (guard.includes("||")) return false;
  return guard === PUBLIC_REPO_GUARD || guard.startsWith(`${PUBLIC_REPO_GUARD} && `);
}

/** Problems in one workflow: nothing publishes except the packed CLI tarball, from a job that runs only in the public repository. */
export function workflowPublishProblems(file: string, text: string, scripts: Readonly<Record<string, string>> = {}): Problem[] {
  const problems: Problem[] = [];
  let parsed: { jobs?: Record<string, WorkflowJob> };
  try {
    parsed = YAML.parse(text) as { jobs?: Record<string, WorkflowJob> };
  } catch {
    return [{ where: file, message: "the workflow is not valid YAML, so what it publishes cannot be read" }];
  }
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    const where = `${file} job ${jobName}`;
    const steps = job.steps ?? [];
    const lines = steps.flatMap((step) => commandLines(step.run ?? ""));
    const publishLines = lines.filter((line) => linePublishes(line, scripts));
    const actions = [job.uses, ...steps.map((step) => step.uses)].filter((name): name is string => typeof name === "string" && /publish/i.test(name));
    if (publishLines.length === 0 && actions.length === 0) continue;
    if (!guardHolds(job.if)) {
      problems.push({ where, message: `a job that publishes must run only in the public repository (its "if" must be ${PUBLIC_REPO_GUARD}, or start with it followed by &&)` });
    }
    for (const action of actions) problems.push({ where, message: `a publish action (${action}) is not allowed; the only publish is "npm publish" of the packed CLI` });
    const out = /release:pack-cli[^\n]*?--out\s+("[^"]+"|'[^']+'|\S+)/.exec(lines.join("\n"))?.[1]?.replace(/^["']|["']$/g, "");
    if (publishLines.length > 0 && out === undefined) {
      problems.push({ where, message: "a publish without release:pack-cli --out in the same job (the only package that may be published is the packed CLI)" });
    }
    for (const line of publishLines) {
      const shape = PUBLISH_SHAPE.exec(line.replace(/"/g, "").replace(/'/g, ""));
      if (shape === null) {
        problems.push({ where, message: `publishes in a way other than "npm publish <tarball> --access public" on a line of its own (${line.split(/\s+/).slice(0, 3).join(" ")} ...)` });
      } else if (out !== undefined && shape[1]!.slice(0, shape[1]!.lastIndexOf("/")) !== out) {
        problems.push({ where, message: `the tarball published is not one release:pack-cli wrote (it must be in the --out folder ${out})` });
      }
    }
    if (publishLines.length > 0 && lines.some((line) => PACK_ANYWHERE.test(line))) {
      problems.push({ where, message: "npm pack in a job that publishes: the tarball must come from release:pack-cli, not from a package of this repository" });
    }
  }
  return problems;
}

/** A composite action (.github/actions/**) that publishes would be called from jobs this check does not follow: refuse it. */
export function compositeActionProblems(file: string, text: string, scripts: Readonly<Record<string, string>> = {}): Problem[] {
  let parsed: { runs?: { steps?: WorkflowStep[] } };
  try {
    parsed = YAML.parse(text) as { runs?: { steps?: WorkflowStep[] } };
  } catch {
    return [{ where: file, message: "the action file is not valid YAML, so what it runs cannot be read" }];
  }
  const steps = parsed?.runs?.steps ?? [];
  const publishes = steps.some((step) => commandLines(step.run ?? "").some((line) => linePublishes(line, scripts) || PACK_ANYWHERE.test(line)) || (typeof step.uses === "string" && /publish/i.test(step.uses)));
  return publishes ? [{ where: file, message: "a composite action that publishes or packs; publishing belongs in the workflow job that carries the public-repository guard" }] : [];
}

/** The workspace package folder a path inside the repository belongs to, by longest matching folder. */
function owningPackage(dirs: ReadonlyMap<string, string>, path: string): string | undefined {
  let best: string | undefined;
  for (const dir of dirs.keys()) if ((path === dir || path.startsWith(`${dir}/`)) && (best === undefined || dir.length > best.length)) best = dir;
  return best === undefined ? undefined : dirs.get(best);
}

/** The packages one package's source actually imports (what esbuild would follow), from its non-test source files, by package name and by relative path. */
export function importedPackages(root: string, dir: string, dirToName: ReadonlyMap<string, string>): Set<string> {
  const found = new Set<string>();
  const srcDir = join(root, dir, "src");
  if (!existsSync(srcDir)) return found;
  const { files } = walk(srcDir);
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(tests?|__tests__)\//.test(file)) continue;
    const path = `${dir}/src/${file}`;
    for (const { specifier, inString } of specifiers(readFileSync(join(srcDir, file), "utf8"))) {
      if (inString) continue;
      if (specifier.startsWith(".")) {
        const owner = owningPackage(dirToName, posix.normalize(posix.join(posix.dirname(path), specifier)));
        if (owner !== undefined && dirToName.get(dir) !== owner) found.add(owner);
      } else if (!specifier.startsWith("node:")) found.add(packageBase(specifier));
    }
  }
  return found;
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
  const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const workflows = join(root, ".github/workflows");
  if (existsSync(workflows)) {
    for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
      result.problems.push(...workflowPublishProblems(`.github/workflows/${file}`, readFileSync(join(workflows, file), "utf8"), scripts));
    }
  }
  const actions = join(root, ".github/actions");
  if (existsSync(actions)) {
    for (const file of walk(actions).files.filter((name) => /(^|\/)action\.ya?ml$/i.test(name))) {
      result.problems.push(...compositeActionProblems(`.github/actions/${file}`, readFileSync(join(actions, file), "utf8"), scripts));
    }
  }
  // What the published CLI reaches: through its dependencies AND through what its source really imports (esbuild follows imports, so an undeclared one is
  // bundled all the same). Cloud-only packages are reached only through the grandfathered, public-repo-gated route.
  const dirToName = new Map(manifests.filter((entry) => entry.manifest.name !== undefined).map((entry) => [entry.dir, entry.manifest.name!] as const));
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
      const deps = new Set([
        ...Object.keys({ ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies, ...entry.manifest.peerDependencies }),
        ...importedPackages(root, entry.dir, dirToName),
      ]);
      for (const dep of deps) {
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
