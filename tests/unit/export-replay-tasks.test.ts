// Setup and test health VX-3: the task exporter for the replay check. Stored task items (unmarshalled DynamoDB items) become snapshots scripts/replay-results.ts reads: names hashed, no repository content, the same verdicts
// as the plain snapshots, the broker's own "already failing" computed from the raw nightly and marks, and every task that cannot be exported counted with a reason. No AWS call is made.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { EvidencePackSchema, NightlyBaselineSchema, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, projectPk, projectRevisionKey } from "@agentx/contracts";
import { SKIP_REASONS, exportReplayTasks, exportText, nameHash, readInputFile, redactPack, scrubWorkflow, unsafeStrings, writeSnapshots, type ExportInput } from "../../scripts/export-replay-tasks.js";
import { ReplaySnapshotSchema, readSnapshotFolder, replayResults } from "../../scripts/replay-results.js";

const ORG = `org_${"a".repeat(20)}` as const;
const PROJECT = "payments";
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86_400_000;
const SALT = "fixed-salt";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
// Content that must never leave: test names, labels, commands, folders, branches, titles.
const SECRET_TEST = "services/payments/tests/test_refund.py::test_secret_refund_rule";
const OTHER_TEST = "services/payments/tests/test_ledger.py::test_ledger_total";
const NEW_TEST = "services/payments/tests/test_new.py::test_brand_new";
const SECRETS = [SECRET_TEST, OTHER_TEST, NEW_TEST, "Payments unit tests", "services/payments", "pytest", "release/secret-branch", "Refund the customer"];
const policy = { required: [{ id: "unit", label: "Payments unit tests", kind: "test", command: { cwd: "services/payments", executable: "pytest", args: ["-q", "--secret-flag"], timeoutSeconds: 600 } }], optional: [], selectedOptionalIds: [], proposed: [] };
const workflow = (taskId: string, over: Record<string, unknown> = {}, state: "READY" | "BLOCKED" = "READY", blockReason?: string) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW_ISO }), definitionVersion: "1.1.0", revision: 7, stage: "VERIFY", state, ...(blockReason === undefined ? {} : { blockReason }), candidate, checkPolicy: policy,
  verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW_ISO, results: [{ checkId: "unit", status: "PASS" }] }, ...over,
});
const failedUnit = { verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW_ISO, results: [{ checkId: "unit", status: "FAILED" }] } };
const pack = (checks: Array<Record<string, unknown>> = [{}]) => EvidencePackSchema.parse({
  schemaVersion: 1, candidateDigest: candidate.digest, environment: { tier: "sandbox", envRevision: 1, services: [{ name: "stripe-mock", mode: "mocked" }], data: "synthetic", accounts: [] },
  checks: checks.map((entry) => ({ checkId: "unit", kind: "test", label: "Payments unit tests", before: "passed", after: "passed", class: "passing", durationMs: 5, exitCode: 0, ...entry })),
  selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [{ kind: "claim", id: "claim-1", text: "Refund the customer", reason: "no test" }],
});
const cleanPack = () => EvidencePackSchema.parse({ ...pack(), notTested: [] });
const oldFailing = (names: string[], newTests: string[] = []) => pack([{
  before: "failed", after: "failed", class: "already_failing",
  tests: { total: 10, passed: 10 - names.length, failed: names.length, skipped: 0, errored: 0, newTests, names: names.map((name) => ({ name, status: "failed" })) },
}]);
const task = (taskId: string, flow: unknown, over: Record<string, unknown> = {}) => ({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, orgId: ORG, project: PROJECT, title: "Refund the customer", createdAt: NOW_ISO, workflow: flow, ...over });
const TASKS = { verified: "00000000-0000-4000-8000-000000000001", env: "00000000-0000-4000-8000-000000000002", code: "00000000-0000-4000-8000-000000000003", known: "00000000-0000-4000-8000-000000000004" } as const;

/** The project's partition as the exporter finds it: the repositories' default branch, the last nightly and the marks. */
function projectItems(over: { branch?: string; ageMs?: number; failed?: string[]; marks?: Array<{ name: string; checkId: string }>; nightly?: boolean } = {}) {
  const items: Array<Record<string, unknown>> = [{ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "app", url: "https://github.com/acme/payments.git", path: "repo/app", defaultBranch: "main" }] } }];
  if (over.nightly !== false) {
    const failed = over.failed ?? [OTHER_TEST], finished = new Date(NOW - (over.ageMs ?? DAY)).toISOString();
    const baseline = NightlyBaselineSchema.parse({ recordedAt: finished, envRevision: 1, branch: over.branch ?? "main", headSha: "a".repeat(40), finishedAt: finished, tests: { total: 100, passed: 100 - failed.length, failed: failed.length, skipped: 0 }, failed, flaky: [] });
    items.push({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: ORG, project: PROJECT, baseline });
  }
  if (over.marks !== undefined) items.push({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#KNOWNFAILING", entityType: "TEST_ENV_KNOWN_FAILING", orgId: ORG, project: PROJECT, marks: over.marks.map((m) => ({ ...m, markedBy: "dev_a", markedAt: NOW_ISO, epoch: 1 })), version: 1, updatedAt: NOW_ISO });
  return items;
}
const failedOld = { stage: "VERIFY", ...failedUnit };
function fixture(): ExportInput {
  return {
    items: [
      ...projectItems({ marks: [{ name: SECRET_TEST, checkId: "unit" }] }),
      task(TASKS.verified, workflow(TASKS.verified, { stage: "REVIEW" })),
      task(TASKS.env, workflow(TASKS.env, { verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed)),
      // Failed before too, with a failing test the nightly and the marks do not show: Code failed.
      task(TASKS.code, workflow(TASKS.code, failedOld, "BLOCKED", WORKFLOW_BLOCK_REASONS.regressionFound)),
      // Failed before too, and every failing test is known (a mark, and the nightly): Partially verified.
      task(TASKS.known, workflow(TASKS.known, failedOld, "BLOCKED")),
    ],
    evidencePacks: { [TASKS.verified]: cleanPack(), [TASKS.code]: oldFailing([SECRET_TEST, NEW_TEST], [NEW_TEST]), [TASKS.known]: oldFailing([SECRET_TEST, OTHER_TEST]) },
    facts: { [TASKS.code]: { checkOriginal: { unit: "failed" }, ignoredKey: "x" }, [TASKS.known]: { checkOriginal: { unit: "failed" } } },
  };
}
const options = { now: NOW, salt: SALT };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(path.join(tmpdir(), "replay-export-")); dirs.push(dir); return dir; };

describe("what is exported", () => {
  it("turns task items into snapshots that scripts/replay-results.ts reads, with the same verdicts as the plain data", async () => {
    const result = await exportReplayTasks(fixture(), options);
    expect(result.skipped).toEqual([]);
    expect(result.snapshots.map((s) => s.taskId).sort()).toEqual(Object.values(TASKS).sort());
    for (const snapshot of result.snapshots) expect(ReplaySnapshotSchema.safeParse(snapshot).success, snapshot.taskId).toBe(true);
    const report = replayResults(result.snapshots);
    expect(report.unreadable).toEqual([]);
    expect(report.byVerdict).toMatchObject({ verified: 1, code_failed: 1, partially_verified: 1, blocked_by_environment: 1 });
    expect(report.ok).toBe(true);
    // The same tasks replayed from plain, unredacted snapshots (names as they are) give the same verdicts.
    const plain = [
      { taskId: TASKS.verified, workflow: workflow(TASKS.verified, { stage: "REVIEW" }), evidence: cleanPack(), alreadyFailing: [OTHER_TEST, { name: SECRET_TEST, checkId: "unit" }] },
      { taskId: TASKS.env, workflow: workflow(TASKS.env, { verification: undefined }, "BLOCKED", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), alreadyFailing: [OTHER_TEST, { name: SECRET_TEST, checkId: "unit" }] },
      { taskId: TASKS.code, workflow: workflow(TASKS.code, failedOld, "BLOCKED", WORKFLOW_BLOCK_REASONS.regressionFound), evidence: oldFailing([SECRET_TEST, NEW_TEST], [NEW_TEST]), alreadyFailing: [OTHER_TEST, { name: SECRET_TEST, checkId: "unit" }], facts: { checkOriginal: { unit: "failed" } } },
      { taskId: TASKS.known, workflow: workflow(TASKS.known, failedOld, "BLOCKED"), evidence: oldFailing([SECRET_TEST, OTHER_TEST]), alreadyFailing: [OTHER_TEST, { name: SECRET_TEST, checkId: "unit" }], facts: { checkOriginal: { unit: "failed" } } },
    ];
    const plainReport = replayResults(plain);
    expect(plainReport.byVerdict).toEqual(report.byVerdict);
    expect(plainReport.suspect.sort()).toEqual(report.suspect.sort());
  });

  it("keeps no repository content: no test name, label, command, folder, branch or title appears anywhere in a snapshot, and every string is a fixed word, an id, a time or a hash", async () => {
    const result = await exportReplayTasks(fixture(), options);
    const text = JSON.stringify(result.snapshots);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain("secret-flag");
    expect(text).not.toContain("stripe-mock");
    expect(unsafeStrings(result.snapshots, new Set(Object.values(WORKFLOW_BLOCK_REASONS)))).toBe(0);
    for (const snapshot of result.snapshots) {
      const flow = snapshot.workflow as { checkPolicy: { required: Array<{ id: string; kind: string; label: string; command: { cwd: string; executable: string; args: string[] } }> } };
      expect(flow.checkPolicy.required[0]).toMatchObject({ id: "unit", kind: "test", command: { args: [] } });
      expect(flow.checkPolicy.required[0]!.label).toMatch(/^h[0-9a-f]{31}$/u);
    }
  });

  it("rebuilds the evidence pack from counts, outcomes and hashed names alone: no output, service, finding, coverage line, URL or claim text", async () => {
    const rebuilt = redactPack(oldFailing([SECRET_TEST, NEW_TEST], [NEW_TEST]), SALT);
    expect(rebuilt.environment).toEqual({ tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] });
    expect(rebuilt.checks[0]).toMatchObject({ checkId: "unit", kind: "test", label: "unit", before: "failed", after: "failed", class: "already_failing" });
    expect(rebuilt.checks[0]!.tests!.names.map((t) => t.name)).toEqual([nameHash(SALT, SECRET_TEST), nameHash(SALT, NEW_TEST)]);
    expect(rebuilt.checks[0]!.tests!.newTests).toEqual([nameHash(SALT, NEW_TEST)]);
    expect(rebuilt.notTested).toEqual([{ kind: "claim", id: nameHash(SALT, "claim-1"), text: "", reason: "redacted" }]);
  });
});

describe("scrubbing a stored workflow", () => {
  it("replaces content fields at any depth (addresses stay URLs), keeps fixed words, numbers and ids, and empties argument lists", () => {
    const scrubbed = scrubWorkflow({
      state: "BLOCKED", path: "FULL", revision: 3, author: "Maya Singh", permalink: "https://slack.example/archives/C1/p1",
      nested: [{ url: "https://github.com/acme/payments/pull/4", note: "do not leak", command: { cwd: "services/payments", executable: "pytest", args: ["-q"] }, id: "unit", number: 4 }],
    }, SALT) as Record<string, unknown>;
    const text = JSON.stringify(scrubbed);
    for (const secret of ["Maya", "slack.example", "github.com", "do not leak", "services/payments", "pytest", "-q"]) expect(text, secret).not.toContain(secret);
    expect(scrubbed).toMatchObject({ state: "BLOCKED", path: "FULL", revision: 3, nested: [{ id: "unit", number: 4, command: { args: [] } }] });
    expect((scrubbed["nested"] as Array<{ url: string }>)[0]!.url).toMatch(/^https:\/\/redacted\.invalid\/[0-9a-f]{12}$/u);
    expect(scrubbed["permalink"]).toMatch(/^https:\/\/redacted\.invalid\/[0-9a-f]{12}$/u);
    expect(unsafeStrings(scrubbed)).toBe(0);
  });

  it("the shape check names anything else as unsafe: sentences, paths, file names, addresses and mixed text", () => {
    expect(unsafeStrings({ a: "A sentence with spaces", b: "services/payments", c: "file.py", d: "https://github.com/x", e: ["ok", "fine"] })).toBe(4);
    expect(unsafeStrings({ keyWith: "a path/inside", ok: "unit", id: "00000000-0000-4000-8000-000000000001", time: NOW_ISO, empty: "" })).toBe(1);
  });
});

describe("hashing", () => {
  it("a name is the same hash everywhere in one export (evidence, nightly, marks), differs between salts, and is not the name", async () => {
    const a = await exportReplayTasks(fixture(), options), b = await exportReplayTasks(fixture(), { ...options, salt: "another" }), c = await exportReplayTasks(fixture(), options);
    const known = a.snapshots.find((s) => s.taskId === TASKS.known)!;
    const hashes = (snapshot: typeof known) => ({
      pack: (snapshot.evidence as { checks: Array<{ tests: { names: Array<{ name: string }> } }> }).checks[0]!.tests.names.map((n) => n.name),
      list: snapshot.alreadyFailing, nightly: snapshot.known?.nightly?.failed, marks: snapshot.known?.marks.map((m) => m.name),
    });
    const h = hashes(known);
    expect(h.pack).toEqual([nameHash(SALT, SECRET_TEST), nameHash(SALT, OTHER_TEST)]);
    expect(h.nightly).toEqual([nameHash(SALT, OTHER_TEST)]);
    expect(h.marks).toEqual([nameHash(SALT, SECRET_TEST)]);
    expect(h.list).toContain(nameHash(SALT, OTHER_TEST));
    expect(JSON.stringify(a.snapshots)).toEqual(JSON.stringify(c.snapshots));
    expect(JSON.stringify(a.snapshots)).not.toEqual(JSON.stringify(b.snapshots));
    expect(nameHash(SALT, SECRET_TEST)).not.toContain("secret");
  });
});

describe("already failing, as the broker's rules would have been given it, and the raw data beside it", () => {
  it("lists a usable nightly's failures and the marks (in their own check), hashed", async () => {
    const result = await exportReplayTasks(fixture(), options);
    const snapshot = result.snapshots.find((s) => s.taskId === TASKS.code)!;
    expect(snapshot.alreadyFailing).toEqual([nameHash(SALT, OTHER_TEST), { name: nameHash(SALT, SECRET_TEST), checkId: "unit" }]);
    expect(snapshot.known).toMatchObject({ now: NOW_ISO, branches: [nameHash(SALT, "main")], nightly: { branch: nameHash(SALT, "main"), failedCount: 1 }, marks: [{ name: nameHash(SALT, SECRET_TEST), checkId: "unit" }] });
  });

  it("lists no nightly failure when the nightly is older than 7 days, from another branch, or absent, yet keeps the raw baseline for the oracle", async () => {
    for (const items of [projectItems({ ageMs: 10 * DAY }), projectItems({ branch: "release/secret-branch" }), projectItems({ nightly: false })]) {
      const input = { ...fixture(), items: [...items, task(TASKS.code, workflow(TASKS.code, failedOld, "BLOCKED"))] };
      const [snapshot] = (await exportReplayTasks(input, options)).snapshots;
      expect(snapshot!.alreadyFailing).toEqual([]);
    }
    const [stale] = (await exportReplayTasks({ items: [...projectItems({ ageMs: 10 * DAY }), task(TASKS.code, workflow(TASKS.code, failedOld, "BLOCKED"))] }, options)).snapshots;
    expect(stale!.known?.nightly?.failed).toEqual([nameHash(SALT, OTHER_TEST)]);
  });

  it("uses the branches the task's open pull requests target, when it has any", async () => {
    const items = [...projectItems(), task(TASKS.code, workflow(TASKS.code, failedOld, "BLOCKED")), { pk: `DEVTASK#${TASKS.code}`, sk: "MERGE_TRACKING#1", state: "open", baseBranch: "release/secret-branch" }];
    const [snapshot] = (await exportReplayTasks({ items }, options)).snapshots;
    expect(snapshot!.alreadyFailing).toEqual([]);
    expect(snapshot!.known?.branches).toEqual([nameHash(SALT, "release/secret-branch")]);
  });
});

describe("tasks that cannot be exported are counted with a reason, never written", () => {
  const base = () => workflow(TASKS.code, failedOld, "BLOCKED", WORKFLOW_BLOCK_REASONS.regressionFound);
  const reasonsOf = async (input: ExportInput) => (await exportReplayTasks(input, options)).skipped.map((s) => s.reason);
  it("names each reason", async () => {
    const items = projectItems();
    expect(await reasonsOf({ items: [...items, task(TASKS.code, undefined)] })).toEqual(["no_workflow"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, { not: "a workflow" })] })).toEqual(["unreadable_workflow"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, workflow(TASKS.code, { definitionVersion: "1.0.0" }))] })).toEqual(["not_version_1_1"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, workflow(TASKS.code, { candidate: undefined, verification: undefined }))] })).toEqual(["no_candidate"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, base(), { orgId: undefined })] })).toEqual(["no_company_or_project"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, base())], evidencePacks: { [TASKS.code]: { schemaVersion: 1 } } })).toEqual(["unreadable_evidence"]);
    expect(await reasonsOf({ items: [...items, task(TASKS.code, workflow(TASKS.code, failedOld, "BLOCKED", "Some sentence nobody can classify."))] })).toEqual(["block_reason_unknown"]);
    for (const reason of await reasonsOf({ items: [...items, task(TASKS.code, undefined)] })) expect(SKIP_REASONS).toContain(reason);
  });

  it("keeps a task with a pull request: its address becomes a placeholder that is still a URL, and nothing of the address is kept", async () => {
    const pullRequests = [{ repositoryId: "app", number: 4, url: "https://github.com/acme/payments/pull/4", headSha: "4".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }];
    const flow = workflow(TASKS.verified, { stage: "REVIEW", pullRequests });
    const result = await exportReplayTasks({ items: [...projectItems(), task(TASKS.verified, flow)], evidencePacks: { [TASKS.verified]: cleanPack() } }, options);
    expect(result.skipped).toEqual([]);
    const text = JSON.stringify(result.snapshots);
    expect(text).not.toContain("github.com");
    expect(text).not.toContain("acme/payments");
    expect((result.snapshots[0]!.workflow as { pullRequests: Array<{ url: string; number: number; state: string }> }).pullRequests[0]).toMatchObject({ number: 4, state: "OPEN", });
    expect((result.snapshots[0]!.workflow as { pullRequests: Array<{ url: string }> }).pullRequests[0]!.url).toMatch(/^https:\/\/redacted\.invalid\/[0-9a-f]{12}$/u);
    expect(replayResults(result.snapshots).byVerdict).toEqual(replayResults([{ taskId: TASKS.verified, workflow: flow, evidence: cleanPack(), alreadyFailing: [OTHER_TEST] }]).byVerdict);
  });

  it("refuses a snapshot that would still hold free text (a repository id that is a path)", async () => {
    const odd = createCandidateManifest([{ repositoryId: "acme/payments", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
    const flow = workflow(TASKS.code, { candidate: odd, verification: undefined });
    const result = await exportReplayTasks({ items: [...projectItems(), task(TASKS.code, flow)] }, options);
    expect(result.skipped).toEqual([{ taskId: TASKS.code, reason: "content_left" }]);
    expect(result.snapshots).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("acme/payments");
  });

  describe("the follow-up full run", () => {
    const needsFullRun = () => EvidencePackSchema.parse({ ...cleanPack(), selection: { method: "full", selected: 1, total: 10, fallbackReason: "map_missing" }, checks: pack([{ after: "not_run", class: "passing" }]).checks });
    const followup = (state: string) => [
      { pk: projectPk(ORG, PROJECT), sk: `FULLRUN#${TASKS.verified}#${candidate.digest.slice(0, 16)}`, entityType: "FULLRUN", candidateDigest: candidate.digest, headSha: "a".repeat(40), queuedAt: NOW_ISO, queuedAtMs: NOW, state },
      { pk: projectPk(ORG, PROJECT), sk: `FULLRUN_LATEST#${TASKS.verified}`, entityType: "FULLRUN_LATEST", digest: candidate.digest },
    ];
    const run = (extra: unknown[]) => exportReplayTasks({ items: [...projectItems(), task(TASKS.verified, workflow(TASKS.verified, { stage: "REVIEW" })), ...extra], evidencePacks: { [TASKS.verified]: needsFullRun() } }, options);
    it("a failed one shows no result, so there is nothing to replay", async () => {
      expect((await run(followup("failed"))).skipped).toEqual([{ taskId: TASKS.verified, reason: "full_run_failed" }]);
    });
    it("a pending one, or none, is the plan's state in the snapshot", async () => {
      expect((await run(followup("running"))).snapshots[0]!.planned).toEqual({ fullSuite: "pending" });
      expect((await run([])).snapshots[0]!.planned).toEqual({ fullSuite: "not_run" });
      expect((await run(followup("passed"))).snapshots[0]!.planned).toEqual({ fullSuite: "not_needed" });
    });
  });
});

describe("the facts", () => {
  it("keeps only the facts a replay reads", async () => {
    const result = await exportReplayTasks(fixture(), options);
    expect(result.snapshots.find((s) => s.taskId === TASKS.code)!.facts).toEqual({ checkOriginal: { unit: "failed" } });
    expect(result.snapshots.find((s) => s.taskId === TASKS.verified)!.facts).toBeUndefined();
  });
});

describe("the input and the output", () => {
  it("reads an array of items, an object with sidecars, or DynamoDB JSON with --marshalled, to the same export", async () => {
    const dir = tmp(), input = fixture();
    const plain = path.join(dir, "object.json"), array = path.join(dir, "array.json"), typed = path.join(dir, "typed.json");
    writeFileSync(plain, JSON.stringify(input));
    writeFileSync(array, JSON.stringify(input.items));
    writeFileSync(typed, JSON.stringify({ ...input, items: input.items.map((item) => marshall(item as Record<string, unknown>, { removeUndefinedValues: true })) }));
    const viaObject = await exportReplayTasks(readInputFile(plain, false), options);
    const viaTyped = await exportReplayTasks(readInputFile(typed, true), options);
    expect(JSON.stringify(viaTyped.snapshots)).toEqual(JSON.stringify(viaObject.snapshots));
    const viaArray = await exportReplayTasks(readInputFile(array, false), options);
    expect(viaArray.snapshots).toHaveLength(4);
    expect(viaArray.snapshots.find((s) => s.taskId === TASKS.verified)!.evidence).toBeUndefined();
  });

  it("writes one file per task that the replay script reads from a folder, and says counts and ids only", async () => {
    const dir = tmp(), result = await exportReplayTasks({ ...fixture(), items: [...(fixture().items as unknown[]), { junk: true }, "not an item"] }, options);
    writeSnapshots(path.join(dir, "out"), result.snapshots);
    const read = readSnapshotFolder(path.join(dir, "out"));
    expect(read).toHaveLength(4);
    expect(replayResults(read).ok).toBe(true);
    const text = exportText(result, "out");
    expect(text).toContain("Exported 4 tasks to out; skipped 0; 1 input entries were not items.");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(readFileSync(path.join(dir, "out", `${TASKS.code}.json`), "utf8")).not.toContain(SECRET_TEST);
  });

  it("exports the newest tasks first and at most --limit", async () => {
    const items = [...projectItems(), task(TASKS.verified, workflow(TASKS.verified), { createdAt: "2026-11-01T00:00:00.000Z" }), task(TASKS.env, workflow(TASKS.env), { createdAt: "2026-11-09T00:00:00.000Z" })];
    const result = await exportReplayTasks({ items }, { ...options, limit: 1 });
    expect(result.snapshots.map((s) => s.taskId)).toEqual([TASKS.env]);
  });
});

describe("the script makes no AWS call", () => {
  it("imports no AWS client and says every staging command goes through staging-aws.sh", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/export-replay-tasks.ts"), "utf8");
    expect(source).not.toMatch(/@aws-sdk\/client-/u);
    expect(source).not.toMatch(/new \w*Client\(/u);
    expect(source).toContain("staging-aws.sh");
    expect(source).toContain("rovara-tools/staging-aws.sh");
    expect(source).toMatch(/NO AWS call/u);
  });
});
