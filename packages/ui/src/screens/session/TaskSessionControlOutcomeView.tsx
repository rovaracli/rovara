import type { ReactNode } from "react";
import { VisibleText } from "../../design/VisibleText.js";

export type TaskSessionControlOutcomeKind = "follow-unconfirmed" | "action-unconfirmed" | "ownership-unavailable";

const OUTCOME_COPY: Record<TaskSessionControlOutcomeKind, string> = {
	"follow-unconfirmed": "Your follow change is not confirmed. It may have applied. Check the current follow status.",
	"action-unconfirmed": "This session action was not confirmed. The session may have changed. Check its current status before acting again.",
	"ownership-unavailable": "Ownership could not be checked. This does not confirm whether takeover applied. Check the current owner.",
};

/** A presentation-only result notice. The parent owns reads, actions and the read-only Check slot. */
export function TaskSessionControlOutcomeView({ kind, check }: { kind: TaskSessionControlOutcomeKind; check?: ReactNode }) {
	return <div className="rv-session-control-outcome">
		<p role="alert"><VisibleText text={OUTCOME_COPY[kind]} /></p>
		{check !== undefined && <div className="rv-actions">{check}</div>}
	</div>;
}
