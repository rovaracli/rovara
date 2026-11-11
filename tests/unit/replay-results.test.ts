// Setup and test health SH20: the replay check. A code failure must never be labelled as environment (or shown as passing); an unreadable snapshot fails the run; the output names task ids and counts only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidencePackSchema, createCandidateManifest } from "@rovara-code/contracts";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createWorkflowSnapshot } from "@agentx/cloud-contracts";
import { hasCodeSignal, hasUnconfirmedFailure, knownSetsOf, readSnapshotFolder, replayOne, replayResults, replayText, type RawKnown, type ViewOf } from "../../scripts/replay-results.js";

const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const NOW = "2026-11-02T12:00:00.000Z";
const policy = { required: [{ id: "unit", label: "Unit tests", kind: "test", command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 } }], optional: [], selectedOptionalIds: [], proposed: [] };
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

  it("a lint (or a check the list does not call a test) with no pack keeps the old rule: not suspect, Blocked by environment", () => {
    const lintList = { ...policy, required: [{ ...policy.required[0]!, kind: "lint" }] };
    const lint = snapshot("t-lint", workflow({ ...failedOld, checkPolicy: lintList }, "BLOCKED"), { alreadyFailing: ["Y"], facts: { checkOriginal: { unit: "failed" } } });
    const report = replayResults([lint]);
    expect(report.suspect).toEqual([]);
    expect(report.byVerdict).toMatchObject({ blocked_by_environment: 1 });
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


describe("the oracle judges 'already failing' from the raw data itself (VX-3)", () => {
  const NOW_RAW = "2026-11-10T12:00:00.000Z", DAY = 86_400_000, at = (ms: number) => new Date(Date.parse(NOW_RAW) - ms).toISOString();
  type RawOver = Omit<Partial<RawKnown>, "nightly"> & { nightly?: Partial<NonNullable<RawKnown["nightly"]>> | null };
  const raw = (over: RawOver = {}): RawKnown => {
    const { nightly, ...rest } = over;
    return { now: NOW_RAW, branches: ["hmain"], marks: [], ...(nightly === null ? {} : { nightly: { branch: "hmain", finishedAt: at(DAY), failedCount: 1, failed: ["hY"], flaky: [], ...nightly } }), ...rest };
  };
  const task = (id: string, names: string[], list: Array<string | { name: string; checkId: string }>, known?: RawKnown) => snapshot(id, workflow(failedOld, "BLOCKED"), { evidence: oldFailing(names), alreadyFailing: list, facts: { checkOriginal: { unit: "failed" } }, ...(known === undefined ? {} : { known }) });

  it("counts a nightly only when it is whole, not from the future, at most 7 days old and from exactly the branches the task is based on", () => {
    expect([...knownSetsOf([], raw()).any]).toEqual(["hY"]);
    expect([...knownSetsOf([], raw({ nightly: { finishedAt: at(7 * DAY) } })).any]).toEqual(["hY"]);
    for (const [label, known] of [
      ["8 days old", raw({ nightly: { finishedAt: at(8 * DAY) } })], ["from the future", raw({ nightly: { finishedAt: at(-2 * 3_600_000) } })], ["another branch", raw({ nightly: { branch: "hrelease" } })],
      ["one branch of two", raw({ branches: ["hmain", "hrelease"] })], ["no branch known", raw({ branches: [] })], ["a truncated list", raw({ nightly: { failedCount: 3 } })], ["none", raw({ nightly: null })],
    ] as const) expect([...knownSetsOf(["hY"], known).any], label).toEqual([]);
  });

  it("takes the marks from the raw data, each for its own check, whatever the snapshot's own list says", () => {
    const sets = knownSetsOf(["hZ", { name: "hW", checkId: "unit" }], raw({ marks: [{ name: "hM", checkId: "lint" }] }));
    expect([...sets.any]).toEqual(["hY"]);
    expect([...sets.perCheck]).toEqual(["lint\u0000hM"]);
    expect([...knownSetsOf(["hZ", { name: "hW", checkId: "unit" }], undefined).perCheck]).toEqual(["unit\u0000hW"]);
  });

  it("flags a code failure the rules excuse on a wrong 'already failing' list that the raw data does not support (a stale nightly counted)", () => {
    const wrong = task("t-stale", ["hY", "hZ"], ["hY", "hZ"], raw({ nightly: { finishedAt: at(30 * DAY), failedCount: 2, failed: ["hY", "hZ"] } }));
    const report = replayResults([wrong]);
    expect(report.byVerdict).toMatchObject({ partially_verified: 1 });
    expect(report.codeShownAsPassing).toEqual(["t-stale"]);
    expect(report.suspect).toEqual(["t-stale"]);
    expect(report.ok).toBe(false);
    // Without the raw data the oracle can only believe the list, as before.
    expect(replayResults([task("t-stale", ["hY", "hZ"], ["hY", "hZ"])]).ok).toBe(true);
  });

  it("flags a name excused in the wrong check, and one the nightly of another branch lists", () => {
    const otherCheck = task("t-check", ["hY"], [{ name: "hY", checkId: "unit" }], raw({ nightly: null, marks: [{ name: "hY", checkId: "lint" }] }));
    const otherBranch = task("t-branch", ["hY"], ["hY"], raw({ nightly: { branch: "hrelease" } }));
    expect(replayResults([otherCheck, otherBranch]).codeShownAsPassing).toEqual(["t-check", "t-branch"]);
  });

  it("does not flag what the raw data confirms, even when the rules did not (a stricter rule is not a violation)", () => {
    const confirmed = task("t-ok", ["hY"], ["hY"], raw());
    const rulesForgot = task("t-forgot", ["hY"], [], raw());
    const report = replayResults([confirmed, rulesForgot]);
    expect(report.codeShownAsPassing).toEqual([]);
    expect(report.byVerdict).toMatchObject({ partially_verified: 1, code_failed: 1 });
    expect(report.ok).toBe(true);
  });

  it("is independent of the result rules' own helpers: the script imports none of them", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/replay-results.ts"), "utf8");
    for (const helper of ["hasUnconfirmedFailingTest", "readableFailingTests", "hasNoTestData", "testCheckFailedBeforeWithoutData", "workflowCheckKind", "newFailingCheckIds"]) expect(source, helper).not.toContain(helper);
    expect(source).not.toMatch(/import (?!type)[^;]*verification\/result\.js/u);
  });

  describe("hasUnconfirmedFailure compares the failing tests with the known sets directly", () => {
    const check = (over: Record<string, unknown>, kind = "test") => pack([{ before: "failed", after: "failed", class: "already_failing", kind, ...over }]).checks[0]!;
    const tests = (names: Array<[string, "failed" | "errored" | "passed"]>, extra: Record<string, unknown> = {}) => {
      const failed = names.filter(([, status]) => status === "failed").length, errored = names.filter(([, status]) => status === "errored").length;
      return { tests: { total: names.length, passed: names.length - failed - errored, failed, skipped: 0, errored, newTests: [], names: names.map(([name, status]) => ({ name, status })), ...extra } };
    };
    const known = { any: new Set(["Y"]), perCheck: new Set(["unit\u0000M"]) };
    it.each([
      ["every failing test known (any check)", tests([["Y", "failed"], ["ok", "passed"]]), false],
      ["a failing test known by a mark in this check", tests([["M", "failed"]]), false],
      ["an errored test counts as failing, and is known by its mark", tests([["Y", "failed"], ["M", "errored"]]), false],
      ["an errored test nobody knows", tests([["Y", "failed"], ["Q", "errored"]]), true],
      ["a failing test nobody knows", tests([["Y", "failed"], ["Z", "failed"]]), true],
      ["a test the change added, even when known", tests([["Y", "failed"]], { newTests: ["Y"] }), true],
      ["fewer names than the count", { tests: { total: 3, passed: 1, failed: 2, skipped: 0, errored: 0, newTests: [], names: [{ name: "Y", status: "failed" }] } }, true],
      ["a name twice", { tests: { total: 3, passed: 1, failed: 2, skipped: 0, errored: 0, newTests: [], names: [{ name: "Y", status: "failed" }, { name: "Y", status: "failed" }] } }, true],
      ["a count of zero on a failed test check", tests([["a", "passed"]]), true],
    ])("%s", (_label, body, unconfirmed) => { expect(hasUnconfirmedFailure(check(body), known)).toBe(unconfirmed); });
    it("a mark for another check does not confirm, and a check with no test data is judged by its kind", () => {
      expect(hasUnconfirmedFailure({ ...check(tests([["M", "failed"]])), checkId: "lint" }, known)).toBe(true);
      expect(hasUnconfirmedFailure(check({}, "test"), known)).toBe(true);
      expect(hasUnconfirmedFailure(check({}, "lint"), known)).toBe(false);
    });
  });
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
