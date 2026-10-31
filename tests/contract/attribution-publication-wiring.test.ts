// Enterprise foundations I3 (wiring): the attribution a publication carries is filled in from the broker's own records, goes to the worker only as the payload's `attribution`
// (the commit and description are built from it there), and the audit event that records the opening relates the people it names. Through the real broker handlers.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ActingAttributionSchema } from "../../packages/contracts/src/index.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";

beforeAll(loadSlackBroker, 60_000);

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const user = "U0123456789";
const MAYA_ID = "a".repeat(64);
const PRIYA_ID = "b".repeat(64);

async function harness() {
  const capture = capturingAuditDeps();
  const { handler, db, brokerInput } = createBroker({ extra: { audit: capture.audit } });
  capture.attach(db);
  (brokerInput.githubPullRequests.reconcilePullRequest as unknown as { mockResolvedValue(value: unknown): void }).mockResolvedValue({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false });
  await registerSlackProject(handler);
  const workspace = await ensureWorkspace(handler, thread, user);
  const workspaceId = workspace.body.workspaceId as string;
  markReady(db, workspaceId);
  return { handler, db, capture, workspaceId };
}

async function startPublish(h: Awaited<ReturnType<typeof harness>>) {
  const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/pull-requests`, { requestId: randomUUID(), repository: "demo", title: "Fix the bug" });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const operationId = (accepted.body.operation as { id: string }).id;
  const invocation = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string; payload: { headBranch: string } };
  return { operationId, capability: invocation.callbackCapability, headBranch: invocation.payload.headBranch };
}

const sendCallback = (h: Awaited<ReturnType<typeof harness>>, start: Awaited<ReturnType<typeof startPublish>>) => call(h.handler, {
  method: "POST",
  path: `/v1/internal/workspaces/${h.workspaceId}/operations/${start.operationId}/pull-request`,
  headers: { "x-agentx-callback-capability": start.capability },
  body: { repository: "demo", repositoryUrl: "https://github.com/example/demo.git", headBranch: start.headBranch, baseBranch: "main", commit: "d".repeat(40), title: "Fix the bug" },
});

describe("the audit event that records a pull request opening relates the people it names", () => {
  it("carries the full ids of the requester and the approver as `related`, taken from the publication", async () => {
    const h = await harness();
    const start = await startPublish(h);
    const operation = h.db.find((item) => item.entityType === "OPERATION" && item.id === start.operationId)[0]!;
    h.db.set({ ...operation, publication: { ...(operation.publication as object), relatedIds: [MAYA_ID, PRIYA_ID] } });
    expect((await sendCallback(h, start)).status).toBe(200);
    const [event] = h.capture.recordedBy("pull_request.opened");
    expect(event?.related).toEqual([MAYA_ID, PRIYA_ID]);
  });

  it("carries no `related` for a publication that named no one (an automatic run)", async () => {
    const h = await harness();
    const start = await startPublish(h);
    expect((await sendCallback(h, start)).status).toBe(200);
    expect(h.capture.recordedBy("pull_request.opened")[0]).not.toHaveProperty("related");
  });
});

describe("the attribution schema is what the worker is sent", () => {
  it("rejects an attribution that carries a person id in place of a reference", () => {
    expect(ActingAttributionSchema.safeParse({ requester: { state: "named", name: "Maya Chen", ref: MAYA_ID } }).success).toBe(false);
    expect(ActingAttributionSchema.safeParse({ requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" } }).success).toBe(true);
  });
});
