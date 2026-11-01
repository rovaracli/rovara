// v1.2 learning loop, follow-up to B4: the reason a person gives when they send CODE back to coding becomes a correction, like a plan send-back's (design 2.2, 2.4).
// The one hook is in `sendTaskWorkflowBackToCoding`, which the task page, the developer API, Slack and MCP all reach. The decider's standing is read live, never taken from the task role.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, EMPTY_RECIPE, agentXError, createCandidateManifest, type ResolvedRecipe, type WorkflowSnapshot } from "@agentx/contracts";
import { sendTaskWorkflowBackToCoding, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { sendBackNoAccessMessage } from "../../packages/broker/src/developer/task-access.js";
import { viewerCannotStartTasksMessage } from "../../packages/broker/src/developer/project-roles.js";
import { captureSendBack, captureSendBackQuietly, sendBackSourceKey } from "../../packages/broker/src/learning/capture-decision.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { captureCorrection, readLearningState } from "../../packages/broker/src/learning/store.js";
import { LEARNING_PROJECT_WIDE, LearningCorrectionSchema, type LearningCorrection } from "../../packages/contracts/src/project-learning.js";
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
async function blockedTask(options: { slack?: boolean; program?: boolean; autofix?: boolean } = {}) {
  const harness = await createSingleAnswerPlanBroker({ brokerExtra: { planSelfCheck: false, ...(options.autofix === true ? { autofix: { enabled: true, capUsd: 1000, roundEstimateUsd: 3 } } : {}) } });
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
  if (options.autofix === true) {
    // Coding ends with a candidate and its reviews find an introduced problem: with automatic fixing on, Rovara sends the work back by itself.
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await harness.finish(workspaceId, String(codingRuns(harness, workspaceId).at(-1)!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    const review = operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW").at(-1)!;
    const now = new Date().toISOString();
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
    ] } });
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
  /** The same through the developer API route. */
  const api = (who: Developer, instructions: string, requestId = randomUUID()) =>
    harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId, expectedRevision: workflowOf(harness, taskId).revision, instructions });
  const slack = (userId: string, requestId = randomUUID()) =>
    harness.handler({ source: "agentx.slack-ingress", action: "workflow-send-back", taskId, userId, thread: THREAD, requestId, expectedRevision: workflowOf(harness, taskId).revision }) as Promise<{ statusCode: number; body: string }>;
  const owner: DeveloperCaller = { ...MAYA_CALLER, developerId: taskRow(harness, taskId).developerId };
  return { harness, taskId, workspaceId, takeOver, send, sendWith, api, slack, owner };
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
  const tasksOff: CheckAccess = async () => { throw agentXError("PROJECT_TASKS_DISABLED", "tasks from AI tools are turned off for `payments`"); };
  const slackDown: CheckAccess = async () => { throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership"); };

  /** Refused before anything moves: no new coding run, the same workflow revision, nothing captured. */
  async function expectRefusedUnchanged(t: Awaited<ReturnType<typeof blockedTask>>, attempt: Promise<unknown>, expected: { code: string; message?: string }) {
    const runs = codingRuns(t.harness, t.workspaceId).length, revision = workflowOf(t.harness, t.taskId).revision;
    await expect(attempt).rejects.toMatchObject(expected);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs);
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ revision, state: "BLOCKED" });
    expect(learningItems(t.harness.db)).toEqual([]);
  }

  it("a taker with no project grant and no channel access is refused like a viewer, and nothing changes", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    await expectRefusedUnchanged(t, t.sendWith(denied, OMAR_CALLER, NOTE), { code: "PROJECT_ACCESS_DENIED", message: `PROJECT_ACCESS_DENIED: ${sendBackNoAccessMessage(PROJECT)}` });
  });

  it("a taker who is a project viewer is refused with the viewer message, and nothing changes", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "viewer");
    t.takeOver(OMAR_CALLER);
    await expectRefusedUnchanged(t, t.sendWith(granted("viewer"), OMAR_CALLER, NOTE), { code: "PROJECT_ACCESS_DENIED", message: `PROJECT_ACCESS_DENIED: ${viewerCannotStartTasksMessage(PROJECT)}` });
  });

  it("a taker who is a contributor by grant may send back", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "contributor");
    t.takeOver(OMAR_CALLER);
    const runs = codingRuns(t.harness, t.workspaceId).length;
    await t.sendWith(granted("contributor"), OMAR_CALLER, NOTE);
    expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs + 1);
    expect(corrections(t.harness)).toMatchObject([{ source: "send_back", stage: "code", author: OMAR.developerId }]);
  });

  for (const orgRole of ["owner", "admin"] as const) {
    it(`a company ${orgRole} with no project grant may send back, even when the project check would refuse them`, async () => {
      const t = await blockedTask({ program: true });
      const who = { ...OMAR_CALLER, orgRole };
      seedPerson(t.harness.db, who, "none");
      t.takeOver(who);
      const runs = codingRuns(t.harness, t.workspaceId).length;
      await t.sendWith(denied, who, NOTE);
      expect(codingRuns(t.harness, t.workspaceId)).toHaveLength(runs + 1);
    });
  }

  it("when the project turned off tasks from AI tools, a grant still decides: a contributor may, no grant may not", async () => {
    const allowed = await blockedTask({ program: true });
    seedPerson(allowed.harness.db, OMAR_CALLER, "contributor");
    allowed.takeOver(OMAR_CALLER);
    const runs = codingRuns(allowed.harness, allowed.workspaceId).length;
    await allowed.sendWith(tasksOff, OMAR_CALLER, NOTE);
    expect(codingRuns(allowed.harness, allowed.workspaceId)).toHaveLength(runs + 1);

    const refused = await blockedTask({ program: true });
    seedPerson(refused.harness.db, OMAR_CALLER, "none");
    refused.takeOver(OMAR_CALLER);
    await expectRefusedUnchanged(refused, refused.sendWith(tasksOff, OMAR_CALLER, NOTE), { code: "PROJECT_ACCESS_DENIED", message: `PROJECT_ACCESS_DENIED: ${sendBackNoAccessMessage(PROJECT)}` });
  });

  it("when Slack cannot be asked, the retryable error stands and nothing changes", async () => {
    const t = await blockedTask({ program: true });
    seedPerson(t.harness.db, OMAR_CALLER, "none");
    t.takeOver(OMAR_CALLER);
    await expectRefusedUnchanged(t, t.sendWith(slackDown, OMAR_CALLER, NOTE), { code: "SLACK_UNAVAILABLE" });
  });
});
