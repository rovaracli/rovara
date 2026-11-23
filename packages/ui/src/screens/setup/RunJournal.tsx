import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SetupHostAskView, SetupJournalReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { servedReadState } from "../../api/served-read.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** The words about a website ask, in one place. Code decides who may decide (a live company owner or admin); these only say where it stands. */
export const HOST_WORDS = Object.freeze({
  heading: "Websites Rovara asked for",
  waiting: "Waiting for a company owner or admin to decide.",
  waitingYou: "Waiting for your decision.",
  allowed: "Allowed. Press Run again to use it.",
  refused: "Refused.",
  allow: "Allow",
  refuse: "Refuse",
  youAllowed: "Allowed. Press Run again to use it.",
  youRefused: "Refused.",
  reconnecting: "Couldn't refresh; reconnecting.",
  wentThrough: "Your change went through.",
  savedReconnecting: "Saved. Couldn't refresh; reconnecting.",
  unknown: "We couldn't confirm your answer was saved. Press Check to see.",
  check: "Check",
  checking: "Checking",
  notConfirmed: "Couldn't check just now. Nothing more can be decided until the page reads again.",
  readRefused: "Couldn't confirm this page just now, so nothing was sent.",
  moved: "That website is not waiting for a decision any more. Reading the page again.",
  failed: "Couldn't send that. Check before deciding again.",
});
/** A refusal that says nothing was changed. Any other failure of a send (a timeout, a lost connection, an answer that does not read) leaves the outcome unknown: it is checked through reads, never sent again blind. */
const REFUSED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "CHANGE_STALE", "CONFIG_INVALID", "IDEMPOTENCY_CONFLICT", "NOT_ON_CODE_YET", "NOT_FOUND", "AUDIT_UNAVAILABLE"]);
export const journalKey = (project: string) => ["onboard", "setup-journal", project] as const;

/**
 * One website ask with its answer. Approve (Allow) and Refuse are drawn only for a person Code says may decide (`canDecide` on THIS read), only while the ask is open, and only while the journal read is current: a failed
 * re-read takes them away (the last facts stay, with one reconnecting line), an access signal clears the page. The press is refused again at send time against the cache's latest read and that read's own binding.
 * One press sends once; an outcome nobody can tell is checked through a read, never sent again blind.
 */
function HostAsks({ project, asks, fresh, reconnecting, done, setDone }: { project: string; asks: SetupHostAskView[]; fresh: boolean; reconnecting: boolean; /** The decisions that went through in this view (kept by the journal, so an access-lost re-read cannot lose them). */ done: Record<string, "approve" | "reject">; setDone: (change: (now: Record<string, "approve" | "reject">) => Record<string, "approve" | "reject">) => void }) {
  const api = useSetupAgentApi(), client = useQueryClient();
  const sending = useRef(false);
  const [busy, setBusy] = useState<{ host: string; outcome: "approve" | "reject" } | "check">();
  const [unknown, setUnknown] = useState<Record<string, boolean>>({}), [problem, setProblem] = useState<Record<string, string>>({});

  async function decide(host: string, outcome: "approve" | "reject") {
    if (sending.current) return;
    // Refused again at send time: the cache's latest read of the journal must be a success, must still hold this ask open, and must still say this person may decide it.
    const state = client.getQueryState(journalKey(project));
    const latest = client.getQueryData<SetupJournalReply>(journalKey(project));
    const ask = latest?.hostAsks.find(one => one.host === host);
    if (state === undefined || state.status !== "success" || state.fetchFailureCount > 0 || ask === undefined || ask.status !== "open" || ask.canDecide !== true || ask.approval === undefined) {
      setProblem(now => ({ ...now, [host]: HOST_WORDS.readRefused })); return;
    }
    sending.current = true; setBusy({ host, outcome }); setProblem(now => { const next = { ...now }; delete next[host]; return next; });
    try {
      await api.hostDecide(project, { requestId: ask.approval.requestId, host, outcome, seen: { revision: ask.approval.revision, artifactDigest: ask.approval.artifactDigest } });
      setDone(now => ({ ...now, [host]: outcome }));
    } catch (caught) {
      if (caught instanceof ApiError && REFUSED_CODES.has(caught.code)) setProblem(now => ({ ...now, [host]: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" ? HOST_WORDS.moved : caught.message }));
      else setUnknown(now => ({ ...now, [host]: true }));
    } finally { sending.current = false; setBusy(undefined); void client.invalidateQueries({ queryKey: journalKey(project) }); void client.invalidateQueries({ queryKey: ["onboard", "setup-agent", project] }); }
  }
  /** Check through a read: a read that succeeds says where the ask stands (closed, or still open and not decided), so deciding again is then safe. A read that fails changes nothing. */
  async function check(host: string) {
    if (sending.current) return;
    sending.current = true; setBusy("check");
    try {
      await client.fetchQuery({ queryKey: journalKey(project), queryFn: () => api.journal(project, { retry: "never" }), staleTime: 0 });
      setUnknown(now => { const next = { ...now }; delete next[host]; return next; });
      setProblem(now => ({ ...now, [host]: "" }));
    } catch { setProblem(now => ({ ...now, [host]: HOST_WORDS.notConfirmed })); }
    finally { sending.current = false; setBusy(undefined); }
  }

  return <>
    <h4>{HOST_WORDS.heading}</h4>
    {reconnecting && <p role="status" className="rv-muted" data-testid="host-asks-reconnecting">{Object.keys(done).length > 0 ? HOST_WORDS.savedReconnecting : HOST_WORDS.reconnecting}</p>}
    <ul aria-label="Websites the run asked for" className="rv-host-asks">{asks.map(ask => {
      const mark = done[ask.host], held = unknown[ask.host] === true, shownProblem = problem[ask.host];
      const mayAct = fresh && ask.status === "open" && ask.canDecide === true && ask.approval !== undefined && mark === undefined && !held;
      return <li key={ask.host} data-testid="host-ask" data-host={ask.host} data-status={ask.status}>
        <code><VisibleText text={ask.host} /></code>{" "}
        {!held && <span className="rv-proposal-meta" data-testid="host-ask-state">{mark === "approve" ? HOST_WORDS.youAllowed : mark === "reject" ? HOST_WORDS.youRefused : ask.status === "approved" ? HOST_WORDS.allowed : ask.status === "refused" ? HOST_WORDS.refused : ask.canDecide === true ? HOST_WORDS.waitingYou : HOST_WORDS.waiting}</span>}
        {mayAct && <span className="rv-connect-actions">
          <Button variant="primary" busy={typeof busy === "object" && busy.host === ask.host && busy.outcome === "approve"} disabled={busy !== undefined} aria-label={`${HOST_WORDS.allow} ${ask.host}`} data-testid="host-allow" onClick={() => { void decide(ask.host, "approve"); }}>{HOST_WORDS.allow}</Button>
          <Button variant="danger" busy={typeof busy === "object" && busy.host === ask.host && busy.outcome === "reject"} disabled={busy !== undefined} aria-label={`${HOST_WORDS.refuse} ${ask.host}`} data-testid="host-refuse" onClick={() => { void decide(ask.host, "reject"); }}>{HOST_WORDS.refuse}</Button>
        </span>}
        {held && <span role="alert" data-testid="host-ask-unknown"> {HOST_WORDS.unknown} <Button busy={busy === "check"} disabled={busy !== undefined} data-testid="host-check" onClick={() => { void check(ask.host); }}>{HOST_WORDS.check}</Button></span>}
        {shownProblem !== undefined && shownProblem !== "" && <span role="alert" data-testid="host-ask-problem"> <VisibleText text={shownProblem} /></span>}
      </li>;
    })}</ul>
  </>;
}

/**
 * What the run did, command by command, and the websites it asked for. Every word of a command or its output is a repository's or a model's text, so it is shown through VisibleText, as quoted text and never
 * as anything to follow. An open website ask is allowed or refused here by a company owner or admin (Code decides who); everyone else sees where it stands.
 */
export function RunJournal({ project, running, heading = true }: { project: string; running: boolean; /** False where a summary above already says "What Rovara ran". */ heading?: boolean }) {
  const api = useSetupAgentApi();
  const query = useQuery({ queryKey: journalKey(project), queryFn: () => api.journal(project, { retry: "never" }), retry: false, refetchInterval: running ? 3000 : false });
  // An access signal wipes what was shown; a failed re-read keeps the last facts (one reconnecting line) and takes every control away.
  const shown = servedReadState(query), data = shown.data;
  // A decision that went through in this view stays said even when the re-read then ends in an access signal (401 / 403 / 404): the facts are wiped, the confirmed outcome is not.
  const [done, setDone] = useState<Record<string, "approve" | "reject">>({});
  if (data === undefined) {
    const went = Object.keys(done).length > 0;
    return query.isError ? <p role="alert" data-testid={went ? "host-asks-went-through" : undefined}>{went ? HOST_WORDS.wentThrough + " " : ""}Couldn't load what the run did.</p> : <p role="status">Loading what the run did.</p>;
  }
  const fresh = !query.isError && query.failureCount === 0, reconnecting = !fresh && data.hostAsks.length > 0;
  return <>
    {heading && <h4>What Rovara ran</h4>}
    {data.entries.length === 0 ? <p className="rv-muted">Nothing yet.</p> : <ol className="rv-setup-journal" aria-label="Commands the run ran">
      {data.entries.map(entry => <li key={entry.n}>
        <p><span className="rv-setup-n">#{entry.n}</span> <span>{entry.source === "person" ? "You ran" : "Rovara ran"}</span> <code><VisibleText text={entry.command} /></code></p>
        <p className="rv-proposal-meta"><span>{entry.timedOut ? "Timed out" : entry.exitCode === 0 ? "Worked" : `Exit ${entry.exitCode === null ? "unknown" : String(entry.exitCode)}`}</span>{entry.flagged && <span>Downloads and runs code (ran only in the sandbox)</span>}</p>
        {entry.blockedHosts.length > 0 && <p className="rv-proposal-meta">Could not reach: {entry.blockedHosts.map(host => <code key={host}><VisibleText text={host} /> </code>)}</p>}
        {entry.tail !== "" && <details><summary>Output</summary><pre><VisibleText text={entry.tail} /></pre></details>}
      </li>)}
    </ol>}
    {data.hostAsks.length > 0 && <HostAsks project={project} asks={data.hostAsks} fresh={fresh} reconnecting={reconnecting} done={done} setDone={setDone} />}
  </>;
}
