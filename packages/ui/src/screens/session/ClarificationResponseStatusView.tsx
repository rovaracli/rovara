import { VisibleText } from "../../design/VisibleText.js";

export interface ClarificationStatusIdentity {
  companyId: string;
  personId: string;
}

export interface RetainedClarificationAnswers extends ClarificationStatusIdentity {
  round: number;
  answers: readonly string[];
}

/** Read-only status for one submitted Understand round; the owning form retains writes and drafts. */
export function ClarificationResponseStatusView({
  status,
  round,
  identity,
  retained,
  onCheck,
}: {
  status: "pending" | "failed";
  round: number;
  identity: ClarificationStatusIdentity;
  retained?: RetainedClarificationAnswers;
  /** Optional read-only round check supplied by the owning screen when it has an exact reader. */
  onCheck?: () => void;
}) {
  const answersMatch = retained !== undefined
    && retained.round === round
    && retained.companyId === identity.companyId
    && retained.personId === identity.personId;
  const copy = status === "pending"
    ? answersMatch
      ? "Your answers are not confirmed yet. Keep them here and check this question round's current status."
      : "Rovara hasn't confirmed this question round. Keep the round open and check its current status."
    : answersMatch
      ? "Rovara did not confirm your answers. They remain on this page. Check the current question round before submitting again."
      : "Rovara did not confirm your answers. Check the current question round before submitting again.";

  return <section aria-label="Question response status">
    <p role="status" className="rv-answer-note"><VisibleText text={copy} /></p>
    {answersMatch && <ul aria-label="Your retained answers">
      {retained.answers.map((answer, index) => <li key={index}><VisibleText text={answer} /></li>)}
    </ul>}
    {onCheck !== undefined && <button type="button" onClick={onCheck}>Check this question round</button>}
  </section>;
}
