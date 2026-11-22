import { VisibleText } from "../../design/VisibleText.js";

/** Only an explicit not-served answer is evidence that this decision log is unavailable here. */
export function TaskDecisionsUnavailableView() {
 return <p className="rv-muted" role="status" data-testid="task-decisions-unavailable">
  <VisibleText text="Decisions are unavailable on this installation or for this task. This is not confirmation that no decision is needed." />
 </p>;
}
