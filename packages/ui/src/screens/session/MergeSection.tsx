import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import type { ReadTask } from "./workspace-types.js";
import { branchFact, changedSince, checksFact, lockOf, pullRowsOf, reviewFact, shortSha, shownOf, type PullRow, type Shown } from "./merge-facts.js";
import { Clock, Facts, MergeChip, Sha, ThreeParts } from "./merge-parts.js";
import { allMerged, bodyOf, clearPending, headsMoved, readPendingNow, usePending, writePending, type PendingPress } from "./merge-pending.js";

const RISK_WORDS = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
/** The level the server named; a level this build does not know is treated as medium (more careful than low). */
const levelOf = (risk: { level: string }): "low" | "medium" | "high" => (risk.level === "low" || risk.level === "high" ? risk.level : "medium");
const mergedEverywhere = (task: ReadTask): boolean => task.workflow?.stage === "MERGED" || ((task.mergeTracking?.length ?? 0) > 0 && task.mergeTracking!.every(item => item.state === "merged"));
/** The task's pull requests that are still open, with the GitHub link Code sent (only a github.com link is ever shown as one). */
export const openPullRequestsOf = (task: ReadTask) => (task.pullRequests ?? []).filter(pull => pull.state === "open");
/** Whether the Merge section has anything to show: a merge view Code sent, or a pull request still open. */
export const hasMergeSection = (task: ReadTask): boolean => task.merge !== undefined || openPullRequestsOf(task).length > 0;

/** Code answers a repeat of a request that is still being made with this fixed sentence (hosted-merge-routes.ts HOSTED_MERGE_WORDS.inProgress, under MERGE_NOT_READY). It is not an answer about the earlier request. */
const IN_PROGRESS = "A merge of this task is already being made.";
const STORAGE_WORDS = "Rovara couldn't save this merge request in this browser, so it wasn't sent. Allow site storage for Rovara and reload, or merge it on GitHub.";

const NOT_INCLUDED = "Merging puts the code in main. It doesn't deploy it.";

/** A read that did not answer (network, throttle, server fault) is "could not read", not "not allowed": only the route being absent or refused leaves the plain GitHub links. */
const couldNotRead = (error: unknown): boolean => error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

function rowChip(row: PullRow, ready: boolean | undefined, held: boolean): { tone: "ok" | "wait" | "bad" | "idle" | "run"; words: string } {
 if (row.state === "merged") return { tone: "ok", words: "Merged on GitHub" };
 if (row.state === "closed") return { tone: "idle", words: "Closed" };
 if (row.state === "unknown") return { tone: "idle", words: "State not read yet" };
 const item = row.tracked;
 if (item === undefined) return { tone: "idle", words: "Open" };
 if (item.draft) return { tone: "idle", words: "Draft" };
 if (held) return { tone: "wait", words: "Result unknown" };
 if (row.drift) return { tone: "wait", words: "Head changed" };
 if (item.ci === "failing" || item.review === "changes_requested" || item.branch === "conflicted") return { tone: "bad", words: "Blocked" };
 if (item.ci === "pending") return { tone: "run", words: "Checking" };
 return ready === true ? { tone: "ok", words: "Ready" } : { tone: "wait", words: "Not ready" };
}

function PullItem({ row, ready, held, many, index }: { row: PullRow; ready: boolean | undefined; held: boolean; many: boolean; index: number }) {
 const url = row.url === undefined || !isGithubUrl(row.url) ? undefined : safeExternalUrl(row.url), chip = rowChip(row, ready, held), item = row.tracked;
 const detail = item === undefined || item.state !== "open" || item.draft ? undefined : [
  { label: "Checks", value: checksFact(item).words, tone: checksFact(item).tone },
  { label: "Review", value: reviewFact(item).words, tone: reviewFact(item).tone },
  { label: "Branch", value: branchFact(item).words, tone: branchFact(item).tone },
  { label: "Checked head", value: <><Sha value={item.headSha} /> · every check and review shown ran on this</> },
  ...(row.githubHead === undefined ? [] : [{ label: "Head on GitHub", value: row.drift ? <><Sha value={row.githubHead} /> · different from the checked head · looked just now</> : <><Sha value={row.githubHead} /> · same as checked · looked just now</>, tone: row.drift ? "wait" as const : "ok" as const }]),
  { label: "GitHub read", value: <RelativeTime at={item.observedAt} /> },
 ];
 const merged = item !== undefined && item.state === "merged" ? [{ label: "Head", value: <Sha value={item.headSha} /> }, { label: "GitHub read", value: <RelativeTime at={item.observedAt} /> }] : undefined;
 return <li className="rv-merge-pr" data-state={row.state}>
  <div className="rv-merge-pr-head">{many && <span className="rv-merge-order" aria-hidden="true">{index + 1}</span>}<h3><VisibleText text={row.label} /></h3><MergeChip tone={chip.tone}>{chip.words}</MergeChip>
   {row.state === "open" && (url === undefined ? null : <a className="rv-merge-link" href={url} target="_blank" rel="noopener noreferrer">Open on GitHub: <VisibleText text={row.label} /></a>)}
   {row.state === "open" && url === undefined && <span className="rv-merge-muted"><VisibleText text={"Open on GitHub: " + row.label} /></span>}</div>
  {row.drift && <p>GitHub has a different head than the one checked. Every result shown is kept for reference and doesn't count for the new head.</p>}
  {(detail ?? merged) && <Facts rows={detail ?? merged!} />}
 </li>;
}

/**
 * The Merge section (owner DEC 254zzz94; L4-TA5 kept the GitHub links; boards 3e-3i, 9a, 12j, 15j in the v5 set). Rovara asks Code, as the person, whether they may merge this task and whether it would merge now (Code re-reads
 * GitHub: Rovara's checks green, the pull request open at the head Rovara checked, and GitHub saying it can merge). A person who may merge sees a Merge button, enabled only when Code says ready AND nothing the person was
 * shown has moved AND the latest read worked; pressing asks once, then sends one request with one request id and the heads shown. Code decides every rule and every refusal is Code's fixed words. Each open pull request keeps
 * its "Open on GitHub" link, and anyone else (or a Code without the route) merges there.
 *
 * Kept deliberately: (1) a head or review digest that changed since it was shown locks Merge and asks for a fresh read; (2) a press is saved in localStorage before it is sent and stays unresolved across reload, a second
 * tab and Back until Code answers that request id, GitHub shows the pull requests merged, or a head moves; the only action is "Check again", which re-sends the SAME request id with the SAME frozen body (Code returns a stored
 * answer, or re-reads GitHub and skips what is merged), and a new request id is never minted while one is unresolved; (3) a pull request GitHub shows merged is an observation ("Merged on GitHub"), and only this page's own
 * accepted answer says "Merged ... on your request"; (4) every piece of state belongs to one session id and resets when it changes; (5) a failed readiness read makes older "ready" data inert. The receipt reader and
 * original-operation adoption are held (MergeReceiptView is the unmounted presentation).
 */
export function MergeSection(props: { sessionId: string; task: ReadTask }) {
 // One subject, one state: a different session id remounts, so one task's lock, dialog or notes can never show on another.
 return <MergeSectionFor key={props.sessionId} {...props} />;
}

type Outcome = "refused" | "in_progress" | "unknown";
const outcomeOf = (failure: unknown): Outcome => failure instanceof ApiError && failure.status === 409 && failure.code === "MERGE_NOT_READY" && failure.message.startsWith(IN_PROGRESS) ? "in_progress" : failure instanceof ApiError && failure.status >= 400 && failure.status < 500 ? "refused" : "unknown";
const doneWords = (pulls: ReadonlyArray<{ repositoryId: string; number: number }>): string => "Merged " + pulls.map(pull => pull.repositoryId + " #" + String(pull.number)).join(", ") + ".";

function MergeSectionFor({ sessionId, task }: { sessionId: string; task: ReadTask }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), reasonId = useId();
 const merged = mergedEverywhere(task), merge = task.merge;
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>(), [note, setNote] = useState<string>();
 const [shown, setShown] = useState<Shown>();
 const sending = useRef(false);
 const open_ = openPullRequestsOf(task);
 const readinessKey = ["session", sessionId, "merge"];
 // Only while something is open to merge; a refusal of the read (a Code without the route, a session gone) leaves the GitHub links only.
 const readiness = useQuery({ queryKey: readinessKey, enabled: !merged && done === undefined && open_.length > 0, retry: false, refetchOnWindowFocus: false, queryFn: async () => api.mergeReadiness(sessionId) });
 // React Query keeps the last good answer after a failed refresh. A read that failed makes that answer inert, until a read works again: an earlier "ready" is never actionable.
 const view = readiness.isError ? undefined : readiness.data, rows = pullRowsOf(task, view), mayPress = view?.mayMerge === true && !merged && done === undefined;
 const stored = usePending(sessionId), entry = stored.kind === "pending" ? stored.entry : undefined;
 const voided = entry !== undefined && headsMoved(entry, rows), settled = entry !== undefined && (merged || done !== undefined || allMerged(entry, rows));
 const active = entry !== undefined && !voided && !settled ? entry : undefined, staleEntry = active !== undefined && stored.kind === "pending" && stored.stale;
 const storageLock = stored.kind === "unavailable" || stored.kind === "unreadable" ? stored.kind : undefined;
 // A record that a moved head voided is dropped with a visible notice, never silently (derived during render, so it needs no effect to set state).
 const [dropped, setDropped] = useState<string>();
 if (voided && !settled && entry !== undefined && dropped !== entry.requestId) setDropped(entry.requestId);
 useEffect(() => {
  if (entry !== undefined && (voided || settled)) clearPending(sessionId, entry.requestId);
 }, [entry, voided, settled, sessionId]);
 const lock = lockOf({ unresolved: active !== undefined, ...(storageLock === undefined ? {} : { storage: storageLock }), rows, readiness: view });
 const readFailed = readiness.isError && couldNotRead(readiness.error);
 const moved = rows.some(row => row.drift), stale = open && shown !== undefined && changedSince(shown, rows, view);
 const base = [...new Set(rows.filter(row => row.state === "open").flatMap(row => row.tracked === undefined ? [] : [row.tracked.baseBranch]))];
 const openRows = rows.filter(row => row.state === "open"), mergedRows = rows.filter(row => row.state === "merged");
 const into = base.length === 1 ? " into " + base[0]! : "";
 const what = openRows.length === 1 ? "#" + String(openRows[0]!.number) + into : String(openRows.length) + " pull requests";
 const buttonWords = "Merge " + what;
 async function press() {
  // A press is only ever sent for exactly what the person was shown. Anything that moved since then is read again, never sent.
  if (sending.current || shown === undefined || changedSince(shown, rows, view)) return;
  // Read the saved record fresh, right now: if one exists (this tab, another tab, an earlier visit) or storage cannot be read, no new request id is minted.
  if (readPendingNow(sessionId).kind !== "none") { setOpen(false); return; }
  const next: PendingPress = { v: 1, sessionId, requestId: crypto.randomUUID(), startedAt: new Date().toISOString(), heads: shown.heads ?? [], risk: shown.risk, sent: (shown.heads ?? []).map(head => head.repositoryId + " #" + String(head.number) + " at " + shortSha(head.headSha)) };
  // Saved before it is sent. If it cannot be saved, it is not sent: a reload could not be kept from sending a second one.
  if (!writePending(next)) { clearPending(sessionId, next.requestId);setOpen(false);setError(STORAGE_WORDS);return; }
  sending.current = true;setBusy(true);setError(undefined);setNote(undefined);
  try {
   const result = await api.merge(sessionId, next.requestId, bodyOf(next));
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   clearPending(sessionId, next.requestId);setOpen(false);setDone(doneWords(result.value.pullRequests));
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) {
   setOpen(false);
   if (outcomeOf(failure) !== "unknown") {
    // Code answered no to this request (another person's merge in progress included): it is over and nothing was sent for it. The next press is a new one.
    clearPending(sessionId, next.requestId);setError((failure as ApiError).message);
   }
   // Otherwise the record stays: a lost or unreadable answer does not say what GitHub did.
   void query.invalidateQueries({ queryKey: readinessKey });
  } finally { sending.current = false;setBusy(false); }
 }
 /** The one action while a press is unresolved: the SAME request id with the SAME frozen body. Never a new id, never new heads. */
 async function checkAgain() {
  const now = readPendingNow(sessionId);
  if (sending.current || now.kind !== "pending") return;
  const saved = now.entry;
  sending.current = true;setBusy(true);setNote(undefined);setError(undefined);
  try {
   const fresh = await readiness.refetch();
   if (headsMoved(saved, pullRowsOf(task, fresh.isError ? undefined : fresh.data))) { clearPending(sessionId, saved.requestId);setNote("The earlier merge request was dropped because the pull request has a new head. It can't be replayed against it.");return; }
   const result = await api.merge(sessionId, saved.requestId, bodyOf(saved));
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   clearPending(sessionId, saved.requestId);setDone(doneWords(result.value.pullRequests));
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) {
   const outcome = outcomeOf(failure);
   if (outcome === "refused") { clearPending(sessionId, saved.requestId);setError((failure as ApiError).message);void query.invalidateQueries({ queryKey: readinessKey }); }
   else setNote(outcome === "in_progress" ? "A merge of this task is still being made. Check again in a moment." : "Still not confirmed. Check again in a moment, or look at the pull request on GitHub.");
  } finally { sending.current = false;setBusy(false); }
 }
 const everyMerged = merged || done !== undefined;
 const partial = !everyMerged && mergedRows.length > 0 && openRows.length > 0;
 const kind = everyMerged ? "merged" : active !== undefined ? "unknown" : storageLock !== undefined && mayPress ? "storage" : partial ? "partial" : moved ? "changed" : readFailed ? "read_failed" : view?.mayMerge === true ? (view.ready ? "ready" : "not_ready") : merge === undefined ? "github" : merge.ready ? "github_ready" : "github_not_ready";
 const headline = ({
  merged: <>Merged</>,
  unknown: <>The result isn't confirmed yet</>,
  storage: <>Merge is locked in this browser</>,
  partial: <>{String(mergedRows.length)} of {String(mergedRows.length + openRows.length)} pull requests {mergedRows.length === 1 ? "is" : "are"} merged on GitHub</>,
  changed: <>The pull request changed after it was checked</>,
  read_failed: <>Rovara couldn't read this from GitHub just now</>,
  ready: <>Ready to merge</>,
  not_ready: <>Not ready to merge{view?.message ? "." : ""}</>,
  github: <>Merge it on GitHub</>,
  github_ready: <>Ready to merge on GitHub</>,
  github_not_ready: <>Not ready to merge.</>,
 } as Record<string, ReactNode>)[kind];
 const tone = ({ merged: "ok", ready: "ok", github_ready: "ok", unknown: "wait", storage: "wait", changed: "wait", partial: "wait", read_failed: "wait", not_ready: "wait", github_not_ready: "wait", github: "idle" } as Record<string, "ok" | "wait" | "idle">)[kind]!;
 const chipWords = ({ merged: "Merged", ready: "Ready to merge", github_ready: "Ready to merge", unknown: "Unknown", storage: "Locked", changed: "Locked", partial: "Partly merged", read_failed: "Unknown", not_ready: "Blocked", github_not_ready: "Blocked", github: "Merge on GitHub" } as Record<string, string>)[kind]!;
 const lede = ({
  merged: done !== undefined ? "You pressed Merge and GitHub accepted it. " + NOT_INCLUDED : "GitHub shows every pull request merged. Rovara read this from GitHub; it doesn't say who pressed Merge. " + NOT_INCLUDED,
  storage: stored.kind === "unreadable" ? "A merge request saved in this browser can't be read, so Rovara can't tell whether one is unresolved. Merge it on GitHub." : "This browser's storage can't be read, so Rovara can't be sure an earlier merge wasn't sent. Merge it on GitHub, or allow site storage for Rovara and reload.",
  partial: "Merged on GitHub: " + mergedRows.map(row => row.label).join(", ") + ". Still open: " + openRows.map(row => row.label).join(", ") + ". Rovara read this from GitHub; it doesn't say who merged what. " + NOT_INCLUDED,
  changed: "GitHub now has a different head than the one every check and review below covered. Merge stays locked until Rovara has checked the new head.",
  read_failed: "That is not a pass and not a failure. Merge stays locked until Rovara can read it.",
  ready: "Everything required is in for the head GitHub would merge.",
  not_ready: view?.message,
  github: "You can't merge this here. Open the pull request on GitHub to merge it.",
  github_ready: undefined,
  github_not_ready: merge?.message,
 } as Record<string, string | undefined>)[kind];
 const rowReady = view?.mayMerge === true ? view.ready : merge?.ready;
 const readAt = readiness.dataUpdatedAt > 0 ? new Date(readiness.dataUpdatedAt).toISOString() : undefined;
 return <section aria-label="Merge" className="rv-merge" data-state={kind} aria-busy={readiness.isFetching || undefined}>
  <header className="rv-merge-head"><MergeChip tone={tone}>{chipWords}</MergeChip><h2 className="rv-merge-state">{headline}</h2>
   {lede !== undefined && <p className="rv-merge-lede"><VisibleText text={lede} /></p>}
   {kind === "ready" && readAt !== undefined && <p className="rv-merge-muted">Rovara read GitHub at <Clock at={readAt} />.</p>}</header>
  {kind === "unknown" && active !== undefined && <ThreeParts
   happened={<>Your merge{active.sent.length > 0 ? " of " + active.sent.join(", ") : ""} was sent at <Clock at={active.startedAt} /> and no reply was seen.</>}
   safe={<>Rovara keeps this request in this browser, so a reload or another tab won't send a second one. {active.sent.length > 0 ? "If GitHub did merge, it merged exactly what you authorized. " : ""}Nothing was deployed.</>}
   next={<>Check again asks Rovara once more about this same request, or open the pull request on GitHub.{staleEntry ? " This request is more than a day old: check on GitHub first." : ""} <span className="rv-merge-muted">Ref MERGE-RESULT-UNKNOWN</span></>} />}
  {kind === "unknown" && active !== undefined && <div className="rv-merge-actions"><Button busy={busy} onClick={() => { void checkAgain(); }}>Check again</Button></div>}
  {kind === "read_failed" && <div className="rv-merge-actions"><Button busy={readiness.isFetching} onClick={() => { void readiness.refetch(); }}>Read again</Button></div>}
  {dropped !== undefined && active === undefined && note === undefined && <p role="status" className="rv-merge-muted">The earlier merge request was dropped because the pull request has a new head. It can't be replayed against it.</p>}
  {note && <p role="status" className="rv-merge-muted"><VisibleText text={note} /></p>}
  {merge?.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(merge.risk)]}</strong></p>{merge.risk.reasons.length > 0 && <ul>{merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {done && <p role="status" className="rv-merge-receipt-line"><VisibleText text={done} /></p>}
  {rows.length > 0 && <ol className="rv-merge-prs" aria-label="Pull requests to merge">{rows.map((row, index) => <PullItem key={row.key} row={row} ready={rowReady} held={active !== undefined} many={rows.length > 1} index={index} />)}</ol>}
  {kind === "ready" && lock === undefined && <div className="rv-merge-authorize"><p><strong>You authorize</strong> {openRows.map(row => row.githubHead ?? row.checkedHead).filter(head => head !== undefined).length > 0 ? "merging " + openRows.map(row => { const head = row.githubHead ?? row.checkedHead; return head === undefined ? row.label : "head " + shortSha(head) + " of " + row.label; }).join(", ") + into + "." : "merging the open pull request" + (openRows.length === 1 ? "" : "s") + into + "."}</p><p className="rv-merge-muted">Not included: deploying. If the head changes before GitHub merges, nothing is merged and you are asked again.</p></div>}
  {mayPress && <div className="rv-merge-actions"><Dialog title={"Merge " + what + "?"} description="Rovara asks GitHub to merge it now, with the project's merge method. GitHub's branch rules, required reviews and required checks still apply." open={open} onOpenChange={value => { if (busy) return; if (value) setShown(shownOf(rows, view)); setOpen(value); }}
   trigger={<Button variant="primary" disabled={lock !== undefined} aria-describedby={lock === undefined ? undefined : reasonId}>{buttonWords}</Button>}>
   <ol className="rv-merge-items">{view.pullRequests.map(pull => { const head = shown?.heads?.find(candidate => candidate.repositoryId === pull.repositoryId && candidate.number === pull.number); return <li key={pull.repositoryId + "#" + String(pull.number)}><VisibleText text={pull.repositoryId + " #" + String(pull.number)} />{head === undefined ? null : <> at <Sha value={head.headSha} /></>}</li>; })}</ol>
   {view.pullRequests.length > 1 && <p className="rv-merge-muted">Rovara merges them one at a time, in the order listed. If one is refused, the ones after it are not tried and the ones already merged stay merged.</p>}
   {stale && <p role="alert" className="rv-merge-stale">What you were shown has changed on GitHub. Nothing was merged. Close this and read it again.</p>}
   <div className="rv-actions"><Button disabled={busy} onClick={() => setOpen(false)}>Not now</Button><Button variant="primary" busy={busy} disabled={stale} onClick={() => { void press(); }}>Press Merge</Button></div>
  </Dialog>
   {lock !== undefined && <p id={reasonId} className="rv-merge-muted"><VisibleText text={lock.words} /></p>}
   {lock?.kind === "drift" && <Button busy={readiness.isFetching} onClick={() => { void readiness.refetch(); }}>Read again</Button>}</div>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
