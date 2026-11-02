// Setup and test health SH20: the replay check. A code failure must never be labelled as environment (or shown as passing); an unreadable snapshot fails the run; the output names task ids and counts only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidencePackSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "@agentx/contracts";
import { hasCodeSignal, readSnapshotFolder, replayOne, replayResults, replayText, type ViewOf } from "../../scripts/replay-results.js";

const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const NOW = "2026-11-02T12:00:00.000Z";
const policy = { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 } }], optional: [], selectedOptionalIds: [], proposed: [] };
const workflow = (over: Record<string, unknown> = {}, state: "READY" | "BLOCKED" = "READY", blockReason?: string) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: NOW }), definitionVersion: "1.1.0", revision: 7, stage: "VERIFY", state, ...(blockReason === undefined ? {} : { blockReason }), candidate, checkPolicy: policy,
  verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] }, ...over,
});
const pack = (checks: Array<Record<string, unknown>> = [{}]) => EvidencePackSchema.parse({
  schemaVersion: 1, candidateDigest: candidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
  checks: checks.map((entry) => ({ checkId: "unit", kind: "test", label: "unit", before: "passed", after: "passed", class: "passing", durationMs: 5, ...entry })),
  selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
});
const snapshot = (taskId: string, flow: unknown, extra: Record<string, unknown> = {}) => ({ taskId, workflow: flow, ...extra });
const failedUnit = { verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "unit", status: "FAILED" }] } };
const regression = pack([{ after: "failed", class: "regression", tests: { total: 10, passed: 9, failed: 1, skipped: 0, errored: 0, newTests: [], names: [{ name: "t::a", status: "failed" }] } }]);

const verified = () => snapshot("t-verified", workflow({ stage: "REVIEW" }), { evidence: pack() });
const environment = () => snapshot("t-env", workflow({ verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed));
const codeFault = () => snapshot("t-code", workflow({ stage: "VERIFY", ...failedUnit }, "BLOCKED", WORKFLOW_BLOCK_REASONS.regressionFound));

describe("replayResults", () => {
  it("is clean for verified, environment and code-failed tasks that are labelled as they should be", () => {
    const report = replayResults([verified(), environment(), codeFault()]);
    expect(report).toMatchObject({ total: 3, ok: true, codeLabelledEnvironment: [], codeShownAsPassing: [], unreadable: [] });
    expect(report.byVerdict).toMatchObject({ verified: 1, blocked_by_environment: 1, code_failed: 1 });
    expect(replayText(report)).toContain("OK: no code failure is labelled as environment.");
  });

  it("finds the code signal without the result rules: a regression class in the evidence, or a code-class block", () => {
    expect(hasCodeSignal(workflow(), {}, regression)).toBe(true);
    expect(hasCodeSignal(workflow({ stage: "VERIFY" }, "BLOCKED", WORKFLOW_BLOCK_REASONS.regressionFound), {}, undefined)).toBe(true);
    expect(hasCodeSignal(workflow({ verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), {}, undefined)).toBe(false);
    expect(hasCodeSignal(workflow(), {}, pack())).toBe(false);
    // Evidence for other code is no signal about this code.
    expect(hasCodeSignal(workflow(), {}, { ...regression, candidateDigest: "9".repeat(64) })).toBe(false);
  });

  it("agrees that a regression beside an environment block is Code failed (code wins)", () => {
    const mixed = snapshot("t-mixed", workflow({ stage: "VERIFY", ...failedUnit }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { evidence: regression });
    expect(replayOne(mixed)).toMatchObject({ verdict: "code_failed", codeSignal: true });
    expect(replayResults([mixed]).ok).toBe(true);
  });

  it("FAILS, naming the task, when a classifier labels a code failure as environment (proof the check can fail)", () => {
    const asEnvironment: ViewOf = () => ({ view: { schemaVersion: 1, result: "blocked_by_environment", reasons: ["check_runner_failed"], rows: [{ label: "Unit tests", command: "pytest -q", status: "blocked", reason: "check_runner_failed" }] } });
    const report = replayResults([codeFault(), environment(), verified()], asEnvironment);
    expect(report.ok).toBe(false);
    expect(report.codeLabelledEnvironment).toEqual(["t-code"]);
    expect(replayText(report)).toContain("FAIL code failure labelled as environment: t-code");
  });

  it("FAILS when a classifier shows a code failure as Verified or Partially verified", () => {
    const asVerified: ViewOf = () => ({ view: { schemaVersion: 1, result: "verified", reasons: [], rows: [{ label: "Unit tests", command: "pytest -q", status: "passed" }] } });
    const report = replayResults([codeFault(), verified()], asVerified);
    expect(report.codeShownAsPassing).toEqual(["t-code"]);
    expect(report.ok).toBe(false);
  });

  it("fails the run for an unreadable snapshot and an empty run, and prints ids and counts only", () => {
    const bad = replayResults([verified(), { taskId: "t-broken", workflow: { not: "a workflow" } }, 17]);
    expect(bad).toMatchObject({ ok: false, unreadable: ["t-broken", "(unknown)"] });
    const text = replayText(bad);
    expect(text).toContain("FAIL snapshots that could not be read: t-broken, (unknown)");
    expect(text).not.toContain("pytest");
    expect(replayResults([]).ok).toBe(false);
    expect(replayText(replayResults([]))).toContain("FAIL no snapshots were given.");
  });

  it("reads a folder of snapshots in name order and treats a file that is not JSON as unreadable", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "rovara-replay-"));
    directories.push(directory);
    writeFileSync(path.join(directory, "a.json"), JSON.stringify(verified()));
    writeFileSync(path.join(directory, "b.json"), "{ not json");
    writeFileSync(path.join(directory, "c.txt"), "ignored");
    const read = readSnapshotFolder(directory);
    expect(read).toHaveLength(2);
    expect(replayResults(read)).toMatchObject({ total: 2, ok: false, unreadable: ["b"] });
  });
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
