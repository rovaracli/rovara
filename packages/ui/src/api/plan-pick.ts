// Decision cards, OWNER DECISION 7 (L4-DCS): what a person picks on a plan, requirements or design card beside Approve, and what an approve (or request-changes) sends for it. Pure; the contract is Code's
// (`DecisionPlanChoicesSchema`, `DecisionApproveBodySchema`). Rules, as Code's card says them ("What Approve takes"): an answer left on Rovara's recommendation is NOT sent (the workflow decision gives it the
// recommendation), only a changed answer is; the optional checks are sent only when the ticks differ from the plan's own selection; the open comments are sent only when one was unticked (absent: all of
// them go, as Slack's Approve takes them); a note goes when there is one; and a raised run limit is sent only after the person ticked it.
import {
 DECISION_OPTIONAL_CHECK_KINDS, DECISION_PLAN_CHOICE_KINDS, DECISION_PLAN_NOTE_MAX, DECISION_RUN_LIMIT_KINDS,
 type DecisionPlanAnswer, type DecisionPlanChoices,
} from "@agentx/contracts/web";

/** What the person has picked so far on one card. */
export interface PlanPick {
 /** Question id to the option id chosen (a question absent here is on Rovara's recommendation). */
 answers: Readonly<Record<string, string>>;
 /** The optional checks ticked (check ids). */
 checks: ReadonlySet<string>;
 /** The open comments still ticked (comment ids). */
 comments: ReadonlySet<string>;
 note: string;
 /** The person ticked "raise the run limit". */
 limitAgreed: boolean;
}

/** The plan fields an approve carries (every one optional; absent means "as the document has it"). */
export interface ApproveExtras {
 answers?: DecisionPlanAnswer[];
 selectedOptionalCheckIds?: string[];
 includedCommentIds?: string[];
 note?: string;
 acknowledgedRunLimitUsd?: number;
}

/** The card's run limit as the card shows it, and whether approving raises it (a raise asks for a tick; no limit yet counts as a raise). */
export interface RunLimitOnCard { currentUsd: number | undefined; proposedUsd: number; raises: boolean }

export function initialPick(choices: DecisionPlanChoices | undefined): PlanPick {
 return {
  answers: {},
  checks: new Set((choices?.optionalChecks ?? []).filter(check => check.selected).map(check => check.id)),
  comments: new Set((choices?.openComments ?? []).map(comment => comment.id)),
  note: "",
  limitAgreed: false,
 };
}

/** The option a question shows as chosen: the person's pick when it is one of the question's options, otherwise Rovara's recommendation. */
export function answerShown(question: DecisionPlanChoices["questions"][number], pick: PlanPick): string {
 const picked = pick.answers[question.id];
 return picked !== undefined && question.options.some(option => option.id === picked) ? picked : question.recommended;
}

/** The run limit of a coding plan's card, or undefined for any other card (the server refuses the field on another kind, so it is never read or sent there). */
export function runLimitOf(card: { kind: string; runLimit?: unknown }): RunLimitOnCard | undefined {
 const limit = card.runLimit;
 if (!DECISION_RUN_LIMIT_KINDS.includes(card.kind) || typeof limit !== "object" || limit === null) return undefined;
 const { currentUsd, proposedUsd } = limit as { currentUsd?: unknown; proposedUsd?: unknown };
 if (typeof proposedUsd !== "number" || !Number.isFinite(proposedUsd) || proposedUsd < 0) return undefined;
 const current = typeof currentUsd === "number" && Number.isFinite(currentUsd) && currentUsd >= 0 ? currentUsd : undefined;
 return { currentUsd: current, proposedUsd, raises: current === undefined || proposedUsd > current };
}

/** Whether Approve must wait: the card raises the run limit and the person has not agreed to the new one. */
export function approveWaitsForLimit(card: { kind: string; runLimit?: unknown }, pick: PlanPick): boolean {
 const limit = runLimitOf(card);
 return limit !== undefined && limit.raises && !pick.limitAgreed;
}

/** The note as it is sent: control and hidden characters taken out (line breaks kept), trimmed and cut at the contract's limit; undefined when nothing is left. */
export function cleanNote(text: string): string | undefined {
 const kept = Array.from(text.replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, character => (character === "\n" ? character : ""))).slice(0, DECISION_PLAN_NOTE_MAX).join("").trim();
 return kept === "" ? undefined : kept;
}

/** Whether every open comment is listed. When the card says more are open than it lists, the person cannot untick one, because an id list would leave the unlisted ones out. */
export function commentsAreAllListed(choices: DecisionPlanChoices): boolean {
 return choices.openCommentCount === undefined || choices.openCommentCount <= choices.openComments.length;
}

/**
 * What an approve of this card sends for the person's picks. Only fields the card's kind takes are ever built (the broker refuses the others, never drops them): answers, comments and a note on a plan,
 * requirements or design card; optional checks on a coding plan only; the run limit on a coding plan only.
 */
export function approveExtras(card: { kind: string; runLimit?: unknown }, choices: DecisionPlanChoices | undefined, pick: PlanPick): ApproveExtras {
 const out: ApproveExtras = {};
 if (DECISION_PLAN_CHOICE_KINDS.includes(card.kind)) {
  if (choices !== undefined) {
   const answers = choices.questions.flatMap((question): DecisionPlanAnswer[] => {
    const shown = answerShown(question, pick);
    return shown === question.recommended ? [] : [{ decisionId: question.id, optionId: shown, opened: true }];
   });
   if (answers.length > 0) out.answers = answers;
   if (DECISION_OPTIONAL_CHECK_KINDS.includes(card.kind) && choices.optionalChecks.some(check => check.selected !== pick.checks.has(check.id))) {
    out.selectedOptionalCheckIds = choices.optionalChecks.filter(check => pick.checks.has(check.id)).map(check => check.id);
   }
   if (commentsAreAllListed(choices) && choices.openComments.some(comment => !pick.comments.has(comment.id))) {
    out.includedCommentIds = choices.openComments.filter(comment => pick.comments.has(comment.id)).map(comment => comment.id);
   }
  }
  const note = cleanNote(pick.note);
  if (note !== undefined) out.note = note;
 }
 const limit = runLimitOf(card);
 if (limit !== undefined && (!limit.raises || pick.limitAgreed)) out.acknowledgedRunLimitUsd = limit.proposedUsd;
 return out;
}

/** The open comments a Request changes sends back with the reason: the ones still ticked, when the card lists them all (absent: none go, as Slack's Request changes). */
export function requestChangesCommentIds(choices: DecisionPlanChoices | undefined, pick: PlanPick, card: { kind: string }): string[] | undefined {
 if (choices === undefined || !DECISION_PLAN_CHOICE_KINDS.includes(card.kind) || choices.openComments.length === 0) return undefined;
 const ids = choices.openComments.filter(comment => pick.comments.has(comment.id)).map(comment => comment.id);
 return ids.length === 0 ? undefined : ids;
}

/** The plan fields a card of this kind may carry, whatever the caller built: a field its kind does not take is dropped here, so a request never carries what the broker would refuse. */
export function extrasAllowedFor(kind: string, extras: ApproveExtras | undefined): ApproveExtras {
 if (extras === undefined) return {};
 const out: ApproveExtras = {};
 if (DECISION_PLAN_CHOICE_KINDS.includes(kind)) {
  if (extras.answers !== undefined) out.answers = extras.answers;
  if (extras.includedCommentIds !== undefined) out.includedCommentIds = extras.includedCommentIds;
  if (extras.note !== undefined) out.note = extras.note;
 }
 if (DECISION_OPTIONAL_CHECK_KINDS.includes(kind) && extras.selectedOptionalCheckIds !== undefined) out.selectedOptionalCheckIds = extras.selectedOptionalCheckIds;
 if (DECISION_RUN_LIMIT_KINDS.includes(kind) && extras.acknowledgedRunLimitUsd !== undefined) out.acknowledgedRunLimitUsd = extras.acknowledgedRunLimitUsd;
 return out;
}
