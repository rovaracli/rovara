import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** A task-page view for a failed decisions read. The parent keeps the existing reader and supplies its refetch. */
export function TaskDecisionsReadRecoveryView({ onRetry }: { onRetry: () => void }) {
 return <section className="rv-card rv-decisions" aria-label="Decisions and answers" data-testid="decisions-error">
  <h3>Decisions and answers</h3>
  <div role="alert" className="rv-section-error">
   <p><VisibleText text="The task's decisions could not be loaded. No answer or approval was sent." /></p>
   <Button onClick={onRetry}>Reload decisions</Button>
  </div>
 </section>;
}
