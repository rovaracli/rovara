// Playbook P1: the "Proof" section of a Rovara Code (version 2) pull request description. It maps each requirement (claim) of the approved plan to its evidence: the checks whose `proves`
// names it and the browser/API scenarios `scenarioProves` names. The section is public to the repository's readers, so every word that a model, a repository or a person wrote is redacted and
// inert, and it is bounded: under size pressure the evidence text shrinks first, then the proven and passed rows, and a failed requirement or a not-tested item is never dropped.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PlanDocument, TestProof } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { PULL_REQUEST_BODY_MAX_BYTES } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { buildProofTable, type ProofCheckResult, type ProofScenarioRow } from "../../packages/broker/src/rovara-code/proof-table.js";
import { PROOF_LEVEL_LAST, proofSection } from "../../packages/broker/src/rovara-code/proof-section.js";
import { loadTestProof } from "../../packages/broker/src/rovara-code/test-proof-reader.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, testedPlanDocument } from "../support/plan-documents.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-27T12:00:00.000Z";
const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const CODE = candidate("1");
const OTHER = candidate("2");
const command = { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 };
const check = (id: string, label: string) => ({ id, label, command });

/** The plan: claim 1 (with child 1.1), claim 2 and claim 3. Check `unit` proves 1.1, `lint` proves 2; claim 3 has no check. */
function plan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schemaVersion: 1,
    title: "Retry failed payments",
    why: [{ text: "Failed payments are dropped.", author: "Priya" }],
    claims: [
      { id: "1", text: "Payments that time out are retried.", children: [{ id: "1.1", text: "The retry waits longer each time." }] },
      { id: "2", text: "A payment is never charged twice." },
      { id: "3", text: "The retry count is shown on the payment page." },
    ],
    notChanging: ["The refund flow stays as it is."],
    risks: ["A slow gateway could keep a retry open."],
    decisions: [],
    checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["1.1"], lint: ["2"] } },
    ...overrides,
  };
}

const passing = (...ids: string[]): ProofCheckResult[] => ids.map((checkId) => ({ checkId, status: "PASS" }));
function proofFor(digest: string, verdict: TestProof["items"][number]["verdict"] = "proves_change"): TestProof {
  return {
    schemaVersion: 1, candidateDigest: digest, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 },
    items: [{ checkId: "unit", label: "Unit tests", granularity: "check", verdict, reason: verdict === "proves_change" ? "assertion_failed_on_old" : "passed_on_old" }], durationMs: 1200,
  };
}
const rowOf = (table: ReturnType<typeof buildProofTable>, claimId: string) => table.rows.find((row) => row.claimId === claimId)!;

describe("buildProofTable", () => {
  it("a claim whose linked check has a proves_change test proof is proven", () => {
    const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: CODE.digest });
    expect(rowOf(table, "1.1").result).toBe("proven");
    expect(rowOf(table, "2").result).toBe("passed");
    expect(table.testProofLines.join("\n")).toContain("1 check fails on the original code and passes now");
  });

  it("a test proof bound to another candidate digest is ignored, as if it were absent", () => {
    const stale = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: proofFor(OTHER.digest), candidateDigest: CODE.digest });
    const absent = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(stale).toEqual(absent);
    expect(rowOf(stale, "1.1").result).toBe("passed");
    expect(stale.testProofLines).toEqual([]);
    // No current digest at all: nothing can be bound to it.
    expect(rowOf(buildProofTable({ plan: plan(), checkResults: passing("unit"), scenarioRows: [], testProof: proofFor(CODE.digest), candidateDigest: undefined }), "1.1").result).toBe("passed");
  });

  it("a parent claim is covered by the checks of its children, and a claim no check names is not tested", () => {
    const table = buildProofTable({ plan: plan(), checkResults: passing("unit", "lint"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(rowOf(table, "1").result).toBe("passed");
    expect(rowOf(table, "3")).toMatchObject({ result: "not_tested", evidence: [] });
    expect(table.notTested.map((item) => [item.kind, item.id])).toContainEqual(["claim", "3"]);
  });

  it("a failed linked check makes the claim failed, even beside a proves_change one", () => {
    const table = buildProofTable({
      plan: plan({ checks: { proposed: [check("unit", "Unit tests"), check("lint", "Lint")], proves: { unit: ["2"], lint: ["2"] } } }),
      checkResults: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }], scenarioRows: [],
      testProof: proofFor(CODE.digest), candidateDigest: CODE.digest,
    });
    expect(rowOf(table, "2").result).toBe("failed");
  });

  it("a claim whose every linked check did not run, or has no result, is not tested, and the check is listed", () => {
    const table = buildProofTable({
      plan: plan(), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest,
      checkResults: [{ checkId: "unit", status: "UNKNOWN" }, { checkId: "lint", status: "FAILED", couldNotRun: true }],
    });
    expect(rowOf(table, "1.1").result).toBe("not_tested");
    expect(rowOf(table, "2").result).toBe("not_tested");
    const checks = table.notTested.filter((item) => item.kind === "check").map((item) => item.id).sort();
    expect(checks).toEqual(["lint", "unit"]);
    // No result at all for a proposed check reads the same.
    const none = buildProofTable({ plan: plan(), checkResults: [], scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest });
    expect(rowOf(none, "2").result).toBe("not_tested");
  });

  it("a claim proved only by checks that read files (the plan self-check's claim-static-only finding) is not tested", () => {
    const reader = { id: "grep", label: "Grep for the flag", command: { cwd: "repo/payments", executable: "grep", args: ["-q", "retry", "src/charge.ts"], timeoutSeconds: 30 } };
    const table = buildProofTable({
      plan: plan({ checks: { proposed: [reader, check("unit", "Unit tests")], proves: { grep: ["2"], unit: ["1.1"] } } }),
      checkResults: passing("grep", "unit"), scenarioRows: [], testProof: undefined, candidateDigest: CODE.digest,
    });
    expect(rowOf(table, "2")).toMatchObject({ result: "not_tested" });
    expect(rowOf(table, "2").evidence).toHaveLength(1);
    expect(table.notTested.find((item) => item.id === "2")?.reason).toMatch(/read files/);
    expect(rowOf(table, "1.1").result).toBe("passed");
  });

  it("scenarios count through scenarioProves: a passed row proves the claim, a failed one fails it, a missing or unknown one is listed as not exercised", () => {
    const withScenarios = plan({
      checks: { proposed: [], proves: {}, noneReason: "no unit tests apply" },
      scenarioProves: { "checkout-flow": ["1.1"], "retry-count": ["3"], "refund-flow": ["2"], "never-ran": ["1.1"] },
    });
    const rows: ProofScenarioRow[] = [
      { scenarioId: "checkout-flow", title: "Checkout flow", kind: "web", status: "PASSED" },
      { scenarioId: "retry-count", title: "Retry count", kind: "web", status: "FAILED" },
      { scenarioId: "refund-flow", title: "Refund flow", kind: "api", status: "UNKNOWN" },
    ];
    const table = buildProofTable({ plan: withScenarios, checkResults: [], scenarioRows: rows, testProof: undefined, candidateDigest: CODE.digest });
    expect(rowOf(table, "1.1").result).toBe("passed");
    expect(rowOf(table, "3").result).toBe("failed");
    expect(rowOf(table, "2").result).toBe("not_tested");
    const skipped = table.notTested.filter((item) => item.kind === "scenario").map((item) => item.id).sort();
    expect(skipped).toEqual(["never-ran", "refund-flow"]);
  });
});

function workflowWith(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: CODE.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
  return WorkflowSnapshot.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate: CODE,
    checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [check("unit", "Unit tests"), check("lint", "Lint")] },
    verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
    ...extra,
  });
}
const WorkflowSnapshot = WorkflowSnapshotSchema;
const task = { title: "Add a retry flag" } as never;
const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
const START = "<!-- rovara:checks-and-reviews -->";
const END = "<!-- /rovara:checks-and-reviews -->";
const files = { files: [{ repository: "payments", path: "src/retry.ts", added: 10, removed: 2 }, { repository: "payments", path: "src/retry.test.ts", added: 30, removed: 0 }], complete: true };
const bodyOf = (proof: unknown, workflow = workflowWith(), extra: Record<string, unknown> = {}) =>
  workflowPullRequestBody(task, workflow, "# Plan\n\n1. Add the retry flag.\n", SESSION, { changedFiles: files, ...(proof === undefined ? {} : { proof }), ...extra } as never);
const proofPart = (body: string) => {
  const from = body.indexOf("### Proof");
  return from === -1 ? "" : body.slice(from, body.indexOf("## Reviews", from));
};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the Proof section of the version 2 pull request description", () => {
  it("shows a requirement whose check has a proves_change test proof as proven, after Tests and before Reviews", () => {
    const body = bodyOf({ plan: plan(), testProof: proofFor(CODE.digest) });
    expect(body.indexOf("### Proof")).toBeGreaterThan(body.indexOf("## Tests"));
    expect(body.indexOf("### Proof")).toBeLessThan(body.indexOf("## Reviews"));
    expect(body.indexOf("### Proof")).toBeGreaterThan(body.indexOf(START));
    expect(body.indexOf("### Proof")).toBeLessThan(body.indexOf(END));
    const section = proofPart(body);
    expect(section).toContain("| Requirement | Evidence | Result |");
    expect(section).toMatch(/\| 1\.1: The retry waits longer each time\. \|[^|\n]*Unit tests[^|\n]*\| ✅ proven \|/);
    expect(section).toMatch(/\| 2: A payment is never charged twice\. \|[^|\n]*Lint[^|\n]*\| ✅ passed \|/);
    expect(section).toContain("1 check fails on the original code and passes now");
  });

  it("shows a requirement with no linked check as not tested and lists it under What wasn't tested", () => {
    const section = proofPart(bodyOf({ plan: plan() }));
    expect(section).toMatch(/\| 3: The retry count is shown on the payment page\. \|[^|\n]*\| ⚠ not tested \|/);
    const after = section.slice(section.indexOf("What wasn't tested"));
    expect(after).toContain("What wasn't tested");
    expect(after).toMatch(/- .*\b3\b.*retry count is shown/);
  });

  it("ignores a test proof bound to a different candidate digest", () => {
    const ignored = bodyOf({ plan: plan(), testProof: proofFor(OTHER.digest) });
    const absent = bodyOf({ plan: plan() });
    expect(ignored).toBe(absent);
    expect(proofPart(ignored)).not.toContain("proven");
    expect(ignored).not.toContain("Test proof:");
  });

  it("renders a requirement's mentions, links, issue numbers, hidden characters and table breaks inert", () => {
    const nasty = "Ping @everyone and @octocat, see [the docs](https://evil.example/x) or https://evil.example/y and www.evil.example, fixes #123 and org/repo#9\u200b\u202e hidden <!-- comment --> | pipe &#x40;user";
    const section = proofPart(bodyOf({ plan: plan({ claims: [{ id: "1", text: nasty }, ...plan().claims.slice(1)] }) }));
    expect(section).not.toMatch(/@[A-Za-z]/u);
    expect(section).not.toMatch(/https?:\/\/[^\s‍]/u);
    expect(section).not.toMatch(/\]\(/u);
    expect(section).not.toMatch(/#\d/u);
    expect(section).not.toContain("<!--");
    expect(section).not.toMatch(/[\u200b\u202e]/u);
    expect(section).not.toMatch(/&#x40;/u);
    // The pipe cannot add a column: every table row has exactly its three cells.
    for (const line of section.split("\n").filter((row) => row.startsWith("| ") && !row.startsWith("| ---"))) expect(line.split(" | ")).toHaveLength(3);
    // The text itself is kept (the words survive), only made inert.
    expect(section).toContain("Ping");
  });

  it("redacts a secret in a requirement and in a check label", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const body = bodyOf({ plan: plan({ claims: [{ id: "1", text: `Uses token ${secret} to call the API` }, ...plan().claims.slice(1)], checks: { proposed: [check("unit", `Unit ${secret}`), check("lint", "Lint")], proves: { unit: ["1"], lint: ["2"] } } }) });
    expect(proofPart(body)).not.toContain("ghp_");
  });

  it("stays within 30,000 bytes under size pressure and never drops a failed requirement or a not-tested item", () => {
    const long = (word: string) => `${word} ${"requirement text that goes on and on ".repeat(8)}`.slice(0, 298);
    const claims = Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1), text: `${index + 1} ${long("claim")}` }));
    const labels = (index: number) => `Check number ${index} ${"with a very long label ".repeat(10)}`.slice(0, 78);
    const proposed = Array.from({ length: 8 }, (_, index) => check(`c${index}`, labels(index)));
    // Claims 1-30 are proven or passed; 31-35 are failed; 36-50 have no check. Each of the first 35 names every check.
    const proves: Record<string, string[]> = Object.fromEntries(proposed.map((item) => [item.id, claims.slice(0, 35).map((claim) => claim.id)]));
    const big = plan({ claims, checks: { proposed, proves } });
    // Failing the last check fails every claim that names it, so give claims 31-35 their own failing check instead.
    const failingPlan = plan({ claims, checks: { proposed: [...proposed.slice(0, 7), check("bad", labels(9))], proves: { ...Object.fromEntries(proposed.slice(0, 7).map((item) => [item.id, claims.slice(0, 30).map((claim) => claim.id)])), bad: claims.slice(30, 35).map((claim) => claim.id) } } });
    const results = [...proposed.slice(0, 7).map((item) => ({ checkId: item.id, status: "PASS" })), { checkId: "bad", status: "FAILED" }];
    const checkPolicy = { required: [], optional: [], selectedOptionalIds: [], proposed: [...proposed.slice(0, 7), check("bad", labels(9))] };
    const workflow = workflowWith({ stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined, checkPolicy, verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results } });
    const manyFiles = { files: Array.from({ length: 200 }, (_, index) => ({ repository: "payments", path: `src/module-${index}/some/deeply/nested/file-name-${index}.ts`, added: 5, removed: 1 })), complete: true };
    const summary = Array.from({ length: 40 }, (_, index) => `Plan line ${index} ${"x".repeat(180)}`).join("\n");
    const body = workflowPullRequestBody(task, workflow, summary, SESSION, { changedFiles: manyFiles, proof: { plan: failingPlan, testProof: undefined } });
    expect(bytes(body)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    // The size pressure was real: the section in its full form added to the rest of the body would not fit, so something had to shrink.
    const without = workflowPullRequestBody(task, workflow, summary, SESSION, { changedFiles: manyFiles });
    const full = proofSection(workflow, { plan: failingPlan })!(0).join("\n");
    expect(bytes(without) + bytes(full)).toBeGreaterThan(PULL_REQUEST_BODY_MAX_BYTES);
    expect(bytes(proofPart(body))).toBeLessThan(bytes(full));
    expect(big.claims).toHaveLength(50);
    const section = proofPart(body);
    for (let id = 31; id <= 35; id += 1) expect(section, `failed ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ❌ failed \\|`, "u"));
    for (let id = 36; id <= 50; id += 1) {
      expect(section, `not tested row ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ⚠ not tested \\|`, "u"));
      expect(section.slice(section.indexOf("What wasn't tested")), `not tested bullet ${id}`).toMatch(new RegExp(`- [^\\n]*\\b${id}\\b`, "u"));
    }
    // The markers, the risk and the closing line stay.
    expect(body).toContain(START);
    expect(body).toContain(END);
    expect(body).toContain("## Risk:");
    expect(body.trimEnd().endsWith("A person must approve it and a person merges it.")).toBe(true);
  });

  it("shrinks the evidence text first, then folds the proven and passed rows, and keeps failed and not-tested items at every level", () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), text: `Requirement ${index + 1} ${"is described in a fair amount of detail ".repeat(7)}`.slice(0, 290) }));
    const proposed = [check("unit", `Unit tests ${"with a long label ".repeat(5)}`.slice(0, 78)), check("lint", "Lint"), check("bad", "Bad check")];
    const checkPolicy = { required: [], optional: [], selectedOptionalIds: [], proposed };
    const results = [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }, { checkId: "bad", status: "FAILED" }];
    const workflow = workflowWith({ stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined, checkPolicy,
      verification: { candidateDigest: CODE.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results } });
    // 1-6 pass (unit and lint), 7-8 fail (bad), 9-12 have no check.
    const ids = (from: number, to: number) => claims.slice(from - 1, to).map((claim) => claim.id);
    const bigPlan = plan({ claims, checks: { proposed, proves: { unit: ids(1, 6), lint: ids(1, 6), bad: ids(7, 8) } } });
    const at = (level: number) => proofSection(workflow, { plan: bigPlan })!(level).join("\n");
    const rowLines = (text: string) => text.split("\n").filter((line) => /^\| \d+: /u.test(line));

    expect(at(0)).toContain(proposed[0]!.label);
    expect(at(0)).toContain(`${proposed[0]!.label} (passed); Lint (passed)`);
    // Level 1 cuts the evidence entries, level 2 turns them into counts; the requirement text is cut later than the evidence.
    expect(at(1)).not.toContain(proposed[0]!.label);
    expect(at(1)).toContain("Unit tests with a long label with a lon…");
    expect(at(2)).not.toContain("Unit tests");
    expect(at(2)).toContain("2 checks");
    expect(rowLines(at(1))).toHaveLength(12);
    expect(rowLines(at(2))).toHaveLength(12);
    expect(rowLines(at(1))[0]!.length).toBeGreaterThan(rowLines(at(2))[0]!.length);
    // Level 3 folds the six passed rows into one line.
    expect(rowLines(at(3))).toHaveLength(6);
    expect(at(3)).toContain("6 more requirements proven or passed");
    expect(at(3)).not.toContain("| 1: ");
    // Failed rows and not-tested items are in every level.
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const text = at(level);
      for (const id of [7, 8]) expect(text, `level ${level} failed ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ❌ failed \\|`, "u"));
      for (const id of [9, 10, 11, 12]) {
        expect(text, `level ${level} row ${id}`).toMatch(new RegExp(`\\| ${id}: [^\\n]*\\| ⚠ not tested \\|`, "u"));
        expect(text.slice(text.indexOf("What wasn't tested")), `level ${level} bullet ${id}`).toMatch(new RegExp(`- Requirement ${id}\\b`, "u"));
      }
    }
    expect(bytes(at(4))).toBeLessThan(bytes(at(3)));
    expect(bytes(at(3))).toBeLessThan(bytes(at(2)));
    expect(bytes(at(2))).toBeLessThan(bytes(at(1)));
    expect(bytes(at(1))).toBeLessThan(bytes(at(0)));
  });

  it("has no Proof section without an approved plan with claims, and the rest of the body is byte-identical to today's", () => {
    const today = bodyOf(undefined);
    expect(today).not.toContain("### Proof");
    expect(bodyOf({ plan: undefined })).toBe(today);
    expect(bodyOf({ plan: plan({ claims: [] }) })).toBe(today);
    expect(bodyOf({ plan: undefined, testProof: proofFor(CODE.digest) })).toBe(today);
    expect(workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { plan: undefined } })).toEqual(workflowPullRequestStatusLines(workflowWith(), { changedFiles: files }));
  });

  it("a rewrite of the status lines after a pushed fix keeps the Proof section", () => {
    const lines = workflowPullRequestStatusLines(workflowWith(), { changedFiles: files, proof: { plan: plan(), testProof: proofFor(CODE.digest) } }).join("\n");
    expect(lines).toContain("### Proof");
    expect(lines).toContain("✅ proven");
  });
});

describe("loadTestProof", () => {
  const task = { ownerKey: "owner-key", workspaceId: "ws-1" };
  const artifactKey = (operationId: string) => `private/owner-key/ws-1/${operationId}/test-proof.json`;
  const actionsWith = (stored: Record<string, string>, operations = [{ id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-10-27T10:00:00.000Z" }]) => ({
    operations: async () => operations,
    artifacts: async (_workspaceId: string, operationId: string) => (stored[artifactKey(operationId)] === undefined ? [] : [{ name: "test-proof.json", objectKey: artifactKey(operationId) }]),
    readArtifact: async (objectKey: string) => { const text = stored[objectKey]; if (text === undefined) throw new Error("missing"); return text; },
  });

  it("returns the parsed proof bound to the candidate digest", async () => {
    const proof = proofFor(CODE.digest);
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proof) }), task, CODE.digest)).toEqual(proof);
  });

  it("returns nothing when there is no artifact (always, until the worker part lands), when it is for another digest, malformed, or from another workspace's key", async () => {
    expect(await loadTestProof(actionsWith({}), task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(OTHER.digest)) }), task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: "{not json" }), task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify({ ...proofFor(CODE.digest), extra: 1 }) }), task, CODE.digest)).toBeUndefined();
    const foreign = { ...actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(CODE.digest)) }), artifacts: async () => [{ name: "test-proof.json", objectKey: "private/someone-else/ws-9/op-1/test-proof.json" }] };
    expect(await loadTestProof(foreign, task, CODE.digest)).toBeUndefined();
    expect(await loadTestProof(actionsWith({ [artifactKey("op-1")]: JSON.stringify(proofFor(CODE.digest)) }), task, undefined)).toBeUndefined();
  });

  it("returns nothing, and does not throw, when storage fails", async () => {
    const broken = { operations: async () => { throw new Error("down"); }, artifacts: async () => [], readArtifact: async () => "" };
    expect(await loadTestProof(broken, task, CODE.digest)).toBeUndefined();
  });
});

// ---- through the broker: the publication reads the approved plan and the test proof from storage

describe("a version 2 task's published pull request through the broker", () => {
  const pullRequestGateway = () => ({
    reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
    getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
    verifyWebhookRepository: vi.fn(async () => true),
  });
  const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });

  async function published(testProofFor?: (digest: string) => unknown) {
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: pullRequestGateway() } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const id = String((started.body.task as { taskId: string }).taskId);
    const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
    const workspaceId = record().workspaceId;
    harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion: "1.1.0", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    // The plan stays a structured document (the only form a new task's planning step ends with), so the approved plan has claims.
    const planning = operations().find((item) => item.workflowMode === "PLAN")!;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(testedPlanDocument()));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const planArtifact = record().workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!;
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/decision`, { requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: planArtifact.sha256 });
    const implementation = operations().find((item) => item.workflowMode === "IMPLEMENT")!;
    const built = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    if (testProofFor !== undefined) await harness.artifact(workspaceId, String(implementation.id), "test-proof.json", JSON.stringify(testProofFor(built.digest)));
    await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: built.repositories, workflowCheckCandidateRepositories: built.repositories, checks: passingChecks() } });
    const review = operations().find((item) => item.workflowMode === "REVIEW")!;
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: built.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: review.id, candidateDigest: built.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
    const publication = (operations().find((item) => item.kind === "publish") as { publication: { body: string } } | undefined)?.publication;
    return { body: String(publication?.body), built };
  }

  it("shows the approved plan's requirements in a Proof section, not tested when no check names them, with no test-proof line when no artifact exists", async () => {
    const { body } = await published();
    const section = proofPart(body);
    expect(section).toContain("### Proof");
    expect(section).toContain("| 1: Payments that fail with a timeout are retried. | none | ⚠ not tested |");
    expect(section).toContain("| 2: A test proves a timed-out payment is retried once and never charged twice. | none | ⚠ not tested |");
    expect(section).toMatch(/What wasn't tested:\n- Requirement 1:.*\n- Requirement 2:/u);
    expect(body).not.toContain("Test proof:");
    expect(bytes(body)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
  });

  it("reads test-proof.json the way the mainline hook does: a proof bound to the candidate adds its line, one bound to other code is ignored", async () => {
    const proofItems = (digest: string) => ({ ...proofFor(digest), items: [{ checkId: "readiness:0", label: "npm test", granularity: "check", verdict: "proves_change", reason: "assertion_failed_on_old" }] });
    const bound = await published(proofItems);
    expect(proofPart(bound.body)).toContain("Test proof: 1 check fails on the original code and passes now");
    const other = await published(() => proofItems(OTHER.digest));
    expect(other.body).not.toContain("Test proof:");
  });
});
