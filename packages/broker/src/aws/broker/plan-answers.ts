// Part of the broker (split out of ../broker.ts): plan critique, plan answers, CI checks and planner replies.

import { criticFailures } from "../../model-selection/task-failures.js";
import { designReviewOutcome } from "../../design-review/outcome.js";
import { storeDesignTemplate } from "../../design-review/template-store.js";
import { designTemplateRetryPrompt } from "../../design-review/template.js";
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { submitWorkflowArtifact, submitPlanCritique, closePlanCritique, retryPlanCritique, blockWorkflow, WorkflowSnapshotSchema, WORKFLOW_BLOCK_REASONS, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { readPlanCritique, parsePlanDocument, planAnswerMissingParts, withCiChecks, groundingScenarioIds, parseCommentAnswers, commentRefInAuthor, commentIdInAuthor, COMMENT_AUTHOR_PREFIX, UNPLACED_COMMENT_AUTHOR, plainPageRefs, type PlanQualityFinding, type CommentAnswer, type PlanClaim, type WorkflowDecisionDetail, retiredClaimIds, canonicalPlanJson, type PlanDocument, type PlanEvidenceBundle, validateTaskGraph, workflowIsDesignReviewing, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, BUDGET_EXHAUSTED_FAILURE_MESSAGE, type OperationStatus, WORKFLOW_PLAN_MAX_BYTES, PLAN_DRY_RUN_FEATURE, type PlanDryRunClass, ROVARA_CODE_AGENT_ID, type RunEstimate } from "@rovara-code/contracts";
import { queryAllItems } from "../admin-reads.js";
import { decisionComments, pageCommentsPrompt, promptComments, readDecisionDetail } from "../../developer/owner-answers.js";
import { writePlannerReplies } from "../../developer/page-comments.js";
import { loadWorkflowDocument, readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { readCiChecks } from "../../rovara-code/ci-checks.js";
import { estimateDuration } from "../../rovara-code/duration.js";
import { planCitesCode, planEvidenceSources } from "../../developer/plan-evidence-jobs.js";
import { resolvePlanEvidence } from "../../developer/plan-evidence.js";
import type { OperationRecord } from "../cancellation.js";
import { isE2EPlanCorrectionBlockReason, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { planQualityFinding } from "@rovara-code/contracts";
import { plannedExpectation } from "../../developer/plan-grounding-findings.js";
import { estimateRun } from "../../spend/estimate.js";
import { CRITIC_MODEL_ATTEMPTS_MAX, criticModelUnusable, critiqueModelOf } from "../../rovara-code/critic.js";
import { defaultWorkerModel } from "../../agents/dispatch.js";
import { planUnreadablePrompt, planWhyEntries, promptTagId } from "../developer-tasks.js";
import { planQualityFindings } from "../../developer/plan-quality.js";
import { planDryRunFindings, readPlanDryRunOutcome } from "../../developer/plan-dry-run-results.js";
import { planUnreadableCategory } from "../../developer/plan-check-summary.js";
import { PLAN_AUTO_REVISIONS_MAX, PlanSelfCheckRecordSchema, autoRevisableFindings, planRevisionPrompt, planRevisionsUsed, planSelfCheckKey, recordedPlanQualityContext, selfCheckNotes, groundingNotCheckedNote, groundingUndecidedNote, PLAN_GROUNDING_HOLD_MS, type GroundingOutcome, type PlanGroundingHold, type PlanSelfCheckSkipReason, type PlanSelfCheckState } from "../../developer/plan-self-check.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireRecordProject } from "./dependency-wiring.js";
import { githubScopeOf, orgOfRecord, routingOf } from "./scope-helpers.js";
import { consumerCodeHostRouter } from "./consumer-hosts.js";
import { operationEventsNewestFirst } from "./terminal-and-github-events.js";
import { githubLoginOfDeveloper } from "./thread-workspaces.js";
import { githubProviderOfRecord } from "./repository-hosts.js";
import type { InlineEvidence } from "./workflow-items.js";

/**
 * Which limit a check or revision that ran out of budget stopped at: `planning` when the task's keys have spent the whole of its planning limit in this window, otherwise `other` (the step's, the
 * month's or the org's). Anything that can't be read says `other`, the wording that claims least.
 */
export async function spendLimitKind(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<"planning" | "other"> {
  if (dependencies.modelAccess === undefined || task.budgetUsd === undefined) return "other";
  try {
    const spent = await dependencies.modelAccess.access.keySpend(task.modelKeyIds ?? []);
    const window = Math.max(0, spent - (task.budgetBaselineUsd ?? 0));
    return window >= task.budgetUsd && (task.maxPerRunUsd === undefined || task.maxPerRunUsd >= task.budgetUsd) ? "planning" : "other";
  } catch {
    return "other";
  }
}

/** The most bytes of a plan check's answer that are read. */
const PLAN_CRITIQUE_ANSWER_MAX_BYTES = 65_536;

/**
 * Plan 6 Task 8: what a plan check's result does to the workflow. A readable answer is the critic's advice: it is kept for the person (or, with a blocking point, sent to the planner once) and
 * can do nothing else. A check that ran out of its budget (the planning limit) goes on to the person saying so. An answer with no readable block, and a run that failed, was stopped or was lost, block
 * the check with the reason; the task's owner can retry it. The critique's model is the one the operation ran on.
 */
export async function planCritiqueOutcome(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }, operation: OperationRecord, terminalStatus: OperationStatus, terminalError: string | undefined, now: string,
  /** Design review (B-M2): collects the Delete items that release the round's packets with the commit that records it. */
  release?: unknown[],
): Promise<WorkflowSnapshot> {
  const workflow = task.workflow;
  // Design review (switch `dr`, off: no task has one): the design form of this stage ends with its own moves, which the plan check's would refuse.
  if (workflowIsDesignReviewing(workflow)) return designReviewOutcome(dependencies, task, operation, terminalStatus, terminalError, now, undefined, release);
  // The check is advice: whatever goes wrong with it, the plan goes on to the person, who is told it was not checked (or that the check stopped at a limit).
  if (terminalStatus !== "SUCCEEDED") {
    if (terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE) {
      return closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "stopped_at_limit", limit: await spendLimitKind(dependencies, task), now });
    }
    // The base rule files could not be verified: the check never read the rules it is to apply, so it does not pass the plan on as unchecked (that would run without them). It stops
    // here, visibly, with its own reason and the owner's Retry plan check. This is not a model failure, so the next-ranked model is not tried, and nothing starts the check again by itself.
    if (terminalError?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true) return blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified, now);
    // The programs earlier work left running could not be stopped: the check read nothing, so the plan is not passed on as unchecked. It stops here with its own reason; not a model failure.
    if (terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true) return blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.leftoverProcesses, now);
    // Staging 0.4.10: the account could not use the check's model (Bedrock's 403). The check is made again on the next-ranked model, one try for each, up to CRITIC_MODEL_ATTEMPTS_MAX; the
    // next start leaves out the models that failed and, when none is left, closes the check as unavailable.
    if (terminalStatus === "FAILED" && criticModelUnusable(terminalError)) {
      const operations = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task");
      const planner = operations.filter((item) => item.workflowMode === "PLAN" && item.conversationId === task.conversationId)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
      // This operation is not yet stored as failed: it is one more try than the stored ones.
      const earlier = criticFailures(operations.filter((item) => item.id !== operation.id), planner).sinceLatestPlan;
      if (earlier + 1 < CRITIC_MODEL_ATTEMPTS_MAX) return retryPlanCritique(workflow, { expectedRevision: workflow.revision, now });
    }
    return closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now });
  }
  const answers = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "ARTIFACT#"))
    .filter((item) => item.operationId === operation.id && item.name === "plan-critique.md")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const artifact = answers.at(-1);
  const text = artifact === undefined ? undefined : await readObjectText(dependencies, String(artifact.objectKey), PLAN_CRITIQUE_ANSWER_MAX_BYTES).catch(() => undefined);
  const read = text === undefined ? undefined : readPlanCritique(text);
  if (read === undefined || !read.ok) return closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now });
  return submitPlanCritique(workflow, {
    expectedRevision: workflow.revision, now,
    critique: { verdict: read.verdict, points: read.points, model: critiqueModelOf(operation.model ?? defaultWorkerModel(routingOf(dependencies)?.rovaraGeography)) },
    ...(operation.criticSameModel === true ? { sameModelAsPlanner: true as const } : {}),
  });
}

/**
 * Plan 3, Task 34: what the run is expected to cost, from this org's runs of the task's project, agent and path (`estimateRun`), for the plan that just reached
 * review. Only with a model proxy (without one nothing is limited). An estimate that can't be made is logged and left out: the plan is still stored, and its
 * approval works the limit out again.
 */
export async function planRunEstimate(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }): Promise<RunEstimate | undefined> {
  if (dependencies.modelAccess === undefined || task.orgId === undefined) return undefined;
  try {
    const cost = await estimateRun(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, ...(dependencies.cloud === true ? { cloud: true } : {}), now: Date.now },
      { orgId: task.orgId, project: task.project, agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, path: task.workflow.path, ...(task.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: task.maxPerRunUsd }) },
    );
    // Plan 6 Task 7: a version 2 plan also carries how long to a pull request. Version 1 estimates stay as recorded.
    if (task.workflow.definitionVersion !== "1.1.0") return cost;
    // A history that can't be read leaves out the time and nothing else: the cost estimate (and the run limit it gives) is not held back by it.
    const minutes = await estimateDuration({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, { orgId: task.orgId, project: task.project, path: task.workflow.path })
      .catch((error: unknown) => {
        console.log(JSON.stringify({ component: "broker", event: "duration_estimate.unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }));
        return undefined;
      });
    return minutes === undefined ? cost : { ...cost, minutes };
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "run_estimate.unavailable", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }));
    return undefined;
  }
}

/** What the broker keeps of a planning answer it could not read: the problems found, at most this many. */
const PLAN_UNREADABLE_ERRORS_MAX = 5;
/** The most bytes of an earlier structured document read back to find the claim numbers that are retired. */
export const EARLIER_PLAN_MAX_BYTES = 32_768;

export const readObjectText = (dependencies: AwsBrokerDependencies, key: string, maxBytes: number) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes);

/**
 * Spec 061: reads the planner's saved answer (`plan.md`) as a structured plan document. A readable plan is stored as
 * canonical JSON and submitted for review at once (the code it cites is attached later, by the evidence job); an unreadable one blocks planning, keeping the
 * problems so Retry planning can tell the planner what to fix.
 */
export async function storePlanAnswer(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord & { workflow: WorkflowSnapshot },
  artifact: Record<string, unknown>,
  now: string,
  /** Whether this planning run was asked for (and its worker parses) the schema-v2 application plan. */
  applicationPlanNegotiated: boolean,
  /** The planning run: what its planner was told of the project (`planQualityContext`), for the plan self-check. */
  operation: Pick<OperationRecord, "id" | "planQualityContext" | "planQualityAsked"> & { groundingSourceAsked?: true | undefined },
  /** T7c: set only when the held plan's check on the current app has ended (the one finish): what it found. Absent on a planning run's own answer. */
  grounded?: { sha256: string; outcome: GroundingOutcome },
): Promise<{ next: WorkflowSnapshot; planUnreadable: NonNullable<DeveloperTaskRecord["planUnreadable"]> | null | undefined; evidenceJob?: { artifactId: string; artifactSha256: string }; inlineEvidence?: Omit<InlineEvidence, "taskId">; plannerReplies?: PlannerReplies;
  /** Plan self-check: the answer was not stored; the planner is asked again with `revision.prompt`, and `selfCheck` records the budget this spent. */
  selfCheck?: PlanSelfCheckState; revision?: { prompt: string };
  /** T7c: the plan is not stored or shown; the task holds it back while its must-not-change checks run on the current app. */
  hold?: PlanGroundingHold }> {
  const workflow = task.workflow;
  const artifactType = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
    : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
  // The automatic second run is spent once per document version (the version being written); an unreadable answer and a plan the self-check sends back share it.
  const version = workflow.artifacts.filter((entry) => entry.type === artifactType).length + 1;
  const revisionsUsed = planRevisionsUsed(task.planSelfCheck, artifactType, version);
  const selfCheckOn = dependencies.planSelfCheck !== false;
  const revisionLeft = selfCheckOn && revisionsUsed < PLAN_AUTO_REVISIONS_MAX;
  /** Not shown to the owner, and not stored: the workflow stays in planning, one revision on, and a dispatch row starts the planner again. */
  const askAgain = (prompt: string) => ({
    next: WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, updatedAt: now }),
    planUnreadable: undefined,
    selfCheck: { artifactType, version, used: revisionsUsed + 1 } satisfies PlanSelfCheckState,
    revision: { prompt },
  });
  const unreadable = (errors: string[]) => {
    if (revisionLeft) return askAgain(planUnreadablePrompt(errors));
    const next = blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.planUnreadable, now);
    return { next, planUnreadable: { workflowRevision: next.revision, errors: errors.slice(0, PLAN_UNREADABLE_ERRORS_MAX), category: planUnreadableCategory(errors), ...(revisionsUsed > 0 ? { autoRetried: true as const } : {}) } };
  };
  // One byte more than the limit is read, so an answer over the limit is told from one at it.
  const answer = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: String(artifact.objectKey), Range: `bytes=0-${WORKFLOW_PLAN_MAX_BYTES}` }));
  const content = answer.Body ? await answer.Body.transformToString("utf8") : "";
  if (Buffer.byteLength(content, "utf8") > WORKFLOW_PLAN_MAX_BYTES) return unreadable(["the answer is too long"]);
  // Design review (off: no task has a `designReview`): the DESIGN phase wrote the Rovara template, read strictly and stored as Markdown; one that does not read is asked for again (or blocks), as an unreadable plan is.
  if (artifactType === "design" && workflow.designReview !== undefined) {
    const stored = await storeDesignTemplate({
      workflow, ownerKey: task.ownerKey, workspaceId: task.workspaceId, artifact: { id: String(artifact.id), createdAt: String(artifact.createdAt) }, content, now,
      put: async (key, body) => { await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key, Body: body, ContentType: "text/markdown; charset=utf-8" })); },
    });
    if (!stored.ok) return revisionLeft ? askAgain(designTemplateRetryPrompt(stored.errors)) : unreadable(stored.errors);
    return { next: stored.next, planUnreadable: null };
  }

  const project = await requireRecordProject(dependencies, task, task.project, task.startingRevision);
  // Claim numbers an earlier structured document of this task had and its latest dropped may not come back. A document
  // that cannot be read back or fails its digest is skipped.
  const earlier: PlanDocument[] = [];
  let previousVersion: PlanDocument | undefined;
  for (const entry of workflow.artifacts) {
    if (entry.format !== "structured") continue;
    const loaded = await loadWorkflowDocument((key) => readObjectText(dependencies, key, EARLIER_PLAN_MAX_BYTES), entry, {}).catch(() => undefined);
    if (loaded?.format === "structured") {
      earlier.push(loaded.plan);
      if (entry.type === artifactType) previousVersion = loaded.plan;
    }
  }
  // Rovara Code version 2: the checks the repository's CI requires join the planner's proposals (a check the project already runs is not repeated, but the plan lists it), so the Checks section
  // never depends on the planner remembering to look. Whether the plan names a test is still read from the answer as the planner wrote it (below).
  const rovaraV2 = workflow.definitionVersion === "1.1.0";
  const withCi = rovaraV2 && artifactType === "plan" && workflow.checkPolicy !== undefined ? await answerWithCiChecks(dependencies, task, project, content) : content;
  // A coding plan's `checks` member proposes its checks; they run only once the owner approves this plan.
  const parsed = parsePlanDocument(withCi, {
    kind: artifactType,
    retiredClaimIds: retiredClaimIds(earlier),
    ...(artifactType === "plan" && workflow.checkPolicy !== undefined ? { checks: {
      repositoryPaths: project.definition.repositories.map((repository) => repository.path),
      required: workflow.checkPolicy.required,
      optionalCount: workflow.checkPolicy.optional.length,
      ...(rovaraV2 ? { listRequired: true } : {}),
    } } : {}),
  });
  if (!parsed.ok) return unreadable(parsed.errors);
  // Plan 6 Task 7: a version 2 coding plan names what changes, which files and how it is tested. The worker asked once more when a part was missing; a plan still missing one is unreadable.
  if (workflow.definitionVersion === "1.1.0" && artifactType === "plan") {
    const missing = planAnswerMissingParts(content, parsed.plan);
    if (missing.length > 0) return unreadable(missing);
  }
  // Defense in depth with the worker's own check: a version 2 intent is stored only from a run that negotiated it.
  if (parsed.plan.e2e?.schemaVersion === 2 && !applicationPlanNegotiated) {
    return unreadable(["the plan: e2e schemaVersion 2 was not offered for this planning step; use the schemaVersion 1 portable intent, or leave e2e out"]);
  }
  if (parsed.plan.workBreakdown !== undefined) {
    if (project.definition.repositories.length !== 1) return unreadable(["ordered work is available only for a task pinned to one registered repository"]);
    const graphValidation = validateTaskGraph(parsed.plan.workBreakdown, { taskId: task.taskId, repositoryId: project.definition.repositories[0]!.name });
    if (!graphValidation.ok) return unreadable(graphValidation.errors);
  }
  // The owner's real request (and the replies this step was given) is what the plan says it is for, not the planner's words.
  const step = await planStepComments(dependencies, task, artifactType);
  const plan: PlanDocument = planWithCommentIds({ ...parsed.plan, why: await planWhyEntries(dependencies, task, parsed.plan.why, (developerId) => githubLoginOfDeveloper(dependencies, developerId)) }, step, previousVersion);
  const canonical = canonicalPlanJson(plan);
  if (Buffer.byteLength(canonical, "utf8") > WORKFLOW_PLAN_MAX_BYTES) return unreadable(["the plan is too long once saved"]);

  // Plan self-check: fixed-code rules on the parsed plan (the same for Quick and Full). What the planner can fix sends the plan back once, unseen; the rest is kept
  // with the plan as findings. The check is advisory: a failure in it never blocks the plan.
  let findings: PlanQualityFinding[] = [];
  let notes: ReturnType<typeof selfCheckNotes> = [];
  /** What the dry run found for each proposed check (a fixed class), kept in the record so the card and page can say it. */
  let tried: Array<{ checkId: string; class: PlanDryRunClass }> | undefined;
  // Why the rules did not run, when they did not: kept in the record as "not checked".
  let skipped: PlanSelfCheckSkipReason | undefined = !selfCheckOn ? "disabled" : artifactType !== "plan" ? "not-a-coding-plan" : plan.checks === undefined ? "checks-not-read" : undefined;
  // A plan whose `checks` member was not read (a task with no check policy) cannot be judged: every claim would look unproved.
  if (skipped === undefined) {
    try {
      // The planning worker's dry run of the proposed checks on the unchanged code (a fixed class per check, never output): its report is read against the exact text the planner
      // saved (`content`, not the canonical form) and each result is attributed to a proposed check by its command. A worker the planner was not asked through (an older one) has no report to read.
      const proposed = (plan.checks?.proposed ?? []).map((check) => ({ id: check.id, command: check.command }));
      const outcome = readPlanDryRunOutcome({
        events: proposed.length === 0 ? [] : (await operationEventsNewestFirst(dependencies, operation.id, 500)).reverse(),
        planText: content, proposed, workerFeatures: operation.planQualityAsked === true ? [PLAN_DRY_RUN_FEATURE] : [],
      });
      findings = [...planQualityFindings(plan, { kind: "plan", context: recordedPlanQualityContext(operation.planQualityContext) }), ...planDryRunFindings({ outcome, expectOnBase: plan.checks?.expectOnBase })];
      notes = selfCheckNotes(outcome);
      tried = outcome.status === "TRIED" ? outcome.results.map((result) => ({ checkId: result.checkId, class: result.class })) : undefined;
    } catch (error) {
      findings = [];
      notes = [];
      tried = undefined;
      skipped = "rules-failed";
      console.log(JSON.stringify({ component: "broker", event: "plan_self_check.failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
    const revisable = autoRevisableFindings(findings, operation.planQualityAsked === true);
    if (revisable.length > 0 && revisionLeft) return askAgain(planRevisionPrompt(revisable));
  }
  // T7c: a coding plan with must-not-change scenarios is held back (nothing stored or submitted) while they run on the unchanged code; the one finish comes back here with what they found.
  const heldSha = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (skipped === undefined && artifactType === "plan" && groundingScenarioIds(plan).length > 0) {
    if (grounded === undefined) {
      if (operation.groundingSourceAsked === true && dependencies.planGrounding !== false) {
        const attempt = revisionsUsed + 1;
        // The held plan is saved under the key it will have once submitted (nothing refers to it until then), so the check can read it back and the finish writes the same bytes.
        await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: `private/${task.ownerKey}/${task.workspaceId}/plan-documents/${String(artifact.id)}.json`, Body: canonical, ContentType: "application/json" }));
        return {
          next: WorkflowSnapshotSchema.parse({ ...workflow, revision: workflow.revision + 1, updatedAt: now }), planUnreadable: undefined,
          hold: { artifactId: String(artifact.id), artifactSha256: heldSha, artifactCreatedAt: String(artifact.createdAt), version, attempt, planOperationId: operation.id, heldAt: now,
            deadlineAt: new Date(Date.parse(now) + PLAN_GROUNDING_HOLD_MS).toISOString() },
        };
      }
    } else {
      // The check ran on the plan as held; a plan that reads differently now was not the one checked.
      let outcome: GroundingOutcome = grounded.sha256 === heldSha ? grounded.outcome : { kind: "unavailable", reason: "refused" };
      if (outcome.kind === "checked") {
        // What the plan itself expected is added to each mismatch (its own words, never the app's value).
        const withExpected = outcome.findings.map((finding) => (finding.code !== "scenario-base-mismatch" || finding.steps === undefined ? finding : planQualityFinding({
          code: finding.code, ...(finding.scenarioIds === undefined ? {} : { scenarioIds: finding.scenarioIds }),
          steps: finding.steps.map((step) => { const expected = plannedExpectation(plan, step.scenarioId, step.assertionKind); return { scenarioId: step.scenarioId, assertionKind: step.assertionKind, ...(step.stepIndex === undefined ? {} : { stepIndex: step.stepIndex }), ...(expected === undefined || expected === "" ? {} : { expected }) }; }) })));
        outcome = { ...outcome, findings: withExpected };
        findings = [...findings, ...withExpected];
        if (outcome.undecided > 0) notes = [...notes, groundingUndecidedNote(outcome.undecided)];
        const revisableGrounding = autoRevisableFindings(outcome.findings, operation.planQualityAsked === true);
        if (revisableGrounding.length > 0 && revisionLeft) return askAgain(planRevisionPrompt(revisableGrounding));
      } else if (outcome.kind === "unavailable") notes = [...notes, groundingNotCheckedNote(outcome.reason)];
    }
  }

  // The plan is stored now. The code it cites is read afterwards by the evidence job, so a slow or failing GitHub never
  // holds up (or blocks) the plan; the job row is written in the same transaction as the plan.
  const artifactId = String(artifact.id);
  const prefix = `private/${task.ownerKey}/${task.workspaceId}/plan-documents/${artifactId}`;
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: `${prefix}.json`, Body: canonical, ContentType: "application/json" }));
  {
    // Beside the document, never inside it: the digest the owner's approval binds does not move. A plan with no record was not checked.
    try {
      const record = PlanSelfCheckRecordSchema.parse({ schemaVersion: 1, status: skipped === undefined ? "checked" : "not-checked", ...(skipped === undefined ? {} : { reason: skipped }), artifactId, artifactSha256: sha(canonical), checkedAt: now, findings, notes, autoRevisions: revisionsUsed, ...(tried === undefined || tried.length === 0 ? {} : { tried }) });
      await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: planSelfCheckKey(prefix), Body: JSON.stringify(record), ContentType: "application/json" }));
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "plan_self_check.record_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  let next = submitWorkflowArtifact(workflow, {
    expectedRevision: workflow.revision,
    now,
    ...(parsed.proposal === undefined ? {} : { proposal: parsed.proposal }),
    ...(parsed.plan.noChangeNeeded === undefined ? {} : { noChangeNeeded: true }),
    artifact: {
      id: artifactId, type: artifactType, version: workflow.artifacts.filter((entry) => entry.type === artifactType).length + 1,
      sha256: sha(canonical), producer: "agentx-worker-untrusted", objectKey: `${prefix}.json`, createdAt: String(artifact.createdAt),
      format: "structured",
    },
  });
  if (isE2EPlanCorrectionBlockReason(next.blockReason)) {
    const { blockReason: _priorE2EPlanReferenceFailure, ...withoutPriorPlanFailure } = next;
    void _priorE2EPlanReferenceFailure;
    next = WorkflowSnapshotSchema.parse(withoutPriorPlanFailure);
  }
  const replies = plannerRepliesFor(content, plan, step, task, { artifactId, version: next.artifacts.at(-1)?.version ?? 1 });
  const withReplies = replies === undefined ? {} : { plannerReplies: replies };
  if (!planCitesCode(plan)) return { next, planUnreadable: null, ...withReplies };
  const artifactSha256 = sha(canonical);
  // With the evidence job configured, the code is read afterwards. Without it (no PlanEvidence function in this deployment),
  // it is read here as before, inside the old 12 second budget, and attached after the plan commits, the same way the job does.
  if (dependencies.startPlanEvidenceJob !== undefined) return { next, planUnreadable: null, evidenceJob: { artifactId, artifactSha256 }, ...withReplies };
  const router = consumerCodeHostRouter(dependencies);
  let bundle: PlanEvidenceBundle;
  try {
    bundle = await resolvePlanEvidence(plan, {
      ...planEvidenceSources(project, { workflow, preparedBase: task.preparedBase }),
      // P5c: each cited repository is read through the code host its RECORD names; a record naming a host this install has not registered is refused (its places stay unavailable).
      readFile: async (url, path, commit, options) => {
        const record = project.definition.repositories.find((repository) => repository.url === url);
        if (record === undefined) throw new Error("the cited repository is not in the task's project");
        return router.forRecord(record).fileAtRevision({ url }, path, commit, await githubScopeOf(dependencies, task), options);
      },
    });
  } catch {
    bundle = { schemaVersion: 1, excerpts: [] };
  }
  return { next, planUnreadable: null, inlineEvidence: { artifactId, artifactSha256, bundle, prefix }, ...withReplies };
}

/** The most repositories whose CI is read for one plan, and how long the reading may take: a plan is never held up for it. */
const CI_READ_REPOSITORIES_MAX = 3;
const CI_READ_TIMEOUT_MS = 10_000;

/**
 * The planner's answer with the checks the task's repositories' CI workflows require added to its proposed checks (Plan 6 plan quality). Read through the org's read-only GitHub reader of each
 * repository's default branch; the answer comes back as it was when there is no reader (a private install), nothing can be read in time, or a workflow can't be understood.
 */
export async function answerWithCiChecks(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  project: Awaited<ReturnType<typeof requireRecordProject>>,
  content: string,
): Promise<string> {
  if (dependencies.cloud !== true || dependencies.githubPullRequests.agentRepositoryReader === undefined) return content;
  const github = dependencies.githubPullRequests;
  try {
    const orgId = await orgOfRecord(dependencies, task);
    const reading = Promise.all(project.definition.repositories.slice(0, CI_READ_REPOSITORIES_MAX).map(async (repository) => {
      try {
        // P5d: the repository's CI is read with the org's GitHub reader (an agent connector the port has no counterpart for, left for P6), so only a GitHub repository is asked. One on another host,
        // or whose host kind is unknown (the router refuses it), adds no checks: this enrichment never holds a plan up.
        githubProviderOfRecord(dependencies, repository);
        const reader = await github.agentRepositoryReader!(repository.url, { orgId }, ...(repository.installationId === undefined ? [] : [{ installationId: repository.installationId }]));
        return await readCiChecks(reader, repository.path);
      } catch {
        return [];
      }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = await Promise.race([reading, new Promise<never[][]>((resolve) => { timer = setTimeout(() => resolve([]), CI_READ_TIMEOUT_MS); })]);
    if (timer !== undefined) clearTimeout(timer);
    return withCiChecks(content, found.flat());
  } catch {
    return content;
  }
}

/** The planner's answers to the comments the owner sent with a decision, for the version just stored. */
export interface PlannerReplies { taskId: string; artifactId: string; version: number; detail: WorkflowDecisionDetail; answers: CommentAnswer[] }

const DOCUMENT_ORDER: readonly string[] = ["requirements", "design", "plan"];

/** The comments the step that wrote a document was given: the decision's detail, and how many of them its prompt showed (refs c1 up to c<shown>). */
interface PlanStepComments { detail: WorkflowDecisionDetail; shown: number }

/**
 * Spec 061 slice 2: the comments a planning step was given, when it follows a decision that sent some. Request changes:
 * the same kind of document, rewritten. Approve: the next document, which builds on the approved one and handles the
 * comments sent with the approval. Undefined when the step did not follow such a decision, or its record cannot be read.
 * A comment the prompt left out for room is not counted: the planner never read it.
 */
async function planStepComments(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }, artifactType: string,
): Promise<PlanStepComments | undefined> {
  const workflow = task.workflow;
  const last = [...workflow.decisions].reverse().find((decision) => (decision.source ?? "GATE") === "GATE");
  if ((last?.decision !== "REQUEST_CHANGES" && last?.decision !== "APPROVE") || (last.commentsIncluded ?? 0) === 0) return undefined;
  const decided = workflow.artifacts.find((artifact) => artifact.sha256 === last.artifactDigest);
  if (decided === undefined) return undefined;
  if (last.decision === "APPROVE" ? DOCUMENT_ORDER.indexOf(artifactType) <= DOCUMENT_ORDER.indexOf(decided.type) : decided.type !== artifactType) return undefined;
  try {
    const detail = await readDecisionDetail(dependencies, task.taskId, last.requestId);
    if (detail === undefined || detail.includedCommentIds.length === 0) return undefined;
    // The prompt cut the comments to fit; the same cut, from the same (locked) comments, says which ones the planner read.
    const comments = await decisionComments(dependencies, task.taskId, detail.includedCommentIds);
    const shown = comments.length === detail.includedCommentIds.length
      ? pageCommentsPrompt(promptComments(comments), promptTagId(task, last.requestId)).shown : detail.includedCommentIds.length;
    return { detail, shown };
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.planner_replies_unread", taskId: task.taskId, errorName: error instanceof Error ? error.name : "unknown" }));
    return undefined;
  }
}

/** The comment IDs a plan's quotes credit (`comment:<ID>`), anywhere in its claim tree. */
function creditedCommentIds(plan: PlanDocument): Set<string> {
  const found = new Set<string>();
  const walk = (claims: readonly PlanClaim[]) => {
    for (const claim of claims) {
      for (const item of claim.evidence ?? []) {
        const id = item.kind === "quote" ? commentIdInAuthor(item.author) : undefined;
        if (id !== undefined) found.add(id);
      }
      walk(claim.children ?? []);
    }
  };
  walk(plan.claims);
  return found;
}

/**
 * A plan whose quotes credit a page comment as "comment c1" (a ref that only means something in this step) with each
 * swapped for `comment:<comment ID>`, which stays true in every later version. A ref this step did not give the planner
 * becomes plain "a comment". A `comment:<ID>` the planner writes itself is kept only for a comment this step showed it, or
 * one the previous version of this document already credited (the planner copies those); anything else that names a
 * comment, in any other form, becomes "a comment" too.
 */
function planWithCommentIds(plan: PlanDocument, step: PlanStepComments | undefined, previous?: PlanDocument): PlanDocument {
  const allowed = new Set([...(step?.detail.includedCommentIds.slice(0, step.shown) ?? []), ...(previous === undefined ? [] : creditedCommentIds(previous))].map((id) => id.toLowerCase()));
  const credit = (author: string): string => {
    const ref = commentRefInAuthor(author);
    if (ref !== undefined) {
      const position = Number(ref.slice(1));
      const id = step === undefined || position > step.shown ? undefined : step.detail.includedCommentIds[position - 1];
      return id === undefined ? UNPLACED_COMMENT_AUTHOR : `${COMMENT_AUTHOR_PREFIX}${id}`;
    }
    if (!/comment:/iu.test(author)) return author;
    const id = commentIdInAuthor(author);
    return id !== undefined && allowed.has(id) ? `${COMMENT_AUTHOR_PREFIX}${id}` : UNPLACED_COMMENT_AUTHOR;
  };
  const walk = (claims: readonly PlanClaim[]): PlanClaim[] => claims.map((claim) => ({
    ...claim,
    ...(claim.evidence === undefined ? {} : { evidence: claim.evidence.map((item) => (item.kind === "quote" ? { ...item, author: credit(item.author) } : item)) }),
    ...(claim.children === undefined ? {} : { children: walk(claim.children) }),
  }));
  return { ...plan, claims: walk(plan.claims) };
}

/**
 * The planner's `agentx-comment-answers` block read against the step's comments (refs c1, c2 and so on): only the ones
 * its prompt showed. A missing or unreadable block (an older worker never writes one) is no answers. Undefined when the
 * step was given no comments.
 */
function plannerRepliesFor(content: string, plan: PlanDocument, step: PlanStepComments | undefined, task: { taskId: string }, stored: { artifactId: string; version: number }): PlannerReplies | undefined {
  if (step === undefined) return undefined;
  const refs = new Set(step.detail.includedCommentIds.slice(0, step.shown).map((_, index) => `c${index + 1}`));
  // The reply says a decision or comment label in words (the model is told not to use them; this is for one that slips through).
  const decisions = new Map(plan.decisions.map((decision) => [decision.id, decision.question]));
  const answers = parseCommentAnswers(content, refs).map((answer) => ({ ...answer, reason: plainPageRefs(answer.reason, { decisions }) }));
  return { taskId: task.taskId, ...stored, detail: step.detail, answers };
}

/** Writes the planner's answers as replies from AgentX, after the plan committed. Best effort: a failure is logged with counts only. */
export async function writeAllPlannerReplies(dependencies: AwsBrokerDependencies, entries: readonly PlannerReplies[]): Promise<void> {
  for (const entry of entries) {
    if (entry.answers.length === 0) continue;
    try {
      await writePlannerReplies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, log: (line) => console.log(JSON.stringify({ component: "broker", ...line })) }, entry);
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "developer.planner_replies_failed", taskId: entry.taskId, answers: entry.answers.length, errorName: error instanceof Error ? error.name : "unknown" }));
    }
  }
}
