import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestEnvApplyAnswer, TestEnvironmentState } from "@agentx/contracts/web";
import { useTestEnvironmentApi } from "../../../api/test-environment.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { isConfirmUrl } from "../../../text/links.js";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ShareRecipePanel } from "../../admin/how-we-work/ShareRecipePanel.js";

type Proposal = NonNullable<TestEnvironmentState["proposal"]>;
type Source = Proposal["valueSources"][number]["source"];

const LESS_SAFE_WORDS: Record<string, string> = {
  preprod: "calls a pre-production service", shared: "uses a shared environment", preview: "builds a copy of your stack for each task", video: "records video", traces: "records traces",
  schema_synth: "answers unrecorded requests with made-up data", round_budget_raised: "raises the time one round of checks may take", preprod_target_changed: "points at a different pre-production service",
  shared_target_changed: "points at a different shared environment", preview_target_changed: "changes how the per-task copy is built", account_target_changed: "uses different test accounts",
  prod_deny_reduced: "shortens the list of what counts as production", nightly_enabled: "runs the whole test suite every night, which costs money", nightly_more_often: "runs the nightly suite more often",
  preview_cost_raised: "raises what the per-task copy may cost", selection_narrowed: "runs fewer of your tests than before",
};
const SKIPPED_WORDS: Record<TestEnvApplyAnswer["skipped"][number]["reason"], string> = {
  different_directory: "run in another directory, which the project's settings can't hold",
  too_many: "didn't fit: a project holds at most 16 commands in a list",
  download_and_run: "download and run code",
  not_needed: "are not build, smoke or test checks, so the check doesn't need them",
};

/** Where a value came from, in the person's words. The path is text from a repository, shown through `VisibleText` by the caller. */
function sourceWords(source: Source): string {
  if (source === "model") return "Rovara's reading of your code";
  if (typeof source === "string") return `Found by the ${source.slice("detector:".length)} detector`;
  return `${source.path}, line ${String(source.line)}`;
}

/** The source of the value at `field`, if the proposal recorded one. */
const sourceOf = (proposal: Proposal, field: string): Source | undefined => proposal.valueSources.find((entry) => entry.field === field)?.source;

function Line({ text, source }: { text: string; source: Source | undefined }) {
  return <li><code><VisibleText text={text} /></code>{source !== undefined && <span className="rv-proposal-meta"> <VisibleText text={sourceWords(source)} /></span>}</li>;
}

/**
 * The setup wizard's test-environment section (E4): Rovara proposes, a maintainer looks at what would run and where each value came from, runs the proposal's own check on a fresh workspace (the commands are NOT in
 * the project's settings yet), proves it from that check, and approves it; the approval adds the commands to the project's settings. A change that is less safe than the sandbox needs a second person's confirmation and the approver's own fresh sign-in; this page only asks, and the server decides. With the feature off
 * the server answers "not found" and this section shows nothing.
 */
export function TestEnvironmentSection({ project, canEditSettings, setupStatus, settingsRevision, onSettingsChanged }: { project: string; /** The page knows the viewer may edit the project's settings (a maintainer): only then is the company-recipe share panel mounted, so a viewer's page never asks and logs a refusal. */ canEditSettings: boolean; setupStatus: string; settingsRevision: number; onSettingsChanged: () => Promise<void> }) {
  const api = useTestEnvironmentApi();
  const host = useAppHost();
  // The setup check finishing (or the settings changing) changes what can be proved: the status is part of the key, so a change reads again.
  const client = useQueryClient();
  const key = ["onboard", "test-environment", project, setupStatus];
  // While the proposal's own check runs, read again every few seconds: it is done when its workspace is.
  const query = useQuery({ queryKey: key, queryFn: () => api.read(project), retry: false, refetchInterval: (q) => (q.state.data?.proposal?.check.status === "checking" || q.state.data?.approved?.check.status === "checking" ? 5000 : false) });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ message: string; reauth: boolean }>();
  const [applied, setApplied] = useState<TestEnvApplyAnswer>();
  const [confirmUrl, setConfirmUrl] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const shown = query.data;
  const refetch = query.refetch;

  async function act<T>(name: string, run: () => Promise<T>, after?: (value: T) => void): Promise<void> {
    setBusy(name); setError(undefined);
    try { after?.(await run()); } catch (caught) {
      if (caught instanceof ApiError) setError({ message: caught.message, reauth: caught.code === "REAUTH_REQUIRED" });
      else setError({ message: "Couldn't finish that. Try again.", reauth: false });
    } finally { setBusy(undefined); }
  }
  const take = (value: TestEnvironmentState) => { client.setQueryData(key, value); };

  // The feature is off (the server answers "not found"), or this server answers in a shape this page can't read (an older or newer one): nothing to show.
  if (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.code === "INVALID_RESPONSE")) return null;
  if (query.isPending) return <section aria-label="Test environment"><p role="status">Loading the test environment.</p></section>;
  if (query.isError || shown === undefined) return <section aria-label="Test environment"><h3>Test environment</h3><p role="alert">Couldn't load the test environment.</p><Button onClick={() => { void refetch(); }}>Try again</Button></section>;

  const proposal = shown.proposal;
  const approvedRevision = shown.approved?.revision ?? 0;

  return <section aria-label="Test environment" className="rv-proposal">
    <h3>Test environment</h3>
    <p>How tests run for this project. Rovara proposes it from your default branch; nothing is used until a maintainer proves and approves it.</p>
    {shown.approved && <p role="status">Approved: revision {shown.approved.revision}, {shown.approved.summary.repositories.reduce((sum, repository) => sum + repository.checks.length, 0)} checks, tier {shown.approved.summary.tier}.</p>}
    {canEditSettings && shown.approved && shown.approved.commandsNotInSettings === 0 && <ShareRecipePanel project={project} />}
    {shown.approved && shown.approved.commandsNotInSettings > 0 && <ApprovedGap
      approved={shown.approved} busy={busy}
      onCheck={() => { void act("check", () => api.startCheck(project, shown.approved!.digest, crypto.randomUUID()), take); }}
      onRefresh={() => { void act("refresh", () => api.read(project), take); }}
      onApply={() => { void act("apply", () => api.applyCommands(project, { digest: shown.approved!.digest, requestId: crypto.randomUUID(), expectedRevision: settingsRevision }), (answer) => { setApplied(answer); take(answer.state); void onSettingsChanged(); }); }}
    />}
    {shown.draft.notes.map((note, index) => <p key={index} className="rv-proposal-meta"><VisibleText text={note} /></p>)}
    {shown.draft.questions.length > 0 && <><p>Rovara is not sure about:</p><ul>{shown.draft.questions.map((question, index) => <li key={index}><VisibleText text={question} /></li>)}</ul></>}

    {proposal === undefined && shown.draft.status === "ready" && <Button busy={busy === "propose"} onClick={() => { void act("propose", () => api.propose(project), take); }}>Propose a test environment</Button>}
    {proposal === undefined && shown.draft.status === "stale" && <p>The setup draft is older than the project's settings. Ask Rovara to propose the setup again, above.</p>}
    {proposal === undefined && shown.draft.status === "none" && !shown.approved && <p>Ask Rovara to propose the setup above first. The test environment is drafted from that look at your default branch.</p>}

    {proposal !== undefined && <ProposalView
      proposal={proposal} approvedRevision={approvedRevision} busy={busy} confirmUrl={confirmUrl} origin={host.origin} applied={applied}
      onCheck={() => { void act("check", () => api.startCheck(project, proposal.digest, crypto.randomUUID()), take); }}
      onProve={() => { void act("prove", () => api.prove(project, proposal.digest), take); }}
      onApprove={() => { void act("approve", () => api.approve(project, proposal.digest, approvedRevision, crypto.randomUUID()), (answer) => { take(answer.state); setConfirmUrl(undefined); void onSettingsChanged(); }); }}
      onAsk={() => { void act("ask", () => api.requestApproval(project, proposal.digest, approvedRevision), (answer) => { take(answer.state); setConfirmUrl(answer.confirmUrl); }); }}
      onRefresh={() => { void act("refresh", () => api.read(project), take); }}
      onEdit={() => setEditing(JSON.stringify(proposal.environment, null, 2))}
    />}
    {proposal !== undefined && editing !== undefined && <div className="rv-proposal-card">
      <TextArea label="Edit the test environment" hint="The whole environment as JSON. It is checked again when you save, and it becomes the proposal; nothing changes until it is proved and approved." value={editing} rows={14} onChange={(event) => setEditing(event.target.value)} />
      <Button variant="primary" busy={busy === "edit"} onClick={() => {
        let parsed: unknown;
        try { parsed = JSON.parse(editing); } catch { setError({ message: "That isn't valid JSON.", reauth: false }); return; }
        void act("edit", () => api.edit(project, parsed), (value) => { take(value); setEditing(undefined); });
      }}>Save my edit</Button>
      <Button onClick={() => setEditing(undefined)}>Cancel</Button>
    </div>}
    {error && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => host.signIn(host.currentPath())}>Sign in again</Button></>}</p>}
  </section>;
}

/**
 * S2: the approval stands but some of the approved commands are not in the project's settings (the write after the approval did not land, or the settings changed since). Nothing is written until a check of THIS approved
 * environment passed at the settings as they are now; then one press writes exactly those commands.
 */
function ApprovedGap({ approved, busy, onCheck, onRefresh, onApply }: { approved: NonNullable<TestEnvironmentState["approved"]>; busy: string | undefined; onCheck: () => void; onRefresh: () => void; onApply: () => void }) {
  return <div className="rv-proposal-card" role="note">
    <p><strong>{approved.commandsNotInSettings === 1 ? "1 approved command is" : `${String(approved.commandsNotInSettings)} approved commands are`} not in the project's settings yet.</strong> Tasks use the settings, so they do not run {approved.commandsNotInSettings === 1 ? "it" : "them"} until it is written.</p>
    {approved.check.status === "checking" && <><p role="status">The check is running.</p><Button busy={busy === "refresh"} onClick={onRefresh}>Check again</Button></>}
    {approved.check.status === "failed" && <p role="alert">The check failed{approved.check.failedStep !== undefined && <>: <VisibleText text={approved.check.failedStep} /></>}</p>}
    {approved.check.status === "ready" && <><p>The check passed at the current settings.</p><Button variant="primary" busy={busy === "apply"} onClick={onApply}>Write the approved commands to the project's settings</Button></>}
    {approved.check.status !== "checking" && approved.check.status !== "ready" && <Button busy={busy === "check"} onClick={onCheck}>{approved.check.status === "failed" ? "Run the check again" : "Run the check"}</Button>}
  </div>;
}

function ProposalView(props: {
  proposal: Proposal; approvedRevision: number; busy: string | undefined; confirmUrl: string | undefined; origin: string; applied: TestEnvApplyAnswer | undefined;
  onCheck: () => void; onProve: () => void; onApprove: () => void; onAsk: () => void; onRefresh: () => void; onEdit: () => void;
}) {
  const { proposal, busy } = props;
  const link = props.confirmUrl !== undefined && isConfirmUrl(props.confirmUrl, props.origin) ? props.confirmUrl : undefined;
  return <div className="rv-proposal-card">
    <h4>{proposal.source === "edited" ? "Your edited proposal" : "Rovara's proposal"}</h4>
    <p className="rv-proposal-meta"><span>Tier: {proposal.summary.tier}</span> <span>Tests chosen by: {proposal.summary.selectionMethod.replace("_", " ")}</span> <span>A round may take {proposal.summary.roundBudgetMin} minutes</span></p>
    <h4>What will run</h4>
    {proposal.runs.map((repository, index) => <div key={index}>
      <p><strong><VisibleText text={repository.repositoryId} /></strong></p>
      {repository.setup.length > 0 && <><p className="rv-proposal-meta">Setup commands</p><ul aria-label={`Setup commands for ${repository.repositoryId}`}>{repository.setup.map((line, at) => <Line key={at} text={line} source={sourceOf(proposal, `repos[${String(index)}].setupCommands[${String(at)}]`)} />)}</ul></>}
      <p className="rv-proposal-meta">Checks</p>
      <ul aria-label={`Checks for ${repository.repositoryId}`}>{repository.checks.map((check, at) => <li key={check.id}>
        <strong><VisibleText text={check.label} /></strong> ({check.kind}): <code><VisibleText text={check.command} /></code>
        {check.selectArgs !== undefined && <> and, once the tests that matter are known, only those: <code><VisibleText text={check.selectArgs.join(" ")} /></code></>}
        {sourceOf(proposal, `repos[${String(index)}].checks[${String(at)}]`) !== undefined && <span className="rv-proposal-meta"> <VisibleText text={sourceWords(sourceOf(proposal, `repos[${String(index)}].checks[${String(at)}]`)!)} /></span>}
      </li>)}</ul>
    </div>)}
    {proposal.valueSources.length === 0 && proposal.source === "edited" && <p className="rv-proposal-meta">Edited by a maintainer, so no value has a source file.</p>}

    {proposal.lessSafe.length > 0 && <div role="note" className="rv-proposal-conflict"><p><strong>This is less safe than a sandbox:</strong></p><ul>{proposal.lessSafe.map((flag) => <li key={flag}>{LESS_SAFE_WORDS[flag] ?? flag.replace(/_/g, " ")}</li>)}</ul>
      <p>It needs a second person to confirm it, and you to sign in again just before you approve.</p></div>}

    <h4>Proof</h4>
    {proposal.proved ? <p role="status">Proved: the check ran these commands and they passed ({proposal.proveSteps.filter((step) => step.status === "passed").map((step) => step.step.replace("_", " ")).join(", ")}).</p>
      : <p>Not proved yet. The check runs the commands above on a fresh copy of your default branch, before any of them is added to the project's settings{proposal.commandsNotInSettings > 0 ? ` (${String(proposal.commandsNotInSettings)} of them are not in the settings yet; approving adds them)` : ""}.</p>}
    {proposal.check.status === "checking" && <p role="status">The check is running.</p>}
    {proposal.check.status === "failed" && <p role="alert">The check failed{proposal.check.failedStep !== undefined && <>: <VisibleText text={proposal.check.failedStep} /></>}</p>}
    {proposal.check.status === "ready" && !proposal.proved && <p>The check passed; prove the environment from it.</p>}
    {proposal.check.status !== "checking" && !proposal.proved && <Button busy={busy === "check"} onClick={props.onCheck}>{proposal.check.status === "unchecked" || proposal.check.status === "outdated" ? "Run the check" : "Run the check again"}</Button>}
    {props.applied && <div role="status">
      {props.applied.added.length > 0 ? <><p>Added to the project's settings{props.applied.setupCheck === "started" ? ", and the project's setup check started" : ""}:</p><ul>{props.applied.added.map((line, index) => <li key={index}><code><VisibleText text={line} /></code></li>)}</ul></> : <p>Nothing to add: the project already has them.</p>}
      {props.applied.skipped.map((entry) => <p key={entry.reason} className="rv-proposal-meta">{entry.count} {entry.count === 1 ? "command was" : "commands were"} left out: {SKIPPED_WORDS[entry.reason]}.</p>)}
    </div>}
    {!proposal.proved && <Button busy={busy === "prove"} disabled={proposal.check.status !== "ready"} onClick={props.onProve}>Prove it</Button>}

    <h4>Approve</h4>
    {!proposal.needs.secondPerson && <>
      <p>{proposal.needs.freshSignIn ? "This raises the risk, so you will be asked to sign in again if your sign-in is more than ten minutes old." : "Tasks in this project use it from now on."}</p>
      <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button>
    </>}
    {proposal.needs.secondPerson && <>
      {proposal.approval.status === "none" && <><p>A second person has to confirm this on a page that asks them to sign in. If you are the only owner, you confirm it yourself there.</p>
        <Button variant="primary" busy={busy === "ask"} disabled={!proposal.proved} onClick={props.onAsk}>Ask a second person to confirm</Button></>}
      {proposal.approval.status === "pending" && <><p role="status">Waiting for a second person to confirm.</p>
        {link !== undefined && <p><a href={link} target="_blank" rel="noopener noreferrer">Open the confirmation page</a> (send this link to the person who confirms it)</p>}
        <Button busy={busy === "ask"} onClick={props.onAsk}>Get the link again</Button><Button busy={busy === "refresh"} onClick={props.onRefresh}>Check again</Button></>}
      {proposal.approval.status === "expired" && <><p role="status">The confirmation expired or was declined.</p><Button busy={busy === "ask"} onClick={props.onAsk}>Ask again</Button></>}
      {proposal.approval.status === "approved" && <><p role="status">Confirmed by a second person. Finish the approval within ten minutes of their sign-in.</p>
        <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button></>}
    </>}
    <Button variant="quiet" onClick={props.onEdit}>Edit this proposal</Button>
  </div>;
}
