// Track record (v1.2 slice 1): the early "PR risk low" score. It is private to the task's owner: the broker adds it to the version 2 task view only when the viewer is the task's owner and the task's PR was
// published with risk "low". It always carries its sample count, says "early, few samples" below ten, stays private above ten, and is never on the shared card, in a thread or on the pull request.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { EarlyRiskSignalSchema, ROVARA_CODE_AGENT_ID, earlyRiskSignalText } from "../../packages/contracts/src/index.js";
import { createCandidateManifest, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { recordOutcomeSample } from "../../packages/broker/src/rovara-code/outcomes.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { agentSessionKey, projectMemberKey } from "../../packages/contracts/src/index.js";
import { getProjectHowWeWork } from "../../packages/broker/src/playbook/routes.js";
import { MAX, ORG_A } from "../support/agent-session-world.js";
import { mergeWorld } from "../support/rovara-code-merge-world.js";
import { TEST_ORG } from "../support/orgs.js";

const CODE = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const OTHER = createCandidateManifest([{ repositoryId: "demo", commitSha: "f".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
const pullRequest = (candidateDigest: string) => ({ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", headSha: "d".repeat(40), candidateDigest, required: true, state: "OPEN" });
const SENTENCE = "Early signal, few samples: PRs this project rated low risk were merged with no changes requested by a person 5 of 6 times (last 30 days). Reverts after merge aren't tracked yet.";

async function lowRiskTask(options: { risk?: "low" | "medium" | "high"; riskDigest?: string; pullRequests?: boolean; held?: number; notHeld?: number; project?: string; unreviewed?: number; closedUnmerged?: number; noOutcome?: number; withSessions?: boolean } = {}) {
  const harness = await createSingleAnswerPlanBroker(options.withSessions === true ? { brokerExtra: { agents: {}, cloud: true } } : {});
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const id = String((started.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
  harness.db.set({
    ...record(),
    workflow: {
      ...record().workflow, definitionVersion: "1.1.0", candidate: CODE, risk: { level: options.risk ?? "low", reasons: [], candidateDigest: options.riskDigest ?? CODE.digest },
      ...(options.pullRequests === false ? {} : { pullRequests: [pullRequest(CODE.digest)] }),
    },
  });
  const now = Date.now();
  const seed = async (state: "held" | "not_held" | "closed_unmerged" | "no_outcome", count: number, unreviewed = 0) => {
    for (let index = 0; index < count; index += 1) {
      await recordOutcomeSample({ ddb: harness.db, tableName: (harness.brokerInput as unknown as { tableName: string }).tableName }, {
        orgId: TEST_ORG, project: options.project ?? "payments", stage: "risk", taskId: `other-${state}-${String(index)}`, claim: "risk_low", round: "r1", state, reason: state === "held" ? "merged_no_changes_requested" : state === "not_held" ? "changes_requested_by_person" : state === "closed_unmerged" ? "closed_unmerged" : "task_closed",
        ...(index < unreviewed ? { unreviewedMerge: true as const } : {}),
        agent: { id: ROVARA_CODE_AGENT_ID, version: "3", digest: "d".repeat(64) }, model: "rovara", createdAt: new Date(now - 10 * 86_400_000).toISOString(), scoredAt: new Date(now - 2 * 86_400_000).toISOString(),
      });
    }
  };
  await seed("held", options.held ?? 5, options.unreviewed ?? 0);
  await seed("not_held", options.notHeld ?? 1);
  await seed("closed_unmerged", options.closedUnmerged ?? 0);
  await seed("no_outcome", options.noOutcome ?? 0);
  const read = async (headers: Record<string, string> = { "x-agentx-task-view": "2" }) => {
    const response = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${id}`, undefined, headers);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.task as Record<string, unknown>;
  };
  const direct = async (actor?: "owner" | "viewer") => {
    const input = harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const deps = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now, tasks: harness.actions }, caller);
    return taskView(deps, record() as never, { events: 0, details: true, ...(actor === undefined ? {} : { actor }) });
  };
  return { harness, id, record, read, direct, sessionId: () => (record() as { sessionId?: string }).sessionId };
}

describe("the owner's early score", () => {
  it("is in the owner's version 2 task view, with the count of samples, when the task's PR was published with risk low", async () => {
    const { read } = await lowRiskTask();
    const view = await read();
    expect(view["earlyRiskSignal"]).toEqual({ held: 5, notHeld: 1, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: false });
    expect(DeveloperTaskViewSchema.safeParse(view).success).toBe(true);
    expect(earlyRiskSignalText(EarlyRiskSignalSchema.parse(view["earlyRiskSignal"]))).toBe(SENTENCE);
  });

  it("says \"early, few samples\" below ten, and the count is always there; above ten it is still the owner's alone", async () => {
    const { read, direct } = await lowRiskTask({ held: 11, notHeld: 2 });
    const signal = EarlyRiskSignalSchema.parse((await read())["earlyRiskSignal"]);
    expect(signal).toMatchObject({ held: 11, notHeld: 2, enough: true });
    const text = earlyRiskSignalText(signal);
    expect(text).toBe("Early signal: PRs this project rated low risk were merged with no changes requested by a person 11 of 13 times (last 30 days). Reverts after merge aren't tracked yet.");
    expect(text).not.toContain("few samples");
    expect((await direct("viewer")).earlyRiskSignal).toBeUndefined();
    const none = { held: 0, notHeld: 0, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: false };
    expect(earlyRiskSignalText(none)).toBe("Early signal, few samples: no PRs this project rated low risk have been scored yet (last 30 days).");
    expect(earlyRiskSignalText({ ...none, closedUnmerged: 2 })).toBe("Early signal, few samples: no PRs this project rated low risk have been scored yet (last 30 days). 2 PRs closed unmerged.");
    expect(earlyRiskSignalText({ ...none, held: 1500, notHeld: 400, capped: true, enough: true })).toContain("(based on the latest 2000)");
  });

  it("is not there for another risk level, before a PR was published, or when the risk is of other code", async () => {
    expect(await (await lowRiskTask({ risk: "medium" })).read()).not.toHaveProperty("earlyRiskSignal");
    expect(await (await lowRiskTask({ risk: "high" })).read()).not.toHaveProperty("earlyRiskSignal");
    expect(await (await lowRiskTask({ pullRequests: false })).read()).not.toHaveProperty("earlyRiskSignal");
    expect(await (await lowRiskTask({ riskDigest: OTHER.digest })).read()).not.toHaveProperty("earlyRiskSignal");
  });

  it("counts this project's samples only", async () => {
    const { read } = await lowRiskTask({ project: "other" });
    expect((await read())["earlyRiskSignal"]).toMatchObject({ held: 0, notHeld: 0, enough: false });
  });

  it("is left out for a client that does not ask for the version 2 view", async () => {
    expect(await (await lowRiskTask()).read({})).not.toHaveProperty("earlyRiskSignal");
  });
});

describe("a viewer who is not the owner never gets it", () => {
  it("a view built for a viewer, or for no named actor, has no early score; the owner's has", async () => {
    const { direct } = await lowRiskTask();
    expect((await direct("owner")).earlyRiskSignal).toEqual({ held: 5, notHeld: 1, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: false });
    expect(await direct("viewer")).not.toHaveProperty("earlyRiskSignal");
    expect(await direct()).not.toHaveProperty("earlyRiskSignal");
  });

  it("never reads better than the data: the limits the card shows are on the early score too", async () => {
    const { read } = await lowRiskTask({ held: 5, notHeld: 1, unreviewed: 5, closedUnmerged: 2, noOutcome: 1 });
    const signal = EarlyRiskSignalSchema.parse((await read())["earlyRiskSignal"]);
    expect(signal).toMatchObject({ held: 5, notHeld: 1, unreviewedMerges: 5, closedUnmerged: 2, noOutcome: 1 });
    expect(earlyRiskSignalText(signal)).toBe("Early signal, few samples: PRs this project rated low risk were merged with no changes requested by a person 5 of 6 times (last 30 days). 2 PRs closed unmerged · 5 merged without a person's review · 1 with no result to check · Reverts after merge aren't tracked yet.");
  });

  it("another member reading the task through the owner-only route is refused, and gets nothing", async () => {
    const { harness, id } = await lowRiskTask();
    const response = await harness.dev(OMAR, "GET", `/v1/dev/tasks/${id}`, undefined, { "x-agentx-task-view": "2" });
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("earlyRiskSignal");
    expect(JSON.stringify(response.body)).not.toContain("rated low risk");
  });

  it("is not part of the shared card: the How we work route answers with no risk record, even with risk samples scored", async () => {
    const w = mergeWorld();
    await w.store.adoptBuiltinVersion({ orgId: ORG_A, agentId: ROVARA_CODE_AGENT_ID, version: 2, expectedPinnedVersion: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID), by: MAX });
    for (let index = 0; index < 12; index += 1) {
      await recordOutcomeSample({ ddb: w.db, tableName: "state" }, {
        orgId: ORG_A, project: "web", stage: "risk", taskId: `risk-${String(index)}`, claim: "risk_low", round: "r1", state: "held", reason: "merged_no_changes_requested",
        agent: { id: ROVARA_CODE_AGENT_ID, version: "3", digest: "d".repeat(64) }, model: "rovara", createdAt: new Date(w.clock.now - 10 * 86_400_000).toISOString(), scoredAt: new Date(w.clock.now - 2 * 86_400_000).toISOString(),
      });
    }
    const card = await getProjectHowWeWork({
      documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
      projectFor: async (caller, name) => ({ name, role: (await w.members.roleOf(caller.orgId, name, { developerId: caller.developerId, orgRole: "member" }))! }),
    }, w.caller(MAX), "web");
    expect(card.stages.some((entry) => entry.id === "risk")).toBe(false);
    expect(card.stages.flatMap((entry) => entry.trackRecord ?? []).map((entry) => entry.claim)).not.toContain("risk_low");
    expect(JSON.stringify(card)).not.toMatch(/risk_low|rated low risk|earlyRiskSignal/u);
  });
});

describe("through the session read route", () => {
  const developer = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
  const SHARED = developer("a", "Shared"), VIEWER = developer("b", "Viewer"), ADMIN = developer("c", "Admin");
  async function world() {
    const t = await lowRiskTask({ withSessions: true });
    const { harness } = t;
    for (const who of [SHARED, VIEWER, ADMIN]) {
      harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      await harness.orgOf(who);
    }
    seedMembership(harness.db, ADMIN.developerId, { orgId: TEST_ORG, role: "admin" });
    // A project viewer, and a member the session is shared with at "use".
    harness.db.set({ ...projectMemberKey(TEST_ORG, VIEWER.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: VIEWER.developerId, projectName: "payments", grantId: randomUUID(), role: "viewer", projectRole: "viewer" });
    const sessionId = t.sessionId()!;
    harness.db.set({
      ...agentSessionKey(TEST_ORG, sessionId, `SHARE#MEMBER#${SHARED.developerId}`), entityType: "AGENT_SESSION_SHARE", orgId: TEST_ORG, sessionId, principal: { kind: "member", developerId: SHARED.developerId }, level: "use",
      sharedBy: { developerId: MAYA.developerId, name: MAYA.name }, sharedAt: "2026-10-22T08:10:00.000Z",
    });
    const readAs = async (who: Developer) => {
      const response = await harness.dev(who, "GET", `/v1/app/sessions/${sessionId}`, undefined, { "x-agentx-task-view": "2" });
      return { status: response.status, task: ((response.body.session as { body?: { task?: Record<string, unknown> } } | undefined)?.body?.task), raw: JSON.stringify(response.body) };
    };
    return { ...t, readAs, sessionId };
  }

  it("gives the owner the early score, and a share reader, a project viewer and an org admin none, though each reads the session", async () => {
    const { readAs } = await world();
    const owner = await readAs(MAYA);
    expect(owner.status).toBe(200);
    expect(owner.task?.["earlyRiskSignal"]).toMatchObject({ held: 5, notHeld: 1 });
    for (const who of [SHARED, VIEWER, ADMIN]) {
      const reader = await readAs(who);
      expect(reader.status, `${who.name}: ${reader.raw}`).toBe(200);
      expect(reader.task, who.name).toBeDefined();
      expect(reader.raw, who.name).not.toContain("earlyRiskSignal");
      expect(reader.raw, who.name).not.toContain("rated low risk");
    }
  });

  it("after a take-over the new owner gets it and the old owner does not", async () => {
    const { harness, id, readAs } = await world();
    const record = harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown>;
    harness.db.set({ ...record, currentOwner: { developerId: OMAR.developerId, name: OMAR.name, provider: OMAR.provider, since: "2026-10-22T11:00:00.000Z" } });
    const taker = await readAs(OMAR);
    expect(taker.status, taker.raw).toBe(200);
    expect(taker.task?.["earlyRiskSignal"]).toMatchObject({ held: 5, notHeld: 1 });
    const before = await readAs(MAYA);
    expect(before.raw).not.toContain("earlyRiskSignal");
  });
});

/** Only the code that builds the task view, its contract and the task page may name the early score: a Slack thread post, the shared card and the pull request body never can. */
describe("where the early score may appear", () => {
  const root = join(__dirname, "../../packages");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  it("is named only in the contract, the task view's builder and compatibility projection, and the task page", () => {
    const named = walk(root).filter((path) => /earlyRiskSignal|EarlyRiskSignal/.test(readFileSync(path, "utf8"))).map((path) => relative(root, path)).sort();
    expect(named).toEqual([
      "broker/src/aws/developer-tasks/task-view.ts",
      "broker/src/rovara-code/early-risk-signal.ts",
      "broker/src/rovara-code/task-view-compat.ts",
      "contracts/src/developer-tasks.ts",
      "contracts/src/how-we-work-track-record.ts",
      "ui/src/screens/session/EarlySignal.tsx",
    ]);
    const forbidden = walk(root).filter((path) => /slack|pull-request-body|how-we-work|effective\.ts|track-record\.ts/.test(relative(root, path)) && /earlyRiskSignal|EarlyRiskSignal|risk_low/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path)).filter((path) => path !== "contracts/src/how-we-work-track-record.ts");
    expect(forbidden).toEqual([]);
  });
});
