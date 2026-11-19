import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
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
 * The Merge section (owner DEC 254zzz94; L4-TA5 kept the GitHub links). Rovara asks Code, as the person, whether they may merge this task and whether it would merge now (Code re-reads GitHub: Rovara's checks
 * green, the pull request open at the head Rovara checked, and GitHub saying it can merge). A person who may merge sees a Merge button, enabled only when Code says ready; pressing asks once, then sends one
 * request with one request id (a repeat of the same press is the same merge). Code decides every rule and every refusal is Code's fixed words. Each open pull request keeps its "Open on GitHub" link, and
 * anyone else (or a Code without the route) merges there.
 */
export function MergeSection({ sessionId, task }: { sessionId: string; task: ReadTask }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]);
 const items = task.mergeTracking ?? [], merged = mergedEverywhere(task), merge = task.merge;
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const sending = useRef(false), requestId = useRef<string | undefined>(undefined);
 const links = openPullRequestsOf(task).flatMap(pull => {
  const url = pull.url === undefined || !isGithubUrl(pull.url) ? undefined : safeExternalUrl(pull.url);
  return [{ key: pull.repository + "#" + String(pull.number), label: pull.repository + " #" + String(pull.number), url }];
 });
 const readinessKey = ["session", sessionId, "merge"];
 // Only while something is open to merge; a refusal of the read (a Code without the route, a session gone) leaves the GitHub links only.
 const readiness = useQuery({ queryKey: readinessKey, enabled: !merged && done === undefined && links.length > 0, retry: false, refetchOnWindowFocus: false, queryFn: async () => api.mergeReadiness(sessionId) });
 const view = readiness.data, mayPress = view?.mayMerge === true && !merged && done === undefined;
 async function press() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   requestId.current ??= crypto.randomUUID();
   const result = await api.merge(sessionId, requestId.current);
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   setOpen(false);setDone("Merged " + result.value.pullRequests.map(pull => pull.repositoryId + " #" + String(pull.number)).join(", ") + ".");requestId.current = undefined;
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) {
   // A refused press sends a fresh request the next time; the readiness is read again so the button shows what Code says now.
   requestId.current = undefined;
   setError(failure instanceof ApiError ? failure.message : "Couldn't press Merge. Try again.");setOpen(false);
   void query.invalidateQueries({ queryKey: readinessKey });
  } finally { sending.current = false;setBusy(false); }
 }
 const state = merged || done !== undefined ? <strong>Merged</strong>
  : view?.mayMerge === true ? (view.ready ? <strong>Ready to merge</strong> : <><strong>Not ready to merge.</strong> <VisibleText text={view.message ?? ""} /></>)
   : merge === undefined ? <strong>Merge it on GitHub</strong> : merge.ready ? <><strong>Ready to merge</strong> on GitHub</> : <><strong>Not ready to merge.</strong> <VisibleText text={merge.message ?? ""} /></>;
 return <section aria-label="Merge" className="rv-merge">
  <p className="rv-merge-state">{state}</p>
  {merge?.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(merge.risk)]}</strong></p>{merge.risk.reasons.length > 0 && <ul>{merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {done && <p role="status"><VisibleText text={done} /></p>}
  {items.length > 0 && <ul className="rv-merge-items" aria-label="Pull requests to merge">{items.map(item => <li key={item.repositoryId + "#" + String(item.number)}><span><VisibleText text={item.repositoryId + " #" + String(item.number)} /></span> <span>{item.state === "merged" ? "Merged" : item.state === "closed" ? "Closed" : item.draft ? "Draft" : checksWords(item) + ". " + reviewWords(item) + ". Head " + item.headSha.slice(0, 7) + ". " + (BRANCH_WORDS[item.branch] ?? "Branch not read yet")}{item.state === "open" && item.draft ? "" : "."}</span></li>)}</ul>}
  {mayPress && <Dialog title="Press Merge?" description="Rovara asks GitHub to merge it now, with the project's merge method. GitHub's branch rules, required reviews and required checks still apply." open={open} onOpenChange={value => { if (!busy) { if (value) requestId.current = crypto.randomUUID();setOpen(value); } }}
   trigger={<Button variant="primary" disabled={view.ready !== true}>Merge</Button>}>
   <ul className="rv-merge-items">{view.pullRequests.map(pull => <li key={pull.repositoryId + "#" + String(pull.number)}><VisibleText text={pull.repositoryId + " #" + String(pull.number)} /></li>)}</ul>
   <div className="rv-actions"><Button disabled={busy} onClick={() => setOpen(false)}>Not now</Button><Button variant="primary" busy={busy} onClick={() => { void press(); }}>Press Merge</Button></div>
  </Dialog>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {!merged && done === undefined && links.length > 0 && <ul className="rv-merge-links" aria-label="Open on GitHub">{links.map(link => <li key={link.key}>{link.url === undefined ? <span><VisibleText text={link.label} /></span> : <a href={link.url} target="_blank" rel="noopener noreferrer">Open on GitHub: <VisibleText text={link.label} /></a>}</li>)}</ul>}
 </section>;
}
