import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import type { ReadTask } from "./workspace-types.js";

const BRANCH_WORDS: Record<string, string> = { up_to_date: "Branch up to date", behind: "Branch behind its base", conflicted: "Branch conflicts with its base", unknown: "Branch not read yet" };
type Item = NonNullable<ReadTask["mergeTracking"]>[number];

function checksWords(item: Item): string {
 if (item.ci === "passing") return "Checks passing";
 if (item.ci === "failing") return item.failingChecks.length === 0 ? "Checks failing" : "Checks failing: " + item.failingChecks.join(", ");
 if (item.ci === "pending") return "Checks still running";
 return "No checks to wait for";
}
function reviewWords(item: Item): string {
 if (item.review === "approved") return item.approval === undefined ? "Approved" : "Approved by " + item.approval.login;
 if (item.review === "changes_requested") return "A reviewer asked for changes";
 return item.review === "requested" ? "Review requested" : "Not reviewed yet";
}

const RISK_WORDS = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
/** The level the server named; a level this build does not know is treated as medium (more careful than low). */
const levelOf = (risk: { level: string }): "low" | "medium" | "high" => (risk.level === "low" || risk.level === "high" ? risk.level : "medium");
const mergedEverywhere = (task: ReadTask): boolean => task.workflow?.stage === "MERGED" || ((task.mergeTracking?.length ?? 0) > 0 && task.mergeTracking!.every(item => item.state === "merged"));
/** The task's pull requests that are still open, with the GitHub link Code sent (only a github.com link is ever shown as one). */
export const openPullRequestsOf = (task: ReadTask) => (task.pullRequests ?? []).filter(pull => pull.state === "open");
/** Whether the Merge section has anything to show: a merge view Code sent, or a pull request still open. */
export const hasMergeSection = (task: ReadTask): boolean => task.merge !== undefined || openPullRequestsOf(task).length > 0;

/**
 * Merging a task's pull request happens on GitHub (L4-TA5): Cloud has no Merge press (Code's hosted root does not wire the merge core, and the old step-up it needed is gone), so there is NO Merge button
 * here. The section says where the task stands (what merge tracking last read, the risk and whether it looks ready, when Code sent them) and links each open pull request on GitHub.
 */
export function MergeSection({ task }: { task: ReadTask }) {
 const items = task.mergeTracking ?? [], merged = mergedEverywhere(task), merge = task.merge;
 const links = openPullRequestsOf(task).flatMap(pull => {
  const url = pull.url === undefined || !isGithubUrl(pull.url) ? undefined : safeExternalUrl(pull.url);
  return [{ key: pull.repository + "#" + String(pull.number), label: pull.repository + " #" + String(pull.number), url }];
 });
 return <section aria-label="Merge" className="rv-merge">
  <p className="rv-merge-state">{merged ? <strong>Merged</strong> : merge === undefined ? <strong>Merge it on GitHub</strong> : merge.ready ? <><strong>Ready to merge</strong> on GitHub</> : <><strong>Not ready to merge.</strong> <VisibleText text={merge.message ?? ""} /></>}</p>
  {merge?.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(merge.risk)]}</strong></p>{merge.risk.reasons.length > 0 && <ul>{merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {items.length > 0 && <ul className="rv-merge-items" aria-label="Pull requests to merge">{items.map(item => <li key={item.repositoryId + "#" + String(item.number)}><span><VisibleText text={item.repositoryId + " #" + String(item.number)} /></span> <span>{item.state === "merged" ? "Merged" : item.state === "closed" ? "Closed" : item.draft ? "Draft" : checksWords(item) + ". " + reviewWords(item) + ". Head " + item.headSha.slice(0, 7) + ". " + (BRANCH_WORDS[item.branch] ?? "Branch not read yet")}{item.state === "open" && item.draft ? "" : "."}</span></li>)}</ul>}
  {!merged && links.length > 0 && <ul className="rv-merge-links" aria-label="Merge on GitHub">{links.map(link => <li key={link.key}>{link.url === undefined ? <span><VisibleText text={link.label} /></span> : <a href={link.url} target="_blank" rel="noopener noreferrer">Merge on GitHub: <VisibleText text={link.label} /></a>}</li>)}</ul>}
 </section>;
}
