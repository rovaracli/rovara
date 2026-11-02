// Setup and test health SH18/SH19: the loader behind the pull request's Testing section and the task page's result. Off unless vx is exactly "1" (and then it reads nothing for a version 1 task); a mark by a
// maintainer counts as already failing; a blocked task shows an environment result only after Rovara stored its Fix setup ask; a failed follow-up full run shows no result.
import { describe, expect, it } from "vitest";
import {
  EvidencePackSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type EvidencePack, type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadTestingView, type TestingViewDeps } from "../../packages/broker/src/aws/developer-tasks/testing-view.js";
import type { AutoFixAsk } from "../../packages/broker/src/developer/autofix-messages.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { markFollowupRunning, queueFullSuiteFollowup, recordFollowupResult } from "../../packages/broker/src/rovara-code/full-suite-followup.js";
import { knownFailingKey } from "../../packages/broker/src/test-env/known-failing.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"c".repeat(20)}`;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const NOW = "2026-11-02T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const ON = { VERIFY_RESULTS_ENABLED: "1" };
type Over = Record<string, unknown>;
const check = (checkId: string, status: string): Over => ({ checkId, status });
const policy = { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 } }], optional: [], selectedOptionalIds: [], proposed: [] };
const workflow = (over: Over = {}, state: "READY" | "BLOCKED" = "READY", blockReason?: string): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: NOW }), definitionVersion: "1.1.0", revision: 7, stage: "REVIEW", state, ...(blockReason === undefined ? {} : { blockReason }), candidate, checkPolicy: policy,
  verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [check("unit", "PASS")] }, ...over,
});
const pack = (checks: Over[] = [{}], over: Over = {}): EvidencePack => EvidencePackSchema.parse({
  schemaVersion: 1, candidateDigest: candidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
  checks: checks.map((entry) => ({ checkId: "unit", kind: "test", label: "unit", before: "passed", after: "passed", class: "passing", durationMs: 5, ...entry })),
  selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [], ...over,
});
const task = (over: Over = {}): DeveloperTaskRecord => ({ taskId: TASK, orgId: ORG, project: "web", ownerKey: "dev_a", workspaceId: "ws", ...over } as unknown as DeveloperTaskRecord);

function bench(evidence: EvidencePack | undefined = pack()) {
  const db = new FakeDynamoDb();
  const calls = { send: 0, pack: 0 };
  const client = { send: (command: unknown) => { calls.send += 1; return db.send(command as never); } };
  const deps: TestingViewDeps = { documentClient: client, tableName: "state", now: () => Date.parse(NOW), evidence: { pack: async () => { calls.pack += 1; return evidence; } } };
  return { db, deps, calls };
}

describe("loadTestingView is off unless vx is exactly 1", () => {
  it("reads nothing and returns nothing for any other value, and for a version 1 task", async () => {
    const t = bench();
    for (const value of [undefined, "", "0", "true", " 1"]) expect(await loadTestingView(t.deps, task(), workflow(), value === undefined ? {} : { VERIFY_RESULTS_ENABLED: value }), String(value)).toBeUndefined();
    expect(await loadTestingView(t.deps, task(), workflow({ definitionVersion: "1.0.0" }), ON)).toBeUndefined();
    expect(t.calls).toEqual({ send: 0, pack: 0 });
    expect((await loadTestingView(t.deps, task(), workflow(), ON))?.result).toBe("verified");
  });
});

describe("a maintainer's mark counts as already failing", () => {
  const failing = () => workflow({ verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [check("unit", "FAILED")] } });
  const evidence = () => pack([{ after: "failed", class: "already_failing", tests: { total: 10, passed: 9, failed: 1, skipped: 0, errored: 0, newTests: [], names: [{ name: "t::a", status: "failed" }] } }]);

  it("is Blocked by environment before the mark and Partially verified (already failing) after it", async () => {
    const t = bench(evidence());
    expect((await loadTestingView(t.deps, task(), failing(), ON))?.result).toBe("blocked_by_environment");
    t.db.set({ ...knownFailingKey(ORG, "web"), entityType: "TEST_ENV_KNOWN_FAILING", tests: ["t::a"], version: 1, updatedAt: NOW });
    const after = await loadTestingView(t.deps, task(), failing(), ON);
    expect(after).toMatchObject({ result: "partially_verified", reasons: ["known_failing_only"] });
    expect(after?.rows[0]).toMatchObject({ status: "known_failing" });
  });
});

describe("a blocked task", () => {
  const blocked = () => workflow({ stage: "VERIFY", verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed);
  const ask = (reason: string): AutoFixAsk => ({ workflowRevision: 7, reason, codes: ["check-runner-failed"], at: NOW } as AutoFixAsk);

  it("shows no environment result while Rovara may still retry (no stored ask for this revision)", async () => {
    expect(await loadTestingView(bench(undefined).deps, task(), blocked(), ON)).toBeUndefined();
    expect(await loadTestingView(bench(undefined).deps, task({ autofixAsk: { ...ask("retry-limit"), workflowRevision: 6 } }), blocked(), ON)).toBeUndefined();
  });

  it("shows Blocked by environment once the stored ask is the Fix setup case, and not for a limit's ask", async () => {
    const v = await loadTestingView(bench(undefined).deps, task({ autofixAsk: ask("retry-limit") }), blocked(), ON);
    expect(v).toMatchObject({ result: "blocked_by_environment", reasons: ["check_runner_failed"] });
    expect(await loadTestingView(bench(undefined).deps, task({ autofixAsk: ask("spend-cap") }), blocked(), ON)).toBeUndefined();
  });

  it("with automatic fixing off there is no ask and no Fix setup card, so no environment result is claimed either", async () => {
    expect(await loadTestingView(bench(undefined).deps, task(), blocked(), { ...ON, AUTOFIX_ENABLED: "false" })).toBeUndefined();
  });
});

describe("the follow-up full run", () => {
  const timedOut = () => pack([{ after: "not_run", class: "not_rerun" }], { selection: { method: "full", selected: 10, total: 10, fallbackReason: "map_missing" } });
  const key = { orgId: ORG, project: "web", taskId: TASK, candidateDigest: candidate.digest };
  const queued = async (t: ReturnType<typeof bench>) => {
    const followup = { documentClient: t.deps.documentClient, tableName: "state", now: () => Date.parse(NOW), admit: async () => undefined };
    await queueFullSuiteFollowup(followup, { ...key, headSha: "1".repeat(40) });
    return followup;
  };

  it("is a pending row while queued or running, a not-run row when never queued, and no result at all when it failed", async () => {
    const t = bench(timedOut());
    expect((await loadTestingView(t.deps, task(), workflow(), ON))?.rows.at(-1)).toMatchObject({ label: "Full test suite", status: "not_run", reason: "full_suite_not_run" });
    const followup = await queued(t);
    expect((await loadTestingView(t.deps, task(), workflow(), ON))?.rows.at(-1)).toMatchObject({ status: "pending", reason: "full_suite_pending" });
    await markFollowupRunning(followup, key);
    expect((await loadTestingView(t.deps, task(), workflow(), ON))?.rows.at(-1)).toMatchObject({ status: "pending" });
    await recordFollowupResult(followup, { ...key, result: { passed: 8, failed: 2, total: 10, flaky: 0, finishedAt: NOW } });
    expect(await loadTestingView(t.deps, task(), workflow(), ON)).toBeUndefined();
  });
});
