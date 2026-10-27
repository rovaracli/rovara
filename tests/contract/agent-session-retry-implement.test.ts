// Plan 5 Task 13 review, I-1: a session editor's retry of blocked CODING (IMPLEMENT/BLOCKED) goes through `queueWorkflowCoding`, which re-authorizes with the action "work". The session actor
// of `retryTaskWorkflowFor` was honoured for "retry" and "control" only, so the coding run committed (spend started) and the retry then threw TASK_NOT_FOUND, with no event, no request
// item and no audit item on the session. The retry now authorizes the same way before and after it commits, and records itself whenever a run started.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSessionKey, projectMemberKey } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, grantProject } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
type Item = Record<string, unknown>;

beforeAll(async () => { await loadSlackBroker(); });

async function setup() {
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; requestId?: string; workflowMode?: string }>;
  const task = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Item & { workspaceId: string; workflow: { revision: number; stage: string; state: string } & Item };
  const events = (sessionId: string) => h.db.find((item) => item.pk === agentSessionKey(TEST_ORG, sessionId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => ({ type: item.type, text: item.text }));
  /** A Quick task whose plan was approved and whose coding step then failed: IMPLEMENT/BLOCKED, shared with Omar at "can edit". */
  const blockedCoding = async () => {
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { taskId, sessionId } = started.body.task as { taskId: string; sessionId: string };
    const record = task(taskId);
    const workspaceId = record.workspaceId;
    h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
    await h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
    await finishPlanningWithMarkdown(h, workspaceId, String(operations(workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
    const approved = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: task(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex"),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const implementation = operations(workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    await h.finish(workspaceId, implementation.id, "FAILED", { error: "the model stopped" });
    expect(task(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    grantProject(h.db, OMAR);
    const shared = await h.dev(MAYA, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: OMAR.developerId }, level: "edit" });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    return { taskId, sessionId, workspaceId };
  };
  return { ...h, operations, task, events, blockedCoding };
}

describe("a session editor retries coding that stopped (13 review I-1)", () => {
  it("restarts the coding run in the same session and records the retry: the event, the request item, and a repeat of the request starts nothing", async () => {
    const t = await setup();
    const { taskId, sessionId, workspaceId } = await t.blockedCoding();
    const requestId = randomUUID();
    const retried = await t.dev(OMAR, "POST", `/v1/app/sessions/${sessionId}/retry`, { requestId });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((retried.body.session as { sessionId: string }).sessionId).toBe(sessionId);
    // The run started...
    expect(t.task(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(t.operations(workspaceId).filter((operation) => operation.requestId === requestId && operation.workflowMode === "IMPLEMENT")).toHaveLength(1);
    // ...and the session says who started it, with the request recorded so a repeat answers the same.
    expect(t.events(sessionId).filter((event) => event.type === "retried")).toEqual([{ type: "retried", text: "Omar Diaz retried this." }]);
    expect(t.db.get(agentSessionKey(TEST_ORG, sessionId, `REQUEST#${requestId}`))).toMatchObject({ action: "retry", by: OMAR.developerId, sessionId });
    const again = await t.dev(OMAR, "POST", `/v1/app/sessions/${sessionId}/retry`, { requestId });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t.operations(workspaceId).filter((operation) => operation.requestId === requestId)).toHaveLength(1);
    expect(t.events(sessionId).filter((event) => event.type === "retried")).toHaveLength(1);
    // Omar is not the owner: the task is still Maya's.
    expect((t.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as { owner: { developerId: string } }).owner.developerId).toBe(MAYA.developerId);
  });

  it("queues no run for an editor who is made a project viewer while the retry is being prepared (the pre-commit check and requireMayGoOn both refuse)", async () => {
    const t = await setup();
    const { taskId, sessionId, workspaceId } = await t.blockedCoding();
    const before = t.operations(workspaceId).length;
    // The editor becomes a viewer of the project after the retry's first check and before its commit (the approved plan is read in between).
    const send = t.db.send;
    let demoted = false;
    t.db.send = async (command) => {
      const input = (command as { input: { Key?: { pk?: string; sk?: string } } }).input;
      if (!demoted && command.constructor.name === "GetCommand" && input.Key?.pk === `WORKSPACE#${workspaceId}` && input.Key.sk === "META") {
        demoted = true;
        t.db.set({ ...projectMemberKey(TEST_ORG, OMAR.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "viewer", projectRole: "viewer" });
      }
      return send(command);
    };
    const refused = await t.dev(OMAR, "POST", `/v1/app/sessions/${sessionId}/retry`, { requestId: randomUUID() });
    t.db.send = send;
    expect(demoted).toBe(true);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(t.operations(workspaceId)).toHaveLength(before);
    expect(t.task(taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
  });
});
