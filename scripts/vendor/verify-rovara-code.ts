// Checks that vendor/rovara-code is the pinned public Rovara Code, byte for byte (convergence plan W0-1, owner decision 72 O1).
//   offline (always): the folder's files hash to the manifest recorded in vendor/rovara-code/PIN; the generated shims and links are current.
//   --remote: also fetches the tree of the pinned sha from the public repository and compares it with `git ls-tree -r` of that sha, file by file.
// Exit 0 when everything matches, 1 otherwise. Node runs this file directly, so only erasable syntax.
//   node scripts/vendor/verify-rovara-code.ts [--remote]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_DIR, CODE_SCOPE, PIN_FILE, SHIMS_DIR, defaultLayout, describeDiff, diffManifests, fetchSha, git, localManifest, manifestDigest, parsePin,
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

export interface VerifyResult { ok: boolean; problems: string[]; sha?: string }

export function verifyRovaraCode(layout: Layout, options: { remote?: boolean } = {}): VerifyResult {
  const problems: string[] = [];
  const pinPath = join(layout.root, PIN_FILE);
  if (!existsSync(pinPath)) return { ok: false, problems: [`${PIN_FILE} is missing`] };
  const parsed = parsePin(readFileSync(pinPath, "utf8"));
  if (parsed.pin === undefined) return { ok: false, problems: parsed.problems };
  const pin = parsed.pin;
  const sha = pin.sha;

  const local = localManifest(join(layout.root, CODE_DIR), new Set(["PIN"]));
  problems.push(...local.problems);
  if (local.entries.length !== pin.files) problems.push(`the copy has ${local.entries.length} files, PIN says ${pin.files}`);
  if (manifestDigest(local.entries) !== pin.manifestSha256) problems.push("the copy's files do not hash to the manifest in PIN (a vendored file was edited, added or removed)");

  if (options.remote === true) {
    try {
      const fetched = fetchSha(pin.repo, sha, { blobs: false });
      try {
        const expected = remoteManifest(fetched.gitDir, sha, pin.include);
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
  if (local.problems.length === 0) problems.push(...checkDependencies(layout));
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
