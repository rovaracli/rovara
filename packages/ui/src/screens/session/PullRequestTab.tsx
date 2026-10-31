import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import { EarlySignal } from "./EarlySignal.js";
import type { ReadTask } from "./workspace-types.js";
const states: Record<string, string> = { open: "Open", closed: "Closed", merged: "Merged" };
export function PullRequestTab({ task }: { task: ReadTask }) {
 // RULING Q34: this summary has repository/number/state, not title or check status.
 return <section aria-label="Pull requests"><EarlySignal task={task} /><ol className="rv-pull-requests">{task.pullRequests?.map(row => <li key={row.repository + ":" + String(row.number)}>{isGithubUrl(row.url) ? <a href={safeExternalUrl(row.url)} target="_blank" rel="noopener noreferrer"><VisibleText text={row.repository + " #" + String(row.number)} /></a> : <span><VisibleText text={row.repository + " #" + String(row.number)} /></span>}<span>{states[row.state] ?? "Status unavailable"}</span></li>)}</ol></section>;
}
