// Cloud keeps its own copies of six of Code's worker files (the test services' AWS plan, env, seed, ledger, helpers and usage record: Cloud adds the company image and the front's markers, and Code has changes
// Cloud has not taken). This keeps the copies from drifting: each file is compared with the vendored one after the import paths and import layout are made alike, and every hunk that differs must be one of the
// KNOWN differences below, named by a line it holds. A new difference (Code's next change not mirrored, or a Cloud edit that was not meant) fails here until it is mirrored or listed with its reason. A listed
// difference that no longer exists fails too, so the list never goes stale.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROVARA_NEVER_COMMIT, ROVARA_NEVER_COMMIT_EXCLUDE, neverCommitRefusal } from "@rovara-code/contracts";
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
  "isolated-git.ts": [
    { reason: "Cloud's wording of the lessons-replay note (older than Code's)", line: "Lane 7 (lessons replay, the file arm)" },
  ],
  "git.ts": [
    { reason: "Code only: a server's redirect is never followed, so the credential is never sent to an address the registered repository does not name (Cloud's copy lacks it: see DEFERRED-CHECKS, 0.5.18 re-pin)", line: '["http.followRedirects", "false"]' },
  ],
  "verification/candidate.ts": [
  ],
  "publish.ts": [
    { reason: "Cloud imports `WorkerInvocation` from its own contracts", line: 'import { type WorkerInvocation } from "@agentx/cloud-contracts";' },
  ],
  "maintain-pull-request.ts": [
    { reason: "Cloud imports `WorkerInvocation` from its own contracts", line: 'import { type WorkerInvocation } from "@agentx/cloud-contracts";' },
    { reason: "Cloud only: `workflowAdopt` (Continue in your own tool: a Recheck of a head pushed outside Rovara) joins the workflow-task branch", line: "invocation.payload.workflowAdopt !== undefined) {" },
    { reason: "Cloud only: `workflowAdopt` returns the adoption before anything is merged or pushed", line: "if (invocation.payload.workflowAdopt !== undefined) return adoptOutsideHead(" },
    { reason: "Cloud only: `adoptOutsideHead`", line: "async function adoptOutsideHead(" },
    { reason: "Cloud's wording of the push note (names the CodeBuild validation branch)", line: "a CodeBuild validation branch) goes through here" },
  ],
  "never-commit-guard.ts": [],
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


// TE-B9 (public PR #510): the pin carries Code's never-commit list and guard since the 0.5.18 re-pin. Cloud imports the list from @rovara-code/contracts (its own copy in cloud-contracts is deleted); the guard is mirrored above.
describe("TE-B9: the never-commit list comes from Code's contracts", () => {
  it("cloud-contracts has no copy of the list any more, and Code's file is in the pin", () => {
    expect(existsSync("packages/cloud-contracts/src/never-commit.ts"), "cloud-contracts/src/never-commit.ts is back: import the list from @rovara-code/contracts").toBe(false);
    expect(existsSync("vendor/rovara-code/packages/contracts/src/never-commit.ts")).toBe(true);
    expect(existsSync(join(CODE, "never-commit-guard.ts"))).toBe(true);
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
