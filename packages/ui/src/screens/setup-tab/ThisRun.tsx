import type { ReactNode } from "react";
import type { SetupJournalReply } from "@agentx/contracts/web";

type SetupJournalEntry = SetupJournalReply["entries"][number];
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { viewerTime } from "../../design/viewer-time.js";
import { servedReadState } from "../../api/served-read.js";
import type { SetupTabData } from "./use-setup-tab.js";
import { AddressAsks, type Decisions } from "./AddressAsks.js";
import { durationWords } from "./setup-card.js";
import { ADDRESSES, RUN } from "./setup-tab-text.js";
import { CommandBox, SteerBox } from "../setup/RunControls.js";

function Chevron() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>; }

/** A command's result in the words of 3.8: Worked, Failed (code 1) or Timed out. */
export const resultWords = (entry: Pick<SetupJournalEntry, "timedOut" | "exitCode">): string => entry.timedOut ? RUN.timedOut : entry.exitCode === 0 ? RUN.worked : RUN.failedCode(entry.exitCode);

/** "Started 2:05 PM" in the viewer's own time zone, with the day when it is not today. */
export function startedWords(at: string | undefined): string | undefined {
  const date = at === undefined ? undefined : new Date(at);
  if (date === undefined || Number.isNaN(date.getTime())) return undefined;
  const today = new Date(), sameDay = date.toDateString() === today.toDateString();
  return RUN.started(sameDay ? viewerTime(date, { hour: "numeric", minute: "2-digit" }) : viewerTime(date, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }));
}

/** The run's facts in one line: Started, how long, cost, commands. A fact the reads do not serve is left out, never guessed. */
export function factsLine(data: Pick<SetupTabData, "checklist" | "run" | "journal">): string | undefined {
  const row = data.checklist?.setupRun, run = data.run;
  // A run that is going shows its time so far, from its start (the stored figure is only as fresh as the last read).
  const started = Date.parse(run?.startedAt ?? row?.startedAt ?? ""), live = run?.status === "running" && Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined;
  const ms = live ?? row?.elapsedMs ?? run?.summary?.elapsedMs, cents = row?.costCents ?? run?.summary?.spendCents;
  const commands = data.journal?.entries.length ?? row?.commandsRun ?? run?.summary?.commandsRun;
  const parts = [startedWords(run?.startedAt ?? row?.startedAt), ms === undefined ? undefined : durationWords(ms), cents === undefined ? undefined : `$${(cents / 100).toFixed(2)}`, commands === undefined ? undefined : `${String(commands)}\u00a0${commands === 1 ? "command" : "commands"}`];
  const line = parts.filter((one): one is string => one !== undefined).join(" · ");
  return line === "" ? undefined : line;
}

function Log({ journal, running, open, onToggle, onRead, failed, reading }: { journal: SetupJournalReply | undefined; running: boolean; open: boolean; onToggle: (open: boolean) => void; onRead: () => void; failed: boolean; reading: boolean }) {
  if (journal === undefined) {
    return failed ? <div role="alert" className="rv-setup-line" data-testid="run-log-failed"><p>{RUN.failed}</p><Button busy={reading} onClick={onRead}>{"Read again"}</Button></div>
      : <p role="status" className="rv-muted" data-testid="run-log-loading">{RUN.loading}</p>;
  }
  const entries = journal.entries, last = entries[entries.length - 1];
  return <details id="setup-log" className="rv-setup-fold" data-testid="run-log" open={open} onToggle={event => { onToggle(event.currentTarget.open); }}>
    <summary><Chevron /><strong>{RUN.ran(entries.length)}</strong>{last !== undefined && <span className="rv-setup-fold-hint"><code><VisibleText text={last.command} /></code> {" · "}{resultWords(last)}</span>}</summary>
    <div className="rv-setup-fold-body">
      {entries.length === 0 ? <p className="rv-muted" data-testid="run-log-empty">{running ? RUN.emptyRunning : RUN.empty}</p> : <ol className="rv-setup-journal" aria-label="Commands the run ran">
        {entries.map(entry => <li key={entry.n}>
          <p><span className="rv-muted">{entry.source === "person" ? RUN.youRan : RUN.rovaraRan}</span> <code><VisibleText text={entry.command} /></code></p>
          <p className="rv-muted" data-testid="run-log-result"><span>{resultWords(entry)}</span>{entry.flagged && <span> · {RUN.flagged}</span>}</p>
          {entry.blockedHosts.length > 0 && <p className="rv-muted">{RUN.couldntReach} {entry.blockedHosts.map((host, index) => <span key={host}>{index > 0 && ", "}<VisibleText text={host} /></span>)}</p>}
          {entry.tail !== "" && <details><summary>{RUN.output}</summary><pre><VisibleText text={entry.tail} /></pre></details>}
        </li>)}
      </ol>}
    </div>
  </details>;
}

/**
 * "This run" (3.8): the facts in one line, the steps (omitted: the server sends no step names, and no line says so), the log folded, and, while a run goes, "Help Rovara along" with the two expert boxes. The addresses a run
 * asked for are decided above; once none is open they come here as a fold.
 */
export function ThisRun({ project, data, decisions, setDecisions, logOpen, onLogToggle, mayAct, running, last = false, note, heading, children }: { project: string; /** Replaces the heading ("The run behind the setup in use") and says in one line what is not in this log. */ heading?: string; note?: string; /** The run is a finished one beside a setup in use (verified, broken later): its heading says "Last run", never "This run". */ last?: boolean; data: SetupTabData; decisions: Decisions; setDecisions: (change: (now: Decisions) => Decisions) => void; logOpen: boolean; onLogToggle: (open: boolean) => void; mayAct: boolean; running: boolean; children?: ReactNode }) {
  const facts = factsLine(data), journal = data.journal, state = data.journalState;
  const asks = journal?.hostAsks ?? [], hasOpen = asks.some(ask => ask.status === "open");
  const fresh = !state.isError && state.failureCount === 0;
  return <section className="rv-setup-section" aria-labelledby="rv-setup-run-heading" data-testid="setup-run">
    <h2 id="rv-setup-run-heading">{heading ?? (last ? RUN.headingLast : RUN.heading)}</h2>
    {note !== undefined && <p className="rv-muted" data-testid="setup-run-note">{note}</p>}
    {facts !== undefined && <p data-testid="setup-run-facts">{facts}</p>}
    {children}
    <div className="rv-setup-folds">
      <Log journal={servedReadState(state).data} running={running} open={logOpen} onToggle={onLogToggle} onRead={() => { void state.refetch(); }} failed={state.isError} reading={state.isFetching} />
      {journal !== undefined && asks.length > 0 && !hasOpen && <details className="rv-setup-fold" data-testid="run-addresses">
        <summary><Chevron /><strong>{ADDRESSES.decidedHeading(asks.length)}</strong></summary>
        <div className="rv-setup-fold-body"><AddressAsks project={project} asks={asks} entries={journal.entries} fresh={fresh} reconnecting={false} done={decisions} setDone={setDecisions} variant="history" /></div>
      </details>}
      {running && mayAct && <details className="rv-setup-fold" data-testid="run-help">
        <summary><Chevron /><strong>{RUN.help}</strong></summary>
        <div className="rv-setup-fold-body">
          {data.run?.sessionId !== undefined && <SteerBox sessionId={data.run.sessionId} />}
          <CommandBox project={project} onRan={() => { data.refresh(); }} />
        </div>
      </details>}
    </div>
  </section>;
}
