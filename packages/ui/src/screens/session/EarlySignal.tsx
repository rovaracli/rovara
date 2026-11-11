import { EarlyRiskSignalSchema, earlyRiskSignalText } from "@agentx/cloud-contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";

/**
 * The early "PR risk low" score, private to the task's owner: the broker sends it only to the owner, and only when this task's pull request was published with risk low. It always says how many samples it
 * rests on, and "early, few samples" below ten. It is this page's alone: never in a thread, on the shared card or on the pull request.
 */
export function EarlySignal({ task }: { task: ReadTask }) {
 const signal = EarlyRiskSignalSchema.safeParse(task.earlyRiskSignal);
 if (!signal.success) return null;
 return <section className="rv-early-signal" aria-label="Early signal, only you can see this"><p className="rv-muted">Only you can see this.</p><p><VisibleText text={earlyRiskSignalText(signal.data)} /></p></section>;
}
