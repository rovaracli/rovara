import { ApiError } from "../../api/errors.js";
import { VisibleText } from "../../design/VisibleText.js";

/** Inline criterion notice for the one explicit Code response that says spec comments are not served. */
export function PlanCriterionCommentAvailabilityView({ error, conversationHref }: {
 error: unknown;
 /** The caller supplies only the existing, authorized task-conversation destination. */
 conversationHref?: string | undefined;
}) {
 if (!(error instanceof ApiError) || error.status !== 501 || error.code !== "NOT_ON_CODE_YET") return null;
 return <p className="rv-muted" role="status" data-testid="criterion-comment-unavailable">
  <VisibleText text="Comments on the spec are not available on this installation. The plan was not changed." />{" "}
  {conversationHref !== undefined && <a href={conversationHref}>Open the task conversation</a>}
 </p>;
}
