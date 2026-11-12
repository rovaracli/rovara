import { Suspense, lazy, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { normaliseAwsServiceKey, type TestEnvApplyAnswer, type TestEnvironmentState } from "@agentx/cloud-contracts/web";
import { useTestEnvironmentApi } from "../../../api/test-environment.js";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { AwsServicePicker, type AwsServicesSaveResult } from "./AwsServicePicker.js";
import { ShareRecipePanel } from "../../admin/how-we-work/ShareRecipePanel.js";

/** The second person's card, on this screen (TS-UX-1 item 1): the decision cards' own card and Approve, with the email-code sign-in. Loaded only when a card waits for this viewer. */
const SingleDecision = lazy(async () => ({ default: (await import("../../home/NeedsYou.js")).SingleDecision }));

type Proposal = NonNullable<TestEnvironmentState["proposal"]>;
type Source = Proposal["valueSources"][number]["source"];

const LESS_SAFE_WORDS: Record<string, string> = {
  preprod: "calls a pre-production service", shared: "uses a shared environment", preview: "builds a copy of your stack for each task", video: "records video", traces: "records traces",
  schema_synth: "answers unrecorded requests with made-up data", round_budget_raised: "raises the time one round of checks may take", preprod_target_changed: "points at a different pre-production service",
  shared_target_changed: "points at a different shared environment", preview_target_changed: "changes how the per-task copy is built", account_target_changed: "uses different test accounts",
  prod_deny_reduced: "shortens the list of what counts as production", nightly_enabled: "runs the whole test suite every night, which costs money", nightly_more_often: "runs the nightly suite more often",
  preview_cost_raised: "raises what the per-task copy may cost", selection_narrowed: "runs fewer of your tests than before",
  test_account: "uses a test account for a dependency", project_image: "runs a company-approved extra image for a dependency", substitute_image: "runs your company's own build of an image", none_excluded_tests: "leaves out the tests that need a dependency", dependency_seed: "runs a command to fill a dependency with test data", run_cap_raised: "raises how many dependencies one run may start",
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
 * The setup wizard's test-environment section (E4, finished to the setup pattern in TS-UX-1): Rovara detects; the maintainer sees ONE screen of plain rows (what will run, the services the tests use with their
 * connection variables and test data, the nightly run, the services not set up yet), presses ONE "Check it works" (it proposes, runs the check on a fresh workspace and reads the proof from it), and presses ONE
 * Approve, with the safety said first. A change that needs a second person waits for them on this same screen, and the person who confirms sees the card here. The server decides who may do what. With the feature off
 * the server answers "not found" and this section shows nothing.
 */
export function TestEnvironmentSection({ project, canEditSettings, setupStatus, settingsRevision, onSettingsChanged }: { project: string; /** The page knows the viewer may edit the project's settings (a maintainer): only then is the company-recipe share panel mounted, so a viewer's page never asks and logs a refusal. */ canEditSettings: boolean; setupStatus: string; settingsRevision: number; onSettingsChanged: () => Promise<void> }) {
  const api = useTestEnvironmentApi();
  const onboarding = useOnboardingApi();
  const host = useAppHost();
  // The look at the repositories (the setup draft) is the one the Setup step above asks for (the same query): when it finishes, what Rovara found is read again, so the page never keeps saying "ask first" after the look ran.
  const client = useQueryClient();
  const look = useQuery({ queryKey: ["onboard", "setup-draft", project], queryFn: () => onboarding.setupDraft(project), retry: false, refetchInterval: (q) => (q.state.data?.status === "drafting" ? 3000 : false) });
  const lookStatus = look.data?.status ?? "none";
  // The setup check finishing (or the settings changing) changes what can be proved: the status is part of the key, so a change reads again.
  const key = ["onboard", "test-environment", project, setupStatus, lookStatus];
  // While the proposal's own check runs, read again every few seconds: it is done when its workspace is.
  const query = useQuery({ queryKey: key, queryFn: () => api.read(project), retry: false, refetchInterval: (q) => (q.state.data?.proposal?.check.status === "checking" || q.state.data?.approved?.check.status === "checking" ? 5000 : false) });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ message: string; reauth: boolean }>();
  const [applied, setApplied] = useState<TestEnvApplyAnswer>();
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
  /**
   * The AWS service picker's save. The edit route replaces the whole environment and takes no digest (the contract's `TestEnvEditBodySchema` is only `{ environment }`: a server gap), so the fence is here: the proposal is read
   * again first, and a save built on an environment that is no longer the current proposal is refused with the picks kept (`stale`). The environment is the one the picker opened on, never the newer one it did not show.
   */
  async function saveAwsServices(snapshot: { digest: string; environment: unknown }, dependencyId: string, services: string[]): Promise<AwsServicesSaveResult> {
    try {
      const current = await api.read(project);
      if (current.proposal?.digest !== snapshot.digest) return { ok: false, stale: true, message: "This test environment changed since you opened the AWS services. Your picks are kept. Discard them to see the newer one." };
      const answer = await api.edit(project, withAwsServices(snapshot.environment as Proposal["environment"], dependencyId, services));
      take(answer);
      return { ok: true };
    } catch (caught) {
      if (caught instanceof ApiError) return { ok: false, stale: caught.status === 409, message: caught.message };
      return { ok: false, stale: false, message: "Couldn't save the AWS services. Try again." };
    }
  }
  const askLook = () => act("look", () => onboarding.startSetupDraft(project, crypto.randomUUID()), () => { void look.refetch(); });

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

    {proposal === undefined && shown.draft.status === "ready" && <div className="rv-proposal-card"><p>Rovara has read your repositories and drafted a test environment. Check that it works: Rovara runs the setup and the tests on a fresh copy of your default branch, before anything is added to the project's settings.</p>
      <PendingServices services={shown.draft.pendingServices} />
      <Button variant="primary" busy={busy === "check"} onClick={() => { void act("check", () => api.startCheck(project, undefined, crypto.randomUUID()), take); }}>Check it works</Button></div>}
    {proposal === undefined && shown.draft.status !== "ready" && !shown.approved && <LookNeeded status={shown.draft.status} looked={shown.draft.looked} drafting={lookStatus === "drafting"} busy={busy === "look"} onLook={() => { void askLook(); }} />}
    {proposal === undefined && shown.draft.status === "stale" && shown.approved && <LookNeeded status="stale" looked drafting={lookStatus === "drafting"} busy={busy === "look"} onLook={() => { void askLook(); }} />}
    {!shown.approved && <Steps current={stepOf(shown, proposal)} />}

    {proposal !== undefined && <ProposalView
      proposal={proposal} approvedRevision={approvedRevision} busy={busy} applied={applied} pendingServices={shown.draft.pendingServices} canEdit={canEditSettings}
      onCheck={() => { void act("check", () => api.startCheck(project, proposal.digest, crypto.randomUUID()), take); }}
      onApprove={() => { void act("approve", () => api.approve(project, proposal.digest, approvedRevision, crypto.randomUUID()), (answer) => { take(answer.state); void onSettingsChanged(); }); }}
      onAsk={() => { void act("approve", () => api.requestApproval(project, proposal.digest, approvedRevision), (answer) => { take(answer.state); }); }}
      onRefresh={() => { void act("refresh", () => api.read(project), take); }}
      onEdit={() => setEditing(JSON.stringify(proposal.environment, null, 2))}
      onSeed={(dependencyId, commands) => act("seed", () => api.setSeed(project, proposal.digest, dependencyId, commands), take)}
      onServices={saveAwsServices}
      onReloadServices={() => { void refetch(); }}
      signIn={error?.reauth === true ? error.message : undefined} onSignIn={() => host.signIn(host.currentPath())}
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
    {error && !(error.reauth && proposal !== undefined) && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => host.signIn(host.currentPath())}>Sign in again</Button></>}</p>}
  </section>;
}

/** The steps from the look at the repositories to the approval, in order, with the one the person is on: one press each (the setup pattern). Nothing here is a second path. */
const STEPS = ["Read your repositories", "Check it works", "Approve it"] as const;
function stepOf(shown: TestEnvironmentState, proposal: Proposal | undefined): number {
  if (proposal === undefined) return shown.draft.status === "ready" ? 1 : 0;
  return proposal.proved ? 2 : 1;
}
function Steps({ current }: { current: number }) {
  return <ol aria-label="Steps to a proven test environment" className="rv-proposal-meta">{STEPS.map((step, index) => <li key={step} aria-current={index === current ? "step" : undefined}>{index === current ? <strong>{step}</strong> : step}</li>)}</ol>;
}

/**
 * Where the test environment starts when there is nothing to propose yet: what is needed, in plain words, and the one button that does it. There is no hidden prerequisite and no "go and do this above first": the look
 * at the repositories is asked for right here (it is the same look the Setup step asks for).
 */
function LookNeeded({ status, looked, drafting, busy, onLook }: { status: "none" | "ready" | "stale"; looked: boolean; drafting: boolean; busy: boolean; onLook: () => void }) {
  if (drafting) return <p role="status">Rovara is reading your repositories. This takes a few minutes; this page updates when it is done.</p>;
  const [words, button] = status === "stale"
    ? ["The last look at your repositories is older than your project's settings, so the test environment drafted from it may no longer fit. Look again to draft it from the settings as they are now. If test services were switched on after your last look, looking again is what makes them appear.", "Look again and draft the test environment"]
    : looked
      ? ["Rovara has looked at your repositories but could not draft a test environment from what it found (the notes above say what was missing). Add what is missing, then look again.", "Look again and draft the test environment"]
      : ["A test environment is drafted from a look at your repositories' default branch: Rovara finds how your tests run, and which services they need (a database, for example). You have not asked for that look yet.", "Look at my repositories and draft the test environment"];
  return <div className="rv-proposal-card" role="note"><p>{words}</p><Button variant="primary" busy={busy} onClick={onLook}>{button}</Button></div>;
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

type Dependency = NonNullable<Proposal["environment"]["dependencies"]>[number];
type PendingService = TestEnvironmentState["draft"]["pendingServices"][number];

/** What starts a dependency, in plain words. */
function backingWords(dependency: Dependency): string {
  const backing = dependency.backing;
  if (backing.kind === "local") return `started by Rovara for each run (${backing.catalogId})`;
  if (backing.kind === "emulated") return "started by Rovara as local AWS for each run";
  if (backing.kind === "fake") return "answered by a fake from approved recordings";
  return backing.kind.replace(/_/gu, " ");
}

/**
 * The services the tests use, one plain row each (TS-UX-1 item 4): what it is, what starts it, the connection variables Rovara gives the tests (names only), the names it is reached by, and its test data. A seed
 * command is edited in its field; a seed FILE is shown as the file it loads.
 */
function DependencyRows({ dependencies, seeds, busy, canEdit, onSeed, proposal, onServices, onReloadServices }: { dependencies: readonly Dependency[]; seeds: Proposal["dependencySeeds"]; busy: boolean; canEdit: boolean; onSeed: (dependencyId: string, commands: string[]) => Promise<void>; proposal: Pick<Proposal, "digest" | "environment">; onServices: (snapshot: { digest: string; environment: unknown }, dependencyId: string, services: string[]) => Promise<AwsServicesSaveResult>; onReloadServices: () => void }) {
  // A picker is started again (its picks dropped) only by this count or by a changed saved list; a newer proposal alone leaves it as it is, and its save is then refused as stale.
  const [restarts, setRestarts] = useState(0);
  if (dependencies.length === 0) return null;
  return <><h4>Services the tests use</h4><ul aria-label="Services the tests use">{dependencies.map((dependency) => {
    const files = dependency.seeds.flatMap((seed) => ("fixturePath" in seed ? [seed.fixturePath] : []));
    const field = seeds.find((entry) => entry.id === dependency.id);
    return <li key={dependency.id}>
      <p><strong><VisibleText text={dependency.name} /></strong> ({dependency.kind}), <VisibleText text={backingWords(dependency)} /></p>
      {dependency.connect.env.length > 0 && <p className="rv-proposal-meta">Connection variables the tests get: {dependency.connect.env.map((entry, at) => <span key={entry.name}>{at > 0 ? ", " : ""}<code><VisibleText text={entry.name} /></code></span>)}</p>}
      {dependency.connect.hostAliases.length > 0 && <p className="rv-proposal-meta">Reached at: {dependency.connect.hostAliases.map((alias, at) => <span key={alias}>{at > 0 ? ", " : ""}<code><VisibleText text={alias} /></code></span>)}</p>}
      {canEdit && dependency.backing.kind === "emulated" && dependency.family.startsWith("aws:") && <details><summary>AWS services ({dependency.backing.awsServices.length})</summary>
        <AwsServicePicker key={`${dependency.id}:${[...dependency.backing.awsServices].sort().join(",")}:${String(restarts)}`} snapshot={{ digest: proposal.digest, environment: proposal.environment }} selected={dependency.backing.awsServices}
          required={normaliseAwsServiceKey(dependency.family.slice(4)) ?? dependency.family.slice(4)} onSave={(snapshot, services) => onServices(snapshot, dependency.id, services)} onDiscard={() => { setRestarts((n) => n + 1); onReloadServices(); }} /></details>}
      {files.length > 0 && <p className="rv-proposal-meta">Test data loaded from {files.map((file, at) => <span key={file}>{at > 0 ? ", " : ""}<code><VisibleText text={file} /></code></span>)} (SQL the test database's own client runs inside the sealed test database, as a role with no superuser rights; it cannot reach the network or your secrets)</p>}
      {field !== undefined && (canEdit ? <SeedField key={`${field.id}:${field.commands.join("\n")}`} dependency={field} busy={busy} onSave={onSeed} /> : field.commands.length > 0 && <p className="rv-proposal-meta">Test data commands: {field.commands.map((line, at) => <span key={at}>{at > 0 ? ", " : ""}<code><VisibleText text={line} /></code></span>)}</p>)}
    </li>;
  })}</ul></>;
}

/** The services the code calls that Rovara cannot start yet, one plain row each (they are not part of the environment). */
function PendingServices({ services }: { services: readonly PendingService[] }) {
  if (services.length === 0) return null;
  return <><p className="rv-proposal-meta">Services your code calls that Rovara does not start yet (the tests reach them only if they fake them):</p><ul aria-label="Services not set up yet">{services.map((service, index) => <li key={index}>{service.kind.replace(/_/gu, " ")}: <code><VisibleText text={service.target} /></code></li>)}</ul></>;
}

/** The nightly run in one plain line. */
function NightlyLine({ nightly }: { nightly: Proposal["environment"]["nightly"] }) {
  return <p className="rv-proposal-meta">Nightly run of the whole suite: {nightly.enabled ? <>on, at <code><VisibleText text={nightly.cronUtc} /></code> UTC on <code><VisibleText text={nightly.branch} /></code></> : "off"}</p>;
}

/** What failed in the check, why, and what fixes it (TS-UX-1 item 2): the failing step as the server named it, the cause in plain words, and the fix, with the setup agent where it helps. */
export function checkFailureOf(failedStep: string | undefined): { cause: string; fix: string; agent: boolean } {
  const step = failedStep ?? "";
  // Review I3: the seed file's content is bound to the approval; a changed file is not loaded.
  if (/seed file holds a psql command/iu.test(step)) return { cause: "The test data file holds a psql command (a backslash, such as \\copy, \\! or the COPY FROM stdin block of a pg_dump), so it was not run.", fix: "Make it plain SQL (for a dump, pg_dump --inserts writes INSERT statements), then check it works again.", agent: false };
  if (/seed file uses COPY \.\.\. PROGRAM/iu.test(step)) return { cause: "The test data file uses COPY ... PROGRAM, which a seed file may not run.", fix: "Load the data with INSERT statements instead, then check it works again.", agent: false };
  if (/statement the seed role may not run/iu.test(step)) return { cause: "The test data file runs a statement the seed role may not run: it has no superuser rights (no file reads, server programs or extensions).", fix: "Keep the file to plain data and schema statements; put anything that needs more in a migration your setup runs. Then check it works again.", agent: false };
  if (/changed since the test environment was approved/iu.test(step)) return { cause: "The test data file changed since the test environment was approved, so it was not loaded.", fix: "Check it works with the file as it is now, then approve the test environment again.", agent: false };
  if (/seed/iu.test(step) && /test service/iu.test(step)) return { cause: "The test data did not load into the test database.", fix: "Check the test data below: a command must succeed against an empty database, and a file must be plain SQL that loads into one. Fix it, then check again.", agent: false };
  if (/test service/iu.test(step)) return { cause: "A service the tests use did not start.", fix: "Check again. If it fails again, an administrator can see why on the machines' health.", agent: false };
  if (step.startsWith("test")) return { cause: "The tests ran on a fresh copy of your default branch and failed.", fix: "If they need a service that is not listed above, add it; otherwise fix the tests in your repository. Then check again.", agent: true };
  return { cause: "A setup command failed on a fresh machine, where no database or other service runs yet.", fix: "If the command fills or migrates a database, put it in that service's test data field instead. Otherwise fix it in your repository or in the setup above, then check again.", agent: true };
}

function FailedCheck({ failedStep }: { failedStep: string | undefined }) {
  const failure = checkFailureOf(failedStep);
  const agent = () => { document.querySelector('[aria-label="Set up with Rovara"]')?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return <div role="alert"><p><strong>It does not work yet.</strong> {failure.cause}</p>
    {failedStep !== undefined && <p className="rv-proposal-meta">What failed: <VisibleText text={failedStep} /></p>}
    <p>To fix it: {failure.fix}</p>
    {failure.agent && typeof document !== "undefined" && document.querySelector('[aria-label="Set up with Rovara"]') !== null && <Button variant="quiet" onClick={agent}>Fix with agent</Button>}
  </div>;
}

/** The real approval rule, said before anything is pressed (TS-UX-1 item 1): who approves, who confirms, the sign-ins, and why. One source of words, so the page never says two different things. */
function SafetyNote({ proposal }: { proposal: Proposal }) {
  // SEED-RISK-1: each seed command's risk and the broker's reason (medium: detected unchanged from the repository, only on the test database).
  const seedRisks = proposal.seedRisks ?? [];
  // M5: what happens later is said once, under the list: a change to the seed's files needs a new approval, and migrate commands are never one maintainer's.
  const seedList = seedRisks.length === 0 ? null : <>
    <ul aria-label="Seed commands">{seedRisks.map((entry, index) => <li key={`${entry.dependencyId}-${String(index)}`}>{entry.reason}</li>)}</ul>
    <p>If a seed's files change later (a task edits them, or a merge to the default branch), the seed stops running until you check it works and approve it again. A migrate command, or a seed command that is not the repository's own unchanged script, always needs a second person.</p>
  </>;
  if (proposal.lessSafe.length === 0 && !proposal.needs.freshSignIn) return seedList === null ? null : <div role="note" className="rv-proposal-conflict">{seedList}</div>;
  return <div role="note" className="rv-proposal-conflict">
    {seedList}
    {proposal.lessSafe.length > 0 && <><p><strong>This is less safe than a sandbox:</strong></p><ul>{proposal.lessSafe.map((flag) => <li key={flag}>{LESS_SAFE_WORDS[flag] ?? flag.replace(/_/g, " ")}</li>)}</ul></>}
    {proposal.lessSafe.includes("dependency_seed") && <p>A seed command runs your own code against the test database, with that database's network access, so it is treated as high risk.</p>}
    {proposal.needs.secondPerson
      ? <p>Approving it takes two people. You press Approve, after signing in within the last ten minutes. A second person confirms it on a card, signing in with an email code: an owner or admin of the company, or a maintainer of this project, who is not you. If the company has only one owner and nobody else who could confirm (and nobody who could has left in the last day), and the company allows its only owner to confirm (a company switch), that owner confirms it on the same card instead. A confirmation stays good for a day.</p>
      : <p>This raises the risk, so you press Approve after signing in within the last ten minutes.</p>}
  </div>;
}

function ProposalView(props: {
  proposal: Proposal; approvedRevision: number; busy: string | undefined; applied: TestEnvApplyAnswer | undefined; pendingServices: readonly PendingService[]; canEdit: boolean;
  onCheck: () => void; onApprove: () => void; onAsk: () => void; onRefresh: () => void; onEdit: () => void;
  onSeed: (dependencyId: string, commands: string[]) => Promise<void>; onServices: (snapshot: { digest: string; environment: unknown }, dependencyId: string, services: string[]) => Promise<AwsServicesSaveResult>; onReloadServices: () => void; signIn: string | undefined; onSignIn: () => void;
}) {
  const { proposal, busy } = props;
  const approval = proposal.approval;
  // The person who asked (an older server that does not say so is read as the asker, as before).
  const asker = approval.askedByYou !== false;
  const checked = proposal.check.status;
  return <div className="rv-proposal-card">
    <h4>{proposal.source === "edited" ? "Your edited proposal" : "Rovara's proposal"}</h4>
    <p className="rv-proposal-meta"><span>Tier: {proposal.summary.tier}</span> <span>Tests chosen by: {proposal.summary.selectionMethod.replace("_", " ")}</span> <span>A round may take {proposal.summary.roundBudgetMin} minutes</span></p>
    <h4>What will run</h4>
    {proposal.runs.map((repository, index) => <div key={index}>
      <p><strong><VisibleText text={repository.repositoryId} /></strong></p>
      {repository.setup.length > 0 && <><p className="rv-proposal-meta">Setup commands (they run on a fresh machine before anything starts, so there is no database yet)</p><ul aria-label={`Setup commands for ${repository.repositoryId}`}>{repository.setup.map((line, at) => <Line key={at} text={line} source={sourceOf(proposal, `repos[${String(index)}].setupCommands[${String(at)}]`)} />)}</ul></>}
      <p className="rv-proposal-meta">Checks</p>
      <ul aria-label={`Checks for ${repository.repositoryId}`}>{repository.checks.map((check, at) => <li key={check.id}>
        <strong><VisibleText text={check.label} /></strong> ({check.kind}): <code><VisibleText text={check.command} /></code>
        {check.selectArgs !== undefined && <> and, once the tests that matter are known, only those: <code><VisibleText text={check.selectArgs.join(" ")} /></code></>}
        {sourceOf(proposal, `repos[${String(index)}].checks[${String(at)}]`) !== undefined && <span className="rv-proposal-meta"> <VisibleText text={sourceWords(sourceOf(proposal, `repos[${String(index)}].checks[${String(at)}]`)!)} /></span>}
      </li>)}</ul>
    </div>)}
    <DependencyRows dependencies={proposal.environment.dependencies ?? []} seeds={proposal.dependencySeeds} busy={busy === "seed"} canEdit={props.canEdit} onSeed={props.onSeed} proposal={proposal} onServices={props.onServices} onReloadServices={props.onReloadServices} />
    <PendingServices services={props.pendingServices} />
    <NightlyLine nightly={proposal.environment.nightly} />
    {proposal.valueSources.length === 0 && proposal.source === "edited" && <p className="rv-proposal-meta">Edited by a maintainer, so no value has a source file.</p>}

    <h4>Check it works</h4>
    {proposal.proved ? <p role="status">✓ It works: the check ran these commands on a fresh copy of your default branch and they passed ({proposal.proveSteps.filter((step) => step.status === "passed").map((step) => step.step.replace("_", " ")).join(", ")}).</p>
      : checked === "checking" ? <p role="status">Checking: Rovara is running the setup and the tests on a fresh copy of your default branch. This page updates when it is done.</p>
        : checked === "failed" ? <FailedCheck failedStep={proposal.check.failedStep} />
          : <p>Rovara runs the commands above on a fresh copy of your default branch, before any of them is added to the project's settings{proposal.commandsNotInSettings > 0 ? ` (${String(proposal.commandsNotInSettings)} of them are not in the settings yet; approving adds them)` : ""}.</p>}
    {checked !== "checking" && !proposal.proved && <Button variant="primary" busy={busy === "check"} onClick={props.onCheck}>{checked === "failed" ? "Check it works again" : "Check it works"}</Button>}
    {props.applied && <div role="status">
      {props.applied.added.length > 0 ? <><p>Added to the project's settings{props.applied.setupCheck === "started" ? ", and the project's setup check started" : ""}:</p><ul>{props.applied.added.map((line, index) => <li key={index}><code><VisibleText text={line} /></code></li>)}</ul></> : <p>Nothing to add: the project already has them.</p>}
      {props.applied.skipped.map((entry) => <p key={entry.reason} className="rv-proposal-meta">{entry.count} {entry.count === 1 ? "command was" : "commands were"} left out: {SKIPPED_WORDS[entry.reason]}.</p>)}
    </div>}

    <h4>Approve</h4>
    <SafetyNote proposal={proposal} />
    {!proposal.needs.secondPerson && <>
      {!proposal.needs.freshSignIn && <p>Tasks in this project use it from now on.</p>}
      <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button>
    </>}
    {proposal.needs.secondPerson && <>
      {(approval.status === "none" || approval.status === "expired") && <>{approval.status === "expired" && <p role="status">The last confirmation expired or was declined. Approve asks for a new one.</p>}
        <Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onAsk}>Approve</Button></>}
      {approval.status === "pending" && asker && <><p role="status">{approval.waitingFor === "you_sole_owner"
        ? "Waiting for you to confirm it on the card below: you are the company's only owner, so you confirm it yourself, with an email code."
        : "Waiting for a second person (an owner or admin of the company, or a maintainer of this project) to confirm it on their card. It shows for them on this page and in their Needs you list."}</p>
        <Button busy={busy === "refresh"} onClick={props.onRefresh}>Check again</Button></>}
      {approval.status === "pending" && !asker && approval.youConfirm !== true && <p role="status">Waiting for a second person to confirm it.</p>}
      {approval.status === "pending" && approval.youConfirm === true && approval.approvalId !== undefined && <div aria-label="Confirm this test environment">
        {!asker && <p>A maintainer asked you to confirm this test environment. Read what changes above, then decide on the card.</p>}
        <Suspense fallback={<p role="status">Loading the card.</p>}><SingleDecision cardId={`approve_request:${approval.approvalId}`} /></Suspense>
        <Button variant="quiet" busy={busy === "refresh"} onClick={props.onRefresh}>I decided: check again</Button>
      </div>}
      {approval.status === "approved" && (asker
        ? <><p role="status">Confirmed. Approve to finish: tasks in this project then use it.</p><Button variant="primary" busy={busy === "approve"} disabled={!proposal.proved} onClick={props.onApprove}>Approve</Button></>
        : <p role="status">Confirmed. The maintainer who asked finishes the approval.</p>)}
    </>}
    {props.signIn !== undefined && <p role="alert"><VisibleText text={props.signIn} /> <Button onClick={props.onSignIn}>Sign in again</Button></p>}
    {props.canEdit && <details><summary>Advanced</summary><p className="rv-proposal-meta">The whole environment as JSON, for what the fields above don't cover.</p><Button variant="quiet" onClick={props.onEdit}>Edit as JSON</Button></details>}
  </div>;
}

/** The environment with one emulated dependency's AWS services replaced (the rest is left as it was); the server checks the whole environment again when it is saved as an edit. */
function withAwsServices(environment: Proposal["environment"], dependencyId: string, services: readonly string[]): Proposal["environment"] {
  return { ...environment, dependencies: (environment.dependencies ?? []).map((dependency) => (dependency.id === dependencyId && dependency.backing.kind === "emulated" ? { ...dependency, backing: { ...dependency.backing, awsServices: [...services] } } : dependency)) };
}

/** The lines of the field as commands: trimmed, with the empty ones left out. */
const seedLinesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

/** One dependency's "fill it with test data" field: EVERY command that fills it, one per line in the order they run. Each line is read and checked by the server when saved. Empty clears them all. */
function SeedField({ dependency, busy, onSave }: { dependency: Proposal["dependencySeeds"][number]; busy: boolean; onSave: (dependencyId: string, commands: string[]) => Promise<void> }) {
  const [text, setText] = useState(dependency.commands.join("\n"));
  const changed = seedLinesOf(text).join("\n") !== dependency.commands.join("\n");
  return <div className="rv-proposal-card">
    <TextArea label={`Fill ${dependency.name} with test data`} hint="The commands that fill the test database, one per line, in the order they run, for example npm run seed. They run against the test database inside the test environment, never in setup. Leave it empty if the tests need no data." value={text} rows={Math.min(8, Math.max(2, dependency.commands.length + 1))} onChange={(event) => setText(event.target.value)} />
    <Button busy={busy} disabled={!changed} onClick={() => { void onSave(dependency.id, seedLinesOf(text)); }}>Save the test data commands</Button>
  </div>;
}
