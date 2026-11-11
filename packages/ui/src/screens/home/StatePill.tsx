import type { PlainState } from "../session/task-plain-state.js";
import { VisibleText } from "../../design/VisibleText.js";
/** A plain state as words with a dot: the tone never carries the meaning alone. */
export function StatePill({ state }: { state: PlainState }) {
 return <span className="rv-hv2-state" data-tone={state.tone}><span className="rv-hv2-dot" aria-hidden="true" /><VisibleText text={state.label} /></span>;
}
