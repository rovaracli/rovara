import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "../../api/work.js";
import { safeExternalUrl } from "../../text/links.js";

/** The task's pull request: its repository and number, open or merged, and the link to GitHub when Code sent one. */
export function PullRequestCard({ pullRequest }: { pullRequest: ReadTask["pullRequests"][number] }) {
 const merged = pullRequest.state === "merged", url = pullRequest.url === undefined ? undefined : safeExternalUrl(pullRequest.url);
 return <section aria-label="Pull request" className="rv-card rv-pr-card">
  <div className="rv-pr-row"><b>{pullRequest.repository === undefined ? "Pull request" : <VisibleText text={pullRequest.repository} />}{pullRequest.number === undefined ? "" : " #" + String(pullRequest.number)}</b>
   <span className="rv-pr-state">{merged ? <StatusPill tone="ok" label="Merged" /> : pullRequest.state === "closed" ? <StatusPill tone="idle" label="Closed" /> : <StatusPill tone="wait" label="Open" />}{url !== undefined && <a href={url} target="_blank" rel="noreferrer noopener">View on GitHub<span className="rv-visually-hidden"> (opens a new tab)</span></a>}</span></div>
 </section>;
}
