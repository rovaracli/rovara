// Design review stage (DR9, 3.7 and 3.11): the card SOURCES for a design under review. Pure: a stored `WorkflowDesignReview` (and the design's `touches[]`) in, a pending `DecisionItem` out, for the
// projector (`decisions/project.ts`) to make a card from. Two sources:
//   - `designApproveItem`: the existing `approve_design` card, now with the evidence chips (reviewers verified, open blockers, disagreements, cost) and the Disagreements group. Its tier is NOT set here: the
//     projector asks `riskTierOf`, which reads the facts below. Model text never sets it.
//   - `designQuestionsItem`: ONE `answer_question` card per round with up to three questions, each with what is unclear, short cited evidence, the options with consequences, and the recommendation with why.
// Every line a model wrote (a finding's text, a question) is passed through `plainLine` by the projector; nothing here is executed or followed.
import { DESIGN_REVIEW_QUESTIONS_MAX, type DesignCitation, type DesignQuestion, type DesignReason, type WorkflowDesignReview } from "@agentx/contracts";
import type { DecisionItem, ItemBase } from "../decisions/project.js";
import { plainLine } from "../decisions/text.js";
import { TIER_REVIEWERS } from "./estimate.js";
import type { DesignCardFacts } from "./risk.js";

/**
 * What the approver is shown, from the stored review. The LAST round counts. `planned` is what the tier meant to run (a review that never ran has no round: planned is the tier's count and verified 0, so it
 * reads "did not run"). A finding is an OPEN blocker or major until a resolution marks it `settled`. A DISAGREEMENT is a finding the planner contested or declined, settled or not: the approver sees every place
 * the planner and a reviewer differ.
 */
export function designCardFactsOf(review: WorkflowDesignReview, touches: readonly DesignReason[]): DesignCardFacts {
  const round = review.rounds.at(-1);
  const planned = TIER_REVIEWERS[review.tier].length;
  const verified = round === undefined ? 0 : round.reviewers.filter((run) => run.verified).length;
  const settled = new Set((round?.resolutions ?? []).filter((resolution) => resolution.settled).map((resolution) => resolution.findingId));
  const differ = new Set((round?.resolutions ?? []).filter((resolution) => resolution.action === "contested" || resolution.action === "declined").map((resolution) => resolution.findingId));
  const findings = round?.findings ?? [];
  return {
    reasons: review.reasons,
    touches,
    reviewers: { planned, verified },
    blockers: findings.filter((finding) => finding.severity === "blocker" && !settled.has(finding.id)).map((finding) => ({ section: finding.section, text: finding.text })),
    majors: findings.filter((finding) => finding.severity === "major" && !settled.has(finding.id)).length,
    disagreements: findings.filter((finding) => differ.has(finding.id)).map((finding) => ({ section: finding.section, text: finding.text })),
    ...(review.spentUsd > 0 ? { costUsd: review.spentUsd } : {}),
  };
}

type CardBase = Omit<ItemBase, "details" | "answeredByRule" | "outcome">;

/** The `approve_design` item for a design under review. `files` are the paths the design says it changes (§6); `review` the facts above. */
export function designApproveItem(base: CardBase & { files: readonly string[]; review: DesignCardFacts }): DecisionItem {
  const { files, review, ...rest } = base;
  return { ...rest, kind: "approve_design", files, review };
}

function citationText(citation: DesignCitation): string {
  switch (citation.kind) {
    case "design": return `design ${citation.section}`;
    case "code": return `${citation.path}:${String(citation.startLine)}`;
    case "source": return `source ${citation.ref}`;
  }
}

/**
 * ONE card for a round's questions (3.7): the item is an `answer_question` with a batch of up to three, each question one detail group the person reads. Zero questions, or more than three, make no card
 * (undefined): the batch is bounded and a broken one is dropped, never trimmed to something the reviewers did not ask.
 */
export function designQuestionsItem(base: CardBase & { designTitle: string; questions: readonly DesignQuestion[] }): DecisionItem | undefined {
  const { designTitle, questions, ...rest } = base;
  if (questions.length === 0 || questions.length > DESIGN_REVIEW_QUESTIONS_MAX) return undefined;
  const details = questions.map((question, index) => ({
    title: plainLine(`${String(index + 1)}. ${question.unclear}`, 60),
    lines: [
      plainLine(`Unclear because: ${question.unclear}`, 200),
      ...(question.evidence.length === 0 ? [] : [plainLine(`Evidence: ${question.evidence.map(citationText).join("; ")}`, 200)]),
      ...question.options.map((option) => plainLine(`${option.id}) ${option.label}: ${option.consequence}`, 200)),
      plainLine(`Recommended: ${question.recommended}. Why: ${question.why}`, 200),
    ],
  }));
  return { ...rest, kind: "answer_question", question: plainLine(`Design questions for "${designTitle}" (${String(questions.length)})`, 160), index: 1, of: 1, batch: { count: questions.length }, details };
}
