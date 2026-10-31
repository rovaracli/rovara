import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { createSessionApi, acceptSessionRead } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { workspaceTask, type ReadTask } from "./workspace-types.js";

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
/** The level the server named; a level this build does not know is treated as medium (more careful than low, and the server decides the press). */
const levelOf = (risk: { level: string } | undefined): "low" | "medium" | "high" | undefined => (risk === undefined ? undefined : risk.level === "low" || risk.level === "high" ? risk.level : "medium");
const mergedEverywhere = (task: ReadTask | undefined): boolean => task !== undefined && (task.workflow?.stage === "MERGED" || ((task.mergeTracking?.length ?? 0) > 0 && task.mergeTracking!.every(item => item.state === "merged")));

/**
 * Rovara Code's Merge (Plan 6 Task 19, web plan Task 13b; one click since 2026-10-27): what merge tracking last read for each pull request, the risk of the code with its reasons, whether the viewer
 * pressing Merge would be allowed to and, if not, the control plane's words. Pressing asks once (a medium or high risk adds a line to that question), then sends one request that merges at once. A
 * server that still asks for a confirmation on its own page (an older one) is followed as before: nothing says "done" until the server's own view shows every pull request merged.
 */
export function MergeSection({ session, task }: { session: ReadSession; task: ReadTask & { merge: NonNullable<ReadTask["merge"]> } }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), sessions = useMemo(() => createSessionApi(host), [host]);
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>();
 const sending = useRef(false), requestId = useRef<string | undefined>(undefined), key = ["session", session.sessionId];
 // While a press waits for its confirmation the session is read again every few seconds, so the page notices the merge without a reload.
 useQuery({ queryKey: key, enabled: pending !== undefined, refetchInterval: 4000, queryFn: async () => acceptSessionRead(query.getQueryData<ReadSession>(key), await sessions.read(session.sessionId)) });
 const items = task.mergeTracking ?? [], merged = mergedEverywhere(task), mayPress = session.you.level !== "view" || session.you.mayMerge === true;
 const unmerged = items.filter(item => item.state !== "merged");
 async function press() {
  if (sending.current || pending !== undefined) return;
  sending.current = true;setBusy(true);setError(undefined);
  try {
   requestId.current ??= crypto.randomUUID();
   const result = await api.merge(session.sessionId, requestId.current, levelOf(task.merge.risk));
   if (result.kind === "done") {
    setOpen(false);setDone("Merged " + result.value.pullRequests.map(pull => pull.repositoryId + " #" + String(pull.number)).join(", ") + ".");requestId.current = undefined;
    await query.invalidateQueries({ queryKey: key });
    return;
   }
   if (result.kind !== "needs_confirmation") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   setOpen(false);setPending(result);
  } catch (failure) {
   // A refused press (the exact words of MERGE_NOT_READY) sends a fresh request the next time.
   requestId.current = undefined;
   setError(failure instanceof ApiError ? failure.message : "Couldn't press Merge. Try again.");setOpen(false);
  } finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label="Merge" className="rv-merge">
  <p className="rv-merge-state">{merged ? <strong>Merged</strong> : merge(task) ? <strong>Ready to merge</strong> : <><strong>Not ready to merge.</strong> <VisibleText text={task.merge.message ?? ""} /></>}</p>
  {task.merge.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(task.merge.risk)!]}</strong></p>{task.merge.risk.reasons.length > 0 && <ul>{task.merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {done && <p role="status"><VisibleText text={done} /></p>}
  {items.length > 0 && <ul className="rv-merge-items" aria-label="Pull requests to merge">{items.map(item => <li key={item.repositoryId + "#" + String(item.number)}><span><VisibleText text={item.repositoryId + " #" + String(item.number)} /></span> <span>{item.state === "merged" ? "Merged" : item.state === "closed" ? "Closed" : item.draft ? "Draft" : checksWords(item) + ". " + reviewWords(item) + ". Head " + item.headSha.slice(0, 7) + ". " + (BRANCH_WORDS[item.branch] ?? "Branch not read yet")}{item.state === "open" && item.draft ? "" : "."}</span></li>)}</ul>}
  {mayPress && !merged && done === undefined && <Dialog title="Press Merge?" description="Rovara merges it now, with the project's merge method." open={open} onOpenChange={value => { if (!busy) { if (value) requestId.current = crypto.randomUUID();setOpen(value); } }}
   trigger={<Button variant="primary" disabled={!task.merge.ready || pending !== undefined}>Merge</Button>}>
   <ul className="rv-merge-items">{unmerged.map(item => <li key={item.repositoryId + "#" + String(item.number)}><VisibleText text={item.repositoryId + " #" + String(item.number)} /></li>)}</ul>
   {task.merge.risk && levelOf(task.merge.risk) !== "low" && <p role="note"><strong>{RISK_WORDS[levelOf(task.merge.risk)!]}.</strong> <VisibleText text={task.merge.risk.reasons.join(" ")} /> {levelOf(task.merge.risk) === "high" ? "You will confirm on the next page, after signing in again." : "Merge anyway?"}</p>}
   <div className="rv-actions"><Button disabled={busy} onClick={() => setOpen(false)}>Not now</Button><Button variant="primary" busy={busy} onClick={() => { void press(); }}>Press Merge</Button></div>
  </Dialog>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
  {pending && <ConfirmInBrowser<ReadSession> result={pending} subjectKey={key} isApplied={view => mergedEverywhere(workspaceTask(view))} onApplied={() => { setPending(undefined);requestId.current = undefined; }} />}
 </section>;
}
const merge = (task: { merge?: { ready: boolean } | undefined }): boolean => task.merge?.ready === true;
