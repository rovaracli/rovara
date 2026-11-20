import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createSessionActions, type MergeReadiness } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import type { ReadTask } from "./workspace-types.js";
import { branchFact, changedSince, checksFact, lockOf, pullRowsOf, reviewFact, shortSha, shownOf, type PullRow, type Shown } from "./merge-facts.js";
import { Clock, Facts, MergeChip, Sha, ThreeParts } from "./merge-parts.js";
import { nextStamp, useLatestTaskReadStamp } from "./merge-stamp.js";
import { allMerged, clearPending, headsMoved, readPendingNow, usePending, writePending, type PendingPress } from "./merge-pending.js";

const RISK_WORDS = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
/** The level the server named; a level this build does not know is treated as medium (more careful than low). */
const levelOf = (risk: { level: string }): "low" | "medium" | "high" => (risk.level === "low" || risk.level === "high" ? risk.level : "medium");
const mergedEverywhere = (task: ReadTask): boolean => task.workflow?.stage === "MERGED" || ((task.mergeTracking?.length ?? 0) > 0 && task.mergeTracking!.every(item => item.state === "merged"));
/** The task's pull requests that are still open, with the GitHub link Code sent (only a github.com link is ever shown as one). */
export const openPullRequestsOf = (task: ReadTask) => (task.pullRequests ?? []).filter(pull => pull.state === "open");
/** Whether the Merge section has anything to show: a merge view Code sent, or a pull request still open. */
export const hasMergeSection = (task: ReadTask): boolean => task.merge !== undefined || openPullRequestsOf(task).length > 0;

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
  ...(row.githubHead === undefined ? [] : [{ label: "Head in Rovara's latest read", value: row.drift ? <><Sha value={row.githubHead} /> · different from the checked head</> : <><Sha value={row.githubHead} /> · same as checked</>, tone: row.drift ? "wait" as const : "ok" as const }]),
  { label: "Tracked from GitHub", value: <RelativeTime at={item.observedAt} /> },
 ];
 const merged = item !== undefined && item.state === "merged" ? [{ label: "Head", value: <Sha value={item.headSha} /> }, { label: "Tracked from GitHub", value: <RelativeTime at={item.observedAt} /> }] : undefined;
 return <li className="rv-merge-pr" data-state={row.state}>
  <div className="rv-merge-pr-head">{many && <span className="rv-merge-order" aria-hidden="true">{index + 1}</span>}<h3><VisibleText text={row.label} /></h3><MergeChip tone={chip.tone}>{chip.words}</MergeChip>
   {row.state === "open" && (url === undefined ? null : <a className="rv-merge-link" href={url} target="_blank" rel="noopener noreferrer">Open on GitHub: <VisibleText text={row.label} /></a>)}
   {row.state === "open" && url === undefined && <span className="rv-merge-muted"><VisibleText text={"Open on GitHub: " + row.label} /></span>}</div>
  {row.drift && <p>Rovara's latest read shows a different head than the one checked. Every result shown is kept for reference and doesn't count for the new head.</p>}
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
 * tab and Back until GitHub shows the pull requests merged, a tracking read taken after the press shows a different head, or Code answers the original press with a definitive refusal. Nothing re-sends it: "Check again" only
 * RE-READS (readiness and the task), because Code replays only a stored success and an unanswered id could cause a second provider merge (retry waits for the R1a journal); (3) a pull request GitHub shows merged is an
 * observation ("Merged on GitHub"), and only this page's own accepted answer says "Merged ... on your request", and that line yields to any later task read that disagrees; (4) every piece of state belongs to one session id
 * and resets when it changes; (5) a failed or refused readiness read makes older "ready" data inert; (6) times are labelled for what they are: the tracking observation time, or "Read by Rovara at" for the answer's arrival.
 * The receipt reader and original-operation adoption are held (MergeReceiptView is the unmounted presentation).
 */
export function MergeSection(props: { sessionId: string; task: ReadTask }) {
 // One subject, one state: a different session id remounts, so one task's lock, dialog or notes can never show on another.
 return <MergeSectionFor key={props.sessionId} {...props} />;
}

/**
 * Only refusals raised BEFORE any provider dispatch mean "nothing more will happen for this request" (R6a): task visibility 404 (`hosted-merge-routes.ts` 114, 116), malformed body 400 CONFIG_INVALID (163), stored-result
 * identity conflict 409 IDEMPOTENCY_CONFLICT (168-173), website/standing 403 FORBIDDEN (230, 240), and Cloud's own malformed or missing session (`merge-routes.ts` 110-122). 409 MERGE_NOT_READY is NOT final: the merge core
 * returns it AFTER a provider call too (`merge.ts` 928-955, a provider refusal or a half merge), and nothing in the answer tells the two apart. Everything else (408, 429, 401, any other 4xx, every 5xx, 202, an unreadable
 * body, a network failure) is UNKNOWN and keeps the lock. A distinct pre-dispatch code from Code would let the page release faster (held).
 */
const FINAL_REFUSALS: ReadonlyArray<readonly [number, string]> = [[409, "IDEMPOTENCY_CONFLICT"], [403, "FORBIDDEN"], [404, "TASK_NOT_FOUND"], [404, "SESSION_NOT_FOUND"], [400, "CONFIG_INVALID"]];
const refused = (failure: unknown): boolean => failure instanceof ApiError && FINAL_REFUSALS.some(([status, code]) => failure.status === status && failure.code === code);
/** The saved answer to this page's own press: the pull requests the server returned, the request it answered, and the issue stamp taken when the answer arrived (a read issued after it can disagree). */
interface Saved { words: string; keys: string[]; requestId: string; stamp: number }
const doneWords = (pulls: ReadonlyArray<{ repositoryId: string; number: number }>): string => "Merged " + pulls.map(pull => pull.repositoryId + " #" + String(pull.number)).join(", ") + ".";

function MergeSectionFor({ sessionId, task }: { sessionId: string; task: ReadTask }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), reasonId = useId();
 const merged = mergedEverywhere(task), merge = task.merge;
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<Saved>(), [note, setNote] = useState<string>(), [retiredNote, setRetiredNote] = useState(false);
 const [shown, setShown] = useState<Shown>();
 const sending = useRef(false);
 const open_ = openPullRequestsOf(task);
 const readinessKey = ["session", sessionId, "merge"];
 // Read order is by ISSUE stamp (R6b). The task read belongs to the session screen: the stamp of the latest completed read is paired with the task value that arrives with it; data of unknown order counts as old.
 const latestRead = useLatestTaskReadStamp(sessionId), [stamped, setStamped] = useState({ task, stamp: 0 });
 if (stamped.task !== task) setStamped({ task, stamp: latestRead });
 const taskStamp = stamped.task === task ? stamped.stamp : latestRead;
 // A saved answer yields, for good, to a task read issued AFTER the answer arrived that shows one of its pull requests open (R2).
 const disagrees = done !== undefined && taskStamp > done.stamp && pullRowsOf(task, undefined).some(row => done.keys.includes(row.key) && row.state === "open");
 if (disagrees) { setDone(undefined);setRetiredNote(true); }
 const saved = disagrees ? undefined : done;
 // Only while something is open to merge; a refusal of the read (a Code without the route, a session gone) leaves the GitHub links only.
 const readiness = useQuery({ queryKey: readinessKey, enabled: !merged && saved === undefined && open_.length > 0, retry: false, refetchOnWindowFocus: false, queryFn: async () => api.mergeReadiness(sessionId) });
 // React Query keeps the last good answer after a failed refresh. A read that failed makes that answer inert, until a read works again: an earlier "ready" is never actionable.
 const view = readiness.isError ? undefined : readiness.data, rows = pullRowsOf(task, view), mayPress = view?.mayMerge === true && !merged && saved === undefined;
 const stored = usePending(sessionId), entry = stored.kind === "pending" ? stored.entry : undefined;
 // A record resolves only through a read issued after its own press, or through the answer to that same request; another request's answer or an older read settles nothing.
 const voided = entry !== undefined && headsMoved(entry, rows, taskStamp), settled = entry !== undefined && ((merged && taskStamp > entry.stamp) || (saved !== undefined && saved.requestId === entry.requestId) || allMerged(entry, rows, taskStamp));
 const active = entry !== undefined && !voided && !settled ? entry : undefined, staleEntry = active !== undefined && stored.kind === "pending" && stored.stale;
 const storageLock = stored.kind === "unavailable" || stored.kind === "unreadable" ? stored.kind : undefined;
 // A record that a moved head voided is dropped with a visible notice, never silently (derived during render, so it needs no effect to set state).
 const [dropped, setDropped] = useState<string>();
 if (voided && !settled && entry !== undefined && dropped !== entry.requestId) setDropped(entry.requestId);
 useEffect(() => {
  if (entry !== undefined && (voided || settled)) clearPending(entry);
 }, [entry, voided, settled, sessionId]);
 // An unresolved press found on load is read again at once (a GET), so a read issued after it can resolve it.
 const hadRecord = useRef(entry !== undefined);
 useEffect(() => { if (hadRecord.current) void query.invalidateQueries({ queryKey: ["session", sessionId] }); }, [query, sessionId]);
 const lock = lockOf({ unresolved: active !== undefined, ...(storageLock === undefined ? {} : { storage: storageLock }), rows, readiness: view });
 const readFailed = readiness.isError && couldNotRead(readiness.error);
 const moved = rows.some(row => row.drift), stale = open && shown !== undefined && changedSince(shown, rows, view);
 const base = [...new Set(rows.filter(row => row.state === "open").flatMap(row => row.tracked === undefined ? [] : [row.tracked.baseBranch]))];
 const openRows = rows.filter(row => row.state === "open"), mergedRows = rows.filter(row => row.state === "merged");
 const into = base.length === 1 ? " into " + base[0]! : "";
 const what = openRows.length === 1 ? "#" + String(openRows[0]!.number) + into : String(openRows.length) + " pull requests";
 const buttonWords = "Merge " + what;
 /** Why the latest completed readiness read does not allow a press, or undefined when it does. Read from the query cache at the moment of sending, never from what was last rendered. */
 function refusalNow(): string | undefined {
  const latest = query.getQueryState<MergeReadiness>(readinessKey), latestView = latest?.status === "success" ? latest.data : undefined;
  if (latest?.status === "error") return "Rovara's latest read failed, so Merge isn't available. Nothing was sent.";
  if (latestView === undefined) return "Rovara hasn't read the latest state yet. Nothing was sent.";
  if (latestView.mayMerge !== true) return "You can't merge this task now. Nothing was sent.";
  if (latestView.ready !== true) return (latestView.message ?? "It isn't ready to merge now.") + " Nothing was sent.";
  if (shown === undefined || changedSince(shown, rows, latestView)) return "What you were shown has changed on GitHub. Nothing was merged. Read it again.";
  return undefined;
 }
 async function press() {
  if (sending.current || shown === undefined) return;
  // Authority and readiness are checked again at the moment of sending, from the latest read in the query cache (R6c): a denial that has not rendered yet still stops the send.
  const why = refusalNow();
  if (why !== undefined) { setOpen(false);setError(why);return; }
  // Read the saved record fresh, right now: if one exists (this tab, another tab, an earlier visit) or storage cannot be read, no new request id is minted.
  if (readPendingNow(sessionId).kind !== "none") { setOpen(false); return; }
  const next: PendingPress = { v: 1, sessionId, requestId: crypto.randomUUID(), startedAt: new Date().toISOString(), stamp: nextStamp(), heads: shown.heads ?? [], risk: shown.risk, sent: (shown.heads ?? []).map(head => head.repositoryId + " #" + String(head.number) + " at " + shortSha(head.headSha)) };
  // Saved before it is sent. If it cannot be saved, it is not sent: a reload could not be kept from sending a second one.
  if (!writePending(next)) { setOpen(false);setError(STORAGE_WORDS);return; }
  sending.current = true;setBusy(true);setError(undefined);setNote(undefined);
  try {
   const result = await api.merge(sessionId, next.requestId, { expectedHeads: next.heads, risk: next.risk });
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   clearPending(next);setOpen(false);setDone({ words: doneWords(result.value.pullRequests), keys: result.value.pullRequests.map(pull => pull.repositoryId + "#" + String(pull.number)), requestId: next.requestId, stamp: nextStamp() });
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) {
   setOpen(false);
   if (refused(failure)) {
    // Code gave a documented final refusal to this request: nothing more will happen for it. The next press is a new one.
    clearPending(next);setError((failure as ApiError).message);
   }
   else if (failure instanceof ApiError && failure.status === 409 && failure.code === "MERGE_NOT_READY") setNote("Code answered: " + failure.message + " That doesn't say nothing was merged, so Merge stays locked until a read shows what GitHub holds.");
   // Anything else is unknown: the record stays, a lost, throttled, timed-out or unreadable answer does not say what GitHub did.
   void query.invalidateQueries({ queryKey: readinessKey });
  } finally { sending.current = false;setBusy(false); }
 }
 /** The one action while a press is unresolved: READ again (readiness and the task). It never sends the merge: Code replays only a stored success, so an unanswered id could cause a second provider merge. */
 async function checkAgain() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setNote(undefined);setError(undefined);
  try {
   // Refetches the readiness read and the task read; whatever they show decides, the lock only clears through the rules above.
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
   const state = query.getQueryState(readinessKey);
   setNote(state?.status === "error" ? "Rovara couldn't read the current state, so this is still not confirmed." : "Rovara read again" + (state?.dataUpdatedAt ? " at " + new Date(state.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "") + ". Nothing there says this request merged, so it is still not confirmed.");
  } finally { sending.current = false;setBusy(false); }
 }
 // An open confirmation becomes inert, and says why, the instant the latest read drops the authority or what was shown moves (R6c).
 const dialogPulls = view?.pullRequests ?? (shown?.heads ?? []).map(({ repositoryId, number }) => ({ repositoryId, number }));
 const inertWhy = !open ? undefined : readiness.isError ? "Rovara's latest read failed, so Merge isn't available. Nothing was sent." : view === undefined ? "Rovara hasn't read the latest state yet. Nothing was sent." : view.mayMerge !== true ? "You can't merge this task now. Nothing was sent." : view.ready !== true ? (view.message ?? "It isn't ready to merge now.") + " Nothing was sent." : stale ? "What you were shown has changed on GitHub. Nothing was merged. Close this and read it again." : lock !== undefined ? lock.words : undefined;
 const everyMerged = merged || saved !== undefined;
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
  merged: saved !== undefined ? "You pressed Merge and GitHub accepted it. " + NOT_INCLUDED : "GitHub shows every pull request merged. Rovara read this from GitHub; it doesn't say who pressed Merge. " + NOT_INCLUDED,
  storage: stored.kind === "unreadable" ? "A merge request saved in this browser can't be read, so Rovara can't tell whether one is unresolved. Merge it on GitHub." : "This browser's storage can't be read, so Rovara can't be sure an earlier merge wasn't sent. Merge it on GitHub, or allow site storage for Rovara and reload.",
  partial: "Merged on GitHub: " + mergedRows.map(row => row.label).join(", ") + ". Still open: " + openRows.map(row => row.label).join(", ") + ". Rovara read this from GitHub; it doesn't say who merged what. " + NOT_INCLUDED,
  changed: "Rovara's latest read shows a different head than the one every check and review below covered. Merge stays locked until Rovara has checked the new head.",
  read_failed: "That is not a pass and not a failure. Merge stays locked until Rovara can read it.",
  ready: "Everything required is in for the head Rovara has checked.",
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
   {kind === "ready" && readAt !== undefined && <p className="rv-merge-muted">Read by Rovara at <Clock at={readAt} />.</p>}</header>
  {kind === "unknown" && active !== undefined && <ThreeParts
   happened={<>Your merge{active.sent.length > 0 ? " of " + active.sent.join(", ") : ""} was sent at <Clock at={active.startedAt} /> and no reply was seen.</>}
   safe={<>Rovara keeps this request in this browser, so a reload or another tab won't send a second one, and nothing here sends it again. {active.sent.length > 0 ? "If GitHub did merge, it merged exactly what you authorized. " : ""}Nothing was deployed.</>}
   next={<>Check again only reads: it never sends the merge again. To merge now, use GitHub.{staleEntry ? " This request is more than a day old: check on GitHub first." : ""} <span className="rv-merge-muted">Ref MERGE-RESULT-UNKNOWN</span></>} />}
  {kind === "unknown" && readiness.isError && <p role="status" className="rv-merge-muted"><VisibleText text={"The latest read failed: " + (readiness.error instanceof ApiError ? readiness.error.message : "Rovara couldn't read it just now.") + " Merge stays locked."} /></p>}
  {kind === "unknown" && active !== undefined && <div className="rv-merge-actions"><Button busy={busy} onClick={() => { void checkAgain(); }}>Check again</Button></div>}
  {kind === "read_failed" && <div className="rv-merge-actions"><Button busy={readiness.isFetching} onClick={() => { void readiness.refetch(); }}>Read again</Button></div>}
  {dropped !== undefined && active === undefined && note === undefined && <p role="status" className="rv-merge-muted">The earlier merge request was dropped because the pull request has a new head. It can't be replayed against it.</p>}
  {note && <p role="status" className="rv-merge-muted"><VisibleText text={note} /></p>}
  {merge?.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(merge.risk)]}</strong></p>{merge.risk.reasons.length > 0 && <ul>{merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {saved && <p role="status" className="rv-merge-receipt-line"><VisibleText text={saved.words} /></p>}
  {retiredNote && <p role="status" className="rv-merge-muted">A later read shows a pull request open again, so the earlier answer no longer applies.</p>}
  {rows.length > 0 && <ol className="rv-merge-prs" aria-label="Pull requests to merge">{rows.map((row, index) => <PullItem key={row.key} row={row} ready={rowReady} held={active !== undefined} many={rows.length > 1} index={index} />)}</ol>}
  {kind === "ready" && lock === undefined && <div className="rv-merge-authorize"><p><strong>You authorize</strong> {openRows.map(row => row.githubHead ?? row.checkedHead).filter(head => head !== undefined).length > 0 ? "merging " + openRows.map(row => { const head = row.githubHead ?? row.checkedHead; return head === undefined ? row.label : "head " + shortSha(head) + " of " + row.label; }).join(", ") + into + "." : "merging the open pull request" + (openRows.length === 1 ? "" : "s") + into + "."}</p><p className="rv-merge-muted">Not included: deploying. If the head changes before GitHub merges, nothing is merged and you are asked again.</p></div>}
  {(mayPress || open) && <div className="rv-merge-actions"><Dialog title={"Merge " + what + "?"} description="Rovara asks GitHub to merge it now, with the project's merge method. GitHub's branch rules, required reviews and required checks still apply." open={open} onOpenChange={value => { if (busy) return; if (value) setShown(shownOf(rows, view)); setOpen(value); }}
   trigger={<Button variant="primary" disabled={lock !== undefined} aria-describedby={lock === undefined ? undefined : reasonId}>{buttonWords}</Button>}>
   <ol className="rv-merge-items">{dialogPulls.map(pull => { const head = shown?.heads?.find(candidate => candidate.repositoryId === pull.repositoryId && candidate.number === pull.number); return <li key={pull.repositoryId + "#" + String(pull.number)}><VisibleText text={pull.repositoryId + " #" + String(pull.number)} />{head === undefined ? null : <> at <Sha value={head.headSha} /></>}</li>; })}</ol>
   {dialogPulls.length > 1 && <p className="rv-merge-muted">Rovara merges them one at a time, in the order listed. If one is refused, the ones after it are not tried and the ones already merged stay merged.</p>}
   {inertWhy !== undefined && <p role="alert" className="rv-merge-stale"><VisibleText text={inertWhy} /></p>}
   <div className="rv-actions"><Button disabled={busy} onClick={() => setOpen(false)}>Not now</Button><Button variant="primary" busy={busy} disabled={inertWhy !== undefined} onClick={() => { void press(); }}>Press Merge</Button></div>
  </Dialog>
   {lock !== undefined && <p id={reasonId} className="rv-merge-muted"><VisibleText text={lock.words} /></p>}
   {lock?.kind === "drift" && <Button busy={readiness.isFetching} onClick={() => { void readiness.refetch(); }}>Read again</Button>}</div>}
  {error && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}
