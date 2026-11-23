// The cards of the Browser testing page, from the approved mock (design system 4e v2). A write control is drawn for a person who may change browser testing (the served read says so) and is DISABLED, never hidden,
// while the read is not fresh; a person who may not sees the facts and no control.
import { useState } from "react";
import type { BrowserTestingFound, BrowserTestingProof, BrowserTestingSummary, BrowserTestingView } from "@agentx/contracts/web";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { BT } from "./browser-testing-text.js";
import { refreshBlock, choicesChangeOnly, firstApplication, kindNames, minutesLabel, newerSentence, newerWhat, proofText, signInsDeclared, whenOf } from "./model.js";
import { ChipView, Facts, Icon, Item, Live, Mono, Notice, Section, WhyOff, plain } from "./parts.js";
import type { useBrowserTesting } from "./use-browser-testing.js";

export type Bt = ReturnType<typeof useBrowserTesting>;
interface CardProps { bt: Bt; view: BrowserTestingView; project: string }
const writes = (view: BrowserTestingView) => view.canManage;

// ---- not set up

export function Intro({ bt, view, project }: CardProps) {
  return <div className="bt-card bt-stack" data-testid="bt-intro">
    <div><h2 className="bt-h">{BT.introTitle(project)}</h2><p className="bt-lead bt-mt">{BT.introLead}</p></div>
    <ol className="bt-need">{BT.need.map(([bold, rest]) => <li key={bold}><div><b>{bold}</b><span>{rest}</span></div></li>)}</ol>
    {writes(view) ? <div className="bt-btnrow"><Button variant="primary" disabled={!bt.canChange} busy={bt.busy === "refresh"} onClick={() => { void bt.act.startSetup(); }}>{BT.start}</Button></div>
      : <div className="bt-note"><Icon name="info" /><span>{BT.onlyAdminsSetUp}</span></div>}
  </div>;
}

// ---- 1 How your app starts

export function StartCard({ bt, view, found, readOnly }: { bt: Bt; view: BrowserTestingView; found: BrowserTestingFound; readOnly?: boolean }) {
  const apps = found.applications, inferred = apps.every((app) => app.recipeSource === "inferred");
  return <Section id="bt-card-start" num="done" title={BT.startTitle} right={inferred ? BT.startUsual : BT.startFound}>
    <p className="bt-lead">{BT.startLead}</p>
    {apps.map((app) => <Item key={app.applicationId} testId="bt-app" name={<>{BT.startCommand} <Mono text={app.start} /></>} text={<>{BT.waitsFor(app.healthPath)}</>}
      extra={<div className="bt-s">{apps.length > 1 && <><VisibleText text={app.applicationId} />. </>}{app.recipeSource === "repo" ? BT.foundInRepo : BT.usualWay}</div>} />)}
    <p className="bt-lead bt-small">{writes(view) ? BT.startFoot : BT.startFootReader}</p>
    {readOnly !== true && writes(view) && <div className="bt-btnrow"><Button disabled={!bt.canChange || refreshBlock(view) !== undefined} busy={bt.busy === "refresh"} onClick={() => { void bt.act.readAgain(); }}>{BT.readAgain}</Button></div>}
    {readOnly !== true && writes(view) && <WhyOff show={refreshBlock(view) !== undefined}>{refreshBlock(view)}</WhyOff>}
  </Section>;
}

// ---- 2 Test accounts

function Snippet({ found }: { found: BrowserTestingFound }) {
  const snippet = found.applications.map((app) => app.snippet).find((one) => one !== null);
  const [copy, setCopy] = useState<string>();
  if (snippet === undefined || snippet === null) return null;
  return <div className="bt-grp">
    <span className="bt-lab">{BT.toTestSignedIn}</span>
    <p className="bt-lead">{BT.snippetLead}</p>
    <p className="bt-s" data-testid="bt-snippet-file">{BT.snippetFile(snippet.path)}</p>
    <pre className="bt-code" tabIndex={0} role="region" aria-label="Snippet to add to your repo" data-testid="bt-snippet-text"><VisibleText text={snippet.text} /></pre>
    <div className="bt-btnrow">
      <Button onClick={() => { void navigator.clipboard.writeText(snippet.text).then(() => { setCopy(BT.copied); }, () => { setCopy(BT.copyFailed); }); }}><Icon name="copy" />{BT.copy}</Button>
      {copy !== undefined && <span role="status" className="bt-s">{copy}</span>}
    </div>
  </div>;
}

export function AccountsCard({ view, found }: { bt: Bt; view: BrowserTestingView; found: BrowserTestingFound }) {
  const signIn = signInsDeclared(found);
  const kinds = found.applications.flatMap((app) => app.userKinds);
  const shown = view.accounts.length > 0 ? view.accounts : kinds.map((kind) => ({ ...kind, lastSignIn: null }));
  const paths = [...new Set(kinds.map((kind) => kind.signInPath).filter((path): path is string => path !== null))];
  const refused = shown.find((account) => account.lastSignIn?.status === "refused");
  const tryLine = view.approved !== null && !view.faults.includes("accounts-refresh-failed") && shown.some((account) => account.lastSignIn === null);
  const visitor = <Item dim testId="bt-visitor" name={BT.visitor} text={BT.visitorText} right={<ChipView chip={plain(BT.alwaysOn)} />} />;
  if (!signIn) {
    return <Section id="bt-card-accounts" num={2} muted title={BT.accountsTitle} right={BT.signedOutOnly}>
      <p className="bt-lead">{BT.noSignIn}</p>
      {visitor}
      <Snippet found={found} />
    </Section>;
  }
  return <Section id="bt-card-accounts" num="done" title={BT.accountsTitle} right={BT.accountsFound(shown.length)}>
    <p className="bt-lead">{BT.accountsLead}</p>
    {tryLine && <p className="bt-lead bt-small" data-testid="bt-tries-first">{BT.triesFirst}</p>}
    {visitor}
    {shown.map((account) => <Item key={account.profileId} testId={`bt-account-${account.profileId}`} name={<VisibleText text={account.profileId} />} text={BT.kindText}
      right={account.lastSignIn === null ? <ChipView chip={plain(BT.untried)} /> : account.lastSignIn.status === "ok" ? <ChipView chip={{ label: BT.signedInOk(whenOf(account.lastSignIn.checkedAt)), kind: "ok" }} icon="check" /> : <ChipView chip={{ label: BT.signInRefused(whenOf(account.lastSignIn.checkedAt)), kind: "bad" }} icon="alert" />} />)}
    {refused?.lastSignIn != null && <Notice kind="attn" icon="alert" title={BT.refusedTitle(refused.profileId, whenOf(refused.lastSignIn.checkedAt))} testId="bt-signin-note">{BT.refusedText}</Notice>}
    {paths.map((path) => <Item key={path} testId="bt-signin-page" name={<>{BT.signInPage}<div><Mono text={path} /></div></>} text={BT.declared} />)}
    <p className="bt-lead bt-small">{writes(view) ? BT.accountsFoot : BT.accountsFootReader}</p>
  </Section>;
}

// ---- 3 Proof and limits

const LIMITS = [5, 10, 15, 20, 30];
export function ProofEditor({ bt, view, from, onClose }: { bt: Bt; view: BrowserTestingView; from: { proof: BrowserTestingProof; runTimeoutMs: number }; onClose: () => void }) {
  const [shots, setShots] = useState(from.proof.screenshotMode), [video, setVideo] = useState(from.proof.video), [ms, setMs] = useState(from.runTimeoutMs);
  const minutes = [...new Set([...LIMITS.map((minute) => minute * 60_000), from.runTimeoutMs])].sort((a, b) => a - b);
  const unchanged = shots === from.proof.screenshotMode && video === from.proof.video && ms === from.runTimeoutMs;
  const revision = view.draft?.revision;
  return <Section id="bt-card-proof" num={3} title={BT.proofTitle} right={BT.proofChanging}>
    <fieldset className="bt-grp"><legend className="bt-lab">{BT.editScreenshots}</legend>
      <label className="bt-rad"><input type="radio" name="bt-shots" checked={shots === "failed"} onChange={() => { setShots("failed"); }} /><span>{BT.editFailed}</span></label>
      <label className="bt-rad"><input type="radio" name="bt-shots" checked={shots === "all"} onChange={() => { setShots("all"); }} /><span>{BT.editAll}</span></label>
    </fieldset>
    <fieldset className="bt-grp"><legend className="bt-lab">{BT.editVideo}</legend>
      <label className="bt-rad"><input type="checkbox" checked={video} onChange={(event) => { setVideo(event.target.checked); }} /><span>{BT.keepVideo}</span></label>
      <span className="bt-s">{BT.videoHint}</span>
    </fieldset>
    <div className="bt-grp"><label className="bt-lab" htmlFor="bt-limit">{BT.editLimit}</label>
      <div className="bt-inline"><span>{BT.stopAfter}</span><select id="bt-limit" className="rv-input bt-select" value={ms} onChange={(event) => { setMs(Number(event.target.value)); }}>{minutes.map((value) => <option key={value} value={value}>{minutesLabel(value)}</option>)}</select></div>
    </div>
    <div className="bt-btnrow">
      <Button variant="primary" disabled={!bt.canChange || unchanged || revision === undefined} busy={bt.busy === "choices"} onClick={() => { if (revision !== undefined) void bt.act.saveChoices({ draftRevision: revision }, { proof: { screenshotMode: shots, video }, runTimeoutMs: ms }, onClose); }}>{BT.saveChoices}</Button>
      <Button disabled={bt.busy !== undefined} onClick={onClose}>{BT.cancel}</Button>
    </div>
  </Section>;
}

export function ProofCard({ bt, view, summary, defaults, editing, onEdit }: { bt: Bt; view: BrowserTestingView; summary: BrowserTestingSummary; defaults?: boolean; editing: boolean; onEdit: (on: boolean) => void }) {
  if (editing && view.draft !== null) return <ProofEditor bt={bt} view={view} from={{ proof: view.draft.proof, runTimeoutMs: view.draft.runTimeoutMs }} onClose={() => { onEdit(false); }} />;
  const canEdit = writes(view) && view.draft !== null && !view.draft.locked && view.state === "draft";
  return <Section id="bt-card-proof" num="done" title={BT.proofTitle} right={defaults === true ? BT.proofDefaults : BT.proofSaved}>
    <p className="bt-lead">{defaults === true ? BT.proofLeadDefaults : BT.proofLead}</p>
    <Facts rows={[[BT.proofKept, proofText(summary.proof)], [BT.limitEach, BT.stopsAfter(minutesLabel(summary.runTimeoutMs))], [BT.aiUse, BT.aiLine]]} />
    {canEdit && <div className="bt-btnrow"><Button disabled={!bt.canChange} onClick={() => { onEdit(true); }}>{BT.changeChoices}</Button></div>}
  </Section>;
}

// ---- the summary shown before and after approving

export function Summary({ summary, view, newer }: { summary: BrowserTestingSummary; view: BrowserTestingView; newer?: string[] }) {
  const app = firstApplication(summary.found);
  const kinds = kindNames(summary.found), declared = signInsDeclared(summary.found);
  const untried = view.accounts.some((account) => account.lastSignIn === null) || view.accounts.length === 0;
  return <Facts rows={[
    [BT.howStarts, app === undefined ? "" : <><Mono text={app.start} />, waiting for <Mono text={app.healthPath} /><br /><span className="bt-muted">{app.recipeSource === "repo" ? BT.startFound : BT.startUsual}</span></>],
    [BT.signInAs, declared ? <>{[BT.visitor, ...kinds].map((name, index) => <span key={name}>{index > 0 && ", "}<VisibleText text={name} />{newer?.includes(name) === true && <> {BT.newMark}</>}</span>)}. {BT.freshLogin}{untried && <><br /><span className="bt-muted" data-testid="bt-untried-line">{BT.untried}. {BT.triesFirst}</span></>}</> : BT.signedOutOnlyLine],
    [BT.proofKept, proofText(summary.proof)], [BT.limitEach, BT.stopsAfter(minutesLabel(summary.runTimeoutMs))], [BT.aiUse, BT.aiLine],
  ]} />;
}
function Commands({ summary }: { summary: BrowserTestingSummary }) {
  const app = firstApplication(summary.found);
  if (app === undefined) return null;
  const lines = [...(app.build.length > 0 ? [`${BT.cmdBuild}: ${app.build.join(" && ")}`] : []), `${BT.cmdStart}: ${app.start}`, `${BT.cmdWait}: ${app.healthPath}`].join("\n");
  return <details className="bt-det"><summary>{BT.commandsSummary}</summary><pre className="bt-code"><VisibleText text={lines} /></pre></details>;
}

// ---- 4 Check and approve

export function CheckCard({ bt, view }: CardProps) {
  const draft = view.draft, candidate = view.candidate;
  const dis = !bt.canChange || !view.sandboxAvailable || draft === null || draft.locked || draft.stale || view.setupWaiting || draft.found.problem !== null;
  const btn = (label: string) => writes(view) && <div className="bt-btnrow"><Button variant="primary" disabled={dis} busy={bt.busy === "check"} onClick={() => { if (draft !== null) void bt.act.checkSetup({ draftRevision: draft.revision }); }}>{label}</Button></div>;
  if (view.state === "checking") return <Section id="bt-card-check" num={4} title={BT.approveTitle} right={BT.chipChecking}><Live>{BT.checkingText}</Live>{writes(view) && <div className="bt-btnrow"><Button variant="primary" disabled>{BT.check}</Button></div>}</Section>;
  if (!view.sandboxAvailable) return <Section id="bt-card-check" num={4} title={BT.approveTitle} right={BT.blocked}><p className="bt-lead">{BT.sandboxBlocked}</p>{writes(view) && <div className="bt-btnrow"><Button variant="primary" disabled>{BT.check}</Button></div>}</Section>;
  const failed = candidate?.status === "failed";
  const anyKinds = view.accounts.length > 0 && draft !== null && signInsDeclared(draft.found);
  return <Section id="bt-card-check" num={4} title={BT.approveTitle} right={failed ? BT.chipFailed : BT.next}>
    {failed ? <p className="bt-lead">{BT.failedLead}</p> : <p className="bt-lead">{BT.checkLead}{anyKinds ? BT.checkLeadSignIns : ""}</p>}
    {view.setupWaiting && <p className="bt-lead" data-testid="bt-setup-waiting">{BT.setupWaiting}</p>}
    {draft?.stale === true && <p className="bt-lead" data-testid="bt-draft-stale">{BT.draftStale}</p>}
    {failed ? writes(view) && <div className="bt-btnrow"><Button disabled={!bt.canChange} busy={bt.busy === "discard"} onClick={() => { void bt.act.discard({}); }}>{BT.clearCheck}</Button></div> : btn(BT.check)}
    <WhyOff show={writes(view) && !bt.fresh}>{BT.offUntilReconnect}</WhyOff>
  </Section>;
}

// ---- the approval card (a first approval, or a change beside the approved setup)

export function ApprovalCard({ bt, view, project, change, onDiscarded }: CardProps & { change: boolean; onDiscarded?: () => void }) {
  const candidate = view.candidate!, summary = candidate.summary;
  const may = writes(view) && candidate.canApprove;
  const approval = candidate.approval;
  const title = change ? BT.approveChangeTitle : BT.approveCardTitle;
  const right = !writes(view) ? BT.waitingForOwner : change ? BT.waitingApproval : BT.waitingForYou;
  const lead = !writes(view) ? BT.approveLeadMember : change ? <>{newerWhat(view)}. {newerSentence(view)}</> : BT.approveLead;
  return <Section id="bt-card-approve" num="none" title={title} right={right}>
    <p className="bt-lead">{lead}</p>
    <div className="bt-okline" role="status"><Icon name="check" /><span>{BT.checkedLine(whenOf(candidate.checkedAt))}</span></div>
    {summary === null ? <p className="bt-lead" data-testid="bt-unreadable-summary">{BT.unreadableSummary}</p> : <><Summary summary={summary} view={view} newer={change ? view.newerChange?.newUserKinds ?? [] : []} /><Commands summary={summary} /></>}
    <p className="bt-why">{BT.whoApproves}</p>
    {writes(view) && <div><b>{BT.happensTitle}</b><p className="bt-lead bt-mt bt-text">{change ? BT.happensChange : BT.happens(project)}</p></div>}
    {writes(view) && <div className="bt-btnrow">
      <Button variant="primary" disabled={!bt.canChange || !may || approval === null || summary === null} busy={bt.busy === "approve"} onClick={() => { if (approval !== null) void bt.act.approve({ approvalDigest: approval.artifactDigest }); }}>{bt.busy === "approve" ? <><Icon name="spin" />{BT.approving}</> : change ? BT.approveChange : BT.approve}</Button>
      {(!change || choicesChangeOnly(view)) && <Button disabled={!bt.canChange} busy={bt.busy === "discard"} onClick={() => { void bt.act.discard(approval === null ? {} : { approvalDigest: approval.artifactDigest }, () => { onDiscarded?.(); }); }}>{change ? BT.discard : BT.changeProof}</Button>}
    </div>}
    {writes(view) && !change && <p className="bt-why" data-testid="bt-change-note">{BT.changeProofNote}</p>}
    <WhyOff show={writes(view) && !bt.fresh}>{BT.offUntilReconnect}</WhyOff>
  </Section>;
}

// ---- on / paused

export function ApprovedCard({ bt, view, summary, onChange, onPause }: { bt: Bt; view: BrowserTestingView; summary: BrowserTestingSummary; onChange: () => void; onPause: () => void }) {
  const approved = view.approved!;
  const who = approved.decidedByYou ? BT.byYou : BT.byAdmin;
  const when = whenOf(approved.approvedAt);
  const paused = view.state === "paused";
  return <Section id="bt-card-on" num="none" title={paused ? BT.approvedSetupPaused : BT.approvedSetup} right={paused ? BT.chipPaused : BT.chipOn}>
    <p className="bt-lead">{BT.approvedBy(who, when)} {paused ? BT.pausedLead : BT.approvedLead}</p>
    <Summary summary={summary} view={view} />
    <p className="bt-lead bt-small">{writes(view) ? BT.changeRepoFoot : BT.changeRepoFootReader}</p>
    {writes(view) && <div className="bt-btnrow">
      {paused ? <Button variant="primary" disabled={!bt.canChange} busy={bt.busy === "resume"} onClick={() => { void bt.act.resume(); }}>{BT.resume}</Button>
        : <Button disabled={!bt.canChange} onClick={onPause}><Icon name="pause" />{BT.pause}</Button>}
      <Button disabled={!bt.canChange} onClick={onChange}>{BT.changeProof}</Button>
      <Button disabled={!bt.canChange || refreshBlock(view) !== undefined} busy={bt.busy === "refresh"} onClick={() => { void bt.act.readAgain(); }}>{BT.readAgain}</Button>
    </div>}
    {writes(view) && <WhyOff show={refreshBlock(view) !== undefined}>{refreshBlock(view)}</WhyOff>}
    <WhyOff show={writes(view) && !bt.fresh}>{BT.offUntilReconnect}</WhyOff>
  </Section>;
}

/** A change found beside the approved setup that is not checked yet (or whose check is running or failed). A checked one is the approval card. */
export function ChangeCard({ bt, view }: CardProps) {
  const candidate = view.candidate, draft = view.draft;
  const failed = candidate?.status === "failed", checking = candidate?.status === "checking";
  const dis = !bt.canChange || !view.sandboxAvailable || draft === null || draft.locked || draft.stale || view.setupWaiting;
  return <Section id="bt-card-change" num="none" title={BT.changeWaitingTitle} right={failed ? BT.chipFailed : checking ? BT.chipChecking : BT.waitingApproval}>
    <p className="bt-lead">{newerWhat(view)}. {newerSentence(view)}</p>
    {checking ? <Live>{BT.checkingText}</Live> : <p className="bt-lead">{failed ? BT.failedLead : BT.newerCheck}</p>}
    {writes(view) && !checking && <div className="bt-btnrow">
      {failed ? <Button disabled={!bt.canChange} busy={bt.busy === "discard"} onClick={() => { void bt.act.discard({}); }}>{BT.clearCheck}</Button>
        : <Button variant="primary" disabled={dis} busy={bt.busy === "check"} onClick={() => { if (draft !== null) void bt.act.checkSetup({ draftRevision: draft.revision }); }}>{BT.check}</Button>}
      {!failed && choicesChangeOnly(view) && candidate !== null && <Button disabled={!bt.canChange} onClick={() => { void bt.act.discard({}); }}>{BT.discard}</Button>}</div>}
  </Section>;
}

