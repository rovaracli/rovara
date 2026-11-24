import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SetupHostAskView, SetupJournalReply } from "@agentx/contracts/web";

type SetupJournalEntry = SetupJournalReply["entries"][number];
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { journalKey } from "../setup/journal-key.js";
import { ADDRESSES, OPEN_POINTS } from "./setup-tab-text.js";

export type Decisions = Record<string, "approve" | "reject">;
/** A refusal that says nothing was changed. Any other failure of a send (a timeout, a lost connection, an answer that does not read) leaves the outcome unknown: it is checked through reads, never sent again blind. */
const REFUSED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "CHANGE_STALE", "CONFIG_INVALID", "IDEMPOTENCY_CONFLICT", "NOT_ON_CODE_YET", "NOT_FOUND", "AUDIT_UNAVAILABLE"]);

/** The command that asked for an address: the journal entry the ask points at, else the first command that could not reach it. Nothing is invented: no entry, no line (3.7). */
export function askedBy(ask: SetupHostAskView, entries: readonly SetupJournalEntry[]): string | undefined {
  const pointed = ask.journalN === undefined ? undefined : entries.find(entry => entry.n === ask.journalN && entry.blockedHosts.includes(ask.host));
  return (pointed ?? entries.find(entry => entry.blockedHosts.includes(ask.host)))?.command;
}

function Mark({ tone }: { tone: "attention" | "ok" | "no" }) {
  return <svg className="rv-setup-mark" data-tone={tone} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {tone === "attention" ? <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></> : tone === "ok" ? <path d="m3 8.5 3.2 3.2L13 4.5" /> : <path d="m4 4 8 8m0-8-8 8" />}
  </svg>;
}

/**
 * The addresses a setup run asked for, one row each, with Allow and Refuse for a person Code says may decide (`canDecide` on THIS read), only while the ask is open and the journal read is current: a failed re-read takes
 * the buttons away (the last facts stay, with one reconnecting line). The press is refused again at send time against the cache's latest read and its own binding. One press sends once; an outcome nobody can tell is
 * checked through a read, never sent again blind. Allow and Refuse are both plain buttons: refusing an address is the safe choice, so it is never red (3.3, 3.7).
 */
export function AddressAsks({ project, asks, entries, fresh, reconnecting, done, setDone, variant = "decide" }: {
  project: string; asks: readonly SetupHostAskView[]; entries: readonly SetupJournalEntry[]; fresh: boolean; reconnecting: boolean;
  /** The decisions that went through in this view (kept by the page, so a re-read that lost access cannot lose them). */
  done: Decisions; setDone: (change: (now: Decisions) => Decisions) => void;
  /** `history`: the asks of a finished decision, no buttons (inside "This run"). */
  variant?: "decide" | "history";
}) {
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
      setProblem(now => ({ ...now, [host]: ADDRESSES.stale })); return;
    }
    sending.current = true; setBusy({ host, outcome }); setProblem(now => { const next = { ...now }; delete next[host]; return next; });
    try {
      await api.hostDecide(project, { requestId: ask.approval.requestId, host, outcome, seen: { revision: ask.approval.revision, artifactDigest: ask.approval.artifactDigest } });
      setDone(now => ({ ...now, [host]: outcome }));
    } catch (caught) {
      if (caught instanceof ApiError && REFUSED_CODES.has(caught.code)) setProblem(now => ({ ...now, [host]: caught.code === "CHANGE_STALE" || caught.code === "IDEMPOTENCY_CONFLICT" ? ADDRESSES.moved : caught.message }));
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
    } catch { setProblem(now => ({ ...now, [host]: ADDRESSES.checkFailed })); }
    finally { sending.current = false; setBusy(undefined); }
  }

  const decideMode = variant === "decide";
  return <>
    {reconnecting && <p role="status" className="rv-muted" data-testid="host-asks-reconnecting">{Object.keys(done).length > 0 ? ADDRESSES.savedReconnecting : ADDRESSES.reconnecting}</p>}
    <ul aria-label="Addresses the run asked for" className="rv-setup-rows" data-testid="host-asks">{asks.map(ask => {
      const mark = done[ask.host], held = unknown[ask.host] === true, shownProblem = problem[ask.host], command = askedBy(ask, entries);
      const mayAct = decideMode && fresh && ask.status === "open" && ask.canDecide === true && ask.approval !== undefined && mark === undefined && !held;
      const state = mark === "approve" ? ADDRESSES.youAllowed : mark === "reject" ? ADDRESSES.youRefused : ask.status === "approved" ? ADDRESSES.allowed : ask.status === "refused" ? ADDRESSES.refused : ask.canDecide === true ? ADDRESSES.waitingYou : ADDRESSES.waitingAdmin;
      const tone = mark === "approve" || ask.status === "approved" ? "ok" : mark === "reject" || ask.status === "refused" ? "no" : "attention";
      return <li key={ask.host} className="rv-setup-row" data-testid="host-ask" data-host={ask.host} data-status={ask.status}>
        <Mark tone={tone} />
        <div className="rv-setup-row-main">
          <strong data-testid="host-ask-name"><VisibleText text={ask.host} /></strong>
          {command !== undefined && <p className="rv-muted" data-testid="host-ask-by">{ADDRESSES.askedWhile} <code><VisibleText text={command} /></code></p>}
          {!held && <p className="rv-muted" data-testid="host-ask-state">{state}</p>}
          {held && <p role="alert" data-testid="host-ask-unknown">{ADDRESSES.noReply} <Button busy={busy === "check"} disabled={busy !== undefined} data-testid="host-check" onClick={() => { void check(ask.host); }}>{ADDRESSES.check}</Button></p>}
          {shownProblem !== undefined && shownProblem !== "" && <p role="alert" data-testid="host-ask-problem"><VisibleText text={shownProblem} /></p>}
        </div>
        {mayAct && <div className="rv-setup-row-end">
          <Button variant="secondary" className="rv-setup-allow" busy={typeof busy === "object" && busy.host === ask.host && busy.outcome === "approve"} disabled={busy !== undefined} aria-label={`${ADDRESSES.allow} ${ask.host}`} data-testid="host-allow" onClick={() => { void decide(ask.host, "approve"); }}>{ADDRESSES.allow}</Button>
          <Button variant="secondary" busy={typeof busy === "object" && busy.host === ask.host && busy.outcome === "reject"} disabled={busy !== undefined} aria-label={`${ADDRESSES.refuse} ${ask.host}`} data-testid="host-refuse" onClick={() => { void decide(ask.host, "reject"); }}>{ADDRESSES.refuse}</Button>
        </div>}
      </li>;
    })}</ul>
    {decideMode && <p className="rv-muted rv-setup-note" data-testid="host-asks-note">{OPEN_POINTS.allowIsThisProjectOnly ? `${ADDRESSES.scope} ` : ""}{ADDRESSES.refuseNote}</p>}
  </>;
}
