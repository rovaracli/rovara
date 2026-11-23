// Projects / <project> / Setup / Browser testing (owner decisions 417, 420, 421; the approved mock). SOURCE-BACKED, NOTHING TYPED: Rovara reads how the app starts and which kinds of user it has from the repository, makes a
// fresh test login for each check, and an owner or admin approves. Every sentence is true for the served read; the controls follow the read-handling rules in use-browser-testing.ts.
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { BrowserTestingView } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { isAccessEnded } from "../../../api/served-read.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { browserTestingAbsent } from "../../../api/browser-testing.js";
import { AccountsCard, ApprovalCard, ApprovedCard, ChangeCard, CheckCard, Intro, ProofCard, ProofEditor, StartCard, type Bt } from "./Cards.js";
import { BT } from "./browser-testing-text.js";
import { chipOf, hasFault, shownSummary, whenOf } from "./model.js";
import { ChipView, Icon, Live, Mono, Notice, plain } from "./parts.js";
import { useBrowserTesting } from "./use-browser-testing.js";
import "./browser-testing.css";

function Crumbs({ project }: { project: string }) {
  return <nav aria-label="Breadcrumb" className="bt-crumbs"><ol>
    <li><Link to="/app">Projects</Link></li><li><Link to={`/app/projects/${encodeURIComponent(project)}`}><VisibleText text={project} /></Link></li><li>Setup</li><li aria-current="page">{BT.title}</li>
  </ol></nav>;
}
function Head({ project, chip }: { project: string; chip?: ReactNode }) {
  return <><Crumbs project={project} /><div className="bt-titlerow"><h1 tabIndex={-1}>{BT.title}</h1>{chip}</div></>;
}

/** What a change that did not go as hoped says. The controls stay off while an outcome is unknown. */
function Outcomes({ bt }: { bt: Bt }) {
  const { outcome } = bt;
  if (outcome.kind === "conflict") return <Notice kind="attn" icon="alert" title={BT.conflictTitle} role="alert" testId="bt-conflict" actions={<Button variant="primary" busy={bt.busy === "refresh-read"} onClick={() => { void bt.refresh(); }}>{BT.refresh}</Button>}>{BT.conflictText}</Notice>;
  if (outcome.kind === "no-permission") return <Notice kind="bad" icon="alert" title={BT.noPermissionTitle} role="alert" testId="bt-no-permission" actions={<Button variant="primary" onClick={() => { void bt.refresh(); }}>{BT.reload}</Button>}>{outcome.sent === true ? BT.noPermissionSentText : BT.noPermissionText}</Notice>;
  if (outcome.kind === "refused") return <Notice kind="bad" icon="alert" title={outcome.text} role="alert" testId="bt-refused" />;
  if (outcome.kind === "unknown") return <Notice kind="attn" icon="alert" title={BT.unknownTitle} role="alert" testId="bt-unknown" actions={<Button variant="primary" busy={bt.busy === "check-read"} onClick={() => { void bt.check(); }}>{BT.checkNow}</Button>}>{BT.unknownText}</Notice>;
  if (outcome.kind === "checked") return <Notice kind="ok" icon="check" title={BT.checkedNow} testId="bt-checked" />;
  return null;
}

function Faults({ view }: { view: BrowserTestingView }) {
  return <>
    {hasFault(view, "sandbox-unavailable") && <Notice kind="bad" icon="alert" title={BT.sandboxTitle} testId="bt-fault-sandbox">{BT.sandboxText}</Notice>}
    {hasFault(view, "accounts-refresh-failed") && <Notice kind="bad" icon="alert" title={BT.accountsFaultTitle} testId="bt-fault-accounts">{BT.accountsFaultText}</Notice>}
    {hasFault(view, "approved-setup-unreadable") && <Notice kind="bad" icon="alert" title={BT.unreadableApprovedTitle} testId="bt-fault-approved">{BT.unreadableApprovedText}</Notice>}
  </>;
}

/** The state's own line at the top of the page. */
function StateBanner({ view, bt, project }: { view: BrowserTestingView; bt: Bt; project: string }) {
  const approved = view.approved, candidate = view.candidate;
  const by = approved === null ? "" : BT.approvedBy(approved.decidedByYou ? BT.byYou : BT.byAdmin, whenOf(approved.approvedAt));
  if (view.state === "paused") return <Notice kind="attn" icon="pause" title={BT.pausedBanner} testId="bt-banner-paused">{BT.pausedText}</Notice>;
  if (view.state === "on") {
    if (candidate?.status === "ready" || (candidate === null && view.newerChange !== null && view.canManage)) return <Notice kind="attn" icon="alert" title={BT.changeWaitingTitle} testId="bt-banner-change" />;
    return <Notice kind="ok" icon="check" title={BT.onTitle(project)} testId="bt-banner-on">{BT.onText} {by}</Notice>;
  }
  if (view.state === "waiting" && view.canManage && candidate?.canApprove === true) return <Notice kind="attn" icon="alert" title={BT.readyTitle} testId="bt-banner-ready">{BT.readyText}</Notice>;
  if (view.state === "check-failed") {
    return <Notice kind="bad" icon="alert" title={BT.failedTitle} testId="bt-banner-failed" actions={view.canManage ? <Button variant="primary" disabled={!bt.canChange} busy={bt.busy === "discard"} onClick={() => { void bt.act.discard({}); }}>{BT.clearCheck}</Button> : undefined}>
      {BT.failedText}{candidate?.failedStep !== undefined && <> <Mono text={candidate.failedStep} />.</>} {BT.failedNext}
    </Notice>;
  }
  return null;
}

function Cards({ bt, view, project }: { bt: Bt; view: BrowserTestingView; project: string }) {
  const [editing, setEditing] = useState(false), [pause, setPause] = useState(false);
  const summary = shownSummary(view);
  const common = { bt, view, project };
  if (view.state === "not-set-up") return <Intro {...common} />;
  if (view.state === "waiting") return <div className="bt-stack"><ApprovalCard {...common} change={false} onDiscarded={() => { setEditing(true); }} /></div>;
  if (view.state === "on" || view.state === "paused") {
    const change = view.candidate !== null && view.candidate.status === "ready";
    if (change) return <div className="bt-stack"><ApprovalCard {...common} change /></div>;
    const approved = view.approved?.summary ?? null;
    return <div className="bt-stack">
      {editing && view.draft !== null && approved !== null && <ProofEditor bt={bt} view={view} from={{ proof: approved.proof, runTimeoutMs: approved.runTimeoutMs }} onClose={() => { setEditing(false); }} />}
      {approved !== null && <ApprovedCard bt={bt} view={view} summary={approved} onPause={() => { setPause(true); }} onChange={() => { void (view.draft === null ? bt.act.readAgain() : Promise.resolve()).then(() => { setEditing(true); }); }} />}
      {(view.newerChange !== null || view.candidate !== null) && <ChangeCard {...common} />}
      {approved !== null && <AccountsCard bt={bt} view={view} found={approved.found} />}
      <Dialog title={BT.pauseTitle} open={pause} onOpenChange={setPause}>
        <div className="bt-box"><b>{BT.pauseQuestion(project)}</b><p>{BT.pauseText}</p></div>
        <div className="bt-btnrow"><Button onClick={() => { setPause(false); }}>{BT.keepOn}</Button><Button variant="primary" disabled={!bt.canChange} busy={bt.busy === "pause"} onClick={() => { void bt.act.pause().then(() => { setPause(false); }); }}>{BT.pause}</Button></div>
      </Dialog>
    </div>;
  }
  // A draft, a check or a failed check always has the draft's own facts; with none there is nothing to draw (the fault above says why).
  if (summary === null) return null;
  const sum = summary;
  return <div className="bt-stack">
    <StartCard bt={bt} view={view} found={sum.found} />
    <AccountsCard bt={bt} view={view} found={sum.found} />
    <ProofCard bt={bt} view={view} summary={sum} defaults={view.state === "draft"} editing={editing} onEdit={setEditing} />
    <CheckCard {...common} />
  </div>;
}

function Body({ bt, project }: { bt: Bt; project: string }) {
  const view = bt.view!;
  const stale = bt.read.isError || bt.read.failureCount > 0;
  const problem = view.draft?.found.problem ?? null;
  return <>
    {!view.canManage && view.state !== "not-set-up" && bt.outcome.kind !== "no-permission" && <div className="bt-note bt-mb"><Icon name="info" /><span>{BT.onlyAdmins}</span></div>}
    {stale && (bt.savedStale ? <Notice kind="attn" icon="alert" title={BT.savedStaleTitle} testId="bt-saved-stale">{BT.savedStaleText}</Notice> : <div className="bt-mb" data-testid="bt-stale"><Live>{BT.stale}</Live></div>)}
    <Outcomes bt={bt} />
    <Faults view={view} />
    {problem !== null && <Notice kind="bad" icon="alert" title={BT.problem[problem]} testId="bt-problem" />}
    <StateBanner view={view} bt={bt} project={project} />
    <Cards bt={bt} view={view} project={project} />
  </>;
}

export function BrowserTestingPage({ project }: { project: string }) {
  const bt = useBrowserTesting(project);
  const view = bt.view;
  if (view === undefined) {
    if (bt.read.isPending || (!bt.read.isError && bt.read.fetchStatus === "fetching")) {
      return <section className="bt-page" data-testid="bt-page"><Head project={project} chip={<ChipView chip={plain(BT.chipReading)} />} /><p className="bt-lede">{BT.lede}</p>
        <div className="bt-card bt-stack" aria-busy="true"><span className="bt-skel" style={{ width: "40%" }} /><span className="bt-skel" /><span className="bt-skel" style={{ width: "80%" }} /><Live>{BT.reading}</Live></div></section>;
    }
    const denied = isAccessEnded(bt.read.error), notYet = browserTestingAbsent(bt.read.error) || (bt.read.error instanceof ApiError && bt.read.error.status === 501);
    return <section className="bt-page" data-testid="bt-page"><Head project={project} />
      {denied ? <Notice kind="bad" icon="alert" title={BT.accessLostTitle} role="alert" testId="bt-access-lost" actions={<Button variant="primary" onClick={() => { void bt.read.refetch(); }}>{BT.reload}</Button>}>{bt.wrote ? `${BT.wentThrough} ` : ""}{BT.accessLostText}</Notice>
        : notYet ? <Notice kind="plain" icon="info" title={BT.notYet} testId="bt-not-yet" />
        : <Notice kind="bad" icon="alert" title={BT.readFailedTitle} role="alert" testId="bt-read-failed" actions={<Button variant="primary" onClick={() => { void bt.read.refetch(); }}>{BT.tryAgain}</Button>}>{BT.readFailedText}</Notice>}
    </section>;
  }
  return <section className="bt-page" data-testid="bt-page"><Head project={project} chip={<ChipView chip={chipOf(view)} {...(view.state === "checking" && view.faults.length === 0 ? { icon: "spin" as const } : {})} testId="bt-chip" />} />
    <p className="bt-lede">{BT.lede}</p>
    <Body bt={bt} project={project} />
  </section>;
}
