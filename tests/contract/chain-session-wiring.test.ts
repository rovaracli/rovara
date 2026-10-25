// Merge of Plan 4 and Plan 5: a chain run is read, steered, stopped and retried as a session through the real broker, on Plan 4's own code, with the org of the request.
// Each seam Plan 5 left for Plan 4 (`ChainSessionReads`, `ChainSteerReads`, `ChainControl`, `chainReadAccess`) answers here instead of RUNTIME_UNAVAILABLE.
// A chain run's session record is written by Plan 5 Task 3 (not built yet), so these tests write it the way that task will.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SessionViewSchema } from "../../packages/contracts/src/session-views.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { agentGuardrailsKey, agentSessionKey, orgProjectCatalogKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { MAYA, OMAR, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const ONE_STEP = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };

async function setup() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { projectMembers: members } } });
  members.setOrgRole(TEST_ORG, MAYA.developerId, "owner");
  members.grant(TEST_ORG, "payments", MAYA.developerId, "maintainer");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments" });
  h.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: MAYA.developerId, updatedAt: "2026-10-21T00:00:00.000Z", guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "run" } });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>) => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    return { status: reply.status, body: reply.body };
  };
  const startedRun = async () => {
    const created = await call(MAYA, "POST", "/v1/app/chains", { name: "Look into it", definition: ONE_STEP });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const chainId = (created.body.chain as { chainId: string }).chainId;
    const draft = await call(MAYA, "GET", `/v1/app/chains/${chainId}/draft`);
    expect((await call(MAYA, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision })).status).toBe(200);
    const started = await call(MAYA, "POST", `/v1/app/chains/${chainId}/runs`, { project: "payments", input: "Why did checkout fail?" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body.run as { runId: string }).runId;
    // The session of the run, as Plan 5 Task 3 writes it with the run: `sessionId` is the run's own id.
    const createdAt = "2026-10-24T08:00:00.000Z";
    h.db.set({
      ...agentSessionKey(TEST_ORG, runId, "META"), entityType: "AGENT_SESSION", orgId: TEST_ORG, sessionId: runId, kind: "chain", mode: "delegate",
      subject: { kind: "chain", chainRunId: runId }, legs: [], where: { kind: "cloud" }, project: "payments", title: "Look into it: Why did checkout fail?",
      owner: { developerId: MAYA.developerId, name: MAYA.name }, startedBy: { kind: "member", developerId: MAYA.developerId }, origin: "app", payer: { kind: "member", developerId: MAYA.developerId },
      followerCount: 0, summaryRevision: 1, revision: 1, createdAt, updatedAt: createdAt,
      summary: { status: "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: createdAt },
    });
    return { chainId, runId };
  };
  return { h, members, call, startedRun };
}

describe("a chain run as a session, through the real broker", () => {
  it("reads the run's view and a step's task for its owner, with the run's own body", async () => {
    const { call, startedRun } = await setup();
    const { runId } = await startedRun();
    const session = await call(MAYA, "GET", `/v1/app/sessions/${runId}`);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    const view = (session.body as { session: unknown }).session;
    expect(SessionViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ sessionId: runId, kind: "chain", body: { kind: "chain", chain: { sessionId: runId, status: "running", sections: [{ seq: 1, stepId: "look" }] } } });
    const task = await call(MAYA, "GET", `/v1/app/sessions/${runId}/sections/1/task`);
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(task.body).toMatchObject({ task: { agent: { agentId: "root-cause-analyst" } } });
  });

  it("shows the chain session to a reader of the chain and the project (Plan 4's rule), and to nobody else", async () => {
    const { members, call, startedRun } = await setup();
    const { chainId, runId } = await startedRun();
    expect((await call(OMAR, "GET", `/v1/app/sessions/${runId}`)).status).toBe(404);
    members.grant(TEST_ORG, "payments", OMAR.developerId, "viewer");
    expect((await call(OMAR, "GET", `/v1/app/sessions/${runId}`)).status).toBe(404);
    const shared = await call(MAYA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: OMAR.developerId }, level: "view" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const read = await call(OMAR, "GET", `/v1/app/sessions/${runId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body as { session: { you: { level: string } } }).session.you.level).toBe("view");
  });

  it("delivers a message to the running step of the chain instead of refusing it", async () => {
    const { call, startedRun } = await setup();
    const { runId } = await startedRun();
    const sent = await call(MAYA, "POST", `/v1/app/sessions/${runId}/messages`, { kind: "steer", text: "Look at the payments service first." });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(sent.body).not.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("stops the run through Plan 4's cancel, for the org of the request", async () => {
    const { h, call, startedRun } = await setup();
    const { runId } = await startedRun();
    const stopped = await call(MAYA, "POST", `/v1/app/sessions/${runId}/stop`, {});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(h.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === runId)[0]).toMatchObject({ status: "cancelled", cancelledBy: MAYA.developerId });
  });

  it("retries a failed run as a new run of the chain, started by the person who retried", async () => {
    const { h, call, startedRun } = await setup();
    const { runId } = await startedRun();
    const run = h.db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === runId)[0]!;
    h.db.set({ ...run, status: "failed", endedAt: "2026-10-24T08:05:00.000Z", failure: { code: "STEP_FAILED", text: "it failed" } });
    const session = h.db.get(agentSessionKey(TEST_ORG, runId, "META").pk, "META") as Record<string, unknown>;
    h.db.set({ ...session, summary: { ...(session.summary as object), status: "failed" } });
    const retried = await call(MAYA, "POST", `/v1/app/sessions/${runId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const runs = h.db.find((item) => item.entityType === "CHAIN_RUN");
    expect(runs).toHaveLength(2);
    expect(runs.find((item) => item.runId !== runId)).toMatchObject({ status: "running", input: "Why did checkout fail?", project: "payments", startedBy: { kind: "member", developerId: MAYA.developerId } });
  });
});
