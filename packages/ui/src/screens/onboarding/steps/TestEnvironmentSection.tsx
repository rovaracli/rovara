import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TestEnvironmentState } from "@agentx/contracts/web";
import { useTestEnvironmentApi } from "../../../api/test-environment.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ShareRecipePanel } from "../../admin/how-we-work/ShareRecipePanel.js";
import { MachineSizeCard } from "../../project/MachineSizeCard.js";

type Proposal = NonNullable<TestEnvironmentState["proposal"]>;
type Source = Proposal["valueSources"][number]["source"];

const LESS_SAFE_WORDS: Record<string, string> = {
  preprod: "calls a pre-production service", shared: "uses a shared environment", preview: "builds a copy of your stack for each task", video: "records video", traces: "records traces",
  schema_synth: "answers unrecorded requests with made-up data", round_budget_raised: "raises the time one round of checks may take", preprod_target_changed: "points at a different pre-production service",
  shared_target_changed: "points at a different shared environment", preview_target_changed: "changes how the per-task copy is built", account_target_changed: "uses different test accounts",
  prod_deny_reduced: "shortens the list of what counts as production", nightly_enabled: "runs the whole test suite every night, which costs money", nightly_more_often: "runs the nightly suite more often",
  preview_cost_raised: "raises what the per-task copy may cost", selection_narrowed: "runs fewer of your tests than before",
  test_account: "uses a test account for a dependency", project_image: "runs your own image for a dependency", substitute_image: "runs your company's own build of an image", none_excluded_tests: "leaves out the tests that need a dependency", dependency_seed: "runs a command to fill a dependency with test data", run_cap_raised: "raises how many dependencies one run may start",
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
 * the project's settings yet), proves it from that check, and approves it; the approval adds the commands to the project's settings. A change that is less safe than the sandbox needs a second person's confirmation; this page only asks, and the server decides. With the feature off
 * the server answers "not found" and this section shows nothing.
 */
export function TestEnvironmentSection({ project, canEditSettings, setupStatus, onSettingsChanged }: { project: string; /** The page knows the viewer may edit the project's settings (a maintainer): only then is the company-recipe share panel mounted, so a viewer's page never asks and logs a refusal. */ canEditSettings: boolean; setupStatus: string; onSettingsChanged: () => Promise<void> }) {
  const api = useTestEnvironmentApi();
  // The setup check finishing (or the settings changing) changes what can be proved: the status is part of the key, so a change reads again.
  const client = useQueryClient();
  const key = ["onboard", "test-environment", project, setupStatus];
  // While the proposal's own check runs, read again every few seconds: it is done when its workspace is.
  const query = useQuery({ queryKey: key, queryFn: () => api.read(project), retry: false, refetchInterval: (q) => (q.state.data?.proposal?.check.status === "checking" || q.state.data?.approved?.check.status === "checking" ? 5000 : false) });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ message: string }>();
  const shown = query.data;
  const refetch = query.refetch;

  async function act<T>(name: string, run: () => Promise<T>, after?: (value: T) => void): Promise<void> {
    setBusy(name); setError(undefined);
    try { after?.(await run()); } catch (caught) {
      if (caught instanceof ApiError) setError({ message: caught.message });
      else setError({ message: "Couldn't finish that. Try again." });
    } finally { setBusy(undefined); }
  }
  const take = (value: TestEnvironmentState) => { client.setQueryData(key, value); };

  // The feature is off (the server answers "not found"), or this server answers in a shape this page can't read (an older or newer one): nothing to show.
  if (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 501 || query.error.code === "NOT_ON_CODE_YET" || query.error.code === "INVALID_RESPONSE")) return null;
  if (query.isPending) return <section aria-label="Test environment"><p role="status">Loading the test environment.</p></section>;
  if (query.isError || shown === undefined) return <section aria-label="Test environment"><h3>Test environment</h3><p role="alert">Couldn't load the test environment.</p><Button onClick={() => { void refetch(); }}>Try again</Button></section>;

  const proposal = shown.proposal;
  const approvedRevision = shown.approved?.revision ?? 0;

  return <section aria-label="Test environment" className="rv-proposal">
    <h3>Test environment</h3>
    <p>How tests run for this project. Rovara proposes it from your default branch; nothing is used until a maintainer proves and approves it.</p>
    <MachineSizeCard project={project} canEdit={canEditSettings} />
    {shown.approved && <p role="status">Approved: revision {shown.approved.revision}, {shown.approved.summary.repositories.reduce((sum, repository) => sum + repository.checks.length, 0)} checks, tier {shown.approved.summary.tier}.</p>}
    {canEditSettings && shown.approved && shown.approved.commandsNotInSettings === 0 && <ShareRecipePanel project={project} />}
    {shown.approved && shown.approved.commandsNotInSettings > 0 && <ApprovedGap
      approved={shown.approved}
    />}
    {shown.draft.notes.map((note, index) => <p key={index} className="rv-proposal-meta"><VisibleText text={note} /></p>)}
    {shown.draft.questions.length > 0 && <><p>Rovara is not sure about:</p><ul>{shown.draft.questions.map((question, index) => <li key={index}><VisibleText text={question} /></li>)}</ul></>}

    {proposal === undefined && shown.draft.status === "stale" && <p>The setup draft is older than the project's settings. Ask Rovara to propose the setup again, above.</p>}
    {proposal === undefined && shown.draft.status === "none" && !shown.approved && shown.draft.notes.length === 0 && <p>Ask Rovara to propose the setup above first. The test environment is drafted from that look at your default branch.</p>}

    {proposal !== undefined && <ProposalView
      proposal={proposal} busy={busy}
      onApprove={() => { void act("approve", () => api.approve(project, proposal.digest, approvedRevision, crypto.randomUUID()), (answer) => { take(answer.state); void onSettingsChanged(); }); }}
    />}
    {error && <p role="alert"><VisibleText text={error.message} /></p>}
  </section>;
}

/**
 * S2: the approval stands but some of the approved commands are not in the project's settings (the write after the approval did not land, or the settings changed since). Nothing is written until a check of THIS approved
 * environment passed at the settings as they are now; then one press writes exactly those commands.
 */
function ApprovedGap({ approved }: { approved: NonNullable<TestEnvironmentState["approved"]> }) {
  return <div className="rv-proposal-card" role="note">
    <p><strong>{approved.commandsNotInSettings === 1 ? "1 approved command is" : `${String(approved.commandsNotInSettings)} approved commands are`} not in the project's settings yet.</strong> Tasks use the settings, so they do not run {approved.commandsNotInSettings === 1 ? "it" : "them"} until it is written.</p>
    {approved.check.status === "checking" && <p role="status">The check is running.</p>}
    {approved.check.status === "failed" && <p role="alert">The check failed{approved.check.failedStep !== undefined && <>: <VisibleText text={approved.check.failedStep} /></>}</p>}
    {approved.check.status === "ready" && <p>The check passed at the current settings.</p>}
  </div>;
}

function ProposalView(props: { proposal: Proposal; busy: string | undefined; onApprove: () => void }) {
  const { proposal, busy } = props;
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
      <p>It needs a second person to confirm it before it can be approved.</p></div>}

    <h4>Proof</h4>
    {proposal.proved ? <p role="status">Proved: the check ran these commands and they passed{proposal.proveSteps.some((step) => step.status === "passed") ? ` (${proposal.proveSteps.filter((step) => step.status === "passed").map((step) => step.step.replace("_", " ")).join(", ")})` : ""}.</p>
      : <p>Not proved yet. The check runs the commands above on a fresh copy of your default branch, before any of them is added to the project's settings{proposal.commandsNotInSettings > 0 ? ` (${String(proposal.commandsNotInSettings)} of them are not in the settings yet; approving adds them)` : ""}.</p>}
    {proposal.check.status === "checking" && <p role="status">The check is running.</p>}
    {proposal.check.status === "failed" && <p role="alert">The check failed{proposal.check.failedStep !== undefined && <>: <VisibleText text={proposal.check.failedStep} /></>}</p>}
    {proposal.check.status === "ready" && !proposal.proved && <p>The check passed; prove the environment from it.</p>}

    <h4>Approve</h4>
    {!proposal.needs.secondPerson && <>
      <p>Tasks in this project use it from now on.</p>
        <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button>
    </>}
    {proposal.needs.secondPerson && <>
      {proposal.approval.status === "none" && <><p>A second person has to confirm this on a page that asks them to sign in. If you are the only owner, you confirm it yourself there.</p>
        {null}</>}
      {proposal.approval.status === "pending" && <><p role="status">Waiting for a second person to confirm.</p>
        </>}
      {proposal.approval.status === "expired" && <p role="status">The confirmation expired or was declined.</p>}
      {proposal.approval.status === "approved" && <><p role="status">Confirmed by a second person.</p>
        <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button></>}
    </>}
  </div>;
}
