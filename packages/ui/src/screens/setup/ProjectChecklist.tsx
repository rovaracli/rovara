// Guided onboarding PR 9 (design section 1 "Project setup checklist"; DEC 254j, 254k, 254l): one project's checklist, shown on the project's page until it is
// finished. Every row is read from Code's real state (Code #841, through Cloud), never from a saved wizard position, so it is right after a reload, on another
// device and for a second admin. One required thing at a time: the next required row is open, the others are collapsed with their state. Slack channel,
// Linear and Invite teammates are optional ("Set up later" marks them "Skipped (optional)", which still counts toward 100%). A person who can't change the
// project (not a company owner or admin, not the project's admin) sees it read-only with "Ask your company's admins to finish setup".
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSetupChecklist, SetupRowState, SetupSkippableRow, SetupStatusRow } from "@agentx/contracts/web";
import { checklistAbsent, fixedSetupWords, setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SlackChannelRow } from "../connect/SlackChannelRow.js";
import { LinearTeamRow } from "../connect/LinearTeamRow.js";
import { SetupRunRow } from "./SetupRunRow.js";
import { WikiChecklistRow } from "./wiki/WikiChecklistRow.js";
import { CompanySetupLine } from "./CompanySetupLine.js";
import { EvalCard } from "./EvalCard.js";
import { EvalCheckRow } from "./EvalCheckRow.js";
import "./checklist.css";

/** The words and tone each row state shows (design: Done, Needs you, Running, Optional, Failed; plus "Skipped (optional)"). */
export const ROW_STATE_WORDS: Readonly<Record<SetupRowState, { label: string; tone: "ok" | "wait" | "run" | "idle" | "bad" }>> = Object.freeze({
 done: { label: "Done", tone: "ok" }, needs_you: { label: "Needs you", tone: "wait" }, running: { label: "Running", tone: "run" },
 optional: { label: "Optional", tone: "idle" }, skipped: { label: "Skipped (optional)", tone: "idle" }, failed: { label: "Failed", tone: "bad" },
});
const ROW_TITLES: Readonly<Record<SetupStatusRow, string>> = Object.freeze({
 repos: "Repos", setupRun: "Setup run", evalConfirm: "Confirm how work is checked", aiAndSpend: "AI and spend limit",
 slackChannel: "Slack channel", linear: "Linear", invites: "Invite teammates", firstTask: "Start your first task",
});
const OPTIONAL: ReadonlySet<SetupStatusRow> = new Set(["slackChannel", "linear", "invites"]);

function Row({ name, state, open, children }: { name: SetupStatusRow; state: SetupRowState; open: boolean; children: ReactNode }) {
 const words = ROW_STATE_WORDS[state];
 return <li className="rv-checklist-row" data-testid={`checklist-row-${name}`} data-state={state}>
  <details open={open}>
   <summary><span className="rv-checklist-title">{ROW_TITLES[name]}</span> <StatusPill tone={words.tone} label={words.label} /></summary>
   <div className="rv-checklist-body">{children}</div>
  </details>
 </li>;
}

/** Shown to a person who can't change the project: no admin is named, because the company member list is admin-only on Code (a plain member is answered 404 by design) and is never asked for. */
function AdminNames() {
 return <p data-testid="checklist-ask-admins">Ask your company's admins to finish setup.</p>;
}

/** The project's setup checklist. `place` "project": shown on the project page, and nothing once every row is done or skipped. */
export function ProjectChecklist({ project, place = "project" }: { project: string; place?: "project" | "onboard" }) {
 const api = useSetupChecklistApi(), query = useQueryClient();
 const status = useQuery({
  queryKey: setupChecklistKey(project), queryFn: () => api.status(project), retry: false,
  refetchInterval: current => (current.state.data?.setupRun.state === "running" ? 5000 : false),
 });
 const [busy, setBusy] = useState<SetupSkippableRow>(), [error, setError] = useState<string>();
 if (status.isError && checklistAbsent(status.error)) return null;
 if (status.isPending) return <Skeleton label="Loading the setup checklist" />;
 if (status.isError) return <section className="rv-checklist" aria-label="Finish setting up"><p role="status" data-testid="checklist-read-error"><VisibleText text={fixedSetupWords(status.error, "The project's setup couldn't be read just now. Try again.")} /></p><Button onClick={() => { void status.refetch(); }}>Try again</Button></section>;
 const data: ProjectSetupChecklist = status.data;
 const canChange = data.viewer.canSkip, admin = data.viewer.companyRole === "owner" || data.viewer.companyRole === "admin";
 // A finished checklist leaves the project page, but the wiki's controls (Refresh now, the agents switch, Delete, nightly upkeep) stay reachable for the people who may use them (lead 4 W6).
 if (data.progress.percent >= 100 && place === "project") return canChange ? <><WikiChecklistRow project={project} companyAdmin={admin} alone /><EvalCheckRow project={project} alone /></> : null;
 const refresh = () => { void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); };
 async function skip(row: SetupSkippableRow, skipped: boolean) {
  setBusy(row); setError(undefined);
  try { await api.skip(project, row, skipped); refresh(); }
  catch (caught) { setError(fixedSetupWords(caught, "That couldn't be saved just now. Try again.")); }
  finally { setBusy(undefined); }
 }
 const next = data.progress.nextRequired;
 const open = (row: SetupStatusRow) => row === next || (OPTIONAL.has(row) && data[row].state === "optional" && canChange);
 const skipButton = (row: SetupSkippableRow) => canChange && data[row].state === "optional" ? <Button busy={busy === row} data-testid={`checklist-skip-${row}`} onClick={() => { void skip(row, true); }}>Set up later</Button> : null;
 const runRow = data.setupRun;
 return <section className="rv-checklist" aria-labelledby="rv-checklist-heading" data-testid="project-checklist">
  <header className="rv-checklist-head">
   <h2 id="rv-checklist-heading">{data.progress.percent >= 100 ? "Setup finished" : "Finish setting up"}</h2>
   <p className="rv-checklist-progress" data-testid="checklist-progress"><progress max={100} value={data.progress.percent} aria-label="Setup progress" /> {data.progress.percent}% done ({data.progress.done} of {data.progress.total})</p>
  </header>
  {admin && <CompanySetupLine />}
  {!canChange && <AdminNames />}
  {error !== undefined && <p role="alert" data-testid="checklist-error"><VisibleText text={error} /></p>}
  <ol className="rv-checklist-rows">
   <Row name="repos" state={data.repos.state} open={open("repos")}>
    {data.repos.items.length === 0 ? <p>No repos in this project yet.</p> : <ul className="rv-checklist-chips" aria-label="Repos in this project">{data.repos.items.map(repo => <li key={repo.name}><VisibleText text={repo.fullName ?? repo.name} /></li>)}</ul>}
   </Row>
   <Row name="setupRun" state={runRow.state} open={open("setupRun") || runRow.state === "running" || runRow.state === "failed"}>
    <SetupRunRow project={project} row={runRow} onChanged={refresh} />
   </Row>
   <Row name="evalConfirm" state={data.evalConfirm.state} open={open("evalConfirm")}>
    {data.evalConfirm.blockedBy === "setupRun" ? <p>After the setup run, Rovara proposes how it checks work here.</p>
     : <EvalCard project={project} fallback={data.evalConfirm.report === "confirmed" ? <p>Rovara runs <code><VisibleText text={data.evalConfirm.confirmedSelection ?? "the confirmed checks"} /></code> before every pull request.</p>
      : data.evalConfirm.report === "reported" ? <>{(data.evalConfirm.suites ?? []).map(suite => <p key={suite.selection}>Rovara will run <code><VisibleText text={suite.selection} /></code> before every pull request.</p>)}<p className="rv-muted" data-testid="checklist-eval-not-yet">Approving these checks from the web isn't connected yet; a company owner or admin, or this project's admin, approves them where Rovara asks.</p></>
      : <p data-testid="checklist-eval-none">The setup run found no checks to confirm yet. Run setup again, or edit the test commands.</p>} />}
   </Row>
   <Row name="aiAndSpend" state={data.aiAndSpend.state} open={open("aiAndSpend")}>
    <p>{data.aiAndSpend.source === "project" && data.aiAndSpend.modelBudgetUsd !== null ? `This project's per-task limit: $${data.aiAndSpend.modelBudgetUsd.toFixed(2)}.` : "Same as company."}</p>
    {canChange && <p><Link to={`/app/projects/${encodeURIComponent(project)}?tab=settings`}>Change in Project settings</Link></p>}
   </Row>
   {/* Lead 4 W6: the project wiki is one more row here, not a second setup page. It is not counted in the progress above (Code computes that) and is absent while Code has no wiki build. */}
   <WikiChecklistRow project={project} companyAdmin={admin} />
   {/* L4-EVCI2: "Eval check from your CI" is one more row, not counted in the progress above (Code computes that) and absent while Code does not serve it. */}
   <EvalCheckRow project={project} />
   <Row name="slackChannel" state={data.slackChannel.state} open={open("slackChannel")}>
    <SlackChannelRow project={project} mode="checklist" canEdit={canChange} skipped={data.slackChannel.state === "skipped"} {...(canChange ? { onSkip: () => { void skip("slackChannel", true); }, onUndoSkip: () => { void skip("slackChannel", false); } } : {})} />
   </Row>
   <Row name="linear" state={data.linear.state} open={open("linear")}>
    <LinearTeamRow project={project} mode="checklist" canEdit={canChange} skipped={data.linear.state === "skipped"} {...(canChange ? { onSkip: () => { void skip("linear", true); }, onUndoSkip: () => { void skip("linear", false); } } : {})} />
   </Row>
   <Row name="invites" state={data.invites.state} open={open("invites")}>
    {data.invites.state === "skipped" ? <><p>Skipped. You can invite teammates any time.</p>{canChange && <Button busy={busy === "invites"} onClick={() => { void skip("invites", false); }}>Invite now</Button>}</>
     : <><p>Bring teammates in with an invite link.</p><div className="rv-connect-actions">{admin && <Link className="rv-button" to="/app/admin/invites">Invite teammates</Link>}{skipButton("invites")}</div></>}
   </Row>
   <Row name="firstTask" state={data.firstTask.state} open={open("firstTask")}>
    {data.firstTask.hasTask ? <p>Work has started here.</p> : data.firstTask.canStart ? <><p>Everything needed is done.</p><Link className="rv-button rv-button-primary" data-testid="checklist-start-task" to={`/app/projects/${encodeURIComponent(project)}#start-work`}>Start your first task</Link></> : <p>Finish the setup run, the checks and the spend limit first.</p>}
   </Row>
  </ol>
 </section>;
}
