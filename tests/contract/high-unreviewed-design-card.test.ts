// Review missing test 5 (OWNER DECISION 7): a HIGH design without design review is approved on its card only under the decide-grade sign-in made for that card. An unreviewed design's own tier tops out at
// medium, so a company lock raises it to high here (the one way it gets there), through the real broker and card routes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserRequests } from "../support/browser-session.js";
import { decideSessionFor, signInApprovalOf } from "../support/decide-sign-in.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

vi.mock("../../packages/broker/src/decisions/risk-tier.js", async (original) => {
  const actual = await original<typeof import("../../packages/broker/src/decisions/risk-tier.js")>();
  return { ...actual, riskTierOf: (kind: Parameters<typeof actual.riskTierOf>[0], inputs: Parameters<typeof actual.riskTierOf>[1], locks: Parameters<typeof actual.riskTierOf>[2] = {}) => actual.riskTierOf(kind, inputs, { ...locks, approve_design: "high" }) };
});

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });

describe("a HIGH design without design review, on its card", () => {
  it("asks for the decide-grade sign-in and decides nothing without it; a token and someone else are refused; with it, the owner approves", async () => {
    const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
    const web = browserRequests(h);
    const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow: { reviewPhase?: string; decisions: Array<{ decision: string }> } };
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "FULL" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = meta(taskId).workspaceId;
    const operation = (predicate: (item: Record<string, unknown>) => boolean) => String(h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter(predicate).at(-1)!.id);
    await h.finish(workspaceId, operation((item) => item.kind === "prepare"), "SUCCEEDED", PREPARED);
    const plan = async (title: string) => {
      const planning = operation((item) => item.workflowMode === "PLAN" && item.status !== "SUCCEEDED");
      await h.artifact(workspaceId, planning, "plan.md", planAnswer(planDocument({ title })));
      await h.finish(workspaceId, planning, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    };
    await plan("Retry failed payments: requirements");
    const cards = async () => { const list = await web(MAYA, "GET", "/v1/app/decisions"); return { cards: (list.body.cards ?? []) as Array<{ id: string; kind: string; risk: string }>, digests: (list.body.digests ?? {}) as Record<string, string> }; };
    const requirements = (await cards()).cards.find((card) => card.kind === "approve_requirements")!;
    const reqDigest = (await cards()).digests[requirements.id]!;
    if (requirements.risk === "medium") await web(MAYA, "POST", `/v1/app/decisions/approve_requirements/${taskId}/evidence-opened`, { requestId: randomUUID(), shownDigest: reqDigest });
    expect((await web(MAYA, "POST", `/v1/app/decisions/approve_requirements/${taskId}/approve`, { requestId: randomUUID(), shownDigest: reqDigest })).status).toBe(200);
    await plan("Retry failed payments: design");
    expect(meta(taskId).workflow.reviewPhase).toBe("DESIGN");
    const listed = await cards();
    const design = listed.cards.find((card) => card.kind === "approve_design")!;
    expect(design).toMatchObject({ id: `approve_design:${taskId}`, risk: "high" });
    const path = `/v1/app/decisions/approve_design/${taskId}/approve`;
    const body = () => ({ requestId: randomUUID(), shownDigest: listed.digests[design.id]! });
    expect((await h.dev(MAYA, "POST", path, body())).status).toBe(403);
    const asked = await web(MAYA, "POST", path, body());
    expect(asked.status, JSON.stringify(asked.body)).toBe(403);
    expect(asked.body).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "member" });
    expect((await web(OMAR, "POST", path, body())).status).toBe(404);
    expect(meta(taskId).workflow.decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(1);
    const { cookie } = await decideSessionFor(h.db, MAYA.developerId, signInApprovalOf(asked.body));
    const approved = await web(MAYA, "POST", path, body(), 0, cookie);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(meta(taskId).workflow.decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(2);
  });
});
