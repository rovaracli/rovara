// SRL-5a: the hourly job's repository check with a real runtime and the fake table: a recorded repository that GitHub no longer shows its installation is removed (the tap's own tombstone, and
// its source row reads as failing); nothing is removed on an error, for an install with no App, or for a repository already removed; the check runs AFTER every company's delete and erase work, inside
// the job's budget, with a deadline on every GitHub call, and walks the companies from where the last run stopped.
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type OrgId } from "@rovara-code/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import type { InstallationRepositoriesPort } from "../../../packages/broker/src/team-record/github-repo-existence.js";
import { getSourceConfigByScope, putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { opsFailuresCheck } from "../../../packages/broker/src/team-record/ops-failures.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const ORG_A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const table = (db: FakeDynamoDb) => ({ documentClient: db as never, tableName: "TeamRecord" });

/** An org with one project that records `repositories` (all pinned to `installationId`). */
async function addOrg(db: FakeDynamoDb, orgId: OrgId, installationId: number, repositories: number[]): Promise<void> {
  db.set({ ...orgProjectCatalogKey(orgId, "web"), entityType: "PROJECT_CATALOG" });
  const pinned = repositories.map((id) => ({ name: `r${id}`, url: `https://github.com/acme/r${id}.git`, path: `repo/r${id}`, defaultBranch: "main", credentialRef: "github-app", installationId, githubRepositoryId: id }));
  db.set({ ...projectRevisionKey(orgId, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1, repositories: pinned, setup: [], readiness: [], orchestratorInstructions: "Delegate work." }, runtimeBinding: {} });
  for (const id of repositories) {
    await putSourceConfig(table(db), { workspaceId: orgId, project: "web", source: "github", scope: `github:repo/${id}`, enabled: true, retention: "D", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
  }
  db.set({ pk: "TEAM_RECORD_ORGS", sk: orgId, entityType: "TEAM_RECORD_ORG", orgId, at: "2026-10-30T10:00:00.000Z" });
}

interface Installation { listed: number[]; direct?: Record<number, "exists" | "missing" | "throw">; throws?: boolean; hangs?: boolean; onOpen?: () => void }
function build(db: FakeDynamoDb, installations: Record<number, Installation>, extra: Partial<Parameters<typeof createTeamRecordRuntime>[0]> = {}) {
  const calls = { open: [] as number[], status: [] as number[], signals: [] as Array<AbortSignal | undefined> };
  const githubRepositories: InstallationRepositoriesPort = {
    async open(installationId, _workspace, signal) {
      calls.open.push(installationId);
      calls.signals.push(signal);
      const installation = installations[installationId]!;
      installation.onOpen?.();
      if (installation.hangs) return new Promise<never>(() => undefined);
      if (installation.throws) throw new Error("403");
      return {
        ids: installation.listed, complete: true,
        async status(repositoryId) { calls.status.push(repositoryId); const answer = installation.direct?.[repositoryId] ?? "missing"; if (answer === "throw") throw new Error("500"); return answer; },
      };
    },
  };
  const logs: Array<Record<string, unknown>> = [];
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, log: (entry) => logs.push(entry), githubRepositories, ...extra });
  if (runtime === undefined) throw new Error("the runtime was not built");
  const health = async (orgId: OrgId, id: number) => (await getSourceConfigByScope(table(db), orgId, "github", `github:repo/${id}`))?.health;
  return { runtime, calls, logs, health };
}

describe("the hourly job's repository check", () => {
  it("removes the record's copy of a repository the installation no longer shows (its source row reads as failing), and does not ask about it again", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900, 901, 902] } });
    const first = await w.runtime.jobs.run("hourly");
    expect(first.details).toMatchObject({ githubReposChecked: 1, githubReposRemoved: 1, githubReposFailed: 0 });
    expect(await w.health(ORG_A, 101)).toBe("failing");
    const opened = w.calls.open.length;
    const second = await w.runtime.jobs.run("hourly");
    expect(second.details.githubReposChecked).toBeUndefined();
    expect(w.calls.open).toHaveLength(opened);
  });

  it("leaves a repository the installation still lists", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [101, 900] } });
    const summary = await w.runtime.jobs.run("hourly");
    expect(summary.details).toMatchObject({ githubReposChecked: 1, githubReposRemoved: 0 });
    expect(await w.health(ORG_A, 101)).toBe("unknown");
    expect(w.calls.status).toEqual([]);
  });

  it("removes nothing when GitHub cannot be asked clearly (an error, an unclear lookup), and counts it", async () => {
    for (const installation of [{ listed: [900], throws: true }, { listed: [900], direct: { 101: "throw" as const } }]) {
      const db = new FakeDynamoDb({ indexKeys });
      await addOrg(db, ORG_A, 55, [101]);
      const w = build(db, { 55: installation });
      const summary = await w.runtime.jobs.run("hourly");
      expect(summary.details).toMatchObject({ githubReposRemoved: 0, githubReposUnknown: 1 });
      expect(await w.health(ORG_A, 101)).toBe("unknown");
    }
  });

  it("is not run by the nightly job", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900] } });
    await w.runtime.jobs.run("nightly");
    expect(w.calls.open).toEqual([]);
  });
});

describe("a source row the check removed can be brought back (R4)", () => {
  it("saving the row again opens the place and the row stops reading `failing`, so the next check looks at it again", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900] } });
    await w.runtime.jobs.run("hourly");
    expect(await w.health(ORG_A, 101)).toBe("failing");
    const row = (await getSourceConfigByScope(table(db), ORG_A, "github", "github:repo/101"))!;
    expect((await putSourceConfig(table(db), row, { edition: "enterprise" })).status).toBe("saved");
    expect(await w.health(ORG_A, 101)).toBe("unknown");
  });
});

describe("a narrowed installation shows on THAT company's Health only (R2)", () => {
  it("3 of 10 recorded repositories not listed removes none and counts once under company B; company A's Health shows nothing of it", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const ids = Array.from({ length: 10 }, (_, index) => 201 + index);
    await addOrg(db, ORG_B, 66, ids);
    const w = build(db, { 55: { listed: [101] }, 66: { listed: ids.slice(3) } });
    const summary = await w.runtime.jobs.run("hourly");
    expect(summary.details).toMatchObject({ githubReposRemoved: 0, githubReposRefused: 1 });
    expect(await w.health(ORG_B, 201)).toBe("unknown");
    expect(await w.runtime.opsFailures(ORG_B)).toMatchObject({ repoCheck: 1 });
    const a = await w.runtime.opsFailures(ORG_A);
    expect(a).toEqual({ eraseSweep: 0, tombstone: 0 });
    expect(opsFailuresCheck(a).status).toBe("ok");
    expect(opsFailuresCheck(await w.runtime.opsFailures(ORG_B))).toMatchObject({ status: "warn" });
  });

  it("a removal no durable path took is counted for that company through its own `tombstone` counter, once (not twice)", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    await addOrg(db, ORG_B, 66, [201]);
    const w = build(db, { 55: { listed: [101] }, 66: { listed: [900] } });
    // The record table refuses the tombstone's writes for org B only.
    const real = db.send.bind(db);
    (db as { send: unknown }).send = async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      if (JSON.stringify(command.input ?? {}).includes(ORG_B) && ["UpdateCommand", "TransactWriteCommand"].includes(command.constructor.name) && !JSON.stringify(command.input).includes("OPSFAIL#")) throw new Error("table down");
      return real(command as never);
    };
    await w.runtime.jobs.run("hourly");
    const b = await w.runtime.opsFailures(ORG_B);
    expect(b.tombstone).toBeLessThanOrEqual(1);
    expect(await w.runtime.opsFailures(ORG_A)).toEqual({ eraseSweep: 0, tombstone: 0 });
  });
});

describe("the check has a deadline and cannot starve the other work (R1)", () => {
  it("a GitHub call that never answers for one company ends at that company's share, the next company is still checked, and every call carried the deadline's signal", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    await addOrg(db, ORG_B, 66, [201]);
    const w = build(db, { 55: { listed: [101], hangs: true }, 66: { listed: [900] } }, { repoCheckOrgMs: 250 });
    const started = Date.now();
    const summary = await w.runtime.jobs.run("hourly");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(summary.orgs).toBe(2);
    expect(await w.health(ORG_A, 101)).toBe("unknown");
    expect(await w.health(ORG_B, 201)).toBe("failing");
    expect(w.calls.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("runs after every company's own work, from what is left: with under two seconds left it does not start at all (a fixed line), and nothing is asked of GitHub", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900] } }, { jobBudgetMs: 1_500 });
    const summary = await w.runtime.jobs.run("hourly");
    expect(w.calls.open).toEqual([]);
    expect(summary.details.githubReposNoTime).toBe(1);
    expect(w.logs.map((entry) => entry.event)).toContain("record.github_repo_check_no_time");
    // The company's own work still ran.
    expect(summary.orgs).toBe(1);
  });

  it("walks the companies from where the last run stopped: when time runs out after company A, the next run starts after A, so B is not starved", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    await addOrg(db, ORG_B, 66, [201]);
    const clock = { now: NOW };
    const installations: Record<number, Installation> = { 55: { listed: [101], hangs: true, onOpen: () => { clock.now += 6_500; } }, 66: { listed: [900] } };
    const w = build(db, installations, { repoCheckOrgMs: 200, jobBudgetMs: 7_000, now: () => clock.now });
    const first = await w.runtime.jobs.run("hourly");
    expect(w.calls.open).toEqual([55]);
    expect(first.details.githubReposOrgsLeft).toBe(1);
    installations[55]!.hangs = false;
    await w.runtime.jobs.run("hourly");
    // Company B was checked first thing in the next run (A is after the cursor's wrap, not before B).
    expect(w.calls.open[1]).toBe(66);
    expect(await w.health(ORG_B, 201)).toBe("failing");
  });
});

describe("no App, or an App that cannot be read", () => {
  it("an install whose GitHub App is not set up makes no GitHub call and logs nothing", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900] } }, { githubAppReady: async () => false });
    const summary = await w.runtime.jobs.run("hourly");
    expect(w.calls.open).toEqual([]);
    expect(summary.details.githubReposChecked).toBeUndefined();
    expect(w.logs.filter((entry) => String(entry.event).startsWith("record.github_sweep_problem"))).toEqual([]);
  });

  it("an App check that FAILS (the secret cannot be read) is not 'no App': it is logged as a problem for the operator and the sweeps skip this hour", async () => {
    const db = new FakeDynamoDb({ indexKeys });
    await addOrg(db, ORG_A, 55, [101]);
    const w = build(db, { 55: { listed: [900] } }, { githubAppReady: async () => { throw new Error("AccessDenied secret detail"); } });
    await w.runtime.jobs.run("hourly");
    expect(w.calls.open).toEqual([]);
    expect(w.logs.some((entry) => entry.event === "record.github_sweep_problem" && entry.appUnreadable === 1)).toBe(true);
    expect(JSON.stringify(w.logs)).not.toContain("secret detail");
  });
});
