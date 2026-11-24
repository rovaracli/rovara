import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { fixedSetupRepairWords, useSetupRepairApi } from "../../api/setup-repair.js";
import { fixedSetupWords } from "../../api/setup-checklist.js";
import type { SetupLimitName } from "../../api/setup-limits.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import type { StatusChipProps } from "../../design/StatusChip.js";
import { setupAgentKey } from "../setup/SetupReview.js";
import type { CardAction, StatusCardModel } from "./setup-card.js";
import type { DecisionState } from "./use-decision.js";
import type { SetupTabData } from "./use-setup-tab.js";
import { TAB } from "./setup-tab-text.js";

const MARKS: Record<string, ReactNode> = {
  needs_you: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11v.2" /></>,
  setting_up: <path d="M8 2a6 6 0 1 1-6 6" />, checking: <path d="M8 2a6 6 0 1 1-6 6" />,
  done: <><circle cx="8" cy="8" r="6" /><path d="m4.5 8 2.5 2.5 4.5-5" /></>,
  failed: <path d="m4 4 8 8m0-8-8 8" />, blocked: <><circle cx="8" cy="8" r="6" /><path d="m4 12 8-8" /></>,
  stopped: <><circle cx="8" cy="8" r="6" /><rect x="6" y="6" width="4" height="4" rx="0.5" fill="currentColor" /></>, could_not_run: <><circle cx="8" cy="8" r="6" /><path d="M5.5 8h5" /></>, unknown: <><circle cx="8" cy="8" r="6" /><path d="M6 6a2 2 0 1 1 3 1.7C8 8.2 8 8.5 8 9M8 11v.2" /></>,
};
function Mark({ chip }: { chip: StatusChipProps }) {
  return <svg className="rv-setup-card-mark" data-state={chip.state} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{MARKS[chip.state] ?? MARKS["unknown"]}</svg>;
}

/** Scroll to a part of the tab and put the keyboard there. */
export function goTo(id: string): void {
  const target = document.getElementById(id);
  if (target === null) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  const heading = target.querySelector<HTMLElement>("h2, h3, summary");
  (heading ?? target).setAttribute("tabindex", "-1");
  (heading ?? target).focus({ preventScroll: true });
}

/**
 * The one status card (3.5): where setup stands and the one thing to do. It draws the model and wires each action: start, stop, fix and check again (the calls the old page made, with one request id each until it
 * lands), approve and don't use it (the shared decision), and the jumps to the parts below. Exactly one button is primary. A button that starts a run says what it costs in the muted line under the group.
 */
export function StatusCard({ project, model, data, decision, locked, onChangeLimit, onShowLog, onStarted }: {
  project: string; model: StatusCardModel; data: SetupTabData; decision: DecisionState;
  /** The page lost its connection: nothing can be sent until it reads again. */
  locked: boolean;
  onChangeLimit: (limit: SetupLimitName) => void; onShowLog: () => void;
  /** A run was started (or stopped): what was decided in the last view is no longer news. */
  onStarted: () => void;
}) {
  const api = useSetupAgentApi(), repairApi = useSetupRepairApi(), client = useQueryClient();
  const [busy, setBusy] = useState<"start" | "stop" | "recheck">(), [error, setError] = useState<string>(), [recheckedIn, setRecheckedIn] = useState<string>(), sending = useRef(false);
  // "Checking setup again." belongs to the state the check was asked in; once the card moves on it is not news.
  const rechecking = recheckedIn === model.state;
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()), [recheckId, setRecheckId] = useState(() => crypto.randomUUID());

  async function act(kind: "start" | "stop") {
    if (sending.current) return;
    sending.current = true; setBusy(kind); setError(undefined);
    try {
      client.setQueryData(setupAgentKey(project), await (kind === "start" ? api.start(project, requestId) : api.stop(project, requestId)));
      setRequestId(crypto.randomUUID()); onStarted(); data.review.reset(); data.refresh();
    } catch (caught) { setError(fixedSetupWords(caught, "Couldn't do that just now. Try again.")); }
    finally { sending.current = false; setBusy(undefined); }
  }
  async function recheck() {
    if (sending.current) return;
    sending.current = true; setBusy("recheck"); setError(undefined);
    try { await repairApi.recheck(project, recheckId); setRecheckedIn(model.state); setRecheckId(crypto.randomUUID()); data.refresh(); }
    catch (caught) { setError(fixedSetupRepairWords(caught, "Couldn't start the check just now. Try again.")); }
    finally { sending.current = false; setBusy(undefined); }
  }

  const button = (action: CardAction, primary: boolean): ReactNode => {
    const common = { variant: primary ? "primary" as const : "secondary" as const, "data-testid": `setup-action-${action.id}`, ...(action.lockedReason === undefined ? {} : { lockedReason: action.lockedReason }) };
    switch (action.id) {
      case "run": case "run_again": case "fix":
        return <Button key={action.id} {...common} busy={busy === "start"} disabled={locked || busy !== undefined || decision.busy !== undefined} data-testid="setup-run-start" onClick={() => { void act("start"); }}>{action.label}</Button>;
      case "stop": return <Button key={action.id} variant="danger" busy={busy === "stop"} disabled={locked || busy !== undefined} data-testid="setup-run-stop" onClick={() => { void act("stop"); }}>{action.label}</Button>;
      case "recheck": return <Button key={action.id} {...common} busy={busy === "recheck"} disabled={locked || busy !== undefined} data-testid="setup-recheck-button" onClick={() => { void recheck(); }}>{action.label}</Button>;
      case "approve": return <Button key={action.id} {...common} busy={decision.busy === "approve"} disabled={locked || decision.busy !== undefined || decision.done} data-testid="setup-approve" onClick={() => { void decision.decide("approve"); }}>{action.label}</Button>;
      case "dont_use": return <Button key={action.id} {...common} busy={decision.busy === "reject"} disabled={locked || decision.busy !== undefined || decision.done} data-testid="setup-reject" onClick={() => { void decision.decide("reject"); }}>{action.label}</Button>;
      case "review_addresses": return <Button key={action.id} {...common} onClick={() => { goTo("setup-addresses"); }}>{action.label}</Button>;
      case "review_setup": return <Button key={action.id} {...common} onClick={() => { goTo(document.getElementById("setup-found") === null ? "setup-approve" : "setup-found"); }}>{action.label}</Button>;
      case "review_newer": return <Button key={action.id} {...common} onClick={() => { goTo(document.getElementById("setup-found") === null ? "setup-approve" : "setup-found"); }}>{action.label}</Button>;
      case "show_log": return <Button key={action.id} {...common} onClick={onShowLog}>{action.label}</Button>;
      case "change_limit": return <Button key={action.id} {...common} onClick={() => { if (action.limit !== undefined) onChangeLimit(action.limit); }}>{action.label}</Button>;
      case "read_again": return <Button key={action.id} {...common} onClick={() => { data.refresh(); void data.review.refetch(); }}>{action.label}</Button>;
      case "start_task": return <Link key={action.id} className={`rv-button ${primary ? "rv-button-primary" : "rv-button-secondary"}`} data-testid="setup-action-start-task" to={`/app/projects/${encodeURIComponent(project)}#start-work`}>{action.label}</Link>;
      case "open_company": return <Link key={action.id} className={`rv-button ${primary ? "rv-button-primary" : "rv-button-secondary"}`} data-testid="setup-action-open-company" to="/app/admin/how-we-work">{action.label}</Link>;
    }
  };

  return <section className="rv-setup-card" aria-labelledby="rv-setup-card-title" data-testid="setup-status-card" data-state={model.state} data-chip={model.chip.state}>
    <h2 id="rv-setup-card-title"><Mark chip={model.chip} /><span>{model.title}{model.titleCode !== undefined && <> <code><VisibleText text={model.titleCode} /></code></>}</span></h2>
    {model.body !== undefined && <p className="rv-setup-card-body" data-testid="setup-card-body"><VisibleText text={model.body} /></p>}
    {model.rows !== undefined && <dl className="rv-setup-three" data-testid="setup-card-rows">{model.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd><VisibleText text={row.text} /></dd></div>)}</dl>}
    {(model.primary !== undefined || model.secondary.length > 0) && <div className="rv-setup-card-actions" data-testid="setup-card-actions">
      {model.primary !== undefined && <div className="rv-setup-action">{button(model.primary, true)}{(model.primary.hints ?? []).map((line, index) => <p key={index} className="rv-muted rv-setup-card-note" data-testid="setup-action-hint">{line}</p>)}</div>}
      {model.secondary.map(action => <div key={action.id} className="rv-setup-action">{button(action, false)}{(action.hints ?? []).map((line, index) => <p key={index} className="rv-muted rv-setup-card-note" data-testid="setup-action-hint">{line}</p>)}</div>)}
    </div>}
    {model.notes.map((note, index) => <p key={index} className="rv-muted rv-setup-card-note" data-testid="setup-card-note">{note}</p>)}
    {rechecking && <p role="status" className="rv-muted" data-testid="setup-recheck-started">Checking setup again.</p>}
    {error !== undefined && <p role="alert" data-testid="setup-run-error"><VisibleText text={error} /></p>}
    {model.readerNote && <p className="rv-muted" data-testid="setup-reader-note">{TAB.readerNote}</p>}
    {decision.problem !== undefined && <div role="alert" data-testid="setup-approval-problem"><p><VisibleText text={decision.problem.message} /></p>{decision.problem.moved && <Button data-testid="setup-approval-refresh" onClick={() => { void data.review.refetch(); }}>Refresh</Button>}</div>}
  </section>;
}
