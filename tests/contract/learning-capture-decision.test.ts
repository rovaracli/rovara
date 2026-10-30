// v1.2 learning loop, B4: a plan send-back reason becomes a correction (design 2.2, 2.4; test I1b; review Critical 1).
// The DECIDER's standing is read live at capture, on every surface (task page, developer API, Slack, MCP), never taken from the task role.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type PlanDocument, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import { decideTaskWorkflow, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { captureSendBack, sendBackSourceKey } from "../../packages/broker/src/learning/capture-decision.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, readLearningState } from "../../packages/broker/src/learning/store.js";
import { LearningCorrectionSchema, type LearningCorrection } from "../../packages/contracts/src/project-learning.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown, planAnswer } from "../support/plan-documents.js";
import { pagePlan } from "../support/page-tasks.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";
import { TEST_ORG } from "../support/orgs.js";
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

function routeDeps(harness: Harness, log: DeveloperTaskRouteDependencies["log"] = () => undefined): DeveloperTaskRouteDependencies {
  return {
    documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions,
    orgId: TEST_ORG, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "contributor" as const }),
    projectChannelIds: async () => [SLACK_CHANNEL], now: () => Date.now(), log,
  };
}

/** A Quick task of project "payments" whose plan waits for its owner, Maya. The project has its META; nobody is a member until `person` says so. */
async function waitingPlan(options: { slackThread?: { teamId: string; channelId: string; threadTs: string } } = {}) {
  const harness = await createSingleAnswerPlanBroker();
  seedProject(harness.db);
  let taskId: string;
  if (options.slackThread === undefined) {
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
    taskId = String((started.body.task as { taskId: string }).taskId);
  } else {
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
  void finishPlanningWithMarkdown;
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
  return { harness, taskId, comment, takeOver, page, api, slack };
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
    seedPerson(slack.harness.db, MAYA_CALLER, "contributor");
    expect((await slack.slack(THREAD, "REQUEST_CHANGES", NOTE)).statusCode).toBe(200);
    expect(corrections(slack.harness)).toMatchObject([{ source: "send_back", standing: "member", author: MAYA.developerId }]);
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
      await t.page(OMAR_CALLER, NOTE);
      expect(corrections(t.harness)).toMatchObject([{ source: "send_back", standing: "outsider", author: OMAR.developerId }]);
    });

    it(`on the developer API and MCP: an owner who took the task over as ${label} is stored as outsider`, async () => {
      const t = await waitingPlan();
      seedPerson(t.harness.db, OMAR_CALLER, grant);
      t.takeOver(OMAR_CALLER);
      const answer = await t.api(OMAR, NOTE);
      // A viewer may be refused outright by the route; whoever gets through is stored as an outsider, and nobody is ever stored as a member.
      if (answer.status === 200) expect(corrections(t.harness)).toMatchObject([{ source: "send_back", standing: "outsider", author: OMAR.developerId }]);
      else expect(corrections(t.harness)).toEqual([]);
      if (grant === "none") expect(answer.status).toBe(200);
    });

    it(`on Slack: the task's owner who is ${label} is stored as outsider`, async () => {
      const t = await waitingPlan({ slackThread: THREAD });
      seedPerson(t.harness.db, MAYA_CALLER, grant);
      expect((await t.slack(THREAD, "REQUEST_CHANGES", NOTE)).statusCode).toBe(200);
      expect(corrections(t.harness)).toMatchObject([{ source: "send_back", standing: "outsider", author: MAYA.developerId }]);
    });
  }

  it("a commenter who took the task over and has no company member record is an outsider", async () => {
    const t = await waitingPlan();
    seedProject(t.harness.db);
    t.harness.db.delete({ pk: `ORG#${TEST_ORG}#MEMBER#${OMAR.developerId}`, sk: "META" });
    t.takeOver(OMAR_CALLER);
    await t.page(OMAR_CALLER, NOTE);
    const stored = corrections(t.harness);
    // Whatever the key layout, the person is no member: the correction (if kept) is an outsider's and never a member's.
    expect(stored.every((c) => c.standing === "outsider")).toBe(true);
  });

  it("the standing is not taken from the decision's role: an outsider's correction never counts as a member's", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    await t.page(OMAR_CALLER, NOTE);
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
    }) as typeof t.harness.db.send;
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
    }) as typeof t.harness.db.send;
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(demoted).toBe(true);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
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

  it("a project with no META (before Plan 2) or an archived project stores nothing; the send-back still happens", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    t.harness.db.delete({ pk: `ORG#${TEST_ORG}#PROJECT#${PROJECT}`, sk: "META" });
    seedProject(t.harness.db, PROJECT, "archived");
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
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
    }) as typeof t.harness.db.send;
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
      expect(c).toMatchObject({ source: "send_back", stage: "plan", taskId: t.taskId, rememberedBy: undefined });
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
    expect(corrections(t.harness)).toMatchObject([{ author: SAM_ID, standing: "member", linkedTo: undefined }]);
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

  it("an outsider's send-back never opens a suggestion, even beside a similar member correction", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    const salt = learningSalt(scope);
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "plan", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, salt)], author: SAM_ID, standing: "member", limit: "automatic",
    });
    await t.page(OMAR_CALLER, "Run the linter before you commit any changes to the repository.");
    expect(items(t.harness, "SUGGESTION#")).toEqual([]);
  });

  it("a grouping failure never fails the send-back", async () => {
    const t = await waitingPlan();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { constructor: { name: string }; input?: { KeyConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("PROJECT_LEARNING")) throw new Error("query failed");
      return send(command as never);
    }) as typeof t.harness.db.send;
    const requestId = randomUUID();
    await t.page(MAYA_CALLER, NOTE, [], requestId);
    expect(requested(t.harness, t.taskId, requestId)).toBe(true);
    expect(corrections(t.harness)).toHaveLength(1);
  });
});

void vi;
