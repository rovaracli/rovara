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

const oldFailing = (names: string[], newTests: string[] = []) => pack([{ before: "failed", after: "failed", class: "already_failing", tests: { total: 10, passed: 10 - names.length, failed: names.length, skipped: 0, errored: 0, newTests, names: names.map((name) => ({ name, status: "failed" })) } }]);
const failedOld = { stage: "VERIFY", verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "unit", status: "FAILED" }] } };

describe("a check that failed before with no usable per-test data (M2, second Opus re-check)", () => {
  const base = (id: string, evidence: unknown) => snapshot(id, workflow(failedOld, "BLOCKED"), { ...(evidence === undefined ? {} : { evidence }), alreadyFailing: ["Y"], facts: { checkOriginal: { unit: "failed" } } });
  const noCounts = pack([{ before: "failed", after: "failed", class: "already_failing" }]);
  const zero = oldFailing([]);

  it("flags a compile or import break (no test counts, a zero count), a pack for other code, and no pack at all; each is Code failed", () => {
    const report = replayResults([base("t-nocounts", noCounts), base("t-zero", zero), base("t-nopack", undefined), base("t-other", { ...oldFailing(["Y"]), candidateDigest: "9".repeat(64) }), base("t-fine", oldFailing(["Y"]))]);
    expect(report.suspect).toEqual(["t-nocounts", "t-zero", "t-nopack", "t-other"]);
    expect(report.byVerdict).toMatchObject({ code_failed: 4, partially_verified: 1 });
    expect(report.ok).toBe(true);
  });

  it("flags a failing name that appears twice", () => {
    expect(replayResults([base("t-twice", oldFailing(["Y", "Y"]))]).suspect).toEqual(["t-twice"]);
  });

  it("is a violation when a classifier calls such a task Blocked by environment", () => {
    const asBlocked: ViewOf = () => ({ view: { schemaVersion: 1, result: "blocked_by_environment", reasons: ["fails_on_original_code"], rows: [{ label: "Unit tests", command: "pytest -q", status: "blocked", reason: "fails_on_original_code" }] } });
    const report = replayResults([base("t-nopack", undefined)], asBlocked);
    expect(report.codeLabelledEnvironment).toEqual(["t-nopack"]);
    expect(report.ok).toBe(false);
  });
});

describe("suspect checks (M2: owner decision)", () => {
  const task = (id: string, names: string[], alreadyFailing: string[], newTests: string[] = []) => snapshot(id, workflow(failedOld, "BLOCKED"), { evidence: oldFailing(names, newTests), alreadyFailing, facts: { checkOriginal: { unit: "failed" } } });

  it("counts and reports a check that failed before with a failing test outside the already-failing list (Y old, Z new), or one the change added; the verdict is Code failed", () => {
    const yz = task("t-yz", ["Y", "Z"], ["Y"]);
    const added = task("t-added", ["Y", "C"], ["Y", "C"], ["C"]);
    const known = task("t-known", ["Y"], ["Y"]);
    const report = replayResults([yz, added, known]);
    expect(report.suspect).toEqual(["t-yz", "t-added"]);
    expect(report.byVerdict).toMatchObject({ code_failed: 2, partially_verified: 1 });
    expect(report.ok).toBe(true);
    expect(replayText(report)).toContain("SUSPECT a check that failed before has a failing test the already-failing list does not show, or one the change added (must be Code failed): t-yz, t-added");
  });

  it("is a violation when a classifier does not call a suspect check Code failed (the oracle counts it as the code's fault)", () => {
    const yz = task("t-yz", ["Y", "Z"], ["Y"]);
    const asBlocked: ViewOf = () => ({ view: { schemaVersion: 1, result: "blocked_by_environment", reasons: ["fails_on_original_code"], rows: [{ label: "Unit tests", command: "pytest -q", status: "blocked", reason: "fails_on_original_code" }] } });
    const report = replayResults([yz], asBlocked);
    expect(report.codeLabelledEnvironment).toEqual(["t-yz"]);
    expect(report.suspect).toEqual(["t-yz"]);
    expect(report.ok).toBe(false);
    const asPartial: ViewOf = () => ({ view: { schemaVersion: 1, result: "partially_verified", reasons: ["known_failing_only"], rows: [{ label: "Unit tests", command: "pytest -q", status: "known_failing", reason: "known_failing_only" }] } });
    expect(replayResults([yz], asPartial).codeShownAsPassing).toEqual(["t-yz"]);
  });

  it("with no usable nightly (an empty list) every failing test of a check that failed before is suspect", () => {
    expect(replayResults([task("t-none", ["Y"], [])]).suspect).toEqual(["t-none"]);
    expect(hasCodeSignal(workflow(failedOld, "BLOCKED"), {}, oldFailing(["Y"]), [])).toBe(true);
    expect(hasCodeSignal(workflow(failedOld, "BLOCKED"), {}, oldFailing(["Y"]), ["Y"])).toBe(false);
  });
});

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
