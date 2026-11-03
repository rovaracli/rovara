// Design review stage (DR2; designs-2026-10-30/design-review-stage.md 3.1): does this task get its design checked before a person approves it?
// Pure. Code decides ON or OFF, who decided it, and whether the task is forced onto the Full path. Understand's `design` field is a reading of the request, never a decision: model
// words are shown to people as inert text (through `plainLine`) and never set the tier, the approver, the cost or the mode.
import {
  DESIGN_REVIEW_HIGH_RISK_REASONS, isHighRiskDesign,
  type DesignReason, type DesignReviewSetting, type IntentAssessment,
} from "@agentx/contracts";
import { plainLine } from "../decisions/text.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, isEffectiveSetting, type EffectiveDesignReviewSetting } from "./effective-setting.js";

export type DesignDecidedBy = "auto" | "always" | "person" | "person_skip" | "never";

export type DesignModeInput = {
  /**
   * The setting the task runs with: `readEffectiveDesignReview(...).setting`, the project's value held to the company's lock. The type is branded, so a raw playbook setting does not compile, and at run
   * time one that got here anyway is read as the strictest posture (always, no skipping), never as itself.
   */
  setting: EffectiveDesignReviewSetting;
  /** What Understand returned. Undefined until it has returned. */
  assessment: IntentAssessment | undefined;
  /** The person typed `design first:` or pressed Design first. Works even when the setting is `never` (owner Q3). */
  designFirst?: boolean;
  /** The person pressed Skip design review. */
  skip?: boolean;
  /** Whether the person who skipped is the project's high-risk approver. Only they may skip a high-risk design (owner Q10). */
  isHighRiskApprover?: boolean;
  /** The person typed `quick:` or pressed Quick (an explicit path of QUICK). */
  quick?: boolean;
};

/** Whether Skip may be used on this design, and if not, why. Shown beside the classification line ("Ask Priya to skip"). */
export type SkipVerdict = { allowed: true } | { allowed: false; because: "skip_off" | "needs_high_risk_approver" };

export type DesignOffBecause = "setting_never" | "not_needed" | "quick_chosen" | "person_skip";

export type DesignModeDecision =
  | { decided: false; why: "not_returned" | "questions" | "answer" }
  | {
    decided: true;
    on: boolean;
    decidedBy: DesignDecidedBy;
    /** The fixed reason codes Understand gave (at most 4); empty for an older worker. */
    reasons: readonly DesignReason[];
    /** Understand's one-line note, already flattened by `plainLine`. */
    note?: string;
    /** ON forces the Full path. */
    forceFull: boolean;
    /** The person typed `quick:` and review is ON: the task tells them and runs Full. */
    quickOverridden: boolean;
    /** Only when OFF. */
    offBecause?: DesignOffBecause;
    /** Whether the person asked to skip and was refused (the review stays ON). */
    skipRefused?: Extract<SkipVerdict, { allowed: false }>;
    /** Whether Skip may be used on this design; the UI shows the button or the "ask the approver" hint from it. */
    skip: SkipVerdict;
  };

/** The skip rules. `allowSkip: false` means no Skip. A design with a high-risk reason can be skipped only by the high-risk approver. */
export function skipVerdict(setting: DesignReviewSetting, reasons: readonly DesignReason[], isHighRiskApprover: boolean): SkipVerdict {
  if (!setting.allowSkip) return { allowed: false, because: "skip_off" };
  if (isHighRiskDesign(reasons) && !isHighRiskApprover) return { allowed: false, because: "needs_high_risk_approver" };
  return { allowed: true };
}

/**
 * The resolution of 3.1, in the order the table gives it. Understand must have returned `ready` first: `answer` (a Just-answer) and `questions` are not decided, so a task that was
 * answered never gets a design review, and `design first:` waits for Understand to be ready like everything else.
 *
 * Ready, then in order:
 * 1. the person asked for design first: ON, decidedBy `person`;
 * 2. the person pressed Skip and the skip rules allow it: OFF, decidedBy `person_skip` (a refused Skip is ignored and recorded in `skipRefused`);
 * 3. setting `never`: OFF;
 * 4. setting `always`: ON for every ready task (owner Q2);
 * 5. setting `auto`: ON when `design.needed`; else OFF. An explicit `quick:` turns it OFF here, with its reason.
 * `quick:` under `always`, or beside design first, runs Full and says so.
 */
export function resolveDesignMode(input: DesignModeInput): DesignModeDecision {
  const assessment = input.assessment;
  if (assessment === undefined) return { decided: false, why: "not_returned" };
  if (assessment.kind !== "ready") return { decided: false, why: assessment.kind };
  const setting = isEffectiveSetting(input.setting) ? input.setting : DESIGN_REVIEW_FAIL_CLOSED_SETTING;
  const design = assessment.design;
  const reasons: readonly DesignReason[] = design?.reasons ?? [];
  const note = design === undefined ? undefined : plainLine(design.note, 200);
  const skip = skipVerdict(setting, reasons, input.isHighRiskApprover === true);
  const base = { decided: true as const, reasons, ...(note === undefined || note === "" ? {} : { note }), skip };
  const quick = input.quick === true;
  const on = (decidedBy: DesignDecidedBy): DesignModeDecision => ({ ...base, on: true, decidedBy, forceFull: true, quickOverridden: quick });
  const off = (decidedBy: DesignDecidedBy, offBecause: DesignOffBecause): DesignModeDecision => ({
    ...base, on: false, decidedBy, forceFull: false, quickOverridden: false, offBecause,
  });

  // Design first and Skip together: the first row of the table wins, so the request for more care stands.
  if (input.designFirst === true) return on("person");
  if (input.skip === true) {
    if (skip.allowed) return off("person_skip", "person_skip");
    // A refused Skip is ignored: the rest of the table decides, and the refusal is recorded beside the result.
    const rest = resolveDesignMode({ ...input, skip: false });
    return rest.decided ? { ...rest, skipRefused: skip } : rest;
  }
  if (setting.mode === "never") return off("never", "setting_never");
  if (setting.mode === "always") return on("always");
  if (design?.needed === true) return quick ? off("auto", "quick_chosen") : on("auto");
  return off("auto", "not_needed");
}

const REASON_PHRASES: Readonly<Record<DesignReason, string>> = {
  new_api: "adds a new API",
  api_change: "changes an existing API",
  data_model: "changes the data model",
  cross_repo_or_service: "works across repositories or services",
  new_dependency: "adds a new dependency",
  auth: "touches sign-in or permissions",
  money: "touches money or billing",
  pii: "touches personal data",
  infrastructure: "changes infrastructure",
  small_change: "a small change inside one module",
  bug_fix: "a bug fix inside one module",
};

/** A fixed phrase for every reason code, so the line never carries a model's words for the reason itself. */
export const designReasonPhrase = (reason: DesignReason): string => REASON_PHRASES[reason];

const reasonText = (reasons: readonly DesignReason[]): string => reasons.map((reason) => REASON_PHRASES[reason]).join("; ");

/** Why a person must ask someone else to skip, in plain words. `approverName` is the high-risk approver's display name, when known. */
export function skipRefusalText(verdict: Extract<SkipVerdict, { allowed: false }>, approverName?: string): string {
  if (verdict.because === "skip_off") return "This project does not allow skipping design review.";
  const name = approverName === undefined || approverName.trim() === "" ? "the design approver" : plainLine(approverName, 80);
  return `Ask ${name} to skip: this design is high risk.`;
}

/**
 * The classification line people see after Understand (1.2): one plain sentence or two. `undefined` when nothing is decided yet, and for an answered task, which has no design
 * review. The reason codes become fixed phrases; the model's note goes through `plainLine` and is labelled as Rovara's reading.
 */
export function designClassificationLine(decision: DesignModeDecision): string | undefined {
  if (!decision.decided) return undefined;
  const reasons = reasonText(decision.reasons);
  const reading = decision.note === undefined ? "" : ` Note from Rovara: ${decision.note}`;
  if (decision.on) {
    const quickNote = decision.quickOverridden ? " You asked for quick, so this task runs the full path to make room for the design." : "";
    switch (decision.decidedBy) {
      case "person": return plainLine(`Design review: on, because you asked for design first.${reasons === "" ? "" : ` Reason: ${reasons}.`}${quickNote}`, 600);
      case "always": return plainLine(`Design review: on, because this project reviews the design of every code change.${reasons === "" ? "" : ` Reason: ${reasons}.`}${quickNote}`, 600);
      default: return plainLine(`Design review: needed. Reason: ${reasons === "" ? "Rovara's reading of the request" : `${reasons} (Rovara's reading of the request)`}.${reading}`, 600);
    }
  }
  switch (decision.offBecause) {
    case "setting_never": return "Design review: off for this project. Type design first to add it.";
    case "person_skip": return "Design review: skipped.";
    case "quick_chosen": return plainLine(`Design review: off, because you chose quick. Rovara would have reviewed the design${reasons === "" ? "" : ` (${reasons})`}. Type design first to add it.${reading}`, 600);
    default: return plainLine(`Design review: not needed.${reasons === "" ? "" : ` Reason: ${reasons}.`}${reading} Design first is available.`, 600);
  }
}

/** The high-risk reason codes, for the approver chip (DR9): the same list the contracts use. */
export const highRiskReasonsOf = (reasons: readonly DesignReason[]): readonly DesignReason[] =>
  reasons.filter((reason) => DESIGN_REVIEW_HIGH_RISK_REASONS.includes(reason));
