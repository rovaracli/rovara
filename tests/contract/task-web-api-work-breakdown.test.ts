// Approving a coding plan that has a work breakdown from the task page: the page sends the breakdown's digest, the API accepts it and hands it to the one decision path
// Slack and MCP use, and the server alone checks that it binds the exact ordered plan. A refusal says why, and leaves a safe log line.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskGraphDigest } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { TASK_PAGE_DECIDING_SCRIPT } from "../../packages/broker/src/aws/task-page-assets.js";
import { PageDecisionInputSchema, createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import { DEV_ISSUER, MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";

const ORIGIN = new URL(DEV_ISSUER).origin;
const CSRF = "c".repeat(43);
const GENERIC = "AgentX couldn't do that right now. Try again shortly.";

afterEach(() => vi.restoreAllMocks());

describe("the decision body", () => {
  const body = { requestId: randomUUID(), expectedRevision: 4, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] };

  it("accepts a work breakdown digest of 64 lowercase hex characters, as the MCP tool does, and nothing else", () => {
    expect(PageDecisionInputSchema.safeParse({ ...body, workBreakdownDigest: "b".repeat(64) }).success).toBe(true);
    for (const bad of ["b".repeat(63), "B".repeat(64), "z".repeat(64), "", 7, null]) {
      expect(PageDecisionInputSchema.safeParse({ ...body, workBreakdownDigest: bad }).success, String(bad)).toBe(false);
    }
  });

  it("reaches the decide dependency with the digest, and a refusal logs only its code, route and task", async () => {
    const taskId = randomUUID();
    const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: "d".repeat(64), sessionId: "s1", amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001", email: "maya@example.com" };
    const seen: unknown[] = [];
    const logged: Array<Record<string, unknown>> = [];
    const deps = { origin: DEV_ISSUER, authenticateSession: async () => caller, log: (entry: Record<string, unknown>) => { logged.push(entry); },
      decide: async (_who: DeveloperCaller, _id: string, input: unknown) => { seen.push(input); throw Object.assign(new Error("CONFIG_INVALID: Maya Chen maya@example.com secret-token"), { code: "CONFIG_INVALID" }); },
    } as unknown as TaskWebApiDependencies;
    const request: AdaptedHttpRequest = { method: "POST", path: `/review/${taskId}/task/api/decision`, requestId: "r",
      body: JSON.stringify({ ...body, workBreakdownDigest: "b".repeat(64), note: "private note text" }),
      headers: { origin: ORIGIN, cookie: `__Host-agentx_review_session=s1; __Host-agentx_review_csrf=${CSRF}`, "x-agentx-csrf": CSRF, "content-type": "application/json" } };
    const answer = await createTaskWebApi(deps)(request, new URL(`${ORIGIN}${request.path}`));
    expect(answer.statusCode).toBe(409);
    expect(seen).toEqual([expect.objectContaining({ workBreakdownDigest: "b".repeat(64) })]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: "task_page.refused", route: "decision", taskId, code: "CONFIG_INVALID" });
    expect(JSON.stringify(logged)).not.toMatch(/Maya|maya@|secret-token|private note|bbbbbbbb/);
  });

  it("logs a body the schema refuses by its code and the names of the fields, never the values", async () => {
    const taskId = randomUUID();
    const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: "d".repeat(64), sessionId: "s1", amr: "slack", name: "Maya Chen" };
    const logged: Array<Record<string, unknown>> = [];
    const deps = { origin: DEV_ISSUER, authenticateSession: async () => caller, log: (entry: Record<string, unknown>) => { logged.push(entry); } } as unknown as TaskWebApiDependencies;
    const request: AdaptedHttpRequest = { method: "POST", path: `/review/${taskId}/task/api/decision`, requestId: "r",
      body: JSON.stringify({ ...body, note: "private note text", surprise: "value-that-must-not-leak" }),
      headers: { origin: ORIGIN, cookie: `__Host-agentx_review_session=s1; __Host-agentx_review_csrf=${CSRF}`, "x-agentx-csrf": CSRF, "content-type": "application/json" } };
    const answer = await createTaskWebApi(deps)(request, new URL(`${ORIGIN}${request.path}`));
    expect(answer.statusCode).toBe(400);
    expect((JSON.parse(answer.body) as { message?: string }).message).toEqual(expect.stringContaining("Refresh"));
    expect(logged).toEqual([expect.objectContaining({ event: "task_page.refused", route: "decision", taskId, code: "INVALID_REQUEST" })]);
    expect(JSON.stringify(logged)).not.toMatch(/private note|value-that-must-not-leak/);
  });
});

describe("approving a coding plan with a work breakdown from the page", () => {
  /** A Quick task whose coding plan carries an ordered work breakdown, waiting for Maya. */
  async function breakdownTask(withBreakdown = true) {
    const harness = await createSingleAnswerPlanBroker({ developerExtra: { workflowDependenciesEnabled: true } });
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
    return { harness, id, graph, digest: withBreakdown ? taskGraphDigest(graph) : undefined, revision, workflow, send, decision, operations };
  }

  it("approves with the plan's own digest and records it on the approval", async () => {
    const t = await breakdownTask();
    const answer = await t.send("decision", t.decision({ workBreakdownDigest: t.digest }));
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(t.workflow().revision).toBeGreaterThan(t.revision);
    expect(t.workflow().decisions.at(-1)).toMatchObject({ decision: "APPROVE", workBreakdownDigest: t.digest });
    expect(t.operations().some((item) => item.workflowMode === "IMPLEMENT")).toBe(true);
  });

  it("refuses a wrong digest in words the page can show, and approves nothing", async () => {
    const t = await breakdownTask();
    const answer = await t.send("decision", t.decision({ workBreakdownDigest: "0".repeat(64) }));
    expect(answer.status).toBe(409);
    expect(answer.json.message).toMatch(/work breakdown changed/i);
    expect(answer.json.message).not.toBe(GENERIC);
    expect(t.workflow().revision).toBe(t.revision);
    expect(t.workflow().decisions.some((entry) => entry.decision === "APPROVE")).toBe(false);
    expect(t.operations().some((item) => item.workflowMode === "IMPLEMENT")).toBe(false);
  });

  it("refuses a missing digest on a plan with a breakdown, says what to do, and approves nothing", async () => {
    const t = await breakdownTask();
    const answer = await t.send("decision", t.decision());
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.json.message).toMatch(/work breakdown/i);
    expect(answer.json.message).toMatch(/refresh/i);
    expect(answer.json.message).not.toBe(GENERIC);
    expect(t.workflow().revision).toBe(t.revision);
    expect(t.operations().some((item) => item.workflowMode === "IMPLEMENT")).toBe(false);
  });

  it("logs the refusal with its code, task and route and none of the request", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const t = await breakdownTask();
    await t.send("decision", t.decision({ workBreakdownDigest: "0".repeat(64), note: "private note text" }));
    const refusal = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).filter((entry) => entry.event === "task_page.refused");
    expect(refusal).toEqual([expect.objectContaining({ component: "broker", route: "decision", taskId: t.id, code: "CONFIG_INVALID" })]);
    expect(lines.join("\n")).not.toMatch(/private note|maya@|Maya Chen|cookie|csrf/i);
  });

  it("still requests changes without a digest", async () => {
    const t = await breakdownTask();
    const answer = await t.send("decision", t.decision({ decision: "REQUEST_CHANGES", note: "Split the second part." }));
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(t.workflow().decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES" });
  });

  it("still rejects without a digest, through the core decision route the page does not use", async () => {
    const t = await breakdownTask();
    const rejected = await t.harness.dev(MAYA, "POST", `/v1/dev/tasks/${t.id}/workflow/decision`, { requestId: randomUUID(), expectedRevision: t.revision, decision: "REJECT", reason: "Not wanted", artifactDigest: t.workflow().artifacts.at(-1)!.sha256 });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
  });

  it("approves a plan with no breakdown as before, and refuses a digest on it", async () => {
    const t = await breakdownTask(false);
    const stray = await t.send("decision", t.decision({ workBreakdownDigest: "0".repeat(64) }));
    expect(stray.status).toBeGreaterThanOrEqual(400);
    expect(stray.json.message).toMatch(/no work breakdown/i);
    const answer = await t.send("decision", t.decision());
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(t.workflow().revision).toBeGreaterThan(t.revision);
  });
});

describe("the page and the decision body", () => {
  it("every field the page script puts in a decision is one the strict schema accepts", () => {
    const start = TASK_PAGE_DECIDING_SCRIPT.indexOf("function submit(){");
    const end = TASK_PAGE_DECIDING_SCRIPT.indexOf('call("POST","decision",payload)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = TASK_PAGE_DECIDING_SCRIPT.slice(start, end);
    const literal = /var body=\{([\s\S]*?)\n {2}\};/u.exec(source)?.[1] ?? "";
    const keys = new Set([
      "requestId",
      ...[...literal.matchAll(/(?:^|[,{\s])([A-Za-z]+):/gu)].map((match) => match[1]!).filter((key) => key !== "function" && key !== "decisionId" && key !== "optionId" && key !== "opened"),
      ...[...source.matchAll(/\bbody\.([A-Za-z]+)\s*=/gu)].map((match) => match[1]!),
    ]);
    expect([...keys]).toEqual(expect.arrayContaining(["expectedRevision", "artifactDigest", "decision", "answers", "includedCommentIds", "workBreakdownDigest", "note"]));
    const accepted = new Set(Object.keys(PageDecisionInputSchema.shape));
    expect([...keys].filter((key) => !accepted.has(key))).toEqual([]);
  });
});
