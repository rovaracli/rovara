// OWNER DECISION 7, with the decision cards on (the page path with them off is task-web-api-work-breakdown.test.ts). Approving a coding plan that has a work breakdown: on its decision card (OWNER DECISION 7; the old review page is read-only) the server works the digest out from the document the card was drawn
// from and hands it to the one decision path Slack and MCP use, which checks that it binds the exact ordered plan; a caller that sends a digest (the AI tool) is checked the same way. A refusal says why.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies-node.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { DEV_ISSUER, MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { browserRequests } from "../support/browser-session.js";
import { cardDecision } from "../support/card-decision.js";
import { TEST_ORG } from "../support/orgs.js";

const ORIGIN = new URL(DEV_ISSUER).origin;
const CSRF = "c".repeat(43);

afterEach(() => vi.restoreAllMocks());

describe("the decision body", () => {
  const body = { requestId: randomUUID(), expectedRevision: 4, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] };

  it("OWNER DECISION 7: the old page's decision is refused (410) before its body is read, and the refusal logs only its code, route and task", async () => {
    const taskId = randomUUID();
    const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: "d".repeat(64), sessionId: "s1", amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001", email: "maya@example.com" };
    const logged: Array<Record<string, unknown>> = [];
    const deps = { origin: DEV_ISSUER, readOnly: true, authenticateSession: async () => caller, log: (entry: Record<string, unknown>) => { logged.push(entry); } } as unknown as TaskWebApiDependencies;
    const request: AdaptedHttpRequest = { method: "POST", path: `/review/${taskId}/task/api/decision`, requestId: "r",
      body: JSON.stringify({ ...body, workBreakdownDigest: "b".repeat(64), note: "private note text", surprise: "value-that-must-not-leak" }),
      headers: { origin: ORIGIN, cookie: `__Host-agentx_review_session=s1; __Host-agentx_review_csrf=${CSRF}`, "x-agentx-csrf": CSRF, "content-type": "application/json" } };
    const answer = await createTaskWebApi(deps)(request, new URL(`${ORIGIN}${request.path}`));
    expect(answer.statusCode).toBe(410);
    expect(logged).toEqual([expect.objectContaining({ event: "task_page.refused", route: "decision", taskId, code: "READ_ONLY" })]);
    expect(JSON.stringify(logged)).not.toMatch(/Maya|maya@|private note|value-that-must-not-leak|bbbbbbbb/);
  });
});

describe("approving a coding plan with a work breakdown on its card (OWNER DECISION 7: the old page is read-only)", () => {
  /** A Quick task whose coding plan carries an ordered work breakdown, waiting for Maya. */
  async function breakdownTask(withBreakdown = true) {
    const harness = await createSingleAnswerPlanBroker({ developerExtra: { workflowDependenciesEnabled: true }, brokerExtra: { agents: {} } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Implement the ordered change", client: "test", workflow: true, workflowPath: "QUICK" });
    const id = (started.body.task as { taskId: string }).taskId;
    const workspaceId = (harness.db.get(`DEVTASK#${id}`, "META") as { workspaceId: string }).workspaceId;
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const first = "11111111-1111-4111-8111-111111111111";
    const graph = { schemaVersion: 1 as const, taskId: id, version: 1, items: [
      { id: first, title: "Implement first", description: "Implement the first change", repository: "demo", dependsOn: [] as string[] },
      { id: "22222222-2222-4222-8222-222222222222", title: "Implement second", description: "Implement the second change", repository: "demo", dependsOn: [first] },
    ] };
    const planning = operations().find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument(withBreakdown ? { workBreakdown: graph } : {})));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const workflow = () => (harness.db.get(`DEVTASK#${id}`, "META") as { workflow: { revision: number; stage: string; artifacts: Array<{ sha256: string }>; decisions: Array<Record<string, unknown>> } }).workflow;
    const sha256 = workflow().artifacts.at(-1)!.sha256;
    const revision = workflow().revision;
    harness.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", developerId: MAYA.developerId, provider: MAYA.provider, displayName: MAYA.name,
      ...(MAYA.slackUserId === undefined ? {} : { slackUserId: MAYA.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const send = async (path: string, body: unknown) => {
      const sessionId = randomUUID();
      harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: MAYA.provider,
        startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
      const response = await harness.handler({
        version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${id}/task/api/${path}`, rawQueryString: "",
        headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=${CSRF}`,
          origin: ORIGIN, "x-agentx-csrf": CSRF, "content-type": "application/json" },
        body: JSON.stringify(body), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
      });
      return { status: response.statusCode, json: JSON.parse(response.body) as Record<string, unknown> & { message?: string; error?: string } };
    };
    const decision = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), expectedRevision: revision, artifactDigest: sha256, decision: "APPROVE", answers: [{ decisionId: "d1", optionId: "three", opened: false }], includedCommentIds: [], ...extra });
    const card = (body: Parameters<typeof cardDecision>[3] = {}) => cardDecision(harness, MAYA, id, body);
    return { harness, id, graph, digest: withBreakdown ? taskGraphDigest(graph) : undefined, revision, workflow, send, decision, operations, card };
  }

  it("approves on the card with the plan's own digest, worked out by the server from the document shown, and records it on the approval", async () => {
    const t = await breakdownTask();
    const answer = await t.card({ answers: [{ decisionId: "d1", optionId: "five", opened: true }] });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(t.workflow().revision).toBeGreaterThan(t.revision);
    expect(t.workflow().decisions.at(-1)).toMatchObject({ decision: "APPROVE", workBreakdownDigest: t.digest });
    expect(t.operations().some((item) => item.workflowMode === "IMPLEMENT")).toBe(true);
  });

  it("the card lists the parts of the work breakdown its Approve binds to", async () => {
    const t = await breakdownTask();
    const before = process.env.DECISION_CARDS_ENABLED;
    process.env.DECISION_CARDS_ENABLED = "1";
    try {
      const list = await browserRequests(t.harness)(MAYA, "GET", "/v1/app/decisions");
      expect(((list.body.details ?? {}) as Record<string, Array<{ title: string; lines: string[] }>>)[`approve_plan:${t.id}`]).toEqual(expect.arrayContaining([{ title: "Work breakdown", lines: ["1. Implement first", "2. Implement second"] }]));
    } finally { if (before === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before; }
  });

  it("the old page's decision is refused and approves nothing, whatever digest it carries", async () => {
    const t = await breakdownTask();
    process.env.DECISION_CARDS_ENABLED = "1";
    let answer: Awaited<ReturnType<typeof t.send>>;
    try { answer = await t.send("decision", t.decision({ workBreakdownDigest: t.digest })); } finally { delete process.env.DECISION_CARDS_ENABLED; }
    expect(answer.status).toBe(410);
    expect(answer.json).toMatchObject({ error: "read_only" });
    expect(t.workflow().revision).toBe(t.revision);
  });

  it("still requests changes on the card without a digest", async () => {
    const t = await breakdownTask();
    const answer = await t.card({ decision: "REQUEST_CHANGES", reason: "Split the second part." });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(t.workflow().decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES" });
  });

  it("approves a plan with no breakdown on the card as before", async () => {
    const t = await breakdownTask(false);
    const answer = await t.card();
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(t.workflow().revision).toBeGreaterThan(t.revision);
  });
});

