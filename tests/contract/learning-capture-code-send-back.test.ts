// v1.2 learning loop, follow-up to B4: the reason a person gives when they send CODE back to coding becomes a correction, like a plan send-back's (design 2.2, 2.4).
// The one hook is in `sendTaskWorkflowBackToCoding`, which the task page, the developer API, Slack and MCP all reach. The decider's standing is read live, never taken from the task role.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, EMPTY_RECIPE, agentXError, createCandidateManifest, type ResolvedRecipe } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { resolveTaskWorkflowFindings, sendTaskWorkflowBackToCoding, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { sendBackNoAccessMessage } from "../../packages/broker/src/developer/task-access.js";
import { viewerCannotStartTasksMessage } from "../../packages/broker/src/developer/project-roles.js";
import { readFileSync } from "node:fs";
import { registerHumanSendBackListener, sendBackToRecord, type HumanSendBackEvent } from "../../packages/broker/src/lessons/send-back-events.js";
import { SEND_BACK_CAPTURE_BUDGET_MS, captureSendBack, captureSendBackQuietly, sendBackSourceKey } from "../../packages/broker/src/learning/capture-decision.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, readLearningState } from "../../packages/broker/src/learning/store.js";
import { openReviewFindings } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { projectMemberKey } from "@rovara-code/contracts";
import { LEARNING_PROJECT_WIDE, LearningCorrectionSchema, type LearningCorrection } from "@rovara-code/contracts";
import { MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";
import { TEST_ORG } from "../support/orgs.js";
import { PROJECT, PROJECT_CREATED_AT, learningItems, seedPerson, seedProject, type GrantKind } from "../support/learning-page.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const NOTE = "Use the shared retry helper in lib/retry, not a hand-written loop.";
const SLACK_NOTE = "Fix the problems listed above, then report what changed.";
const THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000077" };
const scope = { orgId: TEST_ORG, project: PROJECT, projectCreatedAt: PROJECT_CREATED_AT };
/** A program whose coding step is called "code": the step the send-back must name. */
const PROGRAM = { steps: [
  { id: "plan", kind: "plan" }, { id: "code", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "code", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };

const callerOf = (who: Developer): DeveloperCaller => ({ orgId: TEST_ORG, orgRole: "member" as const, developerId: who.developerId, sessionId: who.sessionId, amr: who.provider, name: who.name, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }) });
const MAYA_CALLER = callerOf(MAYA);
const OMAR_CALLER = callerOf(OMAR);

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskRow = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string; developerId: string };
const workflowOf = (harness: Harness, taskId: string) => taskRow(harness, taskId).workflow;
const codingRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });

type CheckAccess = DeveloperTaskRouteDependencies["checkAccess"];
/** The default project check: a contributor through the project's Slack channel, for everyone. */
const channelContributor: CheckAccess = async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "contributor" as const });

function routeDeps(harness: Harness, log: DeveloperTaskRouteDependencies["log"] = () => undefined, checkAccess: CheckAccess = channelContributor): DeveloperTaskRouteDependencies {
  return {
    documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions,
    orgId: TEST_ORG, checkAccess,
    projectChannelIds: async () => [SLACK_CHANNEL], now: () => Date.now(), log,
  };
}

/**
 * A Quick task of project "payments", started by the API or in Slack, whose plan is approved. Coding then stops (FAILED), so the work is blocked and can be sent back.
 * `program: true` gives the stored workflow a program whose coding step is "code".
 */
async function blockedTask(options: { audit?: ReturnType<typeof capturingAuditDeps>; slack?: boolean; program?: boolean; autofix?: boolean; findings?: boolean; beforeReview?: (harness: Harness) => void } = {}) {
  const harness = await createSingleAnswerPlanBroker({ ...(options.audit === undefined ? {} : { audit: options.audit }), brokerExtra: { planSelfCheck: false, ...(options.autofix === true ? { autofix: { enabled: true, capUsd: 1000, roundEstimateUsd: 3 } } : {}) } });
  seedProject(harness.db);
  let taskId: string;
  if (options.slack === true) {
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: THREAD, userId: MAYA.slackUserId, instructions: "Retry failed payments", workflowPath: "QUICK", requestId: randomUUID() }) as { body: string };
    taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  } else {
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
    taskId = String((started.body.task as { taskId: string }).taskId);
  }
  const workspaceId = taskRow(harness, taskId).workspaceId;
  const record = taskRow(harness, taskId);
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const digest = createHash("sha256").update(plan).digest("hex");
  const approval = { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest };
  if (options.slack === true) {
    await harness.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId, userId: MAYA.slackUserId, thread: THREAD, selectedOptionalCheckIds: [], ...approval });
  } else {
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, approval)).status).toBe(200);
  }
  if (options.autofix === true || options.findings === true) {
    // Coding ends with a candidate and its reviews find an introduced problem: with automatic fixing on, Rovara sends the work back by itself;
    // with it off, the review blocks on the finding for the owner to accept or have fixed.
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await harness.finish(workspaceId, String(codingRuns(harness, workspaceId).at(-1)!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    const review = operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW").at(-1)!;
    options.beforeReview?.(harness);
    const now = new Date().toISOString();
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
    ] } });
    if (options.findings === true) expect(workflowOf(harness, taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  } else {
    await harness.finish(workspaceId, String(codingRuns(harness, workspaceId).at(-1)!.id), "FAILED", { error: "the model stopped" });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
  }
  if (options.program === true) {
    const row = taskRow(harness, taskId);
    harness.db.set({ ...row, workflow: { ...row.workflow, program: PROGRAM, programStepId: "review" } });
  }
  const takeOver = (who: DeveloperCaller) => harness.db.set({ ...taskRow(harness, taskId), currentOwner: { developerId: who.developerId, name: who.name, provider: "oidc", since: "2026-10-01T00:00:00.000Z" } });
  /** The owner's Send back to coding, as the route function takes it (page, developer API and MCP reach it through the route). */
  const send = (who: DeveloperCaller, instructions: string, requestId = randomUUID(), log?: DeveloperTaskRouteDependencies["log"]) =>
    sendTaskWorkflowBackToCoding(routeDeps(harness, log), who, taskId, { requestId, expectedRevision: workflowOf(harness, taskId).revision, instructions });
  /** The same with the person's own project check answer (the default answers a channel contributor for everyone). */
  const sendWith = (checkAccess: CheckAccess, who: DeveloperCaller, instructions: string) =>
    sendTaskWorkflowBackToCoding(routeDeps(harness, undefined, checkAccess), who, taskId, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, instructions });
  /** The owner's answer to the blocking review findings, every one to `action`, with the person's own project check answer. */
  const fixWith = (checkAccess: CheckAccess, who: DeveloperCaller, action: "FIX" | "ACCEPT" = "FIX") => {
    const workflow = workflowOf(harness, taskId);
    return resolveTaskWorkflowFindings(routeDeps(harness, undefined, checkAccess), who, taskId, { requestId: randomUUID(), expectedRevision: workflow.revision, candidateDigest: workflow.candidate!.digest,
      resolutions: openReviewFindings(workflow).map((finding) => ({ findingId: finding.findingId, action, note: action === "FIX" ? "" : "Accepted for now." })) });
  };
  /** The same through the developer API route. */
  const api = (who: Developer, instructions: string, requestId = randomUUID()) =>
    harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId, expectedRevision: workflowOf(harness, taskId).revision, instructions });
  const slack = (userId: string, requestId = randomUUID()) =>
    harness.handler({ source: "agentx.slack-ingress", action: "workflow-send-back", taskId, userId, thread: THREAD, requestId, expectedRevision: workflowOf(harness, taskId).revision }) as Promise<{ statusCode: number; body: string }>;
  const owner: DeveloperCaller = { ...MAYA_CALLER, developerId: taskRow(harness, taskId).developerId };
  return { harness, taskId, workspaceId, takeOver, send, sendWith, fixWith, api, slack, owner };
}

const corrections = (harness: Harness): LearningCorrection[] => learningItems(harness.db).filter((item) => String(item.sk).startsWith("CORRECTION#"))
  .map((item) => LearningCorrectionSchema.parse(Object.fromEntries(Object.entries(item).filter(([key]) => !["pk", "sk", "entityType", "orgId"].includes(key)))));
const items = (harness: Harness, prefix: string) => learningItems(harness.db).filter((item) => String(item.sk).startsWith(prefix));
const learningDeps = (harness: Harness) => ({ documentClient: harness.db, tableName: "state", now: () => Date.now() });
const isLearningWrite = (command: { constructor: { name: string }; input?: { TransactItems?: Array<{ Put?: { Item?: { entityType?: string } } }> } }) =>
  command.constructor.name === "TransactWriteCommand" && command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "LEARNING_CORRECTION") === true;
type Command = Parameters<typeof isLearningWrite>[0];
/** Replaces the learning write (only that) with `replacement`; everything else goes through. */
function interceptLearningWrite(harness: Harness, replacement: (command: Command, send: (command: Command) => Promise<unknown>) => Promise<unknown>) {
  const send = harness.db.send.bind(harness.db);
  harness.db.send = (async (command: Command) => (isLearningWrite(command) ? replacement(command, send as never) : send(command as never)));
}

describe("code send-back capture: a member decider", () => {
  it("stores one correction with source send_back, the coding step as stage and the B4 source key", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    await t.send(MAYA_CALLER, NOTE, requestId);
    const [stored, ...others] = corrections(t.harness);
    expect(others).toEqual([]);
    expect(stored).toMatchObject({ stage: "code", source: "send_back", sourceRef: { taskId: t.taskId, decisionRequestId: requestId }, taskId: t.taskId, author: MAYA.developerId, standing: "member", projectCreatedAt: PROJECT_CREATED_AT });
    expect(stored!.rememberedBy).toBeUndefined();
    expect(stored!.text).toContain("shared retry helper");
    expect(items(t.harness, "SOURCE#").map((item) => [item.sk, item.correctionId])).toEqual([[expect.stringContaining(sendBackSourceKey(t.taskId, requestId)), stored!.id]]);
    expect((await readLearningState(learningDeps(t.harness), scope))?.liveCorrections).toBe(1);
    // The send-back itself happened: coding was queued again.
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
  });

  it("comes from the developer API too (the route MCP calls)", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "maintainer");
    expect((await t.api(MAYA, NOTE)).status).toBe(200);
    expect(corrections(t.harness)).toMatchObject([{ source: "send_back", stage: "code", standing: "member", author: MAYA.developerId }]);
  });

  it("a company owner or admin without a project grant is a member", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "none", "admin");
    await t.send({ ...MAYA_CALLER, orgRole: "admin" }, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ standing: "member" }]);
  });

  it("the same request retried stores one correction and queues one run", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const requestId = randomUUID();
    const body = { requestId, expectedRevision: workflowOf(t.harness, t.taskId).revision, instructions: NOTE };
    let learningWrites = 0;
    interceptLearningWrite(t.harness, async (command, send) => { learningWrites += 1; return send(command); });
    await sendTaskWorkflowBackToCoding(routeDeps(t.harness), MAYA_CALLER, t.taskId, body);
    await sendTaskWorkflowBackToCoding(routeDeps(t.harness), MAYA_CALLER, t.taskId, body);
    expect(corrections(t.harness)).toHaveLength(1);
    expect(items(t.harness, "SOURCE#")).toHaveLength(1);
    // A replay does not even try to capture again.
    expect(learningWrites).toBe(1);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
    expect((await readLearningState(learningDeps(t.harness), scope))?.liveCorrections).toBe(1);
  });
});

describe("code send-back capture: the stage", () => {
  it("a send-back from a review goes back to the review's coding step, and names it", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, NOTE);
    expect(workflowOf(t.harness, t.taskId).programStepId).toBe("code");
    expect(corrections(t.harness)).toMatchObject([{ stage: "code" }]);
  });

  /** Freezes `recipe` as the task's agent snapshot, as starting a task with an agent does. */
  const freeze = (t: Awaited<ReturnType<typeof blockedTask>>, recipe: ResolvedRecipe) =>
    t.harness.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "RECIPE", entityType: "TASK_RECIPE", orgId: TEST_ORG, recipe, digest: "d".repeat(64) });
  const rovaraCode = (): ResolvedRecipe => structuredClone(BUILTIN_AGENTS["rovara-code"].versions[0]!.recipe);

  it("(a) a QUICK task with no program and the default recipe gives that recipe's build step, `build`", async () => {
    const t = await blockedTask();
    expect(workflowOf(t.harness, t.taskId).program).toBeUndefined();
    freeze(t, rovaraCode());
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ stage: "build", source: "send_back" }]);
  });

  it("(b) a recipe whose first build step has another id gives that id (the step stepForOperation picks)", async () => {
    const t = await blockedTask();
    const recipe = rovaraCode();
    recipe.steps = recipe.steps.map((step) => (step.kind === "build" ? { ...step, id: "implement", name: "Implement" } : step.kind === "review" ? { ...step, onFindings: { backTo: "implement", maxRounds: 3 } } : step));
    freeze(t, recipe);
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ stage: "implement" }]);
  });

  it("(c) a recipe with no build step gives project-wide", async () => {
    const t = await blockedTask();
    freeze(t, { ...structuredClone(EMPTY_RECIPE), steps: [{ id: "triage", name: "Triage", kind: "agent", workspace: "none", settings: { instructions: [] } }] });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ stage: LEARNING_PROJECT_WIDE }]);
  });

  it("no agent snapshot and no program gives project-wide", async () => {
    const t = await blockedTask();
    expect(workflowOf(t.harness, t.taskId).program).toBeUndefined();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ stage: LEARNING_PROJECT_WIDE }]);
  });

  it("the plan send-back is unchanged: its stage is still plan, and a given stage is kept", async () => {
    const t = await blockedTask();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const base = { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, reason: NOTE, included: [] as never[] };
    const plan = await captureSendBack(routeDeps(t.harness), { ...base, requestId: randomUUID() });
    const code = await captureSendBack(routeDeps(t.harness), { ...base, requestId: randomUUID(), stage: "build" });
    expect(plan.created).toHaveLength(1);
    expect(code.created).toHaveLength(1);
    expect(corrections(t.harness).map((c) => c.stage).sort()).toEqual(["build", "plan"]);
  });
});

describe("code send-back capture: an outsider decider (the same as B4's plan send-back)", () => {
  // A project viewer who took the task over may not send it back at all (viewers only view), so the outsider case is a person with no grant.
  const OUTSIDERS: Array<[string, GrantKind]> = [["a person with no grant (a commenter)", "none"]];
  for (const [label, grant] of OUTSIDERS) {
    it(`an owner who took the task over as ${label} is stored as outsider (stored for a maintainer to see, never grouped)`, async () => {
      const t = await blockedTask({ program: true });
      seedPerson(t.harness.db, OMAR_CALLER, grant);
      t.takeOver(OMAR_CALLER);
      await t.send(OMAR_CALLER, NOTE);
      expect(corrections(t.harness)).toMatchObject([{ source: "send_back", stage: "code", standing: "outsider", author: OMAR.developerId }]);
      expect(corrections(t.harness).filter((c) => c.standing === "member")).toEqual([]);
      expect(items(t.harness, "SUGGESTION#")).toEqual([]);
      // Never grouped: no suggestion above, and the correction is not part of any group.
      expect(corrections(t.harness)[0]!.suggestionId).toBeUndefined();
    });
  }

  it("an owner who took the task over as a project viewer is refused, so nothing is captured", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    await expect(t.send(OMAR_CALLER, NOTE)).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a viewer is refused on the developer API, so nothing reaches capture", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    expect((await t.api(OMAR, NOTE)).status).not.toBe(200);
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("an outsider's code send-back never opens a suggestion, even beside a similar member correction", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(t.harness), scope, {
      id: "earlier-correction", stage: "code", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, learningSalt(scope))], author: "5".repeat(64), standing: "member", limit: "automatic",
    });
    await t.send(OMAR_CALLER, "Run the linter before you commit any changes to the repository.");
    expect(corrections(t.harness)).toHaveLength(2);
    expect(items(t.harness, "SUGGESTION#")).toEqual([]);
  });

  it("a Slack-only person (a Slack-started task's owner with no company record) is an outsider", async () => {
    const t = await blockedTask({ slack: true, program: true });
    // The owner of a Slack-started task has a Slack-derived id and no company member record.
    t.harness.db.delete({ pk: `ORG#${TEST_ORG}#MEMBER#${t.owner.developerId}`, sk: "META" });
    await t.send(t.owner, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ source: "send_back", stage: "code", standing: "outsider", author: t.owner.developerId }]);
  });

  it("a member's standing from a project grant is not borrowed by the person who took over", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    await t.send(OMAR_CALLER, NOTE);
    expect(corrections(t.harness)).toMatchObject([{ standing: "outsider", author: OMAR.developerId }]);
  });
});

describe("code send-back capture: a suggestion", () => {
  it("rule.suggested is emitted when a member's code send-back and an earlier member correction of another task open a suggestion, with ids and counts only", async () => {
    const first = await blockedTask({ program: true });
    const ledger = capturingAuditDeps({ db: first.harness.db, now: () => Date.now() });
    seedPerson(first.harness.db, MAYA_CALLER, "contributor");
    const text = "Always run the linter before committing changes to the repository.";
    await captureCorrection(learningDeps(first.harness), scope, {
      id: "earlier-correction", stage: "code", source: "send_back", sourceKey: "decision#other-task#other-request", sourceRef: { taskId: "other-task" }, taskId: "other-task",
      text, signature: [...signatureOf(text, learningSalt(scope))], author: "5".repeat(64), standing: "member", limit: "automatic",
    });
    const deps = { ...routeDeps(first.harness), learningAudit: ledger.audit };
    await sendTaskWorkflowBackToCoding(deps, MAYA_CALLER, first.taskId, { requestId: randomUUID(), expectedRevision: workflowOf(first.harness, first.taskId).revision, instructions: "Run the linter before you commit any changes to the repository." });
    const [suggestion] = items(first.harness, "SUGGESTION#");
    expect(suggestion).toBeDefined();
    expect(ledger.recordedBy("rule.suggested")).toEqual([expect.objectContaining({
      actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: PROJECT },
      facts: expect.objectContaining({ suggestionId: suggestion!.id, stage: "code", sourceCount: 2, sourceKinds: "send_back" }) as unknown,
    })]);
    expect(JSON.stringify(ledger.recorded())).not.toContain("linter");
  });
});

describe("code send-back capture: changes between the read and the write", () => {
  it("a decider demoted between the read and the write stores nothing, and the send-back still happens", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    let demoted = false;
    interceptLearningWrite(t.harness, async (command, send) => { demoted = true; seedPerson(t.harness.db, MAYA_CALLER, "viewer"); return send(command); });
    const logs: Array<Record<string, unknown>> = [];
    await t.send(MAYA_CALLER, NOTE, randomUUID(), (entry) => logs.push(entry));
    expect(demoted).toBe(true);
    expect(corrections(t.harness)).toEqual([]);
    expect(items(t.harness, "SOURCE#")).toEqual([]);
    expect(logs.filter((entry) => entry.event === "learning.send_back_capture_refused")).toMatchObject([{ taskId: t.taskId, reason: "stale" }]);
    expect(JSON.stringify(logs)).not.toMatch(/retry|helper|loop/i);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  });
});

describe("code send-back capture: what is not a correction", () => {
  it("a short reason is skipped, and the send-back goes through", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    expect((await t.api(MAYA, "Fix it please")).status).toBe(200);
    expect(learningItems(t.harness.db)).toEqual([]);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
  });

  it("a generic reason is skipped", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await t.send(MAYA_CALLER, "Please fix the issues, thanks, looks wrong still.");
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("Slack's own fixed note is not a person's reason: the Slack button stores nothing, a person's own words through the API do", async () => {
    const t = await blockedTask({ slack: true, program: true });
    seedPerson(t.harness.db, t.owner, "contributor");
    // Positive control: this wording is long and specific enough to be a correction when a person writes it.
    expect(SLACK_NOTE.length).toBeGreaterThan(20);
    const answer = await t.slack(MAYA.slackUserId!);
    expect(answer.statusCode).toBe(200);
    expect(workflowOf(t.harness, t.taskId).decisions.at(-1)).toMatchObject({ source: "SEND_BACK", reason: SLACK_NOTE });
    expect(learningItems(t.harness.db)).toEqual([]);
  });

  it("a refused send-back (stale revision, or not the owner) captures nothing", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    seedPerson(t.harness.db, OMAR_CALLER, "contributor");
    const requestId = randomUUID();
    await expect(sendTaskWorkflowBackToCoding(routeDeps(t.harness), MAYA_CALLER, t.taskId, { requestId, expectedRevision: workflowOf(t.harness, t.taskId).revision - 1, instructions: NOTE })).rejects.toBeDefined();
    expect((await t.api(OMAR, NOTE)).status).toBe(404);
    expect(learningItems(t.harness.db)).toEqual([]);
  });
});

describe("code send-back capture: Rovara's own send-back", () => {
  it("an automatic send-back captures nothing", async () => {
    const t = await blockedTask({ autofix: true, program: false });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    // Rovara sent it back by itself already (the review found a problem), with no person involved.
    expect(workflowOf(t.harness, t.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(learningItems(t.harness.db)).toEqual([]);
  });
});

describe("code send-back capture: it never holds up or fails the send-back", () => {
  it("a capture that fails leaves the send-back done and the run queued, and is logged", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    interceptLearningWrite(t.harness, async () => { throw new Error("table unavailable"); });
    const logs: Array<Record<string, unknown>> = [];
    const requestId = randomUUID();
    const answer = await t.send(MAYA_CALLER, NOTE, requestId, (entry) => logs.push(entry));
    expect(answer.task).toBeDefined();
    expect(workflowOf(t.harness, t.taskId).decisions.some((decision) => decision.requestId === requestId && decision.source === "SEND_BACK")).toBe(true);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
    expect(corrections(t.harness)).toEqual([]);
    expect(logs.some((entry) => entry.event === "learning.send_back_capture_failed")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("retry helper");
  });

  it("a capture that never answers does not hold the send-back, and the delay is logged once", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    interceptLearningWrite(t.harness, () => new Promise(() => undefined));
    const logs: Array<Record<string, unknown>> = [];
    const started = Date.now();
    const answer = await t.send(MAYA_CALLER, NOTE, randomUUID(), (entry) => logs.push(entry));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(answer.task).toBeDefined();
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
    expect(logs.filter((entry) => entry.step === "timeout")).toHaveLength(1);
  });

  it("runs after the index sync: the task's index row is updated before capture writes", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const order: string[] = [];
    const send = t.harness.db.send.bind(t.harness.db);
    t.harness.db.send = (async (command: Command & { input?: { Key?: { pk?: string; sk?: string } } }) => {
      const key = command.input?.Key;
      if (command.constructor.name === "UpdateCommand" && String(key?.pk).startsWith("DEVELOPER#") && String(key?.sk).startsWith("TASK#")) order.push("index");
      if (isLearningWrite(command)) order.push("learning");
      return send(command as never);
    });
    await t.send(MAYA_CALLER, NOTE);
    expect(order).toContain("index");
    expect(order.at(-1)).toBe("learning");
    expect(order.indexOf("index")).toBeLessThan(order.indexOf("learning"));
    expect(corrections(t.harness)).toHaveLength(1);
  });

  it("captureSendBackQuietly is the one entry point and takes the stage as its only new field", async () => {
    const t = await blockedTask();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    await captureSendBackQuietly(routeDeps(t.harness), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId: randomUUID(), reason: NOTE, included: [], stage: "code" });
    expect(corrections(t.harness)).toMatchObject([{ stage: "code" }]);
  });
});

describe("code send-back needs the project access starting a task needs (0.4.27)", () => {
  const granted = (role: "viewer" | "contributor" | "maintainer"): CheckAccess => async () => ({ revision: 1, policy: {} as never, access: "granted", channelIds: [], role });
  const denied: CheckAccess = async () => { throw agentXError("PROJECT_ACCESS_DENIED", "you do not have access to `payments`"); };
  const notFound: CheckAccess = async () => { throw agentXError("PROJECT_NOT_FOUND", "project `payments` doesn't exist in this AgentX"); };
  const broken: CheckAccess = async () => { throw new Error("the project check broke"); };
  const slackDown: CheckAccess = async () => { throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership"); };
  /** The project turned off tasks from AI tools: the check refuses, and answers `answer` only when asked with the switch set aside. */
  const tasksOff = (answer: CheckAccess): CheckAccess => async (project, options) => {
    if (options?.ignoreTasksOff === true) return answer(project);
    throw agentXError("PROJECT_TASKS_DISABLED", "tasks from AI tools are turned off for `payments`");
  };
  const noAccess = { code: "PROJECT_ACCESS_DENIED", message: `PROJECT_ACCESS_DENIED: ${sendBackNoAccessMessage(PROJECT)}` };
  const viewer = { code: "PROJECT_ACCESS_DENIED", message: `PROJECT_ACCESS_DENIED: ${viewerCannotStartTasksMessage(PROJECT)}` };

  /** Refused before anything moves: no new coding run, the same workflow revision, nothing captured. */
  async function expectRefusedUnchanged(t: Awaited<ReturnType<typeof blockedTask>>, attempt: () => Promise<unknown>, expected: { code: string; message?: string }) {
    const runs = codingRuns(t.harness, t.workspaceId).length, revision = workflowOf(t.harness, t.taskId).revision;
    await expect(attempt()).rejects.toMatchObject(expected);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ revision, state: "BLOCKED" });
    expect(learningItems(t.harness.db)).toEqual([]);
  }
  async function expectSentBack(t: Awaited<ReturnType<typeof blockedTask>>, attempt: () => Promise<unknown>) {
    const runs = codingRuns(t.harness, t.workspaceId).length;
    await attempt();
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs + 1);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  }
  /** A blocked task Omar has taken over, holding `grant` in the project. */
  async function takenBy(grant: GrantKind, options: { findings?: boolean; orgRole?: "owner" | "admin" } = {}) {
    const t = await blockedTask({ program: true, ...(options.findings === true ? { findings: true } : {}) });
    const who: DeveloperCaller = { ...OMAR_CALLER, ...(options.orgRole === undefined ? {} : { orgRole: options.orgRole }) };
    seedPerson(t.harness.db, who, grant);
    t.takeOver(who);
    return { ...t, who };
  }
  /** Fails the read of Omar's own grant row in the project; everything else goes through. */
  function failGrantReads(harness: Harness) {
    const key = projectMemberKey(TEST_ORG, OMAR.developerId, PROJECT);
    const send = harness.db.send.bind(harness.db);
    harness.db.send = (async (command: Command & { input?: { Key?: { pk?: string; sk?: string } } }) => {
      if (command.constructor.name === "GetCommand" && command.input?.Key?.pk === key.pk && command.input.Key.sk === key.sk) throw new Error("the grant could not be read");
      return send(command as never);
    });
  }

  it("a taker with no project grant and no channel access is refused like a viewer, and nothing changes", async () => {
    const t = await takenBy("none");
    await expectRefusedUnchanged(t, () => t.sendWith(denied, t.who, NOTE), noAccess);
  });

  it("a viewer role is refused with the viewer message even when the check gives it without a grant (the work gate looks only at granted viewers)", async () => {
    const t = await takenBy("none");
    const channelViewer: CheckAccess = async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "viewer" });
    await expectRefusedUnchanged(t, () => t.sendWith(channelViewer, t.who, NOTE), viewer);
  });

  it("a project that is not found is refused as no access, and nothing changes", async () => {
    const t = await takenBy("none");
    await expectRefusedUnchanged(t, () => t.sendWith(notFound, t.who, NOTE), noAccess);
  });

  it("a taker who is a contributor by grant may send back", async () => {
    const t = await takenBy("contributor");
    await expectSentBack(t, () => t.sendWith(granted("contributor"), t.who, NOTE));
    expect(corrections(t.harness)).toMatchObject([{ source: "send_back", stage: "code", author: OMAR.developerId }]);
  });

  for (const orgRole of ["owner", "admin"] as const) {
    it(`a company ${orgRole} with no project grant may send back, even when the project check would refuse them`, async () => {
      const t = await takenBy("none", { orgRole });
      await expectSentBack(t, () => t.sendWith(denied, t.who, NOTE));
    });
  }

  describe("when the project turned off tasks from AI tools, the task already exists: the same access rule decides, the switch aside", () => {
    it("a contributor by grant may send back", async () => {
      const t = await takenBy("contributor");
      await expectSentBack(t, () => t.sendWith(tasksOff(granted("contributor")), t.who, NOTE));
    });
    it("a contributor through the project's Slack channel may send back", async () => {
      const t = await takenBy("none");
      await expectSentBack(t, () => t.sendWith(tasksOff(channelContributor), t.who, NOTE));
    });
    it("a viewer is refused with the viewer message", async () => {
      const t = await takenBy("viewer");
      await expectRefusedUnchanged(t, () => t.sendWith(tasksOff(granted("viewer")), t.who, NOTE), viewer);
    });
    it("no access is refused", async () => {
      const t = await takenBy("none");
      await expectRefusedUnchanged(t, () => t.sendWith(tasksOff(denied), t.who, NOTE), noAccess);
    });
  });

  describe("when the check fails some other way, the person's own grant decides", () => {
    it("a contributor grant may send back", async () => {
      const t = await takenBy("contributor");
      await expectSentBack(t, () => t.sendWith(broken, t.who, NOTE));
    });
    it("no grant is refused as no access", async () => {
      const t = await takenBy("none");
      await expectRefusedUnchanged(t, () => t.sendWith(broken, t.who, NOTE), noAccess);
    });
    it("a grant that cannot be read gives the retryable RUNTIME_UNAVAILABLE, and nothing changes", async () => {
      const t = await takenBy("contributor");
      failGrantReads(t.harness);
      await expectRefusedUnchanged(t, () => t.sendWith(broken, t.who, NOTE), { code: "RUNTIME_UNAVAILABLE" });
    });
  });

  it("when Slack cannot be asked, the retryable error stands and nothing changes", async () => {
    const t = await takenBy("none");
    await expectRefusedUnchanged(t, () => t.sendWith(slackDown, t.who, NOTE), { code: "SLACK_UNAVAILABLE" });
  });

  it("adds no project check of its own: the gate reuses the answer the task's access check got", async () => {
    const t = await takenBy("none");
    const asked: Array<{ ignoreTasksOff?: boolean } | undefined> = [];
    await t.sendWith(async (project, options) => { asked.push(options); return channelContributor(project); }, t.who, NOTE);
    // One for the task's access check and the gate together, then the coding queue's own two fresh rechecks before it commits (unchanged).
    expect(asked).toEqual([undefined, undefined, undefined]);
  });

  it("Rovara's own send-back is stopped when the owner has lost project access (S2, owner decision 2026-11-04; this replaces the 0.4.27 rule that it still ran)", async () => {
    // Maya's only access is the project's Slack channel; she leaves it before the review finds the problem.
    const audit = capturingAuditDeps();
    const t = await blockedTask({ audit, autofix: true, beforeReview: (harness) => harness.channelMembers.mockResolvedValue({ ok: true, memberOf: [] }) });
    const refusedStart = await t.harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Another task", client: "test-client", workflow: true, workflowPath: "QUICK" });
    expect(refusedStart.body).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });
    // Rovara did not send it back by itself: the review's block stands for a person, with its ask, and no second coding run started.
    expect(workflowOf(t.harness, t.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(0);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(1);
    expect(audit.recordedBy("task.work_refused")).toHaveLength(1);
    expect(audit.recordedBy("task.work_refused")[0]).toMatchObject({ target: { kind: "task", id: t.taskId }, facts: { path: "autofix", cause: "no_project_access" } });
  });

  describe("a review finding to fix sends the task back to coding, so it needs the same access", () => {
    it("a taker with no access is refused, and nothing changes", async () => {
      const t = await takenBy("none", { findings: true });
      await expectRefusedUnchanged(t, () => t.fixWith(denied, t.who), noAccess);
    });
    it("a viewer role is refused with the viewer message", async () => {
      const t = await takenBy("none", { findings: true });
      const channelViewer: CheckAccess = async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL], role: "viewer" });
      await expectRefusedUnchanged(t, () => t.fixWith(channelViewer, t.who), viewer);
    });
    it("a contributor by grant may have the findings fixed", async () => {
      const t = await takenBy("contributor", { findings: true });
      await expectSentBack(t, () => t.fixWith(granted("contributor"), t.who));
    });
    it("a company owner may, even when the project check would refuse them", async () => {
      const t = await takenBy("none", { findings: true, orgRole: "owner" });
      await expectSentBack(t, () => t.fixWith(denied, t.who));
    });
    it("with tasks turned off, a channel contributor may and no access may not", async () => {
      const allowed = await takenBy("none", { findings: true });
      await expectSentBack(allowed, () => allowed.fixWith(tasksOff(channelContributor), allowed.who));
      const refused = await takenBy("none", { findings: true });
      await expectRefusedUnchanged(refused, () => refused.fixWith(tasksOff(denied), refused.who), noAccess);
    });
    it("accepting every finding starts the next step, so it needs the same access (S2, any path; this replaces 'no access is not asked for')", async () => {
      const t = await takenBy("none", { findings: true });
      const runs = codingRuns(t.harness, t.workspaceId).length;
      await expect(t.fixWith(denied, t.who, "ACCEPT")).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs);
    });
  });
});

describe("LS-1: one entry point for a send-back, and the lessons side is fed from it", () => {
  /** What the lessons side hears: every announcement, and the rows a Team record emitter would write from them. */
  function lessonsSide() {
    const events: HumanSendBackEvent[] = [];
    const rows: Array<{ sendBackId: string; taskId: string; actorDeveloperId?: string }> = [];
    const emitter = { sendBack: async (row: { sendBackId: string; taskId: string; actorDeveloperId?: string }) => { rows.push(row); } };
    const stopEvents = registerHumanSendBackListener(async (event) => { events.push(event); });
    const stopRows = registerHumanSendBackListener(sendBackToRecord(emitter));
    return { events, rows, stop: () => { stopEvents(); stopRows(); } };
  }

  it("one send-back produces exactly one capture and one record row (the lesson candidate's input), and a replay produces none", async () => {
    const side = lessonsSide();
    try {
      const t = await blockedTask({ program: true });
      seedPerson(t.harness.db, MAYA_CALLER, "contributor");
      const requestId = randomUUID();
      const body = { requestId, expectedRevision: workflowOf(t.harness, t.taskId).revision, instructions: NOTE };
      await sendTaskWorkflowBackToCoding(routeDeps(t.harness), MAYA_CALLER, t.taskId, body);
      expect(corrections(t.harness)).toHaveLength(1);
      expect(side.events.map((event) => [event.requestId, event.taskId, event.round, event.actorDeveloperId])).toEqual([[requestId, t.taskId, 1, MAYA.developerId]]);
      expect(side.rows.map((row) => [row.sendBackId, row.taskId])).toEqual([[requestId, t.taskId]]);
      await sendTaskWorkflowBackToCoding(routeDeps(t.harness), MAYA_CALLER, t.taskId, body);
      expect(corrections(t.harness)).toHaveLength(1);
      expect(side.events).toHaveLength(1);
      expect(side.rows).toHaveLength(1);
    } finally { side.stop(); }
  });

  it("is fed even when the capture itself records nothing (a person with no standing), once, and a failing lessons side does not fail the send-back", async () => {
    const side = lessonsSide();
    const stopBroken = registerHumanSendBackListener(async () => { throw new Error("the record is down"); });
    try {
      const t = await blockedTask({ program: true });
      await t.send(MAYA_CALLER, NOTE);
      expect(side.events).toHaveLength(1);
      expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(2);
    } finally { stopBroken(); side.stop(); }
  });

  it("the Slack button's fixed note is not a reason: the row is announced with none", async () => {
    const side = lessonsSide();
    try {
      const t = await blockedTask({ program: true, slack: true });
      seedPerson(t.harness.db, MAYA_CALLER, "contributor");
      expect((await t.slack(MAYA.slackUserId!)).statusCode).toBe(200);
      expect(side.events.map((event) => event.instructions)).toEqual([""]);
    } finally { side.stop(); }
  });

  it("captureSendBackQuietly runs a lessons callback once, before the capture, and never lets it fail or hold the capture", async () => {
    const t = await blockedTask();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const order: string[] = [];
    let calls = 0;
    await captureSendBackQuietly(routeDeps(t.harness), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId: randomUUID(), reason: NOTE, included: [], stage: "code", alsoRecord: async () => { calls += 1; order.push(corrections(t.harness).length === 0 ? "before" : "after"); } });
    expect(calls).toBe(1);
    expect(order).toEqual(["before"]);
    expect(corrections(t.harness)).toHaveLength(1);
    await captureSendBackQuietly(routeDeps(t.harness), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId: randomUUID(), reason: NOTE, included: [], stage: "code", alsoRecord: async () => { throw new Error("down"); } });
    expect(corrections(t.harness)).toHaveLength(2);
  });

  it("a lessons callback that never returns is given the capture's time limit, then the capture still runs (M1)", async () => {
    const t = await blockedTask();
    seedPerson(t.harness.db, MAYA_CALLER, "contributor");
    const started = Date.now();
    await captureSendBackQuietly(routeDeps(t.harness), { caller: MAYA_CALLER, taskId: t.taskId, project: PROJECT, requestId: randomUUID(), reason: NOTE, included: [], stage: "code", alsoRecord: () => new Promise<void>(() => undefined) });
    const elapsed = Date.now() - started;
    expect(corrections(t.harness)).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(SEND_BACK_CAPTURE_BUDGET_MS - 50);
    expect(elapsed).toBeLessThan(SEND_BACK_CAPTURE_BUDGET_MS * 2 + 500);
  });

  it("no call site announces beside the capture: the announcement is only ever passed to captureSendBackQuietly, and the plan send-back has none", () => {
    const read = (path: string) => readFileSync(new URL(`../../packages/broker/src/aws/developer-tasks/${path}`, import.meta.url), "utf8");
    const coding = read("workflow-coding.ts");
    // WB-7 (lessons in production, lane 2): two call sites, the plain send-back and the findings the owner had FIXED; each announces only from its own captureSendBackQuietly's `alsoRecord`.
    const calls = [...coding.matchAll(/announceTaskSendBack\(/gu)];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(coding.slice(Math.max(0, call.index - 40), call.index)).toContain("alsoRecord: () => ");
    expect(coding.match(/captureSendBackQuietly\(/gu)).toHaveLength(2);
    expect(read("decide.ts")).not.toMatch(/announce(Task|Human)SendBack/u);
    expect(coding).not.toMatch(/announceHumanSendBack/u);
  });
});
