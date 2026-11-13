// Core drivers: Second review, design review, e2e, parallel parts, lessons (areas 8, 9, 10, 11, 14).
//
// second-review, design-review, e2e, lessons: compared at the feature's decisions (features-a-support/decision.ts): the same cases through the core's copy here
// and Cloud's copy in the Cloud driver, one features word per case. Neither journey reaches these features end to end on fakes yet (Cloud's journey harness
// has no second-review model record, design-review reviewer script, e2e browser or team record; the core's local runtime needs provider keys and the
// learning port), so the comparison holds the two copies of the logic the switch moves to the same answers.
//
// parallel-parts (area 11): the same Full task as Cloud's journey. The fake worker answers each phase's plan (the coding plan carries the three-part
// graph), the owner approves each on the local pages, and the coding run reports the parts' checkpoints the way the real worker does (A and B start
// before either finishes, C starts on the tree both were merged into) through the REAL events callback, then its result on the integrated tree. The
// reviews and the publication reuse the task-flow drivers.
import { UNDERSTAND_ARTIFACT_NAME, createCandidateManifest, type WorkerInvocation } from "@rovara-code/contracts";
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import { checkReport, type CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { PART_A, PART_B, PART_C, PART_FILES, partsPlan, partsWords } from "../features-a-support/parts.js";
import { TASK_FLOW_DRIVERS } from "./task-flow.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderObjectStorage } from "@rovara-code/local-adapters";
import { acceptSecondReport, admitSecondReview, againstModels, effectiveMode, planSecondReview, secondOpinionOf, secondOpinionShownOn, secondReviewAcknowledgement, secondReviewAlreadyRan, secondReviewPicker, secondReviewUnavailableDecision, verdictHoldsFor } from "@rovara-code/broker/core/second-review";
import { resolveDesignMode as coreResolveDesignMode } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/mode.js";
import { markEffective as coreMarkEffective } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/effective-setting.js";
import { estimateDesignReviewUsd as coreEstimateDesignReviewUsd, gateDesignReviewCost as coreGateDesignReviewCost, reviewersForRound as coreReviewersForRound } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/estimate.js";
import { requirementsMissingFromDesign as coreRequirementsMissingFromDesign } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/own-findings.js";
import { nextDesignWaitDueAt as coreNextDesignWaitDueAt } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/wait-clock.js";
import { lockViolations as coreLockViolations } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/lock.js";
import { reviewCoverage as coreReviewCoverage } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/risk.js";
import { blockerReasonLine as coreBlockerReasonLine } from "../../../../vendor/rovara-code/packages/broker/src/core/design-review/approval.js";
import { verifyWorkflowE2EEvidence as coreVerifyEvidence } from "../../../../vendor/rovara-code/packages/broker/src/core/e2e/verification.js";
import { classifyTier as coreClassifyTier } from "../../../../vendor/rovara-code/packages/broker/src/lessons/tier.js";
import { approvedForUse as coreApprovedForUse, wilsonLower as coreWilsonLower } from "../../../../vendor/rovara-code/packages/broker/src/lessons/load.js";
import { trialIsStable as coreTrialIsStable, namesAPerson as coreNamesAPerson } from "../../../../vendor/rovara-code/packages/broker/src/lessons/trial.js";
import { lessonValue as coreLessonValue } from "../../../../vendor/rovara-code/packages/broker/src/lessons/value.js";
import { looksLikeCorrection as coreLooksLikeCorrection } from "../../../../vendor/rovara-code/packages/broker/src/lessons/correction-filter.js";
import { polarity as corePolarity, oppositePolarity as coreOppositePolarity, hasEscalationWords as coreHasEscalationWords } from "../../../../vendor/rovara-code/packages/broker/src/lessons/guards.js";
import { cleanLessonLine as coreCleanLessonLine, parseLessonsFile as coreParseLessonsFile } from "../../../../vendor/rovara-code/packages/broker/src/lessons/repo-file-format.js";
import { renderLesson as coreRenderLesson } from "../../../../vendor/rovara-code/packages/broker/src/lessons/repo-file-plan.js";
import { minTrust as coreMinTrust, narrowestAudience as coreNarrowestAudience } from "../../../../vendor/rovara-code/packages/broker/src/lessons/types.js";
import { DEFAULT_APPROVAL_POLICY as CORE_DEFAULT_APPROVAL_POLICY } from "../../../../vendor/rovara-code/packages/broker/src/lessons/policy.js";
import { decisionWords, type DecisionCase, type DecisionImplementations } from "../features-a-support/decision.js";
import { SECOND_REVIEW_CASES } from "../features-a-support/cases-second-review.js";
import { DESIGN_REVIEW_CASES } from "../features-a-support/cases-design-review.js";
import { E2E_CASES } from "../features-a-support/cases-e2e.js";
import { LESSONS_CASES } from "../features-a-support/cases-lessons.js";

type Driver = StepDriver<CoreContext, FakeWorldOptions>;

/** A feature compared at its decisions: the same cases through the core's copy, one features word each, prefixed with the feature. */
function decisionDriver(feature: string, cases: readonly DecisionCase[], implementations: DecisionImplementations, helpers: Record<string, unknown> = {}): Driver {
  return {
    async run(ctx) {
      ctx.extra.features.push(...(await decisionWords(implementations, cases, { engine: "core", helpers })).map((word) => `${feature}:${word}`));
    },
  };
}

const CORE_SECOND_REVIEW: DecisionImplementations = { planSecondReview, acceptSecondReport, secondOpinionOf, secondReviewUnavailableDecision, secondReviewAcknowledgement, secondOpinionShownOn, admitSecondReview, againstModels, secondReviewAlreadyRan, effectiveMode, verdictHoldsFor, secondReviewPicker };
const CORE_DESIGN_REVIEW: DecisionImplementations = {
  // The resolver reads a setting marked effective by its own copy's `markEffective` (Cloud's driver does the same with Cloud's).
  resolveDesignMode: (input: { setting: Parameters<typeof coreMarkEffective>[0] }) => coreResolveDesignMode({ ...input, setting: coreMarkEffective(input.setting) } as never),
  estimateDesignReviewUsd: coreEstimateDesignReviewUsd, gateDesignReviewCost: coreGateDesignReviewCost, reviewersForRound: coreReviewersForRound,
  requirementsMissingFromDesign: coreRequirementsMissingFromDesign, nextDesignWaitDueAt: coreNextDesignWaitDueAt, lockViolations: coreLockViolations,
  reviewCoverage: coreReviewCoverage, blockerReasonLine: coreBlockerReasonLine,
};
const CORE_LESSONS: DecisionImplementations = {
  classifyTier: coreClassifyTier, approvedForUse: coreApprovedForUse, trialIsStable: coreTrialIsStable, lessonValue: coreLessonValue, wilsonLower: coreWilsonLower,
  looksLikeCorrection: coreLooksLikeCorrection, polarity: corePolarity, oppositePolarity: coreOppositePolarity, hasEscalationWords: coreHasEscalationWords,
  namesAPerson: coreNamesAPerson, cleanLessonLine: coreCleanLessonLine, parseLessonsFile: coreParseLessonsFile, renderLesson: coreRenderLesson,
  minTrust: coreMinTrust, narrowestAudience: coreNarrowestAudience,
};

const phaseOf = (job: WorkerInvocation): "requirements" | "design" | "plan" => {
  const phase = (job.payload as { workflowPhase?: string }).workflowPhase;
  return phase === "REQUIREMENTS" ? "requirements" : phase === "DESIGN" ? "design" : "plan";
};

interface Dependencies { approval: { graphDigest: string; runId: string; workflowRevision: number }; sequenceStart: number }

export const FEATURES_A_DRIVERS: Record<string, Driver> = {
  "feature:parallel-parts": {
    // Cloud's journey project checks the integrated tree with `node integration.mjs`; the core's project gets the same check.
    async prepare(ctx, scenario) {
      ctx.project = { ...ctx.project, readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }] };
      // features-a-parallel-parts-understand: the core runs Understand first (Code's default), the one setting under which its Full path advances
      // past the requirements today (known difference parallel-parts/transitions). Runs after the start driver's settings, so it wins.
      if (scenario.id.endsWith("-understand")) ctx.runtime.app.flow.deps.understandFirst = true;
    },
    async run(ctx) {
      // Plans and approvals until the coding run is handed to the worker (requirements, design, coding plan on the Full path).
      let coding: WorkerInvocation | undefined;
      for (let round = 0; round < 12 && coding === undefined; round += 1) {
        const job = await ctx.nextJob();
        if (job === undefined) {
          const task = await ctx.readTask();
          const workflow = task?.workflow as { stage?: string; state?: string } | undefined;
          if (workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING") { await ctx.decidePlan("approve"); continue; }
          return; // stalled: the transitions show where
        }
        const mode = ctx.modeOf(job);
        if (mode === "UNDERSTAND") {
          await ctx.callback(job, "artifacts", { name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify({ kind: "ready", path: "FULL", restatement: "Add a shared greeting service.", assumptions: [] }) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "PLAN") {
          await ctx.callback(job, "artifacts", { name: "plan.md", mediaType: "text/markdown", content: partsPlan(ctx.task.taskId, phaseOf(job)) });
          await ctx.callback(job, "result", { status: "SUCCEEDED" });
        } else if (mode === "IMPLEMENT") {
          coding = job;
        } else {
          ctx.task.pending = job;
          return;
        }
      }
      if (coding === undefined) return;
      const dependencies = (coding.payload as { workflowDependencies?: Dependencies }).workflowDependencies;
      const model = ctx.world.hostModel;
      if (dependencies === undefined) {
        // The core built the plan as one piece: the result is the whole change (the transitions and the missing checkpoints show the difference).
        ctx.task.commit = model.commit("work", Object.assign({}, ...Object.values(PART_FILES)) as Record<string, string>);
        ctx.task.tree = model.revision(ctx.task.commit).tree;
        ctx.task.codingJob = coding;
        await ctx.sendCoding("passed");
      } else {
        // The parts, as the real worker reports them: A and B side by side on the base, then C on the tree both were merged into.
        const base = model.revision(ctx.task.base).tree;
        let sequence = dependencies.sequenceStart;
        const event = (itemId: string, state: string, baseTreeSha: string, extra: Record<string, unknown> = {}) => {
          sequence += 1;
          const at = ctx.clock.now().toISOString();
          return { type: "progress", timestamp: at, payload: { workItemProgress: { schemaVersion: 1, graphDigest: dependencies.approval.graphDigest, runId: dependencies.approval.runId, itemId, sequence, state, operationId: coding.operationId, baseTreeSha, at, producer: "agentx-worker", ...extra } } };
        };
        const afterA = model.commit("work", PART_FILES[PART_A]!);
        const afterAB = model.commit("work", PART_FILES[PART_B]!);
        const treeA = model.revision(afterA).tree;
        const treeAB = model.revision(afterAB).tree;
        await ctx.callback(coding, "events", { events: [event(PART_A, "STARTED", base), event(PART_B, "STARTED", base)] });
        await ctx.callback(coding, "events", { events: [event(PART_A, "IMPLEMENTED", base, { candidateTreeSha: treeA, integratedTreeSha: treeA })] });
        await ctx.callback(coding, "events", { events: [event(PART_B, "IMPLEMENTED", base, { candidateTreeSha: treeAB, integratedTreeSha: treeAB })] });
        await ctx.callback(coding, "events", { events: [event(PART_C, "STARTED", treeAB)] });
        ctx.task.commit = model.commit("work", PART_FILES[PART_C]!);
        ctx.task.tree = model.revision(ctx.task.commit).tree;
        await ctx.callback(coding, "events", { events: [event(PART_C, "IMPLEMENTED", treeAB, { candidateTreeSha: ctx.task.tree, integratedTreeSha: ctx.task.tree })] });
        // The run's result names its ordered work: each part's last acknowledged checkpoint in the plan's order, the run, and the combined candidate.
        const stored = ((await ctx.readTask())?.workflow as { workflowDependenciesProgress?: Array<Record<string, unknown>> } | undefined)?.workflowDependenciesProgress ?? [];
        const lastOf = (itemId: string) => [...stored].reverse().find((entry) => entry.itemId === itemId);
        const workflowDependenciesResult = {
          schemaVersion: 1, taskId: ctx.task.taskId, graphDigest: dependencies.approval.graphDigest, runId: dependencies.approval.runId, operationId: coding.operationId,
          workflowRevision: dependencies.approval.workflowRevision, status: "SUCCEEDED", items: [PART_A, PART_B, PART_C].map(lastOf), candidateDigest: createCandidateManifest(ctx.candidate()).digest, at: ctx.clock.now().toISOString(),
        };
        await ctx.callback(coding, "result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: checkReport("passed"), workflowCandidateRepositories: ctx.candidate(), workflowCheckCandidateRepositories: ctx.candidate(), workflowDependenciesResult } });
      }
      // The parts' checkpoints as the workflow kept them (the features facet: same words as Cloud's driver records).
      const progress = ((await ctx.readTask())?.workflow as { workflowDependenciesProgress?: Array<{ itemId: string; state: string }> } | undefined)?.workflowDependenciesProgress ?? [];
      ctx.extra.features.push(...partsWords(progress));
      // Then the reviews and the publication, as on any task.
      await TASK_FLOW_DRIVERS.reviews!.run(ctx, { do: "reviews", outcome: "pass" }, undefined);
      await TASK_FLOW_DRIVERS.published!.run(ctx, { do: "published" }, undefined);
    },
  },
  "feature:second-review": decisionDriver("second-review", SECOND_REVIEW_CASES, CORE_SECOND_REVIEW),
  "feature:design-review": decisionDriver("design-review", DESIGN_REVIEW_CASES, CORE_DESIGN_REVIEW),
  "feature:e2e": {
    async run(ctx) {
      const root = await mkdtemp(join(tmpdir(), "parity-e2e-objects-"));
      try {
        const objects = new FolderObjectStorage({ root: join(root, "store"), maxObjectBytes: 1_000_000 });
        const deps = {
          objects,
          state: new Proxy({}, { get: () => { throw new Error("the parity e2e case reached the state store"); } }),
          authority: new Proxy({}, { get: () => { throw new Error("the parity e2e case reached the e2e authority"); } }),
          readTask: () => Promise.resolve(undefined),
        } as unknown as Parameters<typeof coreVerifyEvidence>[0];
        const putObject = async (key: string, text: string) => { await objects.put(key, new TextEncoder().encode(text), { contentType: "application/json", metadata: {}, retention: "evidence-std" }); };
        const implementations: DecisionImplementations = {
          verifyWorkflowE2EEvidence: async (...args: unknown[]) => {
            const diagnostic: Record<string, unknown> = {};
            const [operation, task, candidate, projection] = args as [never, never, never, never];
            const verdict = await coreVerifyEvidence(deps, operation, task, candidate, projection, diagnostic);
            return { verdict, ...diagnostic };
          },
        };
        ctx.extra.features.push(...(await decisionWords(implementations, E2E_CASES, { engine: "core", helpers: { putObject } })).map((word) => `e2e:${word}`));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  "feature:lessons": decisionDriver("lessons", LESSONS_CASES, CORE_LESSONS, { policy: CORE_DEFAULT_APPROVAL_POLICY }),
};
