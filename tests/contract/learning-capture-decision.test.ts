// v1.2 learning loop, B4: a plan send-back reason becomes a correction (design 2.2, 2.4; test I1b; review Critical 1).
// The DECIDER's standing is read live at capture, on every surface (task page, developer API, Slack, MCP), never taken from the task role.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type PlanDocument, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import { decideTaskWorkflow, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { captureSendBack, sendBackSourceKey } from "../../packages/broker/src/learning/capture-decision.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, readLearningState } from "../../packages/broker/src/learning/store.js";
import { orgMemberKey } from "../../packages/contracts/src/index.js";
import { LearningCorrectionSchema, type LearningCorrection } from "../../packages/contracts/src/project-learning.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { planAnswer } from "../support/plan-documents.js";
import { pagePlan } from "../support/page-tasks.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { PROJECT, PROJECT_CREATED_AT, learningItems, seedPerson, seedProject, type GrantKind } from "../support/learning-page.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const SAM_ID = "5".repeat(64);
const PLAN: PlanDocument = pagePlan();
delete PLAN.checks;
const NOTE = "Use the shared retry helper in lib/retry, not a hand-written loop.";
const scope = { orgId: TEST_ORG, project: PROJECT, projectCreatedAt: PROJECT_CREATED_AT };

const callerOf = (who: Developer): DeveloperCaller => ({ orgId: TEST_ORG, orgRole: "member" as const, developerId: who.developerId, sessionId: who.sessionId, amr: who.provider, name: who.name, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }) });
const SAM: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: SAM_ID, sessionId: "s-sam", amr: "slack", name: "Sam Lee", slackUserId: "U0SAM0001" };
const OMAR_CALLER = callerOf(OMAR);
const MAYA_CALLER = callerOf(MAYA);

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const workflowOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;

function routeDeps(harness: Harness, log: DeveloperTaskRouteDependencies["log"] = () => undefined, audit?: DeveloperTaskRouteDependencies["learningAudit"]): DeveloperTaskRouteDependencies {
  return {
    ...(audit === undefined ? {} : { learningAudit: audit }),
    documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions,
    orgId: TEST_ORG, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "contributor" as const }),
    projectChannelIds: async () => [SLACK_CHANNEL], now: () => Date.now(), log,
  };
}

/** A Quick task of project "payments" whose plan waits for its owner, Maya. The project has its META; nobody is a member until `person` says so. */
async function waitingPlan(options: { slackThread?: { teamId: string; channelId: string; threadTs: string }; audit?: ReturnType<typeof capturingAuditDeps> } = {}) {
  const harness = await createSingleAnswerPlanBroker(options.audit === undefined ? undefined : { audit: options.audit });
  seedProject(harness.db);
  let taskId: string;
  if (options.slackThread === undefined) {
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
    taskId = String((started.body.task as { taskId: string }).taskId);
  } else {
    // 0.4.24 (C53 turn authority): a Slack-started task's owner must be a live company member before the first turn is queued; each test then sets the grant it is about.
    const slackOwnerId = developerIdForSlackUser(String(MAYA.slackUserId));
    harness.db.set({ pk: `DEVELOPER#${slackOwnerId}`, sk: "META", developerId: slackOwnerId, provider: "slack", slackUserId: MAYA.slackUserId, displayName: "Maya", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedPerson(harness.db, { ...MAYA_CALLER, developerId: slackOwnerId }, "none");
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: options.slackThread, userId: MAYA.slackUserId, instructions: "Retry failed payments", workflowPath: "QUICK", requestId: randomUUID() }) as { body: string };
    taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  }
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(PLAN));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const digest = () => workflowOf(harness, taskId).artifacts.at(-1)!.sha256;
  let minute = 0;
  const comment = (author: DeveloperCaller, text: string, extra: Partial<TaskComment> = {}): string => {
    const commentId = randomUUID();
    minute += 1;
    harness.db.set({
      pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId, commentId, document: "plan", version: 1, target: { kind: "claim", id: "2.1" },
      author: { kind: "person", developerId: author.developerId, name: author.name ?? "Someone", owner: false }, text,
      createdAt: new Date(Date.parse("2026-10-11T09:00:00.000Z") + minute * 60_000).toISOString(), rev: 1, ...extra,
    });
    return commentId;
  };
  const takeOver = (who: DeveloperCaller) => {
    const row = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
    harness.db.set({ ...row, currentOwner: { developerId: who.developerId, name: who.name, provider: "oidc", since: "2026-10-01T00:00:00.000Z" } });
  };
  /** The task page's Request changes, by the given person. */
  const page = (who: DeveloperCaller, note: string | undefined, includedCommentIds: string[] = [], requestId = randomUUID(), log?: DeveloperTaskRouteDependencies["log"]) =>
    decideTaskWorkflow(routeDeps(harness, log), who, taskId, {
      requestId, expectedRevision: workflowOf(harness, taskId).revision, decision: "REQUEST_CHANGES", artifactDigest: digest(),
      reason: note ?? "See the included comments.", includedCommentIds,
    }, { via: "PAGE", ...(note === undefined ? {} : { note }) });
  /** The developer API and MCP (the same route). */
  const api = (who: Developer, reason: string, requestId = randomUUID(), includedCommentIds?: string[]) =>
    harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId, expectedRevision: workflowOf(harness, taskId).revision, decision: "REQUEST_CHANGES", reason, artifactDigest: digest(), ...(includedCommentIds === undefined ? {} : { includedCommentIds }),
    });
  /** The Slack modal's submit. */
  const slack = (thread: { teamId: string; channelId: string; threadTs: string }, decision: "APPROVE" | "REQUEST_CHANGES", reason: string, requestId = randomUUID()) =>
    harness.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId, userId: MAYA.slackUserId, thread, requestId,
      expectedRevision: workflowOf(harness, taskId).revision, artifactDigest: digest(), decision, reason, selectedOptionalCheckIds: [] }) as Promise<{ statusCode: number; body: string }>;
  /** The task's own developer: for a task started in Slack this is the id derived from the Slack user, not Maya's API id. */
  const owner: DeveloperCaller = { ...MAYA_CALLER, developerId: String((harness.db.get(`DEVTASK#${taskId}`, "META") as { developerId: string }).developerId) };
  return { harness, taskId, comment, takeOver, page, api, slack, owner };
}

const corrections = (harness: Harness): LearningCorrection[] => learningItems(harness.db).filter((item) => String(item.sk).startsWith("CORRECTION#"))
  .map((item) => LearningCorrectionSchema.parse(Object.fromEntries(Object.entries(item).filter(([key]) => !["pk", "sk", "entityType", "orgId"].includes(key)))));
const items = (harness: Harness, prefix: string) => learningItems(harness.db).filter((item) => String(item.sk).startsWith(prefix));
const learningDeps = (harness: Harness) => ({ documentClient: harness.db, tableName: "state", now: () => Date.now() });
const THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000099" };
const requested = (harness: Harness, taskId: string, requestId: string) => workflowOf(harness, taskId).decisions.some((d) => d.requestId === requestId && d.decision === "REQUEST_CHANGES");

describe("send-back capture: a member decider", () => {
  it("stores one correction from the page note, with the decider's standing and no rememberedBy", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    const [stored, ...others] = corrections(t.harness);
    expect(others).toEqual([]);
    expect(stored).toMatchObject({
      stage: "plan", source: "send_back", sourceRef: { taskId: t.taskId, decisionRequestId: requestId }, taskId: t.taskId, author: MAYA.developerId, standing: "member", projectCreatedAt: PROJECT_CREATED_AT,
    });
    expect(stored!.rememberedBy).toBeUndefined();
    expect(stored!.linkedTo).toBeUndefined();
    expect(stored!.text).toContain("shared retry helper");
    expect(JSON.stringify(stored!.signature)).not.toContain("retry");
    expect(items(t.harness, "SOURCE#").map((item) => item.correctionId)).toEqual([stored!.id]);
    expect((await readLearningState(learningDeps(t.harness), scope))?.liveCorrections).toBe(1);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
  });

  it("comes from the developer API, which MCP also calls, and from a Slack modal", async () => {
    const api = await waitingPlan();
    seedPerson(api.harness.db, MAYA_CALLER, "maintainer");
    expect((await api.api(MAYA, NOTE)).status).toBe(200);
    expect(corrections(api.harness)).toMatchObject([{ source: "send_back", standing: "member", author: MAYA.developerId }]);

    const slack = await waitingPlan({ slackThread: THREAD });
    seedPerson(slack.harness.db, slack.owner, "contributor");
    expect((await slack.slack(THREAD, "REQUEST_CHANGES", NOTE)).statusCode).toBe(200);
    expect(corrections(slack.harness)).toMatchObject([{ source: "send_back", standing: "member", author: slack.owner.developerId }]);
  });

  it("MCP's decideWorkflowTask is the developer API route the test above drives", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("packages/mcp/src/client.ts", "utf8")).toContain('decideWorkflowTask: async (taskId, request) => task(await call(DeveloperTaskResponseSchema, "POST", path(taskId, "/workflow/decision"), request))');
  });

  it("an owner or admin of the company is a member without a project grant", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "none", "admin");
    await t.page({ ...MAYA_CALLER, orgRole: "admin" }, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ standing: "member" }]);
  });

  it("is idempotent per request: a replay of the page decision adds nothing and counts nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    const input = { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId, reason: NOTE, included: [] };
    const again = await captureSendBack(routeDeps(t.harness), input);
    const third = await captureSendBack(routeDeps(t.harness), input);
    expect(again.created).toEqual([]);
    expect(third.created).toEqual([]);
    expect(corrections(t.harness)).toHaveLength(1);
    expect(items(t.harness, "SOURCE#")).toHaveLength(1);
    expect((await readLearningState(learningDeps(t.harness), scope))?.liveCorrections).toBe(1);
    expect(sendBackSourceKey(t.taskId, requestId)).toBe(`decision#${t.taskId}#${requestId}`);
  });

  it("a replay through the page is the first decision and writes nothing more", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    const revision = workflowOf(t.harness, t.taskId).revision;
    const send = () => decideTaskWorkflow(routeDeps(t.harness), MAYA_CALLER, t.taskId, { requestId, expectedRevision: revision, decision: "REQUEST_CHANGES", artifactDigest: workflowOf(t.harness, t.taskId).artifacts.at(-1)!.sha256, reason: NOTE }, { via: "PAGE", note: NOTE });
    await send();
    await send();
    expect(corrections(t.harness)).toHaveLength(1);
  });
});

describe("send-back capture: I1b, the decider is an outsider (review Critical 1)", () => {
  const OUTSIDER_GRANTS: Array<[string, GrantKind]> = [["a viewer", "viewer"], ["a person with no grant", "none"]];

  for (const [label, grant] of OUTSIDER_GRANTS) {
    it(`on the task page: an owner who took the task over as ${label} is stored as outsider`, async () => {
      const t = await waitingPlan();
      seedPerson(t.harness.db, OMAR_CALLER, grant);
      t.takeOver(OMAR_CALLER);
      const requestId = randomUUID();
      // Since C53 (0.4.24) a viewer may not start the next model turn, so the page refuses the send-back and nothing reaches capture; a person with no grant gets through and is an outsider.
      if (grant === "none") {
        await t.page(OMAR_CALLER, NOTE, [], requestId);
        expect(corrections(t.harness)).toMatchObject([{ source: "send_back", standing: "outsider", author: OMAR.developerId }]);
      } else {
        await expect(t.page(OMAR_CALLER, NOTE, [], requestId)).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
        expect(requested(t.harness, t.taskId, requestId)).toBe(false);
        expect(corrections(t.harness)).toEqual([]);
      }
    });

    it(`on the developer API and MCP: an owner who took the task over as ${label} is stored as outsider`, async () => {
      const t = await waitingPlan();
      seedPerson(t.harness.db, OMAR_CALLER, grant);
      t.takeOver(OMAR_CALLER);
      const answer = await t.api(OMAR, NOTE);
      // S2 (owner decision 2026-11-04; this replaces letting a person with no grant through): asking for plan changes restarts planning, so the API refuses a viewer and a person with no grant alike (403), and nothing reaches capture.
      expect(answer.status).toBe(403);
      expect(corrections(t.harness)).toEqual([]);
    });

    it(`on Slack: the task's owner who is ${label} is stored as outsider`, async () => {
      const t = await waitingPlan({ slackThread: THREAD });
      seedPerson(t.harness.db, t.owner, grant);
      const answer = await t.slack(THREAD, "REQUEST_CHANGES", NOTE);
      // Slack and the API refuse a viewer outright (PROJECT_ACCESS_DENIED), so nothing reaches capture; a person with no grant gets through and is an outsider.
      if (grant === "none") {
        expect(answer.statusCode).toBe(200);
        expect(corrections(t.harness)).toMatchObject([{ source: "send_back", standing: "outsider", author: t.owner.developerId }]);
      } else {
        expect(answer.statusCode).not.toBe(200);
        expect(corrections(t.harness)).toEqual([]);
      }
    });
  }

  it("a commenter who took the task over and has no company member record is an outsider", async () => {
    const t = await waitingPlan();
    seedProject(t.harness.db);
    t.harness.db.delete({ pk: `ORG#${TEST_ORG}#MEMBER#${OMAR.developerId}`, sk: "META" });
    t.takeOver(OMAR_CALLER);
    await t.page(OMAR_CALLER, NOTE);
    const stored = corrections(t.harness);
    // The person is no member: the one correction kept is an outsider's, never a member's (and the set is not empty, so this cannot pass vacuously).
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ standing: "outsider", author: OMAR.developerId });
  });

  it("the standing is not taken from the decision's role: an outsider's correction never counts as a member's", async () => {
    const t = await waitingPlan();
    // A person with no grant: since C53 a viewer's send-back is refused before capture (above).
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    await t.page(OMAR_CALLER, NOTE);
    expect(corrections(t.harness)).toHaveLength(1);
    expect(corrections(t.harness).filter((c) => c.standing === "member")).toEqual([]);
  });

  it("an unreadable member record fails closed: nothing is stored, the send-back still happens, and it is logged", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const logs: Array<Record<string, unknown>> = [];
    const send = t.harness.db.send.bind(t.harness.db);
    const requestId = randomUUID();
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { Key?: { pk?: string } } }) => {
      // The decision's own reads go through; the member record is unreadable only once the send-back is recorded, which is when capture reads it.
      if (command.constructor.name === "GetCommand" && String(command.input?.Key?.pk).includes("MEMBER#") && requested(t.harness, t.taskId, requestId)) throw new Error("boom");
      return send(command as never);
    });
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
    expect(logs.some((entry) => entry.event === "learning.send_back_capture_failed")).toBe(true);
  });

  it("the write carries the decider's standing: a decider demoted between the read and the write stores nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const send = t.harness.db.send.bind(t.harness.db);
    let demoted = false;
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
      if (!demoted && command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) {
        demoted = true;
        seedPerson(t.harness.db, MAYA_CALLER, "viewer");
      }
      return send(command as never);
    });
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(demoted).toBe(true);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
  });
});

/** Runs `between` once, just before the learning correction's transaction is sent: the gap between capture's reads and its write. */
function betweenReadAndWrite(t: Awaited<ReturnType<typeof waitingPlan>>, between: () => void): { fired: () => boolean } {
  const send = t.harness.db.send.bind(t.harness.db);
  let fired = false;
  t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
    if (!fired && command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) {
      fired = true;
      between();
    }
    return send(command as never);
  });
  return { fired: () => fired };
}

describe("send-back capture: changes between the read and the write store nothing, and leave a trace (review items 2 and 3)", () => {
  const refusals = (logs: Array<Record<string, unknown>>) => logs.filter((entry) => entry.event === "learning.send_back_capture_refused");

  it("a decider demoted in the gap: refused as stale, and the log carries ids and a reason only, never the text", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const gap = betweenReadAndWrite(t, () => seedPerson(t.harness.db, MAYA_CALLER, "viewer"));
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(gap.fired()).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
    const [entry, ...others] = refusals(logs);
    expect(others).toEqual([]);
    expect(entry).toEqual({ event: "learning.send_back_capture_refused", taskId: t.taskId, requestId, correctionId: expect.stringMatching(/^[0-9a-f]{32}$/) as string, reason: "stale" });
    expect(JSON.stringify(logs)).not.toMatch(/retry|helper|loop/i);
  });

  it("a decider removed from the company in the gap stores nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const gap = betweenReadAndWrite(t, () => { t.harness.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId)); });
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(gap.fired()).toBe(true);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
    expect(items(t.harness, "SOURCE#")).toEqual([]);
    expect(refusals(logs)).toMatchObject([{ reason: "stale" }]);
  });

  it("a project archived in the gap stores nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const gap = betweenReadAndWrite(t, () => seedProject(t.harness.db, PROJECT, "archived"));
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(gap.fired()).toBe(true);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
    expect(items(t.harness, "SOURCE#")).toEqual([]);
    expect(refusals(logs)).toMatchObject([{ reason: "stale" }]);
  });

  it("a full store refuses the correction and logs store_full with ids only", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const { LEARNING_LIVE_CORRECTIONS_MAX } = await import("../../packages/contracts/src/project-learning.js");
    const first = await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text: "Always run the linter before committing.", signature: [], author: SAM_ID, standing: "member", limit: "automatic",
    });
    expect(first.ok).toBe(true);
    const state = t.harness.db.find((item) => String(item.sk) === "STATE" && String(item.pk).endsWith(`#PROJECT_LEARNING#${PROJECT}`))[0]!;
    // A counter at the limit that was just recounted: the cheap refusal, without counting the table.
    t.harness.db.set({ ...state, liveCorrections: LEARNING_LIVE_CORRECTIONS_MAX, recountedAt: Date.now() });
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness).map((c) => c.id)).toEqual(["earlier-correction"]);
    expect(refusals(logs)).toMatchObject([{ taskId: t.taskId, requestId, reason: "store_full" }]);
    expect(JSON.stringify(logs)).not.toMatch(/retry|helper|loop/i);
  });
});

describe("send-back capture: a refused or stale decision stores nothing (review item 3)", () => {
  it("a decision on a stale revision is refused and captures nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    await expect(decideTaskWorkflow(routeDeps(t.harness), MAYA_CALLER, t.taskId, {
      requestId, expectedRevision: workflowOf(t.harness, t.taskId).revision - 1, decision: "REQUEST_CHANGES", artifactDigest: workflowOf(t.harness, t.taskId).artifacts.at(-1)!.sha256, reason: NOTE,
    }, { via: "PAGE", note: NOTE })).rejects.toBeDefined();
    expect(requested(t.harness, t.taskId, requestId)).toBe(false);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a decision on a changed document (wrong digest) is refused and captures nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    await expect(decideTaskWorkflow(routeDeps(t.harness), MAYA_CALLER, t.taskId, {
      requestId, expectedRevision: workflowOf(t.harness, t.taskId).revision, decision: "REQUEST_CHANGES", artifactDigest: "0".repeat(64), reason: NOTE,
    }, { via: "PAGE", note: NOTE })).rejects.toBeDefined();
    expect(requested(t.harness, t.taskId, requestId)).toBe(false);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a viewer's refused API decision captures nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    expect((await t.api(OMAR, NOTE)).status).toBe(403);
    expect(learningItems(t.harness.db)).toEqual([]);
  });
});

describe("send-back capture: it runs after the index sync, within its own time budget (review item 1)", () => {
  const indexRow = (t: Awaited<ReturnType<typeof waitingPlan>>) => t.harness.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("DEVELOPER#") && String(item.sk).startsWith("TASK#") && String(item.sk).endsWith(`#${t.taskId}`))[0]!;

  it("the index is already synced when capture writes", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const before = indexRow(t).status;
    let atCapture: unknown;
    const gap = betweenReadAndWrite(t, () => { atCapture = indexRow(t).status; });
    await t.page(MAYA_CALLER, NOTE);
    expect(gap.fired()).toBe(true);
    expect(atCapture).not.toBe(before);
    expect(indexRow(t).status).toBe(atCapture);
  });

  it("a capture that never answers does not hold the send-back: the decision is committed, the index is synced, and the delay is logged", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const before = indexRow(t).status;
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
      if (command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) return new Promise(() => undefined);
      return send(command as never);
    });
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    const started = Date.now();
    const answer = await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(answer.task).toBeDefined();
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(indexRow(t).status).not.toBe(before);
    expect(logs.some((entry) => entry.event === "learning.send_back_capture_failed" && entry.step === "timeout")).toBe(true);
  });

  it("a capture that throws leaves the decision committed and the index synced", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const before = indexRow(t).status;
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
      if (command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) throw new Error("table unavailable");
      return send(command as never);
    });
    const requestId = randomUUID();
    const answer = await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(answer.task).toBeDefined();
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(indexRow(t).status).not.toBe(before);
  });

  it("a capture that rejects after the time limit is logged once, as the timeout, and never an unhandled rejection", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
      if (command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) {
        return new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 1800));
      }
      return send(command as never);
    });
    const logs: Array<Record<string, unknown>> = [];
    await t.page(MAYA_CALLER, NOTE, [], randomUUID(), (entry) => logs.push(entry));
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The late result is ignored: one line for the timeout, no second line when the abandoned capture finally fails.
    expect(logs.filter((entry) => typeof entry.event === "string" && entry.event.startsWith("learning.send_back_capture")).map((entry) => entry.step ?? entry.reason)).toEqual(["timeout"]);
  });
});

describe("send-back capture: what is not a correction", () => {
  it("the page's default text and a short note are skipped; the send-back goes through", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const sams = t.comment(SAM, "Fine.");
    await t.page(MAYA_CALLER, undefined, [sams]);
    expect(corrections(t.harness)).toEqual([]);
    const second = await waitingPlan();
    seedPerson(second.harness.db, MAYA_CALLER, "contributor");
    expect((await second.api(MAYA, "Fix it please")).status).toBe(200);
    expect(corrections(second.harness)).toEqual([]);
  });

  it("an approval captures nothing, and neither does a rejection of the page's own text", async () => {
    const t = await waitingPlan({ slackThread: THREAD });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    expect((await t.slack(THREAD, "APPROVE", "Approved in Slack.")).statusCode).toBe(200);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a project with no META (before Plan 2) stores nothing; the send-back still happens", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    t.harness.db.delete({ pk: `ORG#${TEST_ORG}#PROJECT#${PROJECT}`, sk: "META" });
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("an archived project stores nothing: the send-back itself is refused (PROJECT_ARCHIVED), since it would start a new agent run", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedProject(t.harness.db, PROJECT, "archived");
    const requestId = randomUUID();
    await expect(t.page(MAYA_CALLER, NOTE, [], requestId)).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(requested(t.harness, t.taskId, requestId)).toBe(false);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a failing learning write never fails the send-back, and is logged", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const logs: Array<Record<string, unknown>> = [];
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) => {
      if (command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true) throw new Error("table unavailable");
      return send(command as never);
    });
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId, (entry) => logs.push(entry));
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(logs.some((entry) => entry.event === "learning.send_back_capture_failed")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("retry helper");
  });
});

describe("send-back capture: included comments", () => {
  it("each included comment is one correction with its own author's standing, linked to the send-back", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedPerson(t.harness.db, SAM, "contributor");
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    const sams = t.comment(SAM, "Name the migration files with the date prefix first.");
    const omars = t.comment(OMAR_CALLER, "Please also add a rollback script for every migration.");
    const generic = t.comment(SAM, "Looks good to me");
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [sams, omars, generic], requestId);
    const all = corrections(t.harness);
    const main = all.find((c) => c.sourceRef.decisionRequestId === requestId && c.sourceRef.commentId === undefined)!;
    expect(main).toMatchObject({ standing: "member", author: MAYA.developerId });
    const linked = all.filter((c) => c.linkedTo === main.id);
    expect(linked.map((c) => [c.author, c.standing]).sort()).toEqual([[OMAR.developerId, "outsider"], [SAM_ID, "member"]].sort());
    for (const c of linked) {
      expect(c).toMatchObject({ source: "send_back", stage: "plan", taskId: t.taskId });
      expect(c.rememberedBy).toBeUndefined();
      expect(c.sourceRef.decisionRequestId).toBe(requestId);
    }
    expect(all).toHaveLength(3);
    expect((await readLearningState(learningDeps(t.harness), scope))?.liveCorrections).toBe(3);
  });

  it("with only the default text, the comments are still captured, unlinked", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedPerson(t.harness.db, SAM, "contributor");
    const sams = t.comment(SAM, "Name the migration files with the date prefix first.");
    await t.page(MAYA_CALLER, undefined, [sams]);
    expect(corrections(t.harness)).toMatchObject([{ author: SAM_ID, standing: "member" }]);
    expect(corrections(t.harness)[0]!.linkedTo).toBeUndefined();
  });

  it("a comment that was remembered already is not captured twice", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedPerson(t.harness.db, SAM, "contributor");
    const sams = t.comment(SAM, "Name the migration files with the date prefix first.");
    const { rememberTaskComment } = await import("../../packages/broker/src/learning/capture-comment.js");
    await rememberTaskComment({ ...routeDeps(t.harness) }, MAYA_CALLER, t.taskId, sams);
    expect(corrections(t.harness)).toHaveLength(1);
    await t.page(MAYA_CALLER, NOTE, [sams]);
    expect(corrections(t.harness)).toHaveLength(2);
  });

  it("an AgentX comment, a deleted one and an empty one are skipped", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const base = { schemaVersion: 1, taskId: t.taskId, document: "plan", version: 1, target: { kind: "claim", id: "2.1" }, createdAt: "2026-10-11T09:00:00.000Z", rev: 1 };
    const agentx = { ...base, commentId: randomUUID(), author: { kind: "agentx", source: "answer" }, text: "AgentX says to use the shared helper everywhere." } as unknown as TaskComment;
    const deleted = { ...base, commentId: randomUUID(), author: { kind: "person", developerId: SAM_ID, name: "Sam Lee", owner: false }, text: "", deletedAt: "2026-10-11T09:05:00.000Z" } as unknown as TaskComment;
    const outcome = await captureSendBack(routeDeps(t.harness), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId: randomUUID(), reason: NOTE, included: [agentx, deleted] });
    expect(outcome.created).toHaveLength(1);
    expect(corrections(t.harness)).toHaveLength(1);
  });
});

describe("send-back capture: grouping", () => {
  it("runs after a created capture: the new correction is judged (groupedAt) and a lone one forms no suggestion", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.page(MAYA_CALLER, "Run the linter before you commit any changes to the repository.");
    expect(items(t.harness, "SUGGESTION#")).toEqual([]);
    expect(corrections(t.harness)[0]!.groupedAt).toBeDefined();
  });

  it("opens a suggestion when an earlier member correction of another task is similar", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const salt = learningSalt(scope);
    const text = "Always run the linter before committing changes to the repository.";
    const planted = await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, salt)], author: SAM_ID, standing: "member", limit: "automatic",
    });
    expect(planted.ok).toBe(true);
    await t.page(MAYA_CALLER, "Run the linter before you commit any changes to the repository.");
    expect(items(t.harness, "SUGGESTION#")).toHaveLength(1);
  });

  it("emits rule.suggested (by the system, ids and counts only) when a send-back opens a suggestion, and not for a send-back that opens nothing", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const ledger = capturingAuditDeps({ db: t.harness.db, now: () => Date.now() });
    const salt = learningSalt(scope);
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, salt)], author: SAM_ID, standing: "member", limit: "automatic",
    });
    const requestId = randomUUID();
    await captureSendBack(routeDeps(t.harness, undefined, ledger.audit), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId, reason: "Run the linter before you commit any changes to the repository.", included: [] });
    const [suggestion] = items(t.harness, "SUGGESTION#");
    expect(suggestion).toBeDefined();
    expect(ledger.recordedBy("rule.suggested")).toEqual([expect.objectContaining({
      actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: PROJECT },
      facts: { suggestionId: suggestion!.id, stage: "plan", sourceCount: 2, sourceKinds: "send_back", lessSafe: false, fromOnePerson: false },
    })]);
    expect(JSON.stringify(ledger.recorded())).not.toContain("linter");
  });

  it("emits rule.suggested through the hook the page send-back reaches, with no capture failure logged", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const ledger = capturingAuditDeps({ db: t.harness.db, now: () => Date.now() });
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, learningSalt(scope))], author: SAM_ID, standing: "member", limit: "automatic",
    });
    const logs: Array<Record<string, unknown>> = [];
    const answer = await decideTaskWorkflow(routeDeps(t.harness, (entry) => logs.push(entry), ledger.audit), MAYA_CALLER, t.taskId, {
      requestId: randomUUID(), expectedRevision: workflowOf(t.harness, t.taskId).revision, decision: "REQUEST_CHANGES", artifactDigest: workflowOf(t.harness, t.taskId).artifacts.at(-1)!.sha256,
      reason: "Run the linter before you commit any changes to the repository.", includedCommentIds: [],
    }, { via: "PAGE", note: "Run the linter before you commit any changes to the repository." });
    expect(answer.task).toBeDefined();
    expect(ledger.recordedBy("rule.suggested")).toHaveLength(1);
    expect(logs.filter((entry) => typeof entry.event === "string" && entry.event.startsWith("learning.send_back_capture"))).toEqual([]);
  });

  it("emits rule.suggested for a send-back through the developer API (the broker's own wiring), and through the Slack modal", async () => {
    const salt = learningSalt(scope);
    const text = "Always run the linter before committing changes to the repository.";
    const earlier = (t: Awaited<ReturnType<typeof waitingPlan>>) => captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, salt)], author: SAM_ID, standing: "member", limit: "automatic",
    });
    const viaApi = capturingAuditDeps();
    const a = await waitingPlan({ audit: viaApi });
    seedPerson(a.harness.db, MAYA_CALLER, "maintainer");
    await earlier(a);
    expect((await a.api(MAYA, "Run the linter before you commit any changes to the repository.")).status).toBe(200);
    expect(viaApi.recordedBy("rule.suggested")).toHaveLength(1);

    const viaSlack = capturingAuditDeps();
    const b = await waitingPlan({ slackThread: THREAD, audit: viaSlack });
    seedPerson(b.harness.db, b.owner, "contributor");
    await earlier(b);
    expect((await b.slack(THREAD, "REQUEST_CHANGES", "Run the linter before you commit any changes to the repository.")).statusCode).toBe(200);
    expect(viaSlack.recordedBy("rule.suggested")).toHaveLength(1);
  });

  it("an outsider's send-back never opens a suggestion, even beside a similar member correction", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    const salt = learningSalt(scope);
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, salt)], author: SAM_ID, standing: "member", limit: "automatic",
    });
    await t.page(OMAR_CALLER, "Run the linter before you commit any changes to the repository.");
    expect(corrections(t.harness).filter((c) => c.standing === "outsider")).toHaveLength(1);
    expect(items(t.harness, "SUGGESTION#")).toEqual([]);
  });

  it("a grouping failure never fails the send-back", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { KeyConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("PROJECT_LEARNING")) throw new Error("query failed");
      return send(command as never);
    });
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toHaveLength(1);
  });
});

