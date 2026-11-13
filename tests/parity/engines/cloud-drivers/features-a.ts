// Cloud drivers: Second review, design review, e2e, parallel parts, lessons (areas 8, 9, 10, 11, 14).
//
// parallel-parts (area 11) follows Cloud's own journey (tests/contract/rovara-code-parallel-parts-journey.test.ts): a Full task made a Rovara Code
// version 2 task (definition 1.1.0) before its plans are approved, three approvals, the real worker building A and B side by side and C on both, the
// project's readiness check run on the integrated tree, one pull request.
//
// second-review, design-review, e2e, lessons: compared at the feature's decisions (features-a-support/decision.ts), the same cases through Cloud's copy here
// and the core's copy in the core driver. The journey harness reaches none of them end to end (no second-review model record, design-review reviewer
// script, e2e browser or team record), so the comparison holds the two copies of the logic the switch moves to the same answers.
import type { WorkflowE2E } from "../../../support/workflow-e2e.js";
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { PART_FILES, partsPlan, partsWords } from "../features-a-support/parts.js";
import { memoryS3 } from "../../../support/developer-task-broker.js";
import { acceptSecondReport, admitSecondReview, againstModels, planSecondReview, secondOpinionOf, secondOpinionShownOn, secondReviewAcknowledgement, secondReviewAlreadyRan, secondReviewUnavailableDecision } from "../../../../packages/broker/src/rovara-code/second-review.js";
import { secondReviewPicker } from "../../../../packages/broker/src/rovara-code/second-review-picker.js";
import { effectiveMode } from "../../../../packages/broker/src/org/second-review-mode.js";
import { verdictHoldsFor } from "../../../../packages/broker/src/org/second-review-evidence.js";
import { resolveDesignMode } from "../../../../packages/broker/src/design-review/mode.js";
import { markEffective } from "../../../../packages/broker/src/design-review/effective-setting.js";
import { estimateDesignReviewUsd, gateDesignReviewCost, reviewersForRound } from "../../../../packages/broker/src/design-review/estimate.js";
import { requirementsMissingFromDesign } from "../../../../packages/broker/src/design-review/own-findings.js";
import { nextDesignWaitDueAt } from "../../../../packages/broker/src/design-review/wait-clock.js";
import { lockViolations } from "../../../../packages/broker/src/design-review/lock.js";
import { reviewCoverage } from "../../../../packages/broker/src/design-review/risk.js";
import { blockerReasonLine } from "../../../../packages/broker/src/design-review/approval.js";
import { verifyWorkflowE2EEvidence as cloudVerifyEvidence } from "../../../../packages/broker/src/aws/broker/workflow-e2e-verification.js";
import { classifyTier } from "../../../../packages/broker/src/lessons/tier.js";
import { approvedForUse, wilsonLower } from "../../../../packages/broker/src/lessons/load.js";
import { trialIsStable, namesAPerson } from "../../../../packages/broker/src/lessons/trial.js";
import { lessonValue } from "../../../../packages/broker/src/lessons/value.js";
import { looksLikeCorrection } from "../../../../packages/broker/src/lessons/correction-filter.js";
import { polarity, oppositePolarity, hasEscalationWords } from "../../../../packages/broker/src/lessons/guards.js";
import { cleanLessonLine, parseLessonsFile } from "../../../../packages/broker/src/lessons/repo-file-format.js";
import { renderLesson } from "../../../../packages/broker/src/lessons/repo-file-plan.js";
import { minTrust, narrowestAudience } from "../../../../packages/broker/src/lessons/types.js";
import { DEFAULT_APPROVAL_POLICY as CLOUD_DEFAULT_APPROVAL_POLICY } from "../../../../packages/broker/src/lessons/policy.js";
import { decisionWords, type DecisionCase, type DecisionImplementations } from "../features-a-support/decision.js";
import { SECOND_REVIEW_CASES } from "../features-a-support/cases-second-review.js";
import { DESIGN_REVIEW_CASES } from "../features-a-support/cases-design-review.js";
import { E2E_CASES } from "../features-a-support/cases-e2e.js";
import { LESSONS_CASES } from "../features-a-support/cases-lessons.js";
import type { Step } from "../../harness/types.js";

type Driver = StepDriver<CloudContext, CloudOptions>;

/** The harness under the scenario, known once it starts (the faux planner names the task's id in the graph). */
const current: { e2e?: WorkflowE2E } = {};

function itemEdits(latest: string): Array<{ path: string; content: string }> {
  const title = latest.match(/Current approved item[^\n]*\nTitle: (.*)/)?.[1];
  // Parts built side by side work in a folder whose root is the repository; one after another they work in the workspace (repo/demo).
  const where = (file: string) => `${/built at the same time/.test(latest) ? "" : "repo/demo/"}${file}`;
  const part = title?.startsWith("A:") === true ? PART_FILES["11111111-1111-4111-8111-111111111111"] : title?.startsWith("B:") === true ? PART_FILES["22222222-2222-4222-8222-222222222222"] : title?.startsWith("C:") === true ? PART_FILES["33333333-3333-4333-8333-333333333333"] : undefined;
  return Object.entries(part ?? {}).map(([file, content]) => ({ path: where(file), content }));
}

/** A feature compared at its decisions: the same cases through Cloud's copy, one features word each, prefixed with the feature. */
function decisionDriver(feature: string, cases: readonly DecisionCase[], implementations: DecisionImplementations, helpers: Record<string, unknown> = {}): Driver {
  return {
    async run(ctx) {
      ctx.extra.features.push(...(await decisionWords(implementations, cases, { engine: "cloud", helpers })).map((word) => `${feature}:${word}`));
    },
  };
}

const CLOUD_SECOND_REVIEW: DecisionImplementations = { planSecondReview, acceptSecondReport, secondOpinionOf, secondReviewUnavailableDecision, secondReviewAcknowledgement, secondOpinionShownOn, admitSecondReview, againstModels, secondReviewAlreadyRan, effectiveMode, verdictHoldsFor, secondReviewPicker };
const CLOUD_DESIGN_REVIEW: DecisionImplementations = {
  // The resolver reads a setting marked effective by its own copy's `markEffective` (the core's driver does the same with the core's).
  resolveDesignMode: (input: { setting: Parameters<typeof markEffective>[0] }) => resolveDesignMode({ ...input, setting: markEffective(input.setting) } as never),
  estimateDesignReviewUsd, gateDesignReviewCost, reviewersForRound, requirementsMissingFromDesign, nextDesignWaitDueAt, lockViolations, reviewCoverage, blockerReasonLine,
};
const CLOUD_LESSONS: DecisionImplementations = {
  classifyTier, approvedForUse, trialIsStable, lessonValue, wilsonLower, looksLikeCorrection, polarity, oppositePolarity, hasEscalationWords, namesAPerson, cleanLessonLine,
  parseLessonsFile, renderLesson, minTrust, narrowestAudience,
};

export const FEATURES_A_DRIVERS: Record<string, Driver> = {
  "feature:parallel-parts": {
    options: () => ({
      readiness: [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }],
      realProjectCommands: true,
      model: {
        plan: (latest: string) => partsPlan(current.e2e!.taskId(), /writing the requirements/i.test(latest) ? "requirements" : /writing the design/i.test(latest) ? "design" : "plan"),
        edits: itemEdits,
      },
    }),
    async prepare(ctx) { current.e2e = ctx.e2e; },
    async run(ctx) {
      const e2e = ctx.e2e;
      // A version 2 task, as an org on Rovara Code version 2 has it (the journey's own step: Cloud's v1 path refuses a graph without the install switch).
      const key = { pk: `DEVTASK#${e2e.taskId()}`, sk: "META" };
      const task = e2e.db.get(key.pk, key.sk) as { workflow: Record<string, unknown> };
      e2e.db.set({ ...key, ...task, workflow: { ...task.workflow, definitionVersion: "1.1.0" } });
      // Requirements, design and the coding plan, each approved (a modal may ask for the optional checks).
      for (let index = 0; index < 3; index += 1) {
        if (e2e.slack.lastPostWithAction("agentx_workflow_approve") === undefined) break;
        const views = e2e.slack.views.length;
        await e2e.click("agentx_workflow_approve");
        if (e2e.slack.views.length > views) await e2e.submitView();
        await e2e.settle();
      }
      const progress = ((e2e.workflow() as unknown as { workflowDependenciesProgress?: Array<{ itemId: string; state: string }> }).workflowDependenciesProgress ?? []);
      ctx.memo.partsProgress = progress.map((entry) => `${entry.itemId.slice(0, 1)}:${entry.state}`);
      // The parts' checkpoints in the features facet (the core's driver records the same words from its workflow).
      ctx.extra.features.push(...partsWords(progress));
    },
  },
  "feature:second-review": decisionDriver("second-review", SECOND_REVIEW_CASES, CLOUD_SECOND_REVIEW),
  "feature:design-review": decisionDriver("design-review", DESIGN_REVIEW_CASES, CLOUD_DESIGN_REVIEW),
  "feature:e2e": {
    async run(ctx) {
      // Cloud's verifier reads the admission and evidence from the artifact bucket through its S3 client: the in-memory S3 of the journey suites.
      const s3 = memoryS3();
      const dependencies = { s3, artifactBucketName: "parity-artifacts" } as unknown as Parameters<typeof cloudVerifyEvidence>[0];
      const putObject = (key: string, text: string) => { s3.objects.set(key, text); return Promise.resolve(); };
      const implementations: DecisionImplementations = {
        verifyWorkflowE2EEvidence: async (...args: unknown[]) => {
          const diagnostic: Record<string, unknown> = {};
          const [operation, task, candidate, projection] = args as [never, never, never, never];
          const verdict = await cloudVerifyEvidence(dependencies, operation, task, candidate, projection, diagnostic);
          return { verdict, ...diagnostic };
        },
      };
      ctx.extra.features.push(...(await decisionWords(implementations, E2E_CASES, { engine: "cloud", helpers: { putObject } })).map((word) => `e2e:${word}`));
    },
  },
  "feature:lessons": decisionDriver("lessons", LESSONS_CASES, CLOUD_LESSONS, { policy: CLOUD_DEFAULT_APPROVAL_POLICY }),
};

export type { Step };
