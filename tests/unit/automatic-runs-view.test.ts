// What a project's page says about its automatic runs: "Started by Rovara (nightly)", the project's own "Automatic runs" line, the pause, and the reminder when the person who approved the setup has left.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, orgMemberKey, projectMetaKey, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { setAutomaticRunsCap } from "../../packages/broker/src/automatic-runs/cap.js";
import { startAutomaticRun } from "../../packages/broker/src/automatic-runs/start.js";
import { APPROVER_LEFT_WORDS, AUTOMATIC_RUNS_PAUSED_WORDS, automaticRunsView, recentAutomaticRuns, reviewReminderOf } from "../../packages/broker/src/automatic-runs/view.js";
import { approveTestEnvironment, proposeTestEnvironment, recordTestEnvProveReport, type TestEnvDeps } from "../../packages/broker/src/org/test-environment.js";
import type { AgentRunRequest } from "../../packages/broker/src/agents/runs.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "partner-service";
const T0 = Date.UTC(2026, 10, 5, 6, 0, 5);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const body = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }], roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

async function bench(options: { approver?: string; member?: boolean } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...projectMetaKey(ORG, PROJECT), status: "active" });
  const clock = { now: T0 };
  const audit = capturingAuditDeps({ db });
  const deps: TestEnvDeps = { documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, secondPerson: () => Promise.resolve({ mode: "second_person" as const, membershipVersion: 1, conditions: [] }) };
  const approve = async (approvedBy: string, expectedRevision: number, requestId: string) => {
    const proposal = await proposeTestEnvironment(deps, { orgId: ORG, project: PROJECT, proposedBy: approvedBy, role: "maintainer", body: { ...body(), roundBudgetMin: 30 + expectedRevision } });
    await recordTestEnvProveReport(deps, { orgId: ORG, project: PROJECT, report: { schemaVersion: 1, proposalDigest: proposal.digest, steps: [{ step: "smoke", status: "passed", durationMs: 1 }], services: [], finishedAt: "2026-11-05T00:00:00.000Z" } });
    await approveTestEnvironment(deps, { orgId: ORG, project: PROJECT, digest: proposal.digest, expectedRevision, requestId, approvedBy, role: "maintainer", approvedBySignedInAtMs: T0, approval: { approverId: "dev_b", signedInAtMs: T0, sessionRef: "5".repeat(64) } });
  };
  if (options.approver !== undefined) await approve(options.approver, 0, "request-view-0001");
  if (options.approver !== undefined && options.member === true) db.set({ ...orgMemberKey(ORG, options.approver), entityType: "ORG_MEMBER", developerId: options.approver, role: "member" });
  const started: AgentRunRequest[] = [];
  const run = { ...deps, startAgentRun: (request: AgentRunRequest) => { started.push(request); return Promise.resolve({ taskId: `task-${String(started.length)}`, runLimitUsd: 1, stopAtUsd: 1, paused: false }); } };
  const job = (n: number, extra: Record<string, unknown> = {}) => ({ orgId: ORG, project: PROJECT, job: "nightly" as const, requestId: id(n), agent: { agentId: "rovara-code" as const }, input: { text: "Nightly test run." }, origin: "automatic" as const, purpose: "saved_env_rebuild" as const, ...extra });
  return { db, clock, deps, audit, run, started, job, approve };
}

describe("the approver-left reminder", () => {
  it("asks a maintainer to review the setup when the person who approved it is no longer in the company, and the runs go on", async () => {
    const b = await bench({ approver: "dev_gone", member: false });
    const reminder = await reviewReminderOf(b.deps, ORG, PROJECT);
    expect(reminder).toEqual({ kind: "approver_left", revision: 1, words: APPROVER_LEFT_WORDS });
    // the runs are not touched by it
    expect(await startAutomaticRun(b.run, b.job(1, { setupApprovedBy: "dev_gone" }))).toMatchObject({ started: { taskId: "task-1" } });
  });

  it("is not shown while the approver is still a member", async () => {
    const b = await bench({ approver: "dev_here", member: true });
    expect(await reviewReminderOf(b.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("an approver whose account was merged into a member's is not someone who left", async () => {
    const b = await bench({ approver: "dev_old", member: false });
    b.db.set({ ...orgMemberKey(ORG, "dev_survivor"), entityType: "ORG_MEMBER", developerId: "dev_survivor", role: "member" });
    const resolve = (developerId: string) => Promise.resolve(developerId === "dev_old" ? "dev_survivor" : developerId);
    expect(await reviewReminderOf(b.deps, ORG, PROJECT)).toBeDefined();
    expect(await reviewReminderOf(b.deps, ORG, PROJECT, { resolveSurvivor: resolve })).toBeUndefined();
    // a merge that cannot be read says nothing
    expect(await reviewReminderOf(b.deps, ORG, PROJECT, { resolveSurvivor: () => Promise.reject(new Error("boom")) })).toBeUndefined();
  });

  it("is cleared by a new approval: the new approver is the one asked about", async () => {
    const b = await bench({ approver: "dev_gone", member: false });
    expect(await reviewReminderOf(b.deps, ORG, PROJECT)).toBeDefined();
    b.db.set({ ...orgMemberKey(ORG, "dev_new"), entityType: "ORG_MEMBER", developerId: "dev_new", role: "maintainer" });
    await b.approve("dev_new", 1, "request-view-0002");
    expect(await reviewReminderOf(b.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("is not shown when there is no approved setup or the approver cannot be read (advice on a doubt is no advice)", async () => {
    const none = await bench();
    expect(await reviewReminderOf(none.deps, ORG, PROJECT)).toBeUndefined();
    const b = await bench({ approver: "dev_gone", member: false });
    const broken = { ...b.deps, documentClient: { send: (command: unknown) => (JSON.stringify((command as { input?: unknown }).input ?? {}).includes("MEMBER") ? Promise.reject(new Error("boom")) : b.db.send(command as never)) } };
    expect(await reviewReminderOf(broken, ORG, PROJECT)).toBeUndefined();
  });
});

describe("what the project page reads", () => {
  it("shows the runs as 'Started by Rovara (nightly)', newest first, with where each stands, and no task id", async () => {
    const b = await bench({ approver: "dev_here", member: true });
    await startAutomaticRun(b.run, b.job(1));
    b.clock.now += 3_600_000;
    await startAutomaticRun(b.run, b.job(2, { job: "image_rebuild" }));
    // the first run ended: its task says how
    b.db.set({ ...taskKey("task-1"), entityType: "DEVELOPER_TASK", taskId: "task-1", orgId: ORG, project: PROJECT, agentRunEnd: { state: "COMPLETE", at: "2026-11-05T07:00:00.000Z" } });
    b.db.set({ ...taskKey("task-2"), entityType: "DEVELOPER_TASK", taskId: "task-2", orgId: ORG, project: PROJECT });
    const recent = await recentAutomaticRuns(b.deps, ORG, PROJECT);
    expect(recent).toEqual([
      { job: "image_rebuild", words: "Started by Rovara (image rebuild)", startedAt: new Date(T0 + 3_600_000).toISOString(), state: "running" },
      { job: "nightly", words: "Started by Rovara (nightly)", startedAt: new Date(T0).toISOString(), state: "complete" },
    ]);
    expect(JSON.stringify(recent)).not.toContain("task-");
  });

  it("leaves out a run whose task belongs to another project, rather than show what it is not", async () => {
    const b = await bench();
    await startAutomaticRun(b.run, b.job(1));
    b.db.set({ ...taskKey("task-1"), entityType: "DEVELOPER_TASK", taskId: "task-1", orgId: ORG, project: "someone-elses" });
    expect(await recentAutomaticRuns(b.deps, ORG, PROJECT)).toEqual([]);
  });

  it("carries the project's own 'Automatic runs' line, and says so plainly when the cap has paused them", async () => {
    const b = await bench();
    await setAutomaticRunsCap(b.deps, { orgId: ORG, project: PROJECT, role: "maintainer", changedBy: "dev_m", cap: 1, requestId: "request-cap-0001" });
    expect((await automaticRunsView(b.deps, ORG, PROJECT)).line).toMatchObject({ label: "Automatic runs", words: "Automatic runs: 0 of 1 this month", paused: false });
    expect((await automaticRunsView(b.deps, ORG, PROJECT)).pausedWords).toBeUndefined();
    await startAutomaticRun(b.run, b.job(1));
    const paused = await automaticRunsView(b.deps, ORG, PROJECT);
    expect(paused.line).toMatchObject({ words: "Automatic runs: 1 of 1 this month", paused: true });
    expect(paused.pausedWords).toBe(AUTOMATIC_RUNS_PAUSED_WORDS(1));
    expect(paused.recent).toHaveLength(1);
  });
});
