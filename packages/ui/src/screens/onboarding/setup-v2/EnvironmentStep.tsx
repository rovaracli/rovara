import { Suspense, lazy, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppProjectDetail } from "@agentx/cloud-contracts/web";
import { PendingChangeError, useOnboardingApi } from "../../../api/onboarding.js";
import { useSetupAgentApi } from "../../../api/setup-agent.js";
import { useTestEnvironmentApi } from "../../../api/test-environment.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { RECOVERY_LABEL, codeRepositoriesOf, recoveryChoices, repoCheckModel, type MetaRepositoryRef, type Recovery, type RepoRow } from "./repo-check.js";
import type { SetupFailure } from "../steps/setup-failure.js";

// The full setup screen (commands, the test environment, proof) is the "Edit the setup" recovery, in its own chunk; the setup run is the "Fix with the setup agent" recovery.
const SetupStep = lazy(async () => ({ default: (await import("../steps/SetupStep.js")).SetupStep }));
const SetupRunSection = lazy(() => import("../../setup/SetupRunSection.js"));

function Failure({ failure }: { failure: SetupFailure }) {
 return <dl className="rv-psv2-failure"><dt>Step that failed</dt><dd>{failure.step}{failure.command !== undefined && <> <code><VisibleText text={failure.command} /></code></>}</dd><dt>What happened</dt><dd><VisibleText text={failure.cause} /></dd><dt>What to do</dt><dd>{failure.fix}</dd></dl>;
}

/**
 * Environment check per repository. The check itself is one check of the whole project (see repo-check.ts), so the rows share it: each says its own status, the failing step in plain words, and one recovery to press.
 * "Retry the check" runs the same existing check; "Fix with the setup agent" is offered only where the setup agent is on; "Edit the setup" opens the existing setup screen below.
 */
export function EnvironmentStep({ project, metaRepository, onProject, refresh, onNext, nextLabel = "Continue to agents" }: { project: AppProjectDetail; metaRepository?: MetaRepositoryRef | undefined; onProject: (project: AppProjectDetail) => void; refresh: () => void; onNext: () => void; nextLabel?: string }) {
 const api = useOnboardingApi(), agentApi = useSetupAgentApi(), envApi = useTestEnvironmentApi();
 const [busy, setBusy] = useState<Recovery>(), [error, setError] = useState<string>(), [panel, setPanel] = useState<"agent" | "edit">(), panelRef = useRef<HTMLDivElement>(null);
 // Reads that only add detail: with the test environment or the setup agent off, the server answers "not found" and the page simply offers less.
 const runs = useQuery({ queryKey: ["onboard", "setup-v2", "runs", project.name, project.setup.status], queryFn: () => envApi.read(project.name), retry: false, enabled: project.setup.status === "failed" && codeRepositoriesOf(project.repositories, metaRepository).length > 1 });
 const agent = useQuery({ queryKey: ["onboard", "setup-agent", project.name], queryFn: () => agentApi.read(project.name), retry: false });
 const agentAvailable = agent.data !== undefined && agent.data.companySetupOff !== true;
 const model = repoCheckModel({ repositories: project.repositories, setup: project.setup, runs: runs.data?.proposal?.runs, metaRepository });
 function open(next: "agent" | "edit") { setPanel(next);setTimeout(() => { panelRef.current?.scrollIntoView?.({ block: "start" });panelRef.current?.querySelector<HTMLElement>("button, textarea")?.focus(); }, 0); }
 async function recover(choice: Recovery) {
  setError(undefined);
  if (choice === "edit_setup") { open("edit");return; }
  setBusy(choice);
  try {
   if (choice === "retry") onProject((await api.check(project.name, crypto.randomUUID())).project);
   else { await agentApi.start(project.name, crypto.randomUUID());await agent.refetch();open("agent"); }
  } catch (failure) { setError(failure instanceof PendingChangeError || failure instanceof ApiError ? failure.message : choice === "retry" ? "Couldn't start the check. Try again." : "Couldn't start the setup agent. Try again."); }
  finally { setBusy(undefined); }
 }
 const choices = (row: Pick<RepoRow, "state">) => recoveryChoices(row.state, { agentAvailable });
 const checking = project.setup.status === "checking", needs = model.rows.filter(row => row.state === "needs_action").length + (model.unattributed === undefined ? 0 : 1), codeRows = model.rows.filter(row => row.role === "code");
 const summary = checking ? "Checking now" : model.allReady ? "All ready" : needs > 0 ? `${String(needs)} of ${String(codeRows.length)} needs action` : "Not confirmed yet";
 const recoveryButtons = (state: RepoRow["state"], name: string) => choices({ state }).map((choice, at) => <Button key={choice} variant={at === 0 ? "primary" : "secondary"} busy={busy === choice} disabled={busy !== undefined && busy !== choice} aria-label={RECOVERY_LABEL[choice] + " for " + name} onClick={() => { void recover(choice); }}>{RECOVERY_LABEL[choice]}</Button>);
 return <>
  <h2>Environment check</h2>
  <p>Rovara builds each repository and runs its tests once, so the first task doesn't fail on setup. <strong>{summary}.</strong></p>
  <p className="rv-muted">Rovara runs one check for the whole project today. If it fails, the row of the repository where it stopped says what to do.</p>
  {model.rows.length === 0 && <p role="status">This project has no repositories to check.</p>}
  <ul className="rv-psv2-repos" aria-label="Repositories">
   {model.rows.map(row => <li key={row.fullName} className="rv-psv2-repo" data-state={row.state}>
    <div className="rv-psv2-repo-head"><h3><VisibleText text={row.fullName} /></h3><span className="rv-psv2-pill" data-state={row.state}><span aria-hidden="true" className="rv-psv2-glyph">{row.state === "ready" ? "✓" : row.state === "needs_action" ? "!" : row.state === "checking" ? "…" : row.state === "meta" ? "M" : "·"}</span>{row.label}</span></div>
    <p role={row.state === "checking" ? "status" : undefined}>{row.detail}</p>
    {row.failure !== undefined && <Failure failure={row.failure} />}
    {recoveryButtons(row.state, row.fullName).length > 0 && <div className="rv-psv2-actions">{recoveryButtons(row.state, row.fullName)}</div>}
   </li>)}
  </ul>
  {model.unattributed !== undefined && <div className="rv-psv2-repo rv-psv2-whole" data-state="needs_action" role="group" aria-label="The whole check"><h3>The whole check</h3><p>The check stopped at a step that doesn't say which repository it belongs to.</p><Failure failure={model.unattributed} /><div className="rv-psv2-actions">{recoveryButtons("needs_action", "the whole check")}</div></div>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  {checking && <Button onClick={refresh}>Check status</Button>}
  <div ref={panelRef} className="rv-psv2-panel" hidden={panel === undefined}>
   {panel === "agent" && <Suspense fallback={null}><SetupRunSection project={project.name} settingsRevision={project.latestRevision} /></Suspense>}
   {panel === "edit" && <><h3>Edit the setup</h3><Suspense fallback={<p role="status">Loading the setup editor</p>}><SetupStep project={project} onProject={onProject} refresh={refresh} onNext={() => { setPanel(undefined); }} nextLabel="Close the editor" /></Suspense></>}
  </div>
  {model.allReady ? <Button variant="primary" onClick={onNext}>{nextLabel}</Button> : <Button onClick={onNext} disabled={checking}>Continue without a ready environment</Button>}
  {!model.allReady && !checking && <p className="rv-muted">You can fix this later from the project page. The first task needs a ready environment.</p>}
 </>;
}
