// Rovara Code (blind test 02, staging 0.4.13): a real broker handler with a Rovara Code task that asked its questions and waits for answers, so the clients that answer (the CLI, the MCP tools
// and the app) run against the real routes. Maya (the owner) is the signed-in caller; `member` signs in another person. Understand's questions come from untrusted model output, so they go through
// the same artifact path a worker uses.
import { randomUUID } from "node:crypto";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { UNDERSTAND_ARTIFACT_NAME, builtinSettingsKey, projectMemberKey, type IntentAssessment } from "@rovara-code/contracts";
import { MAYA, bearerFor, createDeveloperTaskBroker, seedMembership, DEV_ISSUER, type Developer } from "./developer-task-broker.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { TEST_ORG } from "./orgs.js";

export { MAYA, DEV_ISSUER };
const NOW = "2026-10-25T12:00:00.000Z";
const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
export const CELL = DEV_ISSUER.replace(/\/v1\/auth$/, "");

/** Two questions: the first with options and a recommendation, the second open. */
export const QUESTIONS: IntentAssessment = {
  kind: "questions", restatement: "Add pagination to GET /items.", questions: [
    { id: "q1", text: "What response shape should the paginated endpoint return?", options: [{ id: "a", label: "Plain array" }, { id: "b", label: "Envelope: items, total, limit, offset" }], recommended: "b" },
    { id: "q2", text: "Which page size by default?" },
  ],
};

export async function questionsBroker() {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  await new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });

  /** A member of the org with a role on payments, signed in. */
  const member = (who: Developer, role: "viewer" | "developer" = "developer") => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role, projectRole: role === "viewer" ? "viewer" : "contributor" });
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; sessionId: string; workflow: { revision: number; stage: string; state: string; intent?: { rounds: number; assessment?: IntentAssessment; answers: Array<Record<string, unknown>> } };
  };
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");

  /** A task whose Understand asked `assessment`, and which now waits for answers. */
  const waitingTask = async (assessment: IntentAssessment = QUESTIONS, text = "The items list is getting unwieldy. Add pagination.") => {
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text } });
    if (reply.status !== 202) throw new Error(`the Rovara Code task did not start: ${JSON.stringify(reply.body)}`);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const workspaceId = meta(taskId).workspaceId;
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const operationId = String(operations(workspaceId).filter((item) => item.workflowMode === "UNDERSTAND").at(-1)!.id);
    await h.artifact(workspaceId, operationId, UNDERSTAND_ARTIFACT_NAME, JSON.stringify(assessment));
    await h.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
    const sessionId = meta(taskId).sessionId;
    if (meta(taskId).workflow.state !== "WAITING") throw new Error(`the task is not waiting for answers: ${JSON.stringify(meta(taskId).workflow)}`);
    await refreshSessionSummary({ documentClient: h.db, tableName: "state", now: Date.now, log: () => undefined }, TEST_ORG, sessionId);
    return { taskId, sessionId, workspaceId };
  };
  return { ...h, member, meta, operations, waitingTask, bearer: async (who: Developer = MAYA) => bearerFor(who, await h.orgOf(who)) };
}
export type QuestionsBroker = Awaited<ReturnType<typeof questionsBroker>>;
