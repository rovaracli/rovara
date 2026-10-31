// Track record (v1.2 slice 1): the plan check's claim is written after the person's decision commits, and only then.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PlanDocument, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import { decideTaskWorkflow, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown, planAnswer } from "../support/plan-documents.js";
import { pagePlan } from "../support/page-tasks.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const SAM_ID = "5".repeat(64);

/** Two decisions: d1 on claim 2.1 (AgentX recommends Below) and d2 on claim 1 (AgentX recommends Three times). */
const PLAN: PlanDocument = pagePlan({
  decisions: [
    ...pagePlan().decisions,
    { id: "d2", claimId: "1", question: "How many retries?", options: [{ id: "three", label: "Three times", consequence: "Most clear." }, { id: "five", label: "Five times", consequence: "Slower." }], recommended: "three" },
  ],
});
delete PLAN.checks;
const maya: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId! };

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const workflowOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;

function routeDeps(harness: Harness): DeveloperTaskRouteDependencies {
  return {
    documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions,
    orgId: TEST_ORG, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "contributor" as const }),
    projectChannelIds: async () => [SLACK_CHANNEL], now: () => Date.now(), log: () => undefined,
  };
}

/** A Quick task whose structured coding plan (`plan`) waits for its owner, Maya. */
async function waitingPlan(plan: PlanDocument = PLAN, options: { markdown?: string; slackThread?: { teamId: string; channelId: string; threadTs: string } } = {}) {
  const harness = await createSingleAnswerPlanBroker();
  let taskId: string;
  if (options.slackThread === undefined) {
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
    taskId = String((started.body.task as { taskId: string }).taskId);
  } else {
    // Started from a Slack thread, so its card's buttons work.
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: options.slackThread, userId: MAYA.slackUserId, instructions: "Retry failed payments", workflowPath: "QUICK", requestId: randomUUID() }) as { body: string };
    taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  }
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  if (options.markdown === undefined) {
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(plan));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  } else {
    await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), options.markdown);
  }
  let minute = 0;
  /** A comment as the page stores it, on v1 of the plan; each one a minute after the last. */
  const seed = (extra: Partial<TaskComment> & { teammate?: boolean } = {}): string => {
    const { teammate, ...fields } = extra;
    const commentId = randomUUID();
    minute += 1;
    const owner = teammate === false;
    harness.db.set({
      pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId, commentId, document: "plan", version: 1,
      target: { kind: "claim", id: "2.1" }, author: owner ? { kind: "person", developerId: MAYA.developerId, name: MAYA.name, owner: true } : { kind: "person", developerId: SAM_ID, name: "Sam Lee", owner: false },
      text: `Comment ${minute}`, createdAt: new Date(Date.parse("2026-10-11T09:00:00.000Z") + minute * 60_000).toISOString(), rev: 1, ...fields,
    });
    return commentId;
  };
  const digest = () => workflowOf(harness, taskId).artifacts.at(-1)!.sha256;
  // The page's signed-in owner: the task's own developer (a task started in Slack has its own developer ID).
  const owner: DeveloperCaller = { ...maya, developerId: String((harness.db.get(`DEVTASK#${taskId}`, "META") as { developerId: string }).developerId) };
  const page = (body: Record<string, unknown>, note?: string) => decideTaskWorkflow(routeDeps(harness), owner, taskId, {
    requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", artifactDigest: digest(), reason: note ?? "Approved on the task page.",
    answers: [{ decisionId: "d1", optionId: "below", opened: false }, { decisionId: "d2", optionId: "three", opened: false }], includedCommentIds: [], ...body,
  }, { via: "PAGE", ...(note === undefined ? {} : { note }) });
  /** A decision the way Slack and MCP send it: no answers, no comment list. */
  const plain = (decision: "APPROVE" | "REQUEST_CHANGES", requestId: string = randomUUID(), expectedRevision?: number) =>
    harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId, expectedRevision: expectedRevision ?? workflowOf(harness, taskId).revision, decision, reason: "Looks right.", artifactDigest: digest() });
  return { harness, taskId, workspaceId, seed, page, plain, digest };
}


const OUTCOME_SAMPLES = (t: { harness: Harness }) => t.harness.db.find((item) => item.entityType === "OUTCOME_SAMPLE");
const critique = (verdict: "ok" | "revise" = "ok") => ({ status: "done", revisions: 0, critiques: [{ verdict, points: [], model: { provider: "anthropic", modelId: "claude-test", company: "anthropic" } }] });
/** The plan check's answer on the plan now waiting, as the broker stores it. */
const withCritique = (t: { harness: Harness; taskId: string }, value: unknown = critique()) => {
  const record = t.harness.db.get(`DEVTASK#${t.taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
  t.harness.db.set({ ...record, workflow: { ...record.workflow, definitionVersion: "1.1.0", critique: value } });
};
const rejection = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as Error & { code?: string }; } throw new Error("expected a refusal"); };

describe("the plan check's claim", () => {
  it("an approval writes one scored sample for the revision decided, from the check as it was", async () => {
    const t = await waitingPlan();
    withCritique(t);
    const revision = workflowOf(t.harness, t.taskId).revision;
    await t.page({});
    expect(OUTCOME_SAMPLES(t)).toHaveLength(1);
    expect(OUTCOME_SAMPLES(t)[0]).toMatchObject({ claim: "plan_ready", stage: "plan_critic", taskId: t.taskId, round: String(revision), state: "held", reason: "plan_approved", model: "anthropic/claude-test", project: "payments" });
    expect(t.harness.db.find((item) => item.entityType === "OUTCOME_SCORED")).toHaveLength(1);
  });

  it("a request for changes is scored not_held, though the workflow drops the critique it was made from", async () => {
    const t = await waitingPlan();
    withCritique(t);
    await t.plain("REQUEST_CHANGES");
    expect(workflowOf(t.harness, t.taskId).critique).toBeUndefined();
    expect(OUTCOME_SAMPLES(t)).toHaveLength(1);
    expect(OUTCOME_SAMPLES(t)[0]).toMatchObject({ state: "not_held", reason: "plan_changes_requested" });
  });

  it("a plan the check never approved (no check, or one that asked for a revision) makes no claim", async () => {
    const none = await waitingPlan();
    await none.page({});
    const revise = await waitingPlan();
    withCritique(revise, critique("revise"));
    await revise.page({});
    expect(OUTCOME_SAMPLES(none)).toEqual([]);
    expect(OUTCOME_SAMPLES(revise)).toEqual([]);
  });

  it("a stale decision writes nothing, and neither does a decision that failed to commit", async () => {
    const t = await waitingPlan();
    withCritique(t);
    const stale = await rejection(t.page({ expectedRevision: workflowOf(t.harness, t.taskId).revision + 5 }));
    expect(stale.code).toBeDefined();
    t.harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("WORKFLOW_DECISION_DETAIL"), error: { name: "TransactionCanceledException" } });
    await rejection(t.page({}));
    expect(workflowOf(t.harness, t.taskId).stage).toBe("PLAN_REVIEW");
    expect(OUTCOME_SAMPLES(t)).toEqual([]);
  });

  it("a repeat of a decision that already committed writes no second sample", async () => {
    const t = await waitingPlan();
    withCritique(t);
    const requestId = randomUUID();
    const revision = workflowOf(t.harness, t.taskId).revision;
    expect((await t.plain("APPROVE", requestId, revision)).status).toBe(200);
    expect((await t.plain("APPROVE", requestId, revision)).status).toBe(200);
    expect(OUTCOME_SAMPLES(t)).toHaveLength(1);
  });

  it("an outcome write that fails never blocks the decision", async () => {
    const t = await waitingPlan();
    withCritique(t);
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: { input?: unknown }) => {
      if (JSON.stringify(command.input ?? {}).includes("OUTCOME")) throw Object.assign(new Error("private table text"), { name: "ProvisionedThroughputExceededException" });
      return send(command as never);
    });
    await t.page({});
    expect(workflowOf(t.harness, t.taskId).stage).toBe("IMPLEMENT");
    expect(OUTCOME_SAMPLES(t)).toEqual([]);
  });

  it("several plan rounds give one sample each, keyed by the revision", async () => {
    const t = await waitingPlan();
    withCritique(t);
    const first = workflowOf(t.harness, t.taskId).revision;
    await t.plain("REQUEST_CHANGES");
    // The harness plans the way a version 1 task does: its second plan is not checked, and the check is put back for the decision.
    const sent = t.harness.db.get(`DEVTASK#${t.taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
    t.harness.db.set({ ...sent, workflow: { ...sent.workflow, definitionVersion: "1.0.0" } });
    const planning = operations(t.harness, t.workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    await t.harness.artifact(t.workspaceId, String(planning.id), "plan.md", planAnswer(PLAN));
    await t.harness.finish(t.workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    withCritique(t);
    const second = workflowOf(t.harness, t.taskId).revision;
    expect(second).toBeGreaterThan(first);
    await t.page({});
    expect(OUTCOME_SAMPLES(t).map((item) => `${String(item.round)}:${String(item.state)}`).sort()).toEqual([`${String(first)}:not_held`, `${String(second)}:held`].sort());
  });
});

describe("only the broker writes samples", () => {
  it("nothing a worker reports creates one", async () => {
    const t = await waitingPlan();
    const planning = operations(t.harness, t.workspaceId).find((item) => item.workflowMode === "IMPLEMENT" || item.workflowMode === "PLAN");
    expect(planning).toBeDefined();
    await t.harness.finish(t.workspaceId, String(planning!.id), "SUCCEEDED", { result: {
      outcomeSamples: [{ claim: "plan_ready", state: "held" }], workflowOutcomeSampleKeys: [{ claim: "risk_low" }], outcome: "held", workflowMode: "PLAN",
    } }).catch(() => undefined);
    expect(OUTCOME_SAMPLES(t)).toEqual([]);
    expect(t.harness.db.find((item) => String(item.sk).startsWith("OUTCOME_KEYS#"))).toEqual([]);
  });
});

describe("only the broker's code writes samples", () => {
  const sourcesOf = (directory: string): string[] => !existsSync(directory) ? [] : readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? sourcesOf(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
  it("no package but the broker and the contracts names the outcome writers or keys", () => {
    const writers = /recordOutcomeSample|scoreOutcomeSample|outcomeSampleKey|outcomeScoredKey|OUTCOME#|OUTCOME_SCORED#|OUTCOME_KEYS#/;
    const others = readdirSync("packages").filter((name) => name !== "broker" && name !== "contracts").flatMap((name) => sourcesOf(join("packages", name, "src")));
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((path) => writers.test(readFileSync(path, "utf8")))).toEqual([]);
  });
});
