// S2 (register SB-2 and F27-5, owner decision 2026-11-04): a removed or no-longer-allowed person must not start more coding through ANY path the send-back access gate covers. The gate
// (`requireProjectSendBackRole`) was on Send back and Fix-on-findings only. These are the other human paths: approving the fix of PR review comments, the CI-fix Retry, and forward onto a
// coding step after every finding is accepted. Each is refused the way a send-back is: the same code and words for no access, a viewer and an archived project; another org reads as no task.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMemberKey, orgRemovedKey, projectMetaKey, type WorkflowSnapshot } from "@agentx/contracts";
import { submitWorkflowFeedbackDecision, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { sendBackNoAccessMessage } from "../../packages/broker/src/developer/task-access.js";
import { viewerCannotStartTasksMessage } from "../../packages/broker/src/developer/project-roles.js";
import { MAYA } from "../support/developer-task-broker.js";
import { seedReview } from "../support/rovara-code-feedback.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { agentXError } from "@agentx/contracts";

type CheckAccess = DeveloperTaskRouteDependencies["checkAccess"];
const grantedAs = (role: "maintainer" | "contributor" | "viewer"): CheckAccess => async () => ({ revision: 1, policy: {} as never, access: "granted", channelIds: [], role });
const denied: CheckAccess = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "no access"); };
const OWNER: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };

/** The refusal is PROJECT_ACCESS_DENIED and carries the send-back gate's words (it may add a hint after them). */
async function expectRefused(promise: Promise<unknown>, text: string): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught) as { code?: string; message?: string } | undefined;
  expect(error?.code).toBe("PROJECT_ACCESS_DENIED");
  expect(error?.message).toContain(text);
}

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
/** A real task of project "payments" whose workspace is ready (planning cancelled), then given a stored PR review waiting for the owner's decision. */
async function plannedReview() {
  const harness = await createDeveloperTaskBroker({});
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Handle retries", client: "test", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const meta = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${meta.workspaceId}` && item.entityType === "OPERATION");
  await harness.finish(meta.workspaceId, String(operations().find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  await harness.finish(meta.workspaceId, String(operations().find((item) => item.workflowMode === "PLAN")!.id), "CANCELLED");
  return { harness, ...seedReview(harness, taskId, { extra: { definitionVersion: "1.1.0" } }) };
}

describe("approving the fix of PR review comments is gated like a send-back", () => {
  const approve = async (options: { checkAccess?: CheckAccess; caller?: DeveloperCaller; before?: (f: Awaited<ReturnType<typeof plannedReview>>) => void } = {}) => {
    const fixture = await plannedReview();
    options.before?.(fixture);
    const deps = { ...fixture.deps, ...(options.checkAccess === undefined ? {} : { checkAccess: options.checkAccess }) };
    const card = fixture.workflow.feedbackReview!;
    const body = { requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: card.reviewRef!.sha256, proposalDigest: card.reviewRef!.proposalDigest,
      bundleDigests: card.bundleRefs.map((bundle) => bundle.sha256), decision: "APPROVE" as const, selectedFindingIds: card.reviewRef!.findingRefs.map((finding) => finding.id) };
    const result = submitWorkflowFeedbackDecision(deps, options.caller ?? OWNER, fixture.taskId, body);
    return { fixture, result, workflow: () => fixture.stored().workflow as WorkflowSnapshot };
  };

  it("golden: an allowed contributor approves, and coding starts", async () => {
    const t = await approve({ checkAccess: grantedAs("contributor") });
    await expect(t.result).resolves.toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    expect(t.workflow()).toMatchObject({ stage: "IMPLEMENT" });
  });

  it("a member with no project access is refused with the send-back's words, and nothing changes", async () => {
    const t = await approve({ checkAccess: denied });
    await expectRefused(t.result, sendBackNoAccessMessage("payments"));
    expect(t.workflow().feedbackDecisions ?? []).toEqual([]);
    expect(t.workflow().stage).toBe("WAIT_FOR_MERGE");
  });

  it("a project viewer is refused with the viewer message", async () => {
    const t = await approve({ checkAccess: grantedAs("viewer") });
    await expectRefused(t.result, viewerCannotStartTasksMessage("payments"));
    expect(t.workflow().feedbackDecisions ?? []).toEqual([]);
  });

  it("an archived project is refused (PROJECT_ARCHIVED), even for a maintainer", async () => {
    const t = await approve({ checkAccess: grantedAs("maintainer"), before: (f) => f.harness.db.set({ ...projectMetaKey(TEST_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "x" }) });
    await expect(t.result).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(t.workflow().feedbackDecisions ?? []).toEqual([]);
  });

  it("a company admin with no grant passes (the gate's own rule)", async () => {
    const t = await approve({ checkAccess: denied, caller: { ...OWNER, orgRole: "admin" } });
    await expect(t.result).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("a person removed from the company is refused, and the task ends creator_removed", async () => {
    const t = await approve({ checkAccess: grantedAs("contributor"), before: (f) => { f.harness.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId)); f.harness.db.set({ ...orgRemovedKey(TEST_ORG, MAYA.developerId), entityType: "ORG_REMOVED", removedAt: new Date().toISOString() }); } });
    await expect(t.result).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(t.fixture.stored()).toMatchObject({ outcome: "creator_removed" });
    expect(t.workflow().feedbackDecisions ?? []).toEqual([]);
  });

  it("another company's caller reads it as no task", async () => {
    const t = await approve({ checkAccess: grantedAs("maintainer"), caller: { ...OWNER, orgId: "org_aaaaaaaaaaaaaaaaaaaa" } });
    await expect(t.result).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(t.workflow().feedbackDecisions ?? []).toEqual([]);
  });
});
