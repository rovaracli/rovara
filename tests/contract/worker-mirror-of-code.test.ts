// Cloud keeps its own copies of six of Code's worker files (the test services' AWS plan, env, seed, ledger, helpers and usage record: Cloud adds the company image and the front's markers, and Code has changes
// Cloud has not taken). This keeps the copies from drifting: each file is compared with the vendored one after the import paths and import layout are made alike, and every hunk that differs must be one of the
// KNOWN differences below, named by a line it holds. A new difference (Code's next change not mirrored, or a Cloud edit that was not meant) fails here until it is mirrored or listed with its reason. A listed
// difference that no longer exists fails too, so the list never goes stale.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROVARA_NEVER_COMMIT, ROVARA_NEVER_COMMIT_EXCLUDE, neverCommitRefusal } from "@agentx/cloud-contracts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLOUD = "packages/worker/src";
const CODE = "vendor/rovara-code/packages/worker/src";

/** Import paths made alike, and every import statement on one line (Cloud and Code format long imports differently). */
function normalise(text: string): string {
  return text.replaceAll("@agentx/contracts", "@rovara-code/contracts")
    .replace(/import (?:type )?\{[^}]*\} from "[^"]+";/gu, (statement) => statement.replace(/\s+/gu, " ").replace(/,\s*\}/u, " }").replace(/\{ ,/u, "{"));
}

interface Known { reason: string; /** A line (a substring) that the hunk holds. */ line: string }
const KNOWN: Readonly<Record<string, readonly Known[]>> = {
  "repo-aws-endpoints.ts": [
    { reason: "Cloud only: the note of names not redirected and repositories not read", line: "export interface RepoEndpointNamesNote" },
    { reason: "Cloud only: the signature takes `onNote`", line: "export async function repoAwsEndpointNames(input: { repositoryPaths: readonly string[]; guard?: GuardOptions; onNote" },
    { reason: "Cloud only: the unread count", line: "unread += 1;" },
    { reason: "Cloud only: a pass that ran out of time counts as unread", line: 'detection.notes.some((note) => note.includes("took too long"))' },
    { reason: "Cloud only: the note is given before the cut", line: "const sorted = [...names].sort();" },
  ],
  "service-env.ts": [],
  "service-seed-aws.ts": [],
  "emulator-ledger.ts": [],
  "service-helpers.ts": [
    { reason: "Cloud only (switch `pj`): the company image's reference check", line: 'import { isCompanyImageRepositoryName } from "@agentx/cloud-contracts";' },
    { reason: "Cloud only (switch `pj`): `HelperRequest.image`, a company image's exact reference", line: "A company-approved image (switch `pj`) only: the exact image reference to start" },
    { reason: "Code only: `imageReferences`, the owner-approved images of a laptop", line: "Owner-approved images (Code on a laptop)" },
    { reason: "Cloud only (lane SM3, 2026-11-12; not in Code's pin yet): the model stand-in's config file name and mount target", line: 'export const MODEL_STAND_IN_CONFIG_NAME = "model-stand-in.json";' },
    { reason: "Cloud only (lane SM3): `HelperRequest.sagemakerHelpers`, the stand-ins the front forwards SageMaker invokes to", line: "sagemakerHelpers?: readonly string[];" },
    { reason: "Cloud only (lane SM3): the addresses of the stand-ins this run starts, the only ones the front may be pointed at", line: "const standInTargets = new Set(" },
    { reason: "Cloud only (lane SM3): `ROVARA_AWS_SAGEMAKER_HELPER` is given to the front after the same-run check", line: "ROVARA_AWS_SAGEMAKER_HELPER=" },
    { reason: "Code only: the mongodb helper family", line: "mongodb: { prepare: () => ({ env: [] }) }," },
    { reason: "Cloud only (switch `pj`): `companyImageOf`", line: "function companyImageOf(reference: string, registry: string): string {" },
    { reason: "Cloud and Code differ in which image a helper starts (company image reference against imageReferences)", line: "plans.push({ request, index, entry, name: plainName(request.name)" },
  ],
  // TE-B9 (O38, public PR #510): the never-commit rule for Rovara's own working files. Cloud has it first (the pin does not carry it yet); every line below marked TE-B9 leaves the list when the pin is refreshed past that PR.
  "isolated-git.ts": [
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the list (Cloud's copy, in cloud-contracts) and the unstage helper imports", line: 'import { ROVARA_NEVER_COMMIT_EXCLUDE } from "@agentx/cloud-contracts";' },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the note above the snapshot's excludes", line: "// TE-B9: every snapshot also leaves out Rovara's own working files" },
    { reason: "Cloud's wording of the lessons-replay note (older than Code's)", line: "Lane 7 (lessons replay, the file arm)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the doc of `snapshotTree`'s new `base`", line: "`base`, when the caller has the task's base commit" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: `snapshotTree` takes the task's base", line: "export async function snapshotTree(git: IsolatedGit, commit: string, base?: string)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: M1: a listed path the task committed is taken out of the snapshot's tree", line: "if (base !== undefined) await unstageRovaraWorkingFiles(" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the first `add --all` form excludes the list", line: "...ROVARA_NEVER_COMMIT_EXCLUDE, ...hidden], { index" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the pathspec-file form excludes the list", line: "...ROVARA_NEVER_COMMIT_EXCLUDE, ...hidden, ...gitlinks" },
  ],
  "git.ts": [
    { reason: "Cloud only (not TE-B9): a server's redirect is never followed, so the credential is never sent to an address the registered repository does not name", line: '["http.followRedirects", "false"]' },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the Git variables that change how a pathspec is read are removed from every Git the worker runs", line: '"GIT_LITERAL_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS",' },
  ],
  "verification/candidate.ts": [
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the base's ancestry is checked before the snapshot reads the base, so the ancestry refusal keeps its own message", line: "The base's ancestry is checked FIRST" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: candidate capture names the task's base to the snapshot (so a committed working file never reaches the reviewed commit)", line: "snapshotTree(git, commit, input.baseCommitSha)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the candidate commit's snapshots name the base", line: "snapshotTree(git, oldHead, input.baseCommitSha)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the verifying snapshot names the base", line: "snapshotTree(git, newHead, input.baseCommitSha)" },
  ],
  "publish.ts": [
    { reason: "Cloud imports `WorkerInvocation` from its own contracts", line: 'import { ROVARA_NEVER_COMMIT_EXCLUDE, type WorkerInvocation } from "@agentx/cloud-contracts";' },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the guard imports", line: 'import { assertNoRovaraWorkingFiles, unstageRovaraWorkingFiles } from "./never-commit-guard.js";' },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the reviewed publication's tree is computed with the task's base", line: "temporaryIndexTree({ directory: git.directory }, pinnedBase)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the final check on the commit about to be pushed, against the base (L2: not the first parent for a retry)", line: "await assertNoRovaraWorkingFiles(git, commit, neverCommitBase);" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the candidate publication's tree is computed with its base", line: "temporaryIndexTree({ directory: input.git.directory }, input.preparationCommit)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the snapshot is given the base", line: "await isolated.headCommit(), base));" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: `temporaryIndexTree` takes the base", line: "export async function temporaryIndexTree(git: { readonly directory: string }, base?: string)" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the ordinary publication's add excludes the list and takes a force-added working file out of the index", line: "...ROVARA_NEVER_COMMIT_EXCLUDE]);" },
  ],
  "maintain-pull-request.ts": [
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: the guard imports", line: 'import { assertPushCarriesNoRovaraWorkingFiles, unstageRovaraWorkingFiles } from "./never-commit-guard.js";' },
    { reason: "Cloud imports `WorkerInvocation` from its own contracts", line: 'import { ROVARA_NEVER_COMMIT_EXCLUDE, type WorkerInvocation } from "@agentx/cloud-contracts";' },
    { reason: "Cloud only: `workflowAdopt` (Continue in your own tool: a Recheck of a head pushed outside Rovara) joins the workflow-task branch", line: "invocation.payload.workflowAdopt !== undefined) {" },
    { reason: "Cloud only: `workflowAdopt` returns the adoption before anything is merged or pushed", line: "if (invocation.payload.workflowAdopt !== undefined) return adoptOutsideHead(" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: a fix round's add excludes the list and unstages a force-added working file", line: "...ROVARA_NEVER_COMMIT_EXCLUDE]);" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: a reviewed fix's tree is computed with the task's base", line: "temporaryIndexTree({ directory: repositoryPath }, invocation.payload.workflowBaseCommit)" },
    { reason: "Cloud only: `adoptOutsideHead`", line: "async function adoptOutsideHead(" },
    { reason: "Cloud's wording of the push note (names the CodeBuild validation branch)", line: "a CodeBuild validation branch) goes through here" },
    { reason: "TE-B9 (public PR #510), not in Code's pin yet: every push also carries none of Rovara's working files", line: 'await assertPushCarriesNoRovaraWorkingFiles((args) => git(directory, args), "HEAD");' },
  ],
  "service-usage-record.ts": [
    { reason: "Cloud only: the front's markers (test-services-front-markers.ts)", line: 'import { frontMarkerOfLedger, frontMarkerWord } from "@agentx/cloud-contracts";' },
    { reason: "Cloud only: `takeFrontMarkers` and its slots", line: "function takeFrontMarkers(ledger: EmulatorLedger)" },
    { reason: "Cloud only: `reduceAwsUsage` takes the markers out of the ledger first", line: "export function reduceAwsUsage(rawLedger: EmulatorLedger" },
    { reason: "Cloud only: the ledger as `reduceAwsUsage` reads it, without the markers", line: "const { ledger, markers } = takeFrontMarkers(rawLedger);" },
    { reason: "Cloud only: markers rank apart from the program's own unsupported operations", line: "const rankedMarkers = " },
    { reason: "Cloud only: the record lists the already ranked and cut operations", line: "unsupportedOperations: rankedOps.map(" },
  ],
};

/** The hunks of `diff -U0` between two texts, each as the changed lines (`-` Cloud's, `+` Code's) without the headers. */
function hunks(cloud: string, code: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "worker-mirror-"));
  try {
    writeFileSync(join(dir, "cloud.ts"), cloud);
    writeFileSync(join(dir, "code.ts"), code);
    let output = "";
    try { execFileSync("diff", ["-U0", join(dir, "cloud.ts"), join(dir, "code.ts")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      if (failure.status !== 1) throw error;
      output = failure.stdout ?? "";
    }
    const found: string[] = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("@@")) found.push("");
      else if (found.length > 0 && !line.startsWith("---") && !line.startsWith("+++") && (line.startsWith("-") || line.startsWith("+"))) found[found.length - 1] += `${line}\n`;
    }
    return found.filter((hunk) => hunk !== "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("Cloud's copies of Code's worker files", () => {
  for (const [file, known] of Object.entries(KNOWN)) it(`${file} differs from Code's only where it is listed`, () => {
    const found = hunks(normalise(readFileSync(join(CLOUD, file), "utf8")), normalise(readFileSync(join(CODE, file), "utf8")));
    const unlisted = found.filter((hunk) => !known.some((entry) => hunk.includes(entry.line)));
    expect(unlisted, `${file}: a difference that is not listed (mirror Code's change, or list it with its reason)`).toEqual([]);
    const used = known.filter((entry) => found.some((hunk) => hunk.includes(entry.line)));
    expect(known.filter((entry) => !used.includes(entry)).map((entry) => entry.reason), `${file}: a listed difference that no longer exists`).toEqual([]);
  });
  it("catches drift: a changed line of Cloud's copy is a difference that is not listed (positive control)", () => {
    const cloud = normalise(readFileSync(join(CLOUD, "service-env.ts"), "utf8"));
    expect(hunks(cloud, normalise(readFileSync(join(CODE, "service-env.ts"), "utf8")))).toEqual([]);
    const drifted = cloud.replace("export const REPO_ENDPOINT_NAMES_MAX = 128;", "export const REPO_ENDPOINT_NAMES_MAX = 129;");
    expect(drifted).not.toBe(cloud);
    expect(hunks(drifted, normalise(readFileSync(join(CODE, "service-env.ts"), "utf8"))).length).toBeGreaterThan(0);
  });
});


// TE-B9: Cloud's copy of the never-commit list and guard, until the vendored pin carries Code's (public PR #510). Everything about them is pinned here by content, so a drift in either place fails.
describe("TE-B9: the never-commit files the pin does not carry yet", () => {
  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
  /** The sha-256 of Code's `packages/contracts/src/never-commit.ts` and `packages/worker/src/never-commit-guard.ts` at the commit PR #510 holds. Change them only with Code's file. */
  const CODE_LIST_SHA256 = "1b4b53a43ee6e180041afab440b16e7ce9c6d36b05ad037f84b4e0a976e923fe";
  const CODE_GUARD_SHA256 = "a0baf752056537fe404740eec6af000c94eb0a3dc6a8cb532335b0709def12f7";

  it("never-commit-guard.ts is Cloud's own until the pin carries Code's copy (then list its differences above, import the list from @rovara-code/contracts and delete cloud-contracts/src/never-commit.ts)", () => {
    expect(existsSync(join(CODE, "never-commit-guard.ts")), "never-commit-guard.ts is in the pin now: move it to KNOWN").toBe(false);
    // Code's guard with only its two import lines made Cloud's: the rest is byte for byte.
    const cloud = readFileSync(join(CLOUD, "never-commit-guard.ts"), "utf8")
      .replace('import { agentXError } from "@rovara-code/contracts";\nimport { ROVARA_NEVER_COMMIT, neverCommitRefusal } from "@agentx/cloud-contracts";', 'import { ROVARA_NEVER_COMMIT, agentXError, neverCommitRefusal } from "@agentx/contracts";');
    expect(sha256(cloud), "Cloud's never-commit-guard.ts differs from Code's (PR #510): change it in Code first").toBe(CODE_GUARD_SHA256);
  });

  it("cloud-contracts/src/never-commit.ts is Code's list file word for word behind its three-line note, until the pin carries it", () => {
    expect(existsSync("vendor/rovara-code/packages/contracts/src/never-commit.ts"), "the pin carries never-commit.ts: delete packages/cloud-contracts/src/never-commit.ts and its export, and import from @rovara-code/contracts").toBe(false);
    const copy = readFileSync("packages/cloud-contracts/src/never-commit.ts", "utf8").split("\n");
    expect(copy.slice(0, 3).join("\n")).toContain("CLOUD COPY of Code's");
    expect(sha256(copy.slice(3).join("\n"))).toBe(CODE_LIST_SHA256);
  });

  it("the exported list and the sentence are what the owner approved (O38, the review's M2/M3 and M1(b))", () => {
    expect([...ROVARA_NEVER_COMMIT]).toEqual([
      ":(top,icase,glob)**/.agentx", ":(top,icase,glob)**/.agentx/**", ":(top,icase,glob)**/.agentx-*", ":(top,icase,glob)**/.agentx-*/**",
      ":(top,icase,glob)**/.rovara/state.db*", ":(top,icase,glob)**/.rovara/audit.db*",
    ]);
    expect([...ROVARA_NEVER_COMMIT_EXCLUDE]).toEqual(ROVARA_NEVER_COMMIT.map((entry) => entry.replace(":(top,", ":(top,exclude,")));
    expect(neverCommitRefusal(".agentx/x")).toBe("Rovara stopped: its own working files were about to be committed (.agentx/x). Not your code. Nothing was pushed. Next: run the task again.");
  });
});
