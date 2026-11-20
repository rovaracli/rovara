import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../api/client.js";
import { createSessionActions, type MergeReadiness } from "../../api/session-actions.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isGithubUrl, safeExternalUrl } from "../../text/links.js";
import { workspaceTask, type ReadTask } from "./workspace-types.js";
import type { ReadSession } from "./SessionHeader.js";
import { branchFact, changedSince, checksFact, lockOf, pullKey, pullRowsOf, reviewFact, shortSha, shownOf, type PullRow, type Shown } from "./merge-facts.js";
import { Clock, Facts, MergeChip, Sha, ThreeParts } from "./merge-parts.js";
import { fencedRead, fencedReadiness, observeRecord, useFence } from "./merge-fence.js";
import { createSessionApi } from "../../api/sessions.js";
import { clearAccepted, readAcceptedNow, useAccepted, writeAccepted, type AcceptedAnswer, allMerged, clearPending, headsMoved, readPendingNow, usePending, writePending, type PendingPress } from "./merge-pending.js";

const RISK_WORDS = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
/** The level the server named; a level this build does not know is treated as medium (more careful than low). */
const levelOf = (risk: { level: string }): "low" | "medium" | "high" => (risk.level === "low" || risk.level === "high" ? risk.level : "medium");
const mergedEverywhere = (task: ReadTask): boolean => task.workflow?.stage === "MERGED" || ((task.mergeTracking?.length ?? 0) > 0 && task.mergeTracking!.every(item => item.state === "merged"));
/** The task's pull requests that are still open, with the GitHub link Code sent (only a github.com link is ever shown as one). */
export const openPullRequestsOf = (task: ReadTask) => (task.pullRequests ?? []).filter(pull => pull.state === "open");
/** Whether the Merge section has anything to show: a merge view Code sent, or a pull request still open. */
export const hasMergeSection = (task: ReadTask): boolean => task.merge !== undefined || openPullRequestsOf(task).length > 0;

const ACCEPTED_WORDS = "Code has already answered that these are merged, or Merge isn't available right now. Nothing was sent.";
const STORAGE_WORDS = "Rovara couldn't save this merge request in this browser, so it wasn't sent. Allow site storage for Rovara and reload, or merge it on GitHub.";

const NOT_INCLUDED = "Merging puts the code in main. It doesn't deploy it.";

/** A read that did not answer (network, throttle, server fault) is "could not read", not "not allowed": only the route being absent or refused leaves the plain GitHub links. */
const couldNotRead = (error: unknown): boolean => error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

function rowChip(row: PullRow, ready: boolean | undefined, held: boolean, accepted: boolean): { tone: "ok" | "wait" | "bad" | "idle" | "run"; words: string } {
 if (row.state === "merged") return { tone: "ok", words: "Merged on GitHub" };
 if (row.state === "closed") return { tone: "idle", words: "Closed" };
 if (row.state === "unknown") return { tone: "idle", words: "State not read yet" };
 const item = row.tracked;
 if (item === undefined) return { tone: "idle", words: "Open" };
 if (item.draft) return { tone: "idle", words: "Draft" };
 if (held) return { tone: "wait", words: "Result unknown" };
 if (accepted) return { tone: "wait", words: "Merge accepted" };
 if (row.drift) return { tone: "wait", words: "Head changed" };
 if (item.ci === "failing" || item.review === "changes_requested" || item.branch === "conflicted") return { tone: "bad", words: "Blocked" };
 if (item.ci === "pending") return { tone: "run", words: "Checking" };
 return ready === true ? { tone: "ok", words: "Ready" } : { tone: "wait", words: "Not ready" };
}

function PullItem({ row, ready, held, accepted, many, index }: { row: PullRow; ready: boolean | undefined; held: boolean; accepted: boolean; many: boolean; index: number }) {
 const url = row.url === undefined || !isGithubUrl(row.url) ? undefined : safeExternalUrl(row.url), chip = rowChip(row, ready, held, accepted), item = row.tracked;
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
 * The receipt reader and original-operation adoption are held (the receipt presentation is kept on branch held/merge-receipt-view, not mounted).
 */
/** Who is reading (R6g/N5): company + person from /v1/app/me, then the session. */
const subjectFrom = (me: { org: { orgId: string }; developer: { id: string } } | undefined, sessionId: string): string | undefined => me === undefined ? undefined : me.org.orgId + "|" + me.developer.id + "|" + sessionId;
const identityKeyOf = (sessionId: string): readonly string[] => ["session", sessionId, "identity"];
export function MergeSection(props: { sessionId: string; task: ReadTask }) {
 const host = useAppHost(), meApi = useMemo(() => createApiClient(host), [host]);
 const me = useQuery({ queryKey: identityKeyOf(props.sessionId), retry: false, refetchOnWindowFocus: false, queryFn: async () => meApi.get("/v1/app/me", AppMeResponseReaderSchema) });
 const subject = me.isError ? undefined : subjectFrom(me.data, props.sessionId);
 // One subject, one state (N6): a different session OR a different person or company remounts, so no lock, dialog, notice or accepted-answer attribution of one can show on another.
 return <MergeSectionFor key={props.sessionId + "|" + (subject ?? "unread")} {...props} subject={subject} />;
}

/**
 * Only refusals raised BEFORE any provider dispatch mean "nothing more will happen for this request" (R6a): task visibility 404 (`hosted-merge-routes.ts` 114, 116), malformed body 400 CONFIG_INVALID (163), stored-result
 * identity conflict 409 IDEMPOTENCY_CONFLICT (168-173), website/standing 403 FORBIDDEN (230, 240), and Cloud's own malformed or missing session (`merge-routes.ts` 110-122). 409 MERGE_NOT_READY is NOT final: the merge core
 * returns it AFTER a provider call too (`merge.ts` 928-955, a provider refusal or a half merge), and nothing in the answer tells the two apart. Everything else (408, 429, 401, any other 4xx, every 5xx, 202, an unreadable
 * body, a network failure) is UNKNOWN and keeps the lock. A distinct pre-dispatch code from Code would let the page release faster (held).
 */
const FINAL_REFUSALS: ReadonlyArray<readonly [number, string]> = [[409, "IDEMPOTENCY_CONFLICT"], [403, "FORBIDDEN"], [404, "TASK_NOT_FOUND"], [404, "SESSION_NOT_FOUND"]];
/**
 * 400 CONFIG_INVALID is final only for a press that covers ONE pull request. With several, the merge core can raise it after an earlier pull request was already merged (an installation lookup failing for the second
 * repository, `merge.ts` 916-956 with the GitHub client's lookUpInstallation), and Code neither reports that as a half merge nor wakes tracking: a Code-side gap (held). So it stays unknown for a multi-PR press.
 */
const refused = (failure: unknown, pullCount: number): boolean => failure instanceof ApiError && (FINAL_REFUSALS.some(([status, code]) => failure.status === status && failure.code === code) || (pullCount <= 1 && failure.status === 400 && failure.code === "CONFIG_INVALID"));
const recordKey = (entry: { requestId: string; startedAt: string }): string => entry.requestId + "|" + entry.startedAt;
/** The task of a session read, or undefined when the data does not read as a task session (never throws). */
function taskOfSession(data: unknown): ReadTask | undefined { try { return typeof data === "object" && data !== null && "body" in data ? workspaceTask(data as ReadSession) : undefined; } catch { return undefined; } }
const doneWords = (pulls: ReadonlyArray<{ repositoryId: string; number: number }>): string => "Merged " + pulls.map(pull => pull.repositoryId + " #" + String(pull.number)).join(", ") + ".";

function MergeSectionFor({ sessionId, task, subject }: { sessionId: string; task: ReadTask; subject: string | undefined }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), reasonId = useId();
 const merged = mergedEverywhere(task), merge = task.merge;
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [memoryDone, setMemoryDone] = useState<AcceptedAnswer>(), [retiredInfo, setRetiredInfo] = useState<{ id: string; why: "head" | "closed" }>(), [note, setNote] = useState<string>();
 const [shown, setShown] = useState<Shown>();
 const sending = useRef(false);
 const open_ = openPullRequestsOf(task);
 const readinessKey = ["session", sessionId, "merge", subject ?? "unread"], sessionApi = useMemo(() => createSessionApi(host), [host]);
 // The read fence lives in the QueryClient (merge-fence.ts), keyed by company + person + session, so it outlives this component and is never shared between identities. Facts that may resolve anything come ONLY from reads
 // this section makes itself (`readNow`), each stamped with its own response body: never from a prop, the session screen's cache, or a cache write.
 const fence = useFence(subject ?? "unread"), read = fence.taskFailed === undefined ? fence.latestRead : undefined, readTask = useMemo(() => taskOfSession(read?.data), [read]);
 const readRows = useMemo(() => readTask === undefined ? [] : pullRowsOf(readTask, undefined), [readTask]);
 /** Makes the section's own task read. True only if that very call succeeded: a failed or refused read resolves nothing and is recorded in the fence. */
 async function readNow(): Promise<boolean> {
  if (subject === undefined) return false;
  try { await fencedRead(fence, () => sessionApi.read(sessionId));return true; } catch { return false; }
 }
 // A saved answer yields, for good, only to a task read THIS tab issued after the answer arrived that shows one of its pull requests open (R2).
 // The accepted answer is kept per subject in storage (H1): Code's success path does not record the merge at once, it wakes the tracker, so reads right after the answer still show the pull request OPEN at the same head.
 // "Open at the same head" therefore never retires it. It yields only to facts that truly contradict it, in a body-bound read THIS tab issued after it first saw the answer: a DIFFERENT head for a covered pull request
 // (new commits), or the pull request CLOSED without a merge (R2). Until a read shows every covered pull request merged it is "accepted, waiting for Rovara to record it" and Merge stays locked, across reloads and tabs.
 const storedAccepted = useAccepted(subject ?? "\u0000identity-unread"), done = subject === undefined ? undefined : (storedAccepted ?? memoryDone);
 const doneObserved = done === undefined ? undefined : fence.observed.get("acc|" + done.requestId);
 const afterAnswer = done !== undefined && read !== undefined && doneObserved !== undefined && read.issued > doneObserved;
 const contradicts = (row: PullRow): boolean => done !== undefined && done.keys.includes(row.key) && (row.state === "closed" || (row.tracked !== undefined && done.heads.some(head => pullKey(head.repositoryId, head.number) === row.key && head.headSha !== row.tracked!.headSha)));
 const disagrees = afterAnswer && readRows.some(contradicts);
 const recorded = afterAnswer && done.keys.length > 0 && done.keys.every(key => readRows.find(row => row.key === key)?.state === "merged");
 if (disagrees && done !== undefined && retiredInfo?.id !== done.requestId) setRetiredInfo({ id: done.requestId, why: readRows.some(row => contradicts(row) && row.state === "closed") ? "closed" : "head" });
 const retired = done !== undefined && retiredInfo?.id === done.requestId, retiredNote = retiredInfo;
 const saved = retired ? undefined : done;
 // This tab observes an accepted answer the first time it sees it (a reload starts over) and reads again at once; a retired one, or one the page itself shows merged, is removed from storage.
 useEffect(() => { if (done !== undefined && !retired) { observeRecord(fence, "acc|" + done.requestId);void readNow(); } }, [fence, done?.requestId, retired]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(() => { if (done !== undefined && (retired || merged)) clearAccepted(done); }, [done, retired, merged]);
 // While an accepted answer is shown, a real refetch of the ordinary session query is only a TRIGGER: this section then makes its OWN body-bound read (readNow) and the answer yields if that body disagrees. The
 // subscription never reads the event's data, so no cache write and no kept-older projection can supply a fact.
 useEffect(() => {
  if (done === undefined) return;
  return query.getQueryCache().subscribe(event => {
   const key = event.query.queryKey as readonly unknown[];
   if (event.type === "updated" && event.action.type === "success" && event.action.manual !== true && key.length === 2 && key[0] === "session" && key[1] === sessionId) void readNow();
  });
 }, [done, query, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
 // Only while something is open to merge; a refusal of the read (a Code without the route, a session gone) leaves the GitHub links only.
 const readinessOn = subject !== undefined && !merged && saved === undefined && open_.length > 0;
 const readiness = useQuery({ queryKey: readinessKey, enabled: readinessOn, retry: false, refetchOnWindowFocus: false, queryFn: async () => fencedReadiness(fence, () => api.mergeReadiness(sessionId)) });
 // React Query keeps the last good answer after a failed refresh. A read that failed makes that answer inert, until a read works again: an earlier "ready" is never actionable.
 const view = readiness.isError || fence.readinessDenied !== undefined ? undefined : readiness.data, rows = pullRowsOf(task, view), mayPress = view?.mayMerge === true && !merged && saved === undefined;
 const stored = usePending(subject ?? "\u0000identity-unread"), entry = subject !== undefined && stored.kind === "pending" ? stored.entry : undefined;
 // A record resolves only through a task read THIS tab issued after THIS tab first observed it, or through the answer to that same request; another request's answer, an older read or a cache write settles nothing.
 const entryKey = entry === undefined ? undefined : recordKey(entry), observedAt = entryKey === undefined ? undefined : fence.observed.get(entryKey);
 const resolving = read !== undefined && observedAt !== undefined && read.issued > observedAt && readTask !== undefined;
 const voided = entry !== undefined && resolving && headsMoved(entry, readRows), settled = entry !== undefined && ((resolving && (mergedEverywhere(readTask) || allMerged(entry, readRows))) || (saved !== undefined && saved.requestId === entry.requestId));
 const active = entry !== undefined && !voided && !settled ? entry : undefined, staleEntry = active !== undefined && stored.kind === "pending" && stored.stale;
 const storageLock = subject !== undefined && (stored.kind === "unavailable" || stored.kind === "unreadable") ? stored.kind : undefined;
 // A record that a moved head voided is dropped with a visible notice, never silently (derived during render, so it needs no effect to set state).
 const [dropped, setDropped] = useState<string>();
 if (voided && !settled && entry !== undefined && dropped !== entry.requestId) setDropped(entry.requestId);
 useEffect(() => {
  if (entry !== undefined && (voided || settled)) clearPending(entry);
 }, [entry, voided, settled, sessionId]);
 // A refusal found in the fence once the identity is bound (an earlier visit) is read again once: a fresh manual cache write can make the cached answer look fresh, but only a real read clears the refusal.
 const deniedTried = useRef(false);
 useEffect(() => { if (fence.readinessDenied !== undefined && !deniedTried.current && !merged && saved === undefined && open_.length > 0) { deniedTried.current = true;void readiness.refetch(); } });
 // This tab observes a record the first time it sees it (a reload starts over); only reads issued after that can resolve it. The record found (or written) is then read again at once, a GET, so a read issued after the observation exists.
 useEffect(() => { if (entryKey !== undefined) { observeRecord(fence, entryKey);void readNow();void query.invalidateQueries({ queryKey: ["session", sessionId] }); } }, [fence, entryKey, query, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
 const lock = lockOf({ unresolved: active !== undefined, identityUnread: subject === undefined, ...(storageLock === undefined ? {} : { storage: storageLock }), rows, readiness: view });
 const readFailed = readiness.isError && couldNotRead(readiness.error);
 const moved = rows.some(row => row.drift), stale = open && shown !== undefined && changedSince(shown, rows, view);
 const base = [...new Set(rows.filter(row => row.state === "open").flatMap(row => row.tracked === undefined ? [] : [row.tracked.baseBranch]))];
 const openRows = rows.filter(row => row.state === "open"), mergedRows = rows.filter(row => row.state === "merged");
 const into = base.length === 1 ? " into " + base[0]! : "";
 const what = openRows.length === 1 ? "#" + String(openRows[0]!.number) + into : String(openRows.length) + " pull requests";
 const buttonWords = "Merge " + what;
 /** Why the latest completed readiness read does not allow a press, or undefined when it does. Read from the query cache at the moment of sending, never from what was last rendered. */
 function refusalNow(): string | undefined {
  // Identity is read from the query state AT SEND, not from the last render: a failed or changed identity read means nothing is sent (N5).
  const meNow = query.getQueryState<{ org: { orgId: string }; developer: { id: string } }>(identityKeyOf(sessionId)), nowSubject = meNow?.status === "success" ? subjectFrom(meNow.data, sessionId) : undefined;
  if (subject === undefined || nowSubject === undefined) return "Rovara hasn't read who you are yet. Nothing was sent.";
  if (nowSubject !== subject) return "Who you are changed since this page was shown. Nothing was sent. Review it again.";
  // An accepted answer for these pull requests (this tab, another tab, an earlier visit) or a readiness read that is switched off means a cached "ready" is not current: nothing is sent (M2).
  if (readAcceptedNow(subject) !== undefined || memoryDone !== undefined || !readinessOn) return ACCEPTED_WORDS;
  const latest = query.getQueryState<MergeReadiness>(readinessKey), latestView = latest?.status === "success" ? latest.data : undefined;
  if (latest?.status === "error") return "Rovara's latest read failed, so Merge isn't available. Nothing was sent.";
  if (latestView === undefined) return "Rovara hasn't read the latest state yet. Nothing was sent.";
  if (latestView.mayMerge !== true) return "You can't merge this task now. Nothing was sent.";
  if (latestView.ready !== true) return (latestView.message ?? "It isn't ready to merge now.") + " Nothing was sent.";
  if (shown === undefined || changedSince(shown, rows, latestView)) return "What you were shown has changed on GitHub. Nothing was merged. Read it again.";
  return undefined;
 }
 async function press() {
  if (sending.current || shown === undefined || subject === undefined) return;
  // Authority and readiness are checked again at the moment of sending, from the latest read in the query cache (R6c): a denial that has not rendered yet still stops the send.
  const why = refusalNow();
  if (why !== undefined) { setOpen(false);setError(why);return; }
  // Read the saved record fresh, right now: if one exists (this tab, another tab, an earlier visit) or storage cannot be read, no new request id is minted.
  if (readPendingNow(subject).kind !== "none") { setOpen(false); return; }
  const next: PendingPress = { v: 1, sessionId: subject, requestId: crypto.randomUUID(), startedAt: new Date().toISOString(), heads: shown.heads ?? [], risk: shown.risk, sent: (shown.heads ?? []).map(head => head.repositoryId + " #" + String(head.number) + " at " + shortSha(head.headSha)) };
  // Saved before it is sent. If it cannot be saved, it is not sent: a reload could not be kept from sending a second one.
  if (!writePending(next)) { setOpen(false);setError(STORAGE_WORDS);return; }
  observeRecord(fence, recordKey(next));
  sending.current = true;setBusy(true);setError(undefined);setNote(undefined);
  try {
   const result = await api.merge(sessionId, next.requestId, { expectedHeads: next.heads, risk: next.risk });
   if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara answered Merge in an unexpected way. Reload this page.");
   const answer: AcceptedAnswer = { v: 1, subject, requestId: next.requestId, acceptedAt: new Date().toISOString(), words: doneWords(result.value.pullRequests), keys: result.value.pullRequests.map(pull => pull.repositoryId + "#" + String(pull.number)), heads: next.heads };
   // Kept in storage so a reload or another tab cannot offer Merge again for pull requests Code already said are merged; in memory if storage refuses.
   if (!writeAccepted(answer)) setMemoryDone(answer);
   // The accepted answer is saved BEFORE the pending record is released, so there is no instant in which another tab sees neither.
   clearPending(next);setOpen(false);
   observeRecord(fence, "acc|" + answer.requestId);void readNow();
   await query.invalidateQueries({ queryKey: ["session", sessionId] });
  } catch (failure) {
   setOpen(false);
   if (failure instanceof ApiError && failure.status === 403 && (failure.code === "CSRF_INVALID" || failure.code === "CSRF_STALE")) {
    // Cloud's CSRF check (403 CSRF_INVALID, handler.ts:315-316) runs before anything is routed or forwarded, so nothing was sent; it is not a refusal of authority (R6h). Say so plainly and read who you are again.
    clearPending(next);setError("Couldn't merge that. Your sign-in changed, so nothing was sent. Rovara is reading who you are again; try again in a moment.");void query.invalidateQueries({ queryKey: ["session", sessionId, "identity"] });
   } else if (refused(failure, next.heads.length)) {
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
   // What Check says comes from the result of its OWN task read: a failed or refused read says so and changes nothing else; only a read that succeeded is announced as read.
   const [ok] = await Promise.all([readNow(), query.invalidateQueries({ queryKey: ["session", sessionId] })]);
   setNote(ok ? "Rovara read again at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "." : "Rovara couldn't read this just now. Nothing else changed.");
  } finally { sending.current = false;setBusy(false); }
 }
 // An open confirmation becomes inert, and says why, the instant the latest read drops the authority or what was shown moves (R6c).
 const dialogPulls = view?.pullRequests ?? (shown?.heads ?? []).map(({ repositoryId, number }) => ({ repositoryId, number }));
 const inertWhy = !open ? undefined : saved !== undefined ? "Code has already answered that these are merged. Nothing was sent." : readiness.isError ? "Rovara's latest read failed, so Merge isn't available. Nothing was sent." : view === undefined ? "Rovara hasn't read the latest state yet. Nothing was sent." : view.mayMerge !== true ? "You can't merge this task now. Nothing was sent." : view.ready !== true ? (view.message ?? "It isn't ready to merge now.") + " Nothing was sent." : stale ? "What you were shown has changed on GitHub. Nothing was merged. Close this and read it again." : lock !== undefined && !(busy && lock.kind === "unresolved") ? lock.words : undefined;
 const everyMerged = merged || saved !== undefined;
 const partial = !everyMerged && mergedRows.length > 0 && openRows.length > 0;
 const waiting = saved !== undefined && !recorded && !merged;
 const kind = waiting ? "accepted" : everyMerged ? "merged" : active !== undefined ? "unknown" : storageLock !== undefined && mayPress ? "storage" : partial ? "partial" : moved ? "changed" : readFailed ? "read_failed" : view?.mayMerge === true ? (view.ready ? "ready" : "not_ready") : merge === undefined ? "github" : merge.ready ? "github_ready" : "github_not_ready";
 const headline = ({
  merged: <>Merged</>,
  accepted: <>Merge accepted{storedAccepted === undefined && memoryDone !== undefined ? " (this browser couldn't save it)" : ""}</>,
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
 const tone = ({ accepted: "wait", merged: "ok", ready: "ok", github_ready: "ok", unknown: "wait", storage: "wait", changed: "wait", partial: "wait", read_failed: "wait", not_ready: "wait", github_not_ready: "wait", github: "idle" } as Record<string, "ok" | "wait" | "idle">)[kind]!;
 const chipWords = ({ accepted: "Waiting for Rovara", merged: "Merged", ready: "Ready to merge", github_ready: "Ready to merge", unknown: "Unknown", storage: "Locked", changed: "Locked", partial: "Partly merged", read_failed: "Unknown", not_ready: "Blocked", github_not_ready: "Blocked", github: "Merge on GitHub" } as Record<string, string>)[kind]!;
 const lede = ({
  accepted: "Code answered that these are merged, and GitHub reports them merged. Rovara's tracking hasn't recorded it yet, so the pull request below can still show as open. Merge stays locked until it has. " + NOT_INCLUDED,
  merged: saved !== undefined ? "Code answered that these are merged, and GitHub reports them merged. Code's answer doesn't say whether this press or an earlier merge did it. " + NOT_INCLUDED : "GitHub shows every pull request merged. Rovara read this from GitHub; it doesn't say who pressed Merge. " + NOT_INCLUDED,
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
  {kind === "accepted" && <div className="rv-merge-actions"><Button busy={busy} onClick={() => { void checkAgain(); }}>Check again</Button></div>}
  {kind === "read_failed" && <div className="rv-merge-actions"><Button busy={readiness.isFetching} onClick={() => { void readiness.refetch(); }}>Read again</Button></div>}
  {dropped !== undefined && active === undefined && note === undefined && <p role="status" className="rv-merge-muted">The earlier merge request was dropped because the pull request has a new head. It can't be replayed against it.</p>}
  {note && <p role="status" className="rv-merge-muted"><VisibleText text={note} /></p>}
  {merge?.risk && <div className="rv-merge-risk" aria-label="Risk"><p><strong>{RISK_WORDS[levelOf(merge.risk)]}</strong></p>{merge.risk.reasons.length > 0 && <ul>{merge.risk.reasons.map(reason => <li key={reason}><VisibleText text={reason} /></li>)}</ul>}</div>}
  {saved && <p role="status" className="rv-merge-receipt-line"><VisibleText text={saved.words} /></p>}
  {retiredNote && <p role="status" className="rv-merge-muted">{retiredNote.why === "closed" ? "A later read shows a pull request this merge covered closed without a merge, so the earlier answer no longer applies." : "A later read shows a different head for a pull request this merge covered, so the earlier answer no longer applies."}</p>}
  {rows.length > 0 && <ol className="rv-merge-prs" aria-label="Pull requests to merge">{rows.map((row, index) => <PullItem key={row.key} row={row} ready={rowReady} held={active !== undefined} accepted={saved !== undefined && saved.keys.includes(row.key)} many={rows.length > 1} index={index} />)}</ol>}
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
