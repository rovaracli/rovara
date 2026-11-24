import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOnboardingApi } from "../../api/onboarding.js";
import type { SetupLimitName } from "../../api/setup-limits.js";
import { Skeleton } from "../../design/Skeleton.js";
import { setupAgentKey } from "../setup/SetupReview.js";
import { AddressAsks } from "./AddressAsks.js";
import { AlsoForProject } from "./AlsoForProject.js";
import { ApproveCard } from "./ApproveCard.js";
import { FoundSetupCard } from "./FoundSetupCard.js";
import { LimitsForSetupRun } from "./LimitsForSetupRun.js";
import { StatusCard } from "./StatusCard.js";
import { ThisRun } from "./ThisRun.js";
import { ADDRESSES, FOUND, HELP, RUN, TAB } from "./setup-tab-text.js";
import { askCounts } from "./setup-card.js";
import { canManageRun, type SetupTabData } from "./use-setup-tab.js";
import { useSetupDecision } from "./use-decision.js";
import "./setup-tab.css";

/** States where the run on the page is a finished one beside a setup already in use. */
/** The setup in use broke after its run: the card names the later check's failing step, and the run below is the earlier run that made it. */
const LATER_CHECK_STATES: ReadonlySet<string> = new Set(["repair", "repair_fix_ready", "approved_failed"]);
const LAST_RUN_STATES: ReadonlySet<string> = new Set(["verified", "newer", "newer_checking", "repair", "repair_fix_ready", "approved_failed", "approved_unchecked"]);

/** "The setup Rovara found" needs the project's current settings revision to propose against; the run's own base revision is the fallback when the project can't be read. */
function FoundSlot({ project, data, primary }: { project: string; data: SetupTabData; primary: boolean }) {
  const onboarding = useOnboardingApi(), client = useQueryClient();
  const view = data.run, manage = canManageRun(view);
  const wanted = manage && view?.proposal !== undefined;
  const projectRead = useQuery({ queryKey: ["onboard", "project", project], queryFn: () => onboarding.project(project), retry: false, enabled: wanted });
  if (view === undefined || view.proposal === undefined) return null;
  if (!manage) return <p className="rv-muted" role="status" data-testid="setup-review-read-only">{FOUND.readOnly}</p>;
  if (projectRead.isPending) return null;
  const revision = projectRead.data?.latestRevision ?? view.basedOnRevision;
  return <FoundSetupCard project={project} view={{ ...view, proposal: view.proposal }} settingsRevision={revision} primary={primary} onProposed={() => { void client.invalidateQueries({ queryKey: setupAgentKey(project) }); void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] }); data.refresh(); }} />;
}

/**
 * The project's Setup tab (FABLE-REVIEW 3.2): the status card with the one thing to do, the addresses waiting for a decision right under it, this run, the extras, and the limits for a setup run at the bottom. Setup status
 * does not vanish when the checklist reaches 100%: this tab is always here. `data` is the project page's one read of everything setup (it also draws the header chip).
 */
export function SetupTab({ project, data, canChange, connection }: { project: string; data: SetupTabData; canChange: boolean; connection: string }) {
  const [logOpen, setLogOpen] = useState(false), [focus, setFocus] = useState<SetupLimitName>();
  const decision = useSetupDecision(project, data.run?.apply, reply => { data.review.finished(reply); });
  const locked = connection === "reconnecting";
  if (data.pending) return <Skeleton label={TAB.loading} />;
  if (data.unavailable || data.model === undefined) return <p className="rv-muted" role="status" data-testid="setup-run-not-yet">{TAB.notAvailable}</p>;
  const model = data.model, run = data.run, apply = run?.apply, journal = data.journal;
  const counts = askCounts(journal?.hostAsks), mayAct = canManageRun(run), running = run?.status === "running";
  const fresh = !data.journalState.isError && data.journalState.failureCount === 0;
  const help = HELP[model.state];
  const found = data.review.stage === "review" && apply === undefined && run?.proposal !== undefined;
  const companyAdmin = data.checklist?.viewer.companyRole === "owner" || data.checklist?.viewer.companyRole === "admin";
  return <div className="rv-setup-tab" data-testid="setup-tab" data-state={model.state}>
    {locked && <p className="rv-muted" role="status" data-testid="setup-reconnecting">{TAB.reconnecting}</p>}
    <div className="rv-setup-cols">
      <StatusCard project={project} model={model} data={data} decision={decision} locked={locked} onChangeLimit={limit => { setFocus(limit); document.getElementById("setup-limits")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        onShowLog={() => { setLogOpen(true); document.getElementById("setup-log")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} onStarted={() => { data.setDecisions(() => ({})); }} />
      {help !== undefined && <aside className="rv-setup-help" aria-label={help.heading} data-testid="setup-help"><h2>{help.heading}</h2><p>{help.text}</p></aside>}
      {counts.open > 0 && journal !== undefined && <section id="setup-addresses" className="rv-setup-section" aria-labelledby="rv-setup-addresses-heading" data-testid="setup-addresses">
        <h2 id="rv-setup-addresses-heading">{ADDRESSES.heading}</h2>
        <AddressAsks project={project} asks={journal.hostAsks} entries={journal.entries} fresh={fresh} reconnecting={!fresh && journal.hostAsks.length > 0} done={data.decisions} setDone={data.setDecisions} />
      </section>}
      {found && <FoundSlot project={project} data={data} primary={model.primary === undefined} />}
      {apply !== undefined && apply.check.status !== "checking" && <ApproveCard apply={apply} canManage={mayAct} decision={decision} newer={model.state === "newer"} />}
      {run !== undefined && run.status !== "none" && <ThisRun project={project} data={data} decisions={data.decisions} setDecisions={data.setDecisions} logOpen={logOpen} onLogToggle={setLogOpen} mayAct={mayAct} running={running} last={LAST_RUN_STATES.has(model.state)} {...(LATER_CHECK_STATES.has(model.state) ? { heading: RUN.headingSetupInUse, note: RUN.laterCheck } : {})} />}
      <AlsoForProject project={project} checklist={data.checklist} companyAdmin={companyAdmin} />
      <LimitsForSetupRun project={project} canChange={canChange} company={data.company} focus={focus} onFocused={() => { setFocus(undefined); }} />
    </div>
  </div>;
}
