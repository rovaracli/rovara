// A test-proof.json made by the worker's own code (`runTestProof` and `serializeTestProof`), so a fixture carries exactly the check ids the worker writes
// (`readiness:<index of the command in the check plan>`) and breaks if the worker's format changes. Check `provenIndex` is a test runner whose new test fails on the
// original code; every other check is a linter that passed (the worker marks it not applicable and the proof does not count it). Test support only.
import { rm } from "node:fs/promises";
import type { CheckEntry, ProjectCommand, TestProof } from "../../packages/contracts/src/index.js";
import type { CheckPlan } from "../../packages/worker/src/verification/checks.js";
import { runTestProof, serializeTestProof } from "../../packages/worker/src/verification/test-proof.js";
import { FAKE_TEST_COMMAND, fakeTestRunner, passedEntry, repositoryWithCandidate } from "./test-proof-fixture.js";

const LINT: ProjectCommand = { cwd: ".", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 };

/** The proof the worker writes (one item per check of the plan: `checkCount` checks, default up to the proven one) for `candidateDigest` when the check at `provenIndex` (0-based, in the task's selected-check order) is the one whose new test proves the change. */
export async function workerTestProof(candidateDigest: string, provenIndex: number, checkCount = provenIndex + 1): Promise<{ proof: TestProof; json: string }> {
  const made = await repositoryWithCandidate({ "src/bug.ts": "export const value = 1;\n" }, { "src/bug.ts": "export const value = 2;\n", "src/bug.test.ts": 'import { value } from "./bug.js";\nexpect(value).toBe(2);\n' });
  try {
    const readiness = Array.from({ length: checkCount }, (_, index) => (index === provenIndex ? FAKE_TEST_COMMAND : LINT));
    const plan: CheckPlan = { source: "project", readiness, projectBefore: readiness.map(() => "unknown" as const) };
    const newEntries: CheckEntry[] = readiness.map((_, index) => passedEntry(`readiness:${index}`, index === provenIndex ? "retry tests" : "lint"));
    const proof = await runTestProof({
      plan, newEntries, runners: fakeTestRunner(made.directory),
      repositories: [{ repositoryId: "app", directory: made.directory, startCommit: made.startCommit, candidateTreeSha: made.candidateTreeSha }],
      candidateDigest, rootPath: made.directory, signal: new AbortController().signal, budgetMs: 60_000,
    });
    return { proof, json: serializeTestProof(proof) };
  } finally {
    await rm(made.directory, { recursive: true, force: true });
  }
}
