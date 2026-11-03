// Design review stage, DR7 slice B (design-review-stage.md 3.1): the one place the Understand step's `ready` answer meets the design review. Understand has returned and the workflow stands at PLAN/READY with the
// reading recorded; if the `dr` switch is on, code reads the project's EFFECTIVE setting (the playbook value held to the company's lock, `readEffectiveDesignReview` and nothing else), resolves the mode
// (`resolveDesignMode`: Understand's `design` field is a reading, never a decision) and, when it is ON, switches the review on with `enableDesignReview`, which forces the Full path. Nothing is shown here: showing the
// classification line is DR11. With the switch off this is never called into: the first line returns the workflow it was given.
import { WorkflowTransitionError, enableDesignReview, type IntentAssessment, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { isExplicitPath } from "../rovara-code/explicit-path.js";
import type { ProjectPlaybookReader } from "../playbook/project-playbook-store.js";
import { resolveDesignMode } from "./mode.js";
import { readEffectiveDesignReview } from "./setting.js";
import { designReviewEnabled } from "./switch.js";

export interface DesignModeAtUnderstandInput {
  orgId: OrgId;
  project: string;
  /** The workflow just after `recordIntentAssessment`: PLAN/READY with the reading on `intent`. */
  workflow: WorkflowSnapshot;
  /** The checked, redacted assessment the workflow recorded. */
  assessment: IntentAssessment;
  now: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The workflow with the design review switched on when the mode says so, else the workflow unchanged. Only a `ready` answer is decided (a question, or an answered task, never gets a review). A read of the setting that fails
 * throws: the task is not started on a guessed setting (the Understand step's own handler turns that into its retryable block). A switch that cannot be applied here (the sequence has no plan check step to review the design
 * in) leaves the review off and says so in the log with a fixed code; it never changes the workflow any other way.
 */
export async function withDesignReviewMode(deps: ProjectPlaybookReader, input: DesignModeAtUnderstandInput): Promise<WorkflowSnapshot> {
  if (!designReviewEnabled(input.env)) return input.workflow;
  const { workflow, assessment } = input;
  if (assessment.kind !== "ready" || workflow.stage !== "PLAN" || workflow.state !== "READY" || workflow.designReview !== undefined) return workflow;
  const effective = await readEffectiveDesignReview(deps, input.orgId, input.project);
  // What the person asked for, as far as the start recorded it: an explicit Quick path. (`design first:` and Skip arrive with DR11's intake; they are not invented here.)
  const decision = resolveDesignMode({ setting: effective.setting, assessment, quick: isExplicitPath(workflow) && workflow.path === "QUICK" });
  if (!decision.decided || !decision.on) return workflow;
  if (decision.decidedBy !== "auto" && decision.decidedBy !== "always") return workflow;
  try {
    return enableDesignReview(workflow, {
      expectedRevision: workflow.revision, now: input.now,
      start: { decidedBy: decision.decidedBy, reasons: [...decision.reasons], ...(decision.note === undefined ? {} : { note: decision.note }), tier: effective.setting.tier, capUsd: effective.setting.capUsdPerTask },
    });
  } catch (error) {
    if (!(error instanceof WorkflowTransitionError)) throw error;
    console.log(JSON.stringify({ component: "broker", event: "design_review.not_enabled", reason: "workflow_refused" }));
    return workflow;
  }
}
