// SRL-5a: the hourly job's repository check with a real runtime and the fake table: a recorded repository that GitHub no longer shows its installation is removed (the tap's own tombstone, and
// its source row reads as failing), and nothing is removed on an error, for an install with no App, or for a repository already removed.
import { describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { createTeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import type { InstallationRepositoriesPort } from "../../../packages/broker/src/team-record/github-repo-existence.js";
import { getSourceConfigByScope, putSourceConfig } from "../../../packages/broker/src/team-record/store.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const ON = { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: "enterprise" } as const;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const table = (db: FakeDynamoDb) => ({ documentClient: db as never, tableName: "TeamRecord" });

async function world(options: { listed: number[]; direct?: Record<number, "exists" | "missing" | "throw">; ready?: boolean; listThrows?: boolean; repositories?: number[] }) {
  const db = new FakeDynamoDb({ indexKeys });
  db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG" });
  const repositories = (options.repositories ?? [101]).map((id) => ({ name: `r${id}`, url: `https://github.com/acme/r${id}.git`, path: `repo/r${id}`, defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: id }));
  db.set({ ...projectRevisionKey(TEST_ORG, "web", 1), entityType: "PROJECT", definition: { name: "web", revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work." }, runtimeBinding: {} });
  for (const id of options.repositories ?? [101]) {
    await putSourceConfig(table(db), { workspaceId: TEST_ORG, project: "web", source: "github", scope: `github:repo/${id}`, enabled: true, retention: "D", exclude: [], audienceDefault: "project", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" }, { edition: "enterprise" });
  }
  const calls = { list: 0, status: [] as number[] };
  const githubRepositories: InstallationRepositoriesPort = {
    async repositoryIds() { calls.list += 1; if (options.listThrows) throw new Error("403"); return { ids: options.listed, complete: true }; },
    async status(_installation, repositoryId) { calls.status.push(repositoryId); const answer = options.direct?.[repositoryId] ?? "missing"; if (answer === "throw") throw new Error("500"); return answer; },
  };
  const logs: Array<Record<string, unknown>> = [];
  const runtime = createTeamRecordRuntime({ env: ON, documentClient: db, stateTableName: "State", now: () => NOW, log: (entry) => logs.push(entry), githubRepositories, ...(options.ready === undefined ? {} : { githubAppReady: async () => options.ready! }) });
  if (runtime === undefined) throw new Error("the runtime was not built");
  // The org joins the scheduled jobs' directory.
  db.set({ pk: "TEAM_RECORD_ORGS", sk: TEST_ORG, entityType: "TEAM_RECORD_ORG", orgId: TEST_ORG, at: "2026-10-30T10:00:00.000Z" });
  const health = async (id = 101) => (await getSourceConfigByScope(table(db), TEST_ORG, "github", `github:repo/${id}`))?.health;
  return { db, runtime, calls, logs, health };
}

describe("the hourly job's repository check", () => {
  it("removes the record's copy of a repository the installation no longer shows (its source row reads as failing), and does not ask about it again", async () => {
    const w = await world({ listed: [900, 901, 902] });
    const first = await w.runtime.jobs.run("hourly");
    expect(first.details).toMatchObject({ githubReposChecked: 1, githubReposRemoved: 1, githubReposFailed: 0 });
    expect(await w.health()).toBe("failing");
    const lists = w.calls.list;
    const second = await w.runtime.jobs.run("hourly");
    expect(second.details.githubReposChecked).toBeUndefined();
    expect(w.calls.list).toBe(lists);
  });

  it("leaves a repository the installation still lists", async () => {
    const w = await world({ listed: [101, 900] });
    const summary = await w.runtime.jobs.run("hourly");
    expect(summary.details).toMatchObject({ githubReposChecked: 1, githubReposRemoved: 0 });
    expect(await w.health()).toBe("unknown");
    expect(w.calls.status).toEqual([]);
  });

  it("removes nothing when GitHub cannot be asked clearly (an error, an unclear lookup), and counts it", async () => {
    for (const options of [{ listed: [900], listThrows: true }, { listed: [900], direct: { 101: "throw" as const } }]) {
      const w = await world(options);
      const summary = await w.runtime.jobs.run("hourly");
      expect(summary.details).toMatchObject({ githubReposRemoved: 0, githubReposUnknown: 1 });
      expect(await w.health()).toBe("unknown");
    }
  });

  it("a narrowed installation (3 of 10 recorded repositories not listed) removes none and shows on Health", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => 101 + index);
    const w = await world({ listed: ids.slice(3), repositories: ids });
    const summary = await w.runtime.jobs.run("hourly");
    expect(summary.details).toMatchObject({ githubReposRemoved: 0, githubReposRefused: 1 });
    expect(await w.health(101)).toBe("unknown");
    expect(await w.runtime.opsFailures(TEST_ORG)).toMatchObject({ githubSweep: 1 });
  });

  it("an install with no GitHub App, or a budget too small for it, makes no GitHub call at all", async () => {
    const w = await world({ listed: [900], ready: false });
    const summary = await w.runtime.jobs.run("hourly");
    expect(w.calls.list).toBe(0);
    expect(summary.details.githubReposChecked).toBeUndefined();
  });

  it("is not run by the nightly job", async () => {
    const w = await world({ listed: [900] });
    await w.runtime.jobs.run("nightly");
    expect(w.calls.list).toBe(0);
  });
});
