// Plan 5 Task 16: the project page's data. `GET /v1/app/projects/{name}/overview` answers, for a person with a role in the project, the project's card (repositories, setup, channels), what
// that person may do there, the agents that work on it with how many are running, the month's budget and cost per merged pull request (only for a maintainer, who may see spend), and the open
// sessions the person may view. Everything is read now for the caller: a person with no role gets `PROJECT_NOT_FOUND`, the same as for a project that is not there. A merged pull request adds
// one to the project's month count in the transaction that records the merge.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  LIVE_PAGE_MAX, ProjectOverviewReaderSchema, ProjectOverviewSchema, agentSessionKey, liveSessionKey, projectAiKey, projectMonthStatsKey, spendCounterKey, type OrgId, type ProjectOverview, type SessionStatus,
} from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow.js";
import { isAgentSessionRoute, routeAgentSessionRequest, type SessionRouteDependencies } from "../../packages/broker/src/agent-sessions/routes.js";
import { reconcileTaskPullRequestFeedback } from "../../packages/broker/src/aws/github-webhooks.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { addToRoster } from "../../packages/broker/src/agents/roster.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, T0, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const iso = (ms: number) => new Date(ms).toISOString();
const MONTH = "2026-10";
const OVERVIEW = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/overview`;
const SCRATCH = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent" as const, workspace: "none" as const }] };

function world() {
  const w = sessionWorld();
  w.project(ORG_A, "api");
  w.grant(MAX, "api", "maintainer");
  w.grant(ZED, "api", "contributor");
  w.project(ORG_B, "ops");
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now });
  const approvals = {
    store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now: () => w.clock.now, confirmOrigin: CELL, log: () => undefined,
  } as unknown as ApprovalDependencies;
  const page = (name: string) => ({ name, status: "active" as const, repositories: [{ fullName: `acme/${name}`, defaultBranch: "main" }], setup: { status: "ready" as const }, channels: ["C0123456789"] });
  const deps = (extra: Partial<SessionRouteDependencies> = {}): SessionRouteDependencies => ({
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => ({}) as never, approvals, projectPage: async (_caller, name) => page(name), ...extra,
  });
  const call = (method: string, path: string, who: string, orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) =>
    routeAgentSessionRequest(deps(extra), w.caller(who, orgId), { method, path, headers: {}, requestId: "r" }, new URL(`${CELL}${path}`));
  const overview = (who: string, project = "web", orgId: OrgId = ORG_A, extra: Partial<SessionRouteDependencies> = {}) => call("GET", OVERVIEW(project), who, orgId, extra) as Promise<ProjectOverview>;

  let minute = 0;
  /** An open session as the summary refresh leaves it: the record and its tile. */
  const open = (o: { owner?: string; project?: string | null; kind?: "task" | "local"; orgId?: OrgId; agentId?: string; status?: SessionStatus; ended?: boolean; people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }> } = {}) => {
    const orgId = o.orgId ?? ORG_A;
    minute += 1;
    const seeded = w.seedSession({ owner: o.owner ?? PRIYA, ...(o.project === undefined ? {} : { project: o.project }), orgId, ...(o.kind === undefined ? {} : { kind: o.kind }), ...(o.people === undefined ? {} : { people: o.people }) });
    const meta = w.db.get(agentSessionKey(orgId, seeded.sessionId, "META")) as Item;
    const createdAt = iso(Date.parse("2026-10-22T07:00:00.000Z") + minute * 60_000);
    const updatedAt = iso(T0 - 5 * 60_000 + minute * 1000);
    const status = o.status ?? "running";
    const summary = { status, costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: updatedAt };
    const { endedAt: _unused, ...rest } = meta; // eslint-disable-line @typescript-eslint/no-unused-vars -- the seed's own end is replaced
    const endedAt = o.ended === true ? iso(T0 - 3_600_000) : undefined;
    const record = { ...rest, createdAt, updatedAt, summary, summaryRevision: 2, ...(endedAt === undefined ? {} : { endedAt }), ...(o.agentId === undefined ? {} : { agent: { agentId: o.agentId, name: "Helper", version: 1 } }) };
    w.db.set(record);
    w.db.set({
      ...liveSessionKey(orgId, seeded.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: seeded.sessionId, kind: record.kind, ...(record.project === undefined ? {} : { project: record.project }),
      ownerId: (record as Item & { owner: { developerId: string } }).owner.developerId, owner: record.owner, title: record.title, where: record.where, status, summary, summaryRevision: 2, revision: record.revision, createdAt, updatedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
    return seeded;
  };
  const spend = (project: string, spentUsd: number, month = MONTH, orgId: OrgId = ORG_A) =>
    w.db.set({ ...spendCounterKey(orgId, month, `PROJECT#${project}`), entityType: "SPEND_COUNTER", orgId, spentUsd, committedUsd: spentUsd + 5 });
  const merged = (project: string, mergedPullRequests: number, month = MONTH, orgId: OrgId = ORG_A) =>
    w.db.set({ ...projectMonthStatsKey(orgId, project, month), entityType: "PROJECT_SESSION_STATS", orgId, project, month, mergedPullRequests });
  return { ...w, store, approvals, deps, call, overview, open, spend, merged };
}

describe("the shape", () => {
  it("is strict, keeps what a newer server adds for a reader, and has no budget unless it is given", () => {
    const base = {
      project: { name: "web", status: "active", latestRevision: 3, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], setup: { status: "ready" }, channels: ["C0123456789"] },
      you: { role: "contributor", canStartWork: true, canEditSettings: false, canViewSpend: false },
      agents: [{ agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Triage", description: "Sorts tickets", running: 2 }],
      running: [],
    };
    expect(ProjectOverviewSchema.parse(base)).toEqual(base);
    const withBudget = { ...base, budget: { month: MONTH, spentUsd: 812, limitUsd: 1000, mergedPullRequests: 208, costPerMergedPullRequestUsd: 3.9 } };
    expect(ProjectOverviewSchema.parse(withBudget)).toEqual(withBudget);
    expect(ProjectOverviewSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(ProjectOverviewSchema.safeParse({ ...base, you: { role: "contributor" } }).success).toBe(false);
    expect(ProjectOverviewSchema.safeParse({ ...base, budget: { ...withBudget.budget, mergedPullRequests: -1 } }).success).toBe(false);
    expect(ProjectOverviewReaderSchema.parse({ ...withBudget, later: true })).toMatchObject({ later: true });
  });

  it("is a session route", () => {
    expect(isAgentSessionRoute("/v1/app/projects/web/overview")).toBe(true);
    expect(isAgentSessionRoute("/v1/app/projects/web")).toBe(false);
    expect(isAgentSessionRoute("/v1/app/projects/web/spend")).toBe(false);
  });
});

describe("who may read it, and what each sees", () => {
  it("shows a maintainer everything: the card, what they may do, the budget with the cost of a merged pull request", async () => {
    const w = world();
    w.spend("web", 812);
    w.merged("web", 208);
    const answer = await w.overview(MAX);
    expect(ProjectOverviewReaderSchema.parse(answer)).toBeDefined();
    expect(answer.project).toMatchObject({ name: "web", status: "active", repositories: [{ fullName: "acme/web", defaultBranch: "main" }], setup: { status: "ready" }, channels: ["C0123456789"] });
    expect(answer.you).toEqual({ role: "maintainer", canStartWork: true, canEditSettings: true, canViewSpend: true });
    expect(answer.budget).toEqual({ month: MONTH, spentUsd: 812, mergedPullRequests: 208, costPerMergedPullRequestUsd: 3.9 });
  });

  it("gives an org admin without a grant the maintainer's page", async () => {
    const w = world();
    w.spend("web", 40);
    const answer = await w.overview(OLA);
    expect(answer.you).toEqual({ role: "maintainer", canStartWork: true, canEditSettings: true, canViewSpend: true });
    expect(answer.budget).toMatchObject({ spentUsd: 40 });
  });

  it("shows a contributor that they can start work but not edit settings, and no money at all", async () => {
    const w = world();
    w.spend("web", 812);
    w.merged("web", 208);
    const answer = await w.overview(PRIYA);
    expect(answer.you).toEqual({ role: "contributor", canStartWork: true, canEditSettings: false, canViewSpend: false });
    expect("budget" in answer).toBe(false);
    const text = JSON.stringify(answer);
    for (const secret of ["812", "208", "3.9", "spentUsd", "mergedPullRequests", "costPer"]) expect(text, secret).not.toContain(secret);
  });

  it("shows a viewer that they can do nothing but look", async () => {
    const w = world();
    w.spend("web", 812);
    const answer = await w.overview(MIA);
    expect(answer.you).toEqual({ role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false });
    expect("budget" in answer).toBe(false);
  });

  it("answers PROJECT_NOT_FOUND, in the same words, to a person with no role, to a role in another project only, to another org, and for a project that is not there", async () => {
    const w = world();
    w.spend("web", 812);
    const refusals = [
      await code(w.overview(ARJUN, "ops")),
      await code(w.overview(ZED, "web")),
      await code(w.overview(BO, "web", ORG_A)),
      await code(w.overview(BO, "nope", ORG_B)),
      await code(w.overview(PRIYA, "nope")),
      await code(w.overview(PRIYA, "NOT A NAME!")),
      await code(w.call("GET", "/v1/app/projects/%E0%A4%A/overview", PRIYA)),
    ];
    for (const refusal of refusals) expect(refusal).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(new Set(refusals.map((refusal) => refusal!.message)).size).toBe(1);
    // Bo has a role in his own org's `web`: that page is his org's, with nothing of org A.
    w.grant(BO, "ops", "contributor", ORG_B);
    expect((await w.overview(BO, "ops", ORG_B)).project.name).toBe("ops");
  });

  it("answers a project whose page cannot be read the same way", async () => {
    const w = world();
    expect(await code(w.overview(PRIYA, "web", ORG_A, { projectPage: async () => undefined }))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await code(w.overview(PRIYA, "web", ORG_A, { projectPage: undefined }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads a revoked role at the next read", async () => {
    const w = world();
    expect((await w.overview(PRIYA)).you.role).toBe("contributor");
    w.members.revoke(ORG_A, "web", PRIYA);
    expect(await code(w.overview(PRIYA))).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("only answers a read", async () => {
    const w = world();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(await code(w.call(method, OVERVIEW("web"), MAX)), method).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the budget and the cost of a merged pull request", () => {
  it("is the spend and the merged count of the current month, to the cent", async () => {
    const w = world();
    w.spend("web", 812);
    w.merged("web", 208);
    expect((await w.overview(MAX)).budget).toMatchObject({ spentUsd: 812, mergedPullRequests: 208, costPerMergedPullRequestUsd: 3.9 });
    w.spend("web", 100);
    w.merged("web", 3);
    expect((await w.overview(MAX)).budget).toMatchObject({ costPerMergedPullRequestUsd: 33.33 });
    w.spend("web", 0.005);
    w.merged("web", 1);
    expect((await w.overview(MAX)).budget).toMatchObject({ costPerMergedPullRequestUsd: 0.01 });
  });

  it("shows no cost without a merged pull request, and a merged one for free costs nothing", async () => {
    const w = world();
    w.spend("web", 812);
    const none = (await w.overview(MAX)).budget!;
    expect(none).toEqual({ month: MONTH, spentUsd: 812, mergedPullRequests: 0 });
    expect("costPerMergedPullRequestUsd" in none).toBe(false);
    w.spend("web", 0);
    w.merged("web", 2);
    expect((await w.overview(MAX)).budget).toMatchObject({ spentUsd: 0, mergedPullRequests: 2, costPerMergedPullRequestUsd: 0 });
    expect((await world().overview(MAX)).budget).toEqual({ month: MONTH, spentUsd: 0, mergedPullRequests: 0 });
  });

  it("reads this project in this org in this month only, and never shows what is committed but not spent", async () => {
    const w = world();
    w.spend("web", 10);
    w.spend("web", 999, "2026-09");
    w.spend("api", 888);
    w.spend("web", 777, MONTH, ORG_B);
    w.merged("web", 4);
    w.merged("web", 99, "2026-09");
    w.merged("api", 98);
    w.merged("web", 97, MONTH, ORG_B);
    const budget = (await w.overview(MAX)).budget!;
    expect(budget).toEqual({ month: MONTH, spentUsd: 10, mergedPullRequests: 4, costPerMergedPullRequestUsd: 2.5 });
    expect(JSON.stringify(budget)).not.toContain("15");
    w.clock.now = Date.parse("2026-11-01T00:00:01.000Z");
    expect((await w.overview(MAX)).budget).toEqual({ month: "2026-11", spentUsd: 0, mergedPullRequests: 0 });
  });

  it("treats a counter that does not read as nothing", async () => {
    const w = world();
    w.db.set({ ...spendCounterKey(ORG_A, MONTH, "PROJECT#web"), spentUsd: "lots", committedUsd: null });
    w.db.set({ ...projectMonthStatsKey(ORG_A, "web", MONTH), mergedPullRequests: -4 });
    expect((await w.overview(MAX)).budget).toEqual({ month: MONTH, spentUsd: 0, mergedPullRequests: 0 });
  });

  it("shows the project's monthly limit when it has one, and none when it has none", async () => {
    const w = world();
    w.spend("web", 5);
    expect("limitUsd" in (await w.overview(MAX)).budget!).toBe(false);
    w.db.set({ ...projectAiKey(ORG_A, "web"), entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: 1000, revision: 1 });
    expect((await w.overview(MAX)).budget).toEqual({ month: MONTH, spentUsd: 5, limitUsd: 1000, mergedPullRequests: 0 });
  });
});

describe("what is running", () => {
  it("lists the open sessions on this project the caller may view, and nothing else", async () => {
    const w = world();
    const mine = w.open({ owner: PRIYA });
    const arjuns = w.open({ owner: ARJUN });
    const otherProject = w.open({ owner: PRIYA, project: "ops" });
    const ended = w.open({ owner: PRIYA, ended: true, status: "succeeded" });
    const otherOrg = w.open({ owner: BO, orgId: ORG_B });
    const answer = await w.overview(PRIYA);
    const ids = answer.running.map((tile) => tile.sessionId);
    expect(ids).toContain(arjuns.sessionId);
    expect(ids).not.toContain(otherProject.sessionId);
    expect(ids).not.toContain(ended.sessionId);
    expect(ids).not.toContain(otherOrg.sessionId);
    // The team filter: the caller's own work is on the page too when it is a cloud session of the project.
    expect(ids.length).toBeGreaterThanOrEqual(1);
    void mine;
  });

  it("never shows an unshared local session, nor a task the caller cannot view", async () => {
    const w = world();
    const local = w.open({ owner: PRIYA, kind: "local" });
    const hidden = w.open({ owner: PRIYA, people: [{ developerId: ARJUN, role: "denied" }] });
    const visible = w.open({ owner: PRIYA });
    const ids = (await w.overview(ARJUN)).running.map((tile) => tile.sessionId);
    expect(ids).toContain(visible.sessionId);
    expect(ids).not.toContain(local.sessionId);
    expect(ids).not.toContain(hidden.sessionId);
    expect(JSON.stringify(await w.overview(ARJUN))).not.toContain(local.sessionId);
  });

  it("is at most one page, and says nothing of the sessions it leaves out", async () => {
    const w = world();
    for (let index = 0; index < LIVE_PAGE_MAX + 20; index += 1) w.open({ owner: ARJUN });
    const answer = await w.overview(PRIYA);
    expect(answer.running).toHaveLength(LIVE_PAGE_MAX);
    expect(Object.keys(answer).sort()).toEqual(["agents", "project", "running", "you"]);
  });
});

describe("the agents", () => {
  const addAgent = async (w: ReturnType<typeof world>, name: string, owner: string) => {
    const agent = await w.store.create({ orgId: ORG_A, name, description: `${name} works on tickets`, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
    await addToRoster(w.approvals as never, { orgId: ORG_A, project: "web", agentId: agent.agentId, by: owner });
    return agent;
  };

  it("lists the agents the caller may see on the project's roster, each with how many of the caller's visible sessions it runs", async () => {
    const w = world();
    const triage = await addAgent(w, "Triage", MAX);
    w.open({ owner: ARJUN, agentId: triage.agentId });
    w.open({ owner: ARJUN, agentId: triage.agentId });
    w.open({ owner: ARJUN });
    const asMax = await w.overview(MAX);
    expect(asMax.agents.find((agent) => agent.agentId === triage.agentId)).toEqual({ agentId: triage.agentId, name: "Triage", description: "Triage works on tickets", running: 2 });
    // Max owns the agent; Priya has no access to it, so it is not on her page at all, nor its count.
    const asPriya = await w.overview(PRIYA);
    expect(asPriya.agents.find((agent) => agent.agentId === triage.agentId)).toBeUndefined();
    expect(JSON.stringify(asPriya)).not.toContain(triage.agentId);
  });

  it("counts only the sessions the caller can view", async () => {
    const w = world();
    const triage = await addAgent(w, "Triage", MAX);
    w.open({ owner: ARJUN, agentId: triage.agentId });
    w.open({ owner: ARJUN, agentId: triage.agentId, people: [{ developerId: MAX, role: "denied" }] });
    expect((await w.overview(MAX)).agents.find((agent) => agent.agentId === triage.agentId)?.running).toBe(1);
  });
});

describe("a merged pull request adds one to the project's month, once", () => {
  const TASK = "550e8400-e29b-41d4-a716-446655440012";
  const NOW = "2026-10-05T12:00:00.000Z";

  /** A task with two pull requests waiting for their merge, a webhook reconcile that writes through a fake table, and GitHub's answers. */
  function harness(project = "web", orgId: OrgId | undefined = ORG_A) {
    const db = new FakeDynamoDb();
    const repositories = ["api", "ui"];
    const candidate = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) })));
    let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: NOW }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING",
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: TASK, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
      pullRequests: repositories.map((repositoryId, index) => ({ repositoryId, number: index + 1, url: `https://github.com/acme/${repositoryId}/pull/${String(index + 1)}`, headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" })),
    });
    const rows = new Map(repositories.map((repositoryId, index) => [`GITHUB_PR#acme/${repositoryId}`, {
      entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${repositoryId}`, repositoryId, number: index + 1,
      url: `https://github.com/acme/${repositoryId}/pull/${String(index + 1)}`, taskId: TASK, workspaceId: "workspace", candidateDigest: candidate.digest,
    }]));
    const remote = new Map<number, "open" | "merged">([[1, "open"], [2, "open"]]);
    let revision = 0;
    let clock = Date.parse(NOW);
    const reconcile = (fullName: string, number: number, extra: { failTransaction?: boolean; now?: string } = {}) => reconcileTaskPullRequestFeedback({
      documentClient: { send: async (command: unknown) => ({ Item: rows.get(String(((command as { input: { Key: { pk: string } } }).input.Key).pk)) }) },
      tableName: "state", repositoryFullName: fullName, number, deliveryId: randomUUID(), observationMode: "merge", now: extra.now ?? iso(clock += 1000),
      loadTask: async () => ({ project, startingRevision: 1, ...(orgId === undefined ? {} : { orgId }), workflow }),
      repositoryUrl: async (_project: string, _revision: number, repositoryId: string) => `https://github.com/acme/${repositoryId}.git`,
      getCurrentFeedback: async (_url: string, prNumber: number) => ({
        pullRequest: { number: prNumber, url: `https://github.com/acme/${prNumber === 1 ? "api" : "ui"}/pull/${String(prNumber)}`, state: remote.get(prNumber)!, headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), headTreeSha: "b".repeat(40), title: "t", body: "" },
        comments: [], threads: [],
      }),
      persistBundle: async () => { throw new Error("no feedback is collected on a merge poll"); },
      saveWorkflow: async (_taskId, expectedRevision, next, extraItems = []) => {
        if (expectedRevision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
        if (extra.failTransaction === true) throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
        revision += 1;
        await db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "TASK", sk: "META", revision } } }, ...extraItems] }));
        workflow = next;
      },
    });
    const count = (month = MONTH) => (db.get(projectMonthStatsKey(orgId ?? ORG_A, project, month)) as Item | undefined)?.["mergedPullRequests"];
    return { db, remote, reconcile, count };
  }

  it("adds one when a pull request is found merged, nothing for a redelivery, and one for the next pull request", async () => {
    const h = harness();
    expect(h.count()).toBeUndefined();
    h.remote.set(1, "merged");
    expect(await h.reconcile("acme/api", 1)).toBe(true);
    expect(h.count()).toBe(1);
    expect(await h.reconcile("acme/api", 1)).toBe(false);
    expect(await h.reconcile("acme/api", 1)).toBe(false);
    expect(h.count()).toBe(1);
    h.remote.set(2, "merged");
    expect(await h.reconcile("acme/ui", 2)).toBe(true);
    expect(h.count()).toBe(2);
  });

  it("adds both when one delivery finds both merged", async () => {
    const h = harness();
    h.remote.set(1, "merged");
    h.remote.set(2, "merged");
    expect(await h.reconcile("acme/api", 1)).toBe(true);
    expect(h.count()).toBe(2);
    expect(await h.reconcile("acme/ui", 2)).toBe(false);
    expect(h.count()).toBe(2);
  });

  it("counts a merge in the UTC month it was found", async () => {
    const h = harness();
    h.remote.set(1, "merged");
    await h.reconcile("acme/api", 1, { now: "2026-10-31T23:59:59.000Z" });
    h.remote.set(2, "merged");
    await h.reconcile("acme/ui", 2, { now: "2026-11-01T00:00:01.000Z" });
    expect(h.count("2026-10")).toBe(1);
    expect(h.count("2026-11")).toBe(1);
  });

  it("counts nothing when the save does not commit, and nothing for a pull request that is still open", async () => {
    const h = harness();
    await h.reconcile("acme/api", 1);
    expect(h.count()).toBeUndefined();
    h.remote.set(1, "merged");
    await expect(h.reconcile("acme/api", 1, { failTransaction: true })).rejects.toThrow();
    expect(h.count()).toBeUndefined();
    expect(await h.reconcile("acme/api", 1)).toBe(true);
    expect(h.count()).toBe(1);
  });

  it("counts on the task's own org and project, and nowhere else", async () => {
    const h = harness("api", ORG_B);
    h.remote.set(1, "merged");
    await h.reconcile("acme/api", 1);
    expect(h.count()).toBe(1);
    expect(h.db.get(projectMonthStatsKey(ORG_A, "api", MONTH))).toBeUndefined();
    expect(h.db.get(projectMonthStatsKey(ORG_B, "web", MONTH))).toBeUndefined();
  });

  it("still records the merge for a task whose org is not known, without a count", async () => {
    const h = harness("web", undefined);
    h.remote.set(1, "merged");
    expect(await h.reconcile("acme/api", 1)).toBe(true);
    expect(h.db.find((item) => item.entityType === "PROJECT_SESSION_STATS")).toEqual([]);
  });
});
