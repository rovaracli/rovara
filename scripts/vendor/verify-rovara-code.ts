// Checks that vendor/rovara-code is the pinned public Rovara Code, byte for byte (convergence plan W0-1, owner decision 72 O1).
//   offline (always): the folder's files hash to the manifest recorded in vendor/rovara-code/PIN; the generated shims and links are current.
//   --remote: also fetches the tree of the pinned sha from the public repository and compares it with `git ls-tree -r` of that sha, file by file.
// Exit 0 when everything matches, 1 otherwise. Node runs this file directly, so only erasable syntax.
//   node scripts/vendor/verify-rovara-code.ts [--remote]
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_DIR, CODE_SCOPE, DEFAULT_REF, PIN_FILE, SHIMS_DIR, defaultLayout, describeDiff, diffManifests, fetchSha, git, localManifest, manifestDigest, parsePin,
  planLinks, planShims, readLinks, readPlanned, remoteManifest, type Layout,
} from "./rovara-code-vendor.ts";

/**
 * Every third-party dependency Code's packages declare must resolve, from where the vendored files sit, to the exact version Code declares: Code's
 * files are compiled and run against Cloud's installed packages, so a drift would silently change what Code's code runs on. Needs node_modules installed
 * (a checkout before `npm ci` has nothing to resolve, so it reports nothing).
 */
export function checkDependencies(layout: Layout): string[] {
  const problems: string[] = [];
  if (!existsSync(join(layout.root, "node_modules"))) return problems;
  const packagesDir = join(layout.root, CODE_DIR, "packages");
  for (const name of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
    const lookup = [join(packagesDir, name, "node_modules"), join(packagesDir, "node_modules"), join(layout.root, CODE_DIR, "node_modules"), join(layout.root, "vendor/node_modules"), join(layout.root, "node_modules")];
    for (const [dep, wanted] of Object.entries(manifest.dependencies ?? {})) {
      if (dep.startsWith(`${CODE_SCOPE}/`) || wanted.startsWith("file:")) continue;
      const found = lookup.map((dir) => join(dir, dep, "package.json")).find((path) => existsSync(path));
      const have = found === undefined ? undefined : (JSON.parse(readFileSync(found, "utf8")) as { version?: string }).version;
      if (have !== wanted) problems.push(`Code's ${name} wants ${dep}@${wanted} but it resolves to ${have ?? "nothing"} from vendor/ (see THIRD_PARTY_LINKS in scripts/vendor/rovara-code-vendor.ts)`);
    }
  }
  return problems;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_SPECIFIER = /\b(?:import|export)\s[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']|(?<![\w"'`.-])import\s*["']([^"'\n]+)["']|\bimport\(\s*["']([^"'\n]+)["']\s*\)|(?<![.\w])require\(\s*["']([^"'\n]+)["']\s*\)/g;
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Imports Code's source makes without declaring them in the importing package's package.json (found by this check at the pin 1c3880cbe). They resolve from Cloud's root
 * node_modules by hoisting, which works today because Cloud installs the same versions. Upstream owed: Code declares them, then this list shrinks to nothing.
 * Anything not listed here and not declared fails.
 */
export const UNDECLARED_IMPORTS: Readonly<Record<string, readonly string[]>> = { broker: ["typescript"], verifier: ["zod"] };

/** The package a bare import specifier names: `@scope/name` or `name`, without a subpath. Undefined for a relative, absolute or node: specifier. */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Code's source may import only the vendored `@agentx/*` packages (the ones vendor/node_modules links) and the third-party packages its own package.json declares.
 * An `@agentx/<name>` that Cloud also publishes but vendor/ does not link (orchestrator, mcp, ...) would resolve to Cloud's package without a word, and an undeclared
 * package would resolve by hoisting luck. Build output (dist, node_modules) is not scanned.
 */
export function checkImports(layout: Layout): string[] {
  const problems: string[] = [];
  const packagesDir = join(layout.root, CODE_DIR, "packages");
  if (!existsSync(packagesDir)) return problems;
  const linked = new Set(planLinks(layout.root, layout.thirdPartyLinks).map((link) => link.name).filter((name) => name.startsWith(`${CODE_SCOPE}/`)));
  for (const name of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string> | undefined>;
    const declared = new Set([...["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => Object.keys(manifest[key] ?? {})), ...(layout.undeclaredImports ?? UNDECLARED_IMPORTS)[name] ?? []]);
    const bad = new Map<string, Set<string>>();
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
          if (rel === "" && (entry === "dist" || entry === "node_modules")) continue;
          walk(path, rel === "" ? entry : `${rel}/${entry}`);
        } else if (stat.isFile() && SOURCE_FILE.test(entry)) {
          const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
          for (const match of text.matchAll(IMPORT_SPECIFIER)) {
            const pkg = packageOfSpecifier(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
            if (pkg === undefined) continue;
            const ok = pkg.startsWith(`${CODE_SCOPE}/`) ? linked.has(pkg) : declared.has(pkg);
            if (!ok) (bad.get(pkg) ?? bad.set(pkg, new Set()).get(pkg)!).add(`${rel === "" ? "" : `${rel}/`}${entry}`);
          }
        }
      }
    };
    walk(join(packagesDir, name), "");
    for (const [pkg, files] of bad) {
      const why = pkg.startsWith(`${CODE_SCOPE}/`) ? "is not one of the vendored packages that vendor/node_modules links, so it would resolve to Cloud's package of that name" : "is not a dependency Code's package.json declares";
      problems.push(`Code's ${name} imports ${pkg} (${[...files].slice(0, 3).join(", ")}${files.size > 3 ? ", ..." : ""}), which ${why}`);
    }
  }
  return problems;
}

const BUILD_OUTPUT_PATH = /^vendor\/rovara-code\/packages\/[^/]+\/(?:(?:dist|node_modules)(?:\/|$)|tsconfig\.tsbuildinfo$)/;

/**
 * The offline hash skips the build output `tsc -b` writes (packages/<pkg>/dist, node_modules, tsconfig.tsbuildinfo), so a force-added file there would hash clean
 * while `tsc -b` keeps it and the shims load it. Git must not track any path there. Reads the index, so it also holds in CI's fresh checkout. Skipped when the
 * root is not a git work tree (a tarball, a test fixture).
 */
export function trackedBuildOutput(layout: Layout): string[] {
  let listed: string;
  try {
    listed = git(layout.root, ["ls-files", "-z", "--", CODE_DIR]);
  } catch {
    return [];
  }
  return listed.split("\0").filter((path) => BUILD_OUTPUT_PATH.test(path));
}

/**
 * The pinned sha must be on `code/next`, not only a commit the public repository happens to serve (GitHub serves a fork's pull request commits by sha too, and the tree check above only proves the copy equals
 * that sha's tree). `status` is what GitHub's compare answers for `<sha>...code/next`: `identical` or `ahead` mean the sha is `code/next` or an ancestor of it.
 */
export function ancestryProblem(sha: string, status: string | undefined): string | undefined {
  if (status === "identical" || status === "ahead") return undefined;
  return status === undefined ? `could not ask GitHub whether ${sha} is on code/next` : `the pinned sha ${sha} is not an ancestor of ${DEFAULT_REF} (GitHub says ${status}): pin a commit of code/next`;
}

/** Asks GitHub (the public repository's compare endpoint, with the token when the environment has one) for the status of `<sha>...code/next`. */
function compareStatus(repoUrl: string, sha: string): string | undefined {
  const slug = /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/u.exec(repoUrl)?.[1];
  if (slug === undefined) return undefined;
  const token = process.env["GITHUB_TOKEN"];
  const run = spawnSync("curl", ["-fsS", "--max-time", "30", "-H", "Accept: application/vnd.github+json", ...(token === undefined || token === "" ? [] : ["-H", `Authorization: Bearer ${token}`]), `https://api.github.com/repos/${slug}/compare/${sha}...${DEFAULT_REF}`], { encoding: "utf8" });
  if (run.status !== 0) return undefined;
  try { const status = (JSON.parse(run.stdout) as { status?: unknown }).status; return typeof status === "string" ? status : undefined; } catch { return undefined; }
}

export interface VerifyResult { ok: boolean; problems: string[]; sha?: string }

export function verifyRovaraCode(layout: Layout, options: { remote?: boolean } = {}): VerifyResult {
  const problems: string[] = [];
  const pinPath = join(layout.root, PIN_FILE);
  if (!existsSync(pinPath)) return { ok: false, problems: [`${PIN_FILE} is missing`] };
  const parsed = parsePin(readFileSync(pinPath, "utf8"));
  if (parsed.pin === undefined) return { ok: false, problems: parsed.problems };
  const pin = parsed.pin;
  const sha = pin.sha;
  // The repository and the include list are the scripts' own constants, never whatever PIN says: otherwise a change that edits the vendored files and PIN together
  // (PIN naming another repository, or a shorter include list) would verify against itself.
  if (pin.repo !== layout.repoUrl) problems.push(`PIN names the repository ${pin.repo}, but the copy may only come from ${layout.repoUrl}`);
  if (JSON.stringify(pin.include) !== JSON.stringify(layout.include)) problems.push("PIN's include list is not the one in scripts/vendor/rovara-code-vendor.ts (INCLUDE)");

  const local = localManifest(join(layout.root, CODE_DIR), new Set(["PIN"]));
  problems.push(...local.problems);
  if (local.entries.length !== pin.files) problems.push(`the copy has ${local.entries.length} files, PIN says ${pin.files}`);
  if (manifestDigest(local.entries) !== pin.manifestSha256) problems.push("the copy's files do not hash to the manifest in PIN (a vendored file was edited, added or removed)");

  if (options.remote === true) {
    // Only where the repository is on GitHub (the public one is; a fixture repository on disk has no code/next to ask about).
    if (/github\.com\//u.test(layout.repoUrl)) {
      const ancestry = ancestryProblem(sha, compareStatus(layout.repoUrl, sha));
      if (ancestry !== undefined) problems.push(ancestry);
    }
    try {
      const fetched = fetchSha(layout.repoUrl, sha, { blobs: false });
      try {
        const expected = remoteManifest(fetched.gitDir, sha, layout.include);
        const diff = diffManifests(expected, local.entries);
        problems.push(...describeDiff(diff));
        if (manifestDigest(expected) !== pin.manifestSha256) problems.push(`the public tree of ${sha} does not hash to the manifest in PIN`);
      } finally {
        fetched.cleanup();
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  const tracked = trackedBuildOutput(layout);
  if (tracked.length > 0) problems.push(`git tracks build output inside the copy, which tsc -b would keep and the shims would load: ${tracked.slice(0, 5).join(", ")}${tracked.length > 5 ? ", ..." : ""} (git rm --cached them)`);

  // The generated layer is Cloud's own, so it is compared with what the generator would write now.
  if (local.problems.length === 0 && existsSync(join(layout.root, CODE_DIR, "packages"))) {
    const planned = planShims(layout.root, layout.shimmed);
    const onDisk = new Map(readPlanned(layout.root, SHIMS_DIR).map((f) => [f.path, f.content]));
    for (const file of planned) if (onDisk.get(file.path) !== file.content) problems.push(`${SHIMS_DIR}/${file.path} is missing or stale (run update-rovara-code.ts)`);
    const wanted = new Set(planned.map((f) => f.path));
    for (const path of onDisk.keys()) if (!wanted.has(path)) problems.push(`${SHIMS_DIR}/${path} is not generated (run update-rovara-code.ts)`);
    const links = JSON.stringify(readLinks(layout.root));
    if (links !== JSON.stringify(planLinks(layout.root, layout.thirdPartyLinks))) problems.push("vendor/node_modules/@agentx links are missing or stale (run update-rovara-code.ts)");
  }
  if (local.problems.length === 0) problems.push(...checkImports(layout), ...checkDependencies(layout));
  return { ok: problems.length === 0, problems, sha };
}

if (process.argv[1]?.endsWith("verify-rovara-code.ts")) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const result = verifyRovaraCode(defaultLayout(root), { remote: process.argv.includes("--remote") });
  if (!result.ok) {
    console.error(`vendor/rovara-code does not match its pin:\n  ${result.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/rovara-code matches ${result.sha}${process.argv.includes("--remote") ? " (checked against the public repository)" : " (offline check)"}.`);
}
