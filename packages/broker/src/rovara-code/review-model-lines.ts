// Trust fix A2: what a person reads about the model that reviewed the code, in the task's message and the pull request's Reviews section. The model is the one the review report records (the
// worker names the model its reviewer sessions ran on); the note says so when review used the build's own model. A model name is a report's text, so each line passes through the caller's
// inert helper before it is shown.
import { redactText, type WorkflowSnapshot } from "@agentx/contracts";

/** Said when the project (or the account) offered no model but the build's for the review. */
export const REVIEW_SAME_MODEL_NOTE = "Review used the same model as Build. Enable another model for an independent review.";

const ROLE_WORD = { CRITIC: "code review", SECURITY: "security review" } as const;
const MODEL_MAX = 80;

const modelName = (review: { provider: string; version: string }): string => redactText(`${review.provider}/${review.version}`).replace(/\s+/gu, " ").trim().slice(0, MODEL_MAX);

/**
 * The lines about the reviewer model for the current code of a Rovara Code (version 2) task: one line naming the model of each review, and the same-model note when a review of this code
 * used the build's model. Nothing for a version 1 task, or before any review of the current code. Each line is for the caller to make inert (`inertLine` for GitHub, `cleanLine` for Slack).
 */
export function reviewModelLines(workflow: Pick<WorkflowSnapshot, "definitionVersion" | "candidate" | "reviews">): string[] {
  if (workflow.definitionVersion !== "1.1.0") return [];
  const current = (workflow.reviews ?? []).filter((review) => workflow.candidate === undefined || review.candidateDigest === workflow.candidate.digest);
  if (current.length === 0) return [];
  const ordered = (["CRITIC", "SECURITY"] as const).flatMap((role) => current.filter((review) => review.role === role));
  const names = new Set(ordered.map(modelName));
  const line = names.size === 1 ? `Reviewed by ${[...names][0]!}` : `Reviewed by ${ordered.map((review) => `${ROLE_WORD[review.role]}: ${modelName(review)}`).join("; ")}`;
  return [line, ...(current.some((review) => review.sameModelAsBuild === true) ? [REVIEW_SAME_MODEL_NOTE] : [])];
}
