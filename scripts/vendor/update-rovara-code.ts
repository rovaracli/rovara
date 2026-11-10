// Refreshes the pinned copy of public Rovara Code in vendor/rovara-code (convergence plan W0-1, owner decision 72 O1).
// Fetches one sha of the public repository (no history), extracts the paths in INCLUDE with `git archive`, checks the extracted files
// against `git ls-tree` of that sha, replaces vendor/rovara-code, writes vendor/rovara-code/PIN, and regenerates the `@rovara-code/*`
// shims and the vendor/node_modules/@agentx links. Never edits a vendored file: change Code upstream first, then update the pin.
// Node runs this file directly, so only erasable syntax. Usage, from the repository root:
//   node scripts/vendor/update-rovara-code.ts [<40-character sha> | <public branch>]     (default: the head of code/next)
// Afterwards: `npm install --package-lock-only --ignore-scripts` if the shim set changed, then `npx tsc -b`, and commit.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CODE_DIR, DEFAULT_REF, PIN_FILE, defaultLayout, describeDiff, diffManifests, fetchSha, formatPin, git, localManifest, manifestDigest,
  planLinks, planShims, remoteManifest, resolveRef, writeLinks, writePlanned, SHIMS_DIR, type Layout, type Pin,
} from "./rovara-code-vendor.ts";
import { verifyRovaraCode } from "./verify-rovara-code.ts";

export function updateRovaraCode(layout: Layout, ref: string, log: (line: string) => void = () => undefined): Pin {
  const sha = resolveRef(layout.repoUrl, ref);
  log(`fetching ${sha} from ${layout.repoUrl}`);
  const fetched = fetchSha(layout.repoUrl, sha, { blobs: true });
  const staging = mkdtempSync(join(tmpdir(), "rovara-code-staging-"));
  try {
    const tarFile = join(staging, "code.tar");
    const extracted = join(staging, "tree");
    execFileSync("git", ["archive", "--format=tar", "-o", tarFile, sha, "--", ...layout.include], { cwd: fetched.gitDir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("mkdir", [extracted]);
    execFileSync("tar", ["-xf", tarFile, "-C", extracted]);
    // The extracted files must be the public tree's files exactly (git archive applies .gitattributes; a conversion would show here).
    const expected = remoteManifest(fetched.gitDir, sha, layout.include);
    const { entries, problems } = localManifest(extracted);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const diff = diffManifests(expected, entries);
    if (diff.missing.length + diff.extra.length + diff.changed.length > 0) throw new Error(`the extracted files differ from the public tree: ${describeDiff(diff).join("; ")}`);
    if (expected.length === 0) throw new Error("the include list matched no files");
    const ignored = ignoredByCloud(layout.root, expected.map((e) => e.path));
    if (ignored.length > 0) throw new Error(`Cloud's .gitignore would drop these files from the copy (add an exception, then retry): ${ignored.slice(0, 10).join(", ")}`);

    rmSync(join(layout.root, CODE_DIR), { recursive: true, force: true });
    cpSync(extracted, join(layout.root, CODE_DIR), { recursive: true });
    const pin: Pin = { repo: layout.repoUrl, sha, branch: ref, include: [...layout.include], files: expected.length, manifestSha256: manifestDigest(expected) };
    writeFileSync(join(layout.root, PIN_FILE), formatPin(pin));
    writePlanned(layout.root, SHIMS_DIR, planShims(layout.root, layout.shimmed));
    writeLinks(layout.root, planLinks(layout.root, layout.thirdPartyLinks));
    return pin;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    fetched.cleanup();
  }
}

/** Paths the repository's .gitignore would drop if the copy were added: build output and the like must not be among Code's tracked files. */
function ignoredByCloud(root: string, paths: readonly string[]): string[] {
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return []; // Not a git checkout (a test fixture, or an unpacked tarball): there is no .gitignore to apply.
  }
  try {
    const out = execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], { cwd: root, input: paths.map((p) => `${CODE_DIR}/${p}`).join("\0"), encoding: "utf8" });
    return out.split("\0").filter((p) => p !== "");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

if (process.argv[1]?.endsWith("update-rovara-code.ts")) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const ref = process.argv[2] ?? DEFAULT_REF;
  const pin = updateRovaraCode(defaultLayout(root), ref, (line) => console.log(line));
  const check = verifyRovaraCode(defaultLayout(root));
  if (!check.ok) {
    console.error(`update wrote the copy but it does not verify:\n  ${check.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/rovara-code is now ${pin.sha} (${pin.files} files).`);
  console.log("Next: npm install --package-lock-only --ignore-scripts (if the shim set changed), npx tsc -b, then commit.");
}
