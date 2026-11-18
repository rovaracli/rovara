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
import { useSetupReview } from "./SetupReview.js";
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
 repos: "Repos", setupRun: "Setup run", evalConfirm: "AI evals", aiAndSpend: "AI for your agents",
 slackChannel: "Slack channel", linear: "Linear", invites: "Invite teammates", firstTask: "Start your first task",
});
/** What the AI row says while no AI can be called (setup review G6). */
export const AI_NEEDS_YOU = "Needs you: connect an AI key or choose Rovara's AI";
/** L4-T2c: a newer proposal beside the approved setup: the row keeps what Code says about the approved setup (Done while its check is ready); the waiting proposal is named and its cards are shown. */
const hasNewer = (run: ProjectSetupChecklist["setupRun"]): boolean => run.approval === "approved" && run.newerProposal !== undefined;
const waitingNewer = (run: ProjectSetupChecklist["setupRun"]): boolean => run.approval === "approved" && (run.newerProposal === "needs_you" || run.newerProposal === "checking");
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
  refetchInterval: current => (current.state.data?.setupRun.state === "running" || current.state.data?.setupRun.newerProposal === "checking" ? 5000 : false),
 });
 const [busy, setBusy] = useState<SetupSkippableRow | "evalNone">(), [error, setError] = useState<string>();
 // L4-T1: a setup waiting for a person is reviewed and approved in the Setup run row, not on another page. Asked only once the checklist says a run finished.
 const review = useSetupReview(project, status.data?.setupRun.status === "ready" && (status.data.progress.percent < 100 || place === "onboard" || waitingNewer(status.data.setupRun)));
 if (status.isError && checklistAbsent(status.error)) return null;
 if (status.isPending) return <Skeleton label="Loading the setup checklist" />;
 if (status.isError) return <section className="rv-checklist" aria-label="Finish setting up"><p role="status" data-testid="checklist-read-error"><VisibleText text={fixedSetupWords(status.error, "The project's setup couldn't be read just now. Try again.")} /></p><Button onClick={() => { void status.refetch(); }}>Try again</Button></section>;
 const data: ProjectSetupChecklist = status.data;
 const canChange = data.viewer.canSkip, admin = data.viewer.companyRole === "owner" || data.viewer.companyRole === "admin";
 // L4-T2c: a finished checklist whose approved setup has a newer proposal waiting (or being checked) stays, so the proposal can be reviewed where it is named; a rejected one needs no decision, and a person who cannot change the project has nothing to do about one, so they leave with the rest. It is read again every 5 s while its check goes (Code keeps the row Done meanwhile).
 // A finished checklist leaves the project page, but the wiki's controls (Refresh now, the agents switch, Delete, nightly upkeep) stay reachable for the people who may use them (lead 4 W6).
 if (data.progress.percent >= 100 && place === "project" && !(canChange && waitingNewer(data.setupRun))) return canChange ? <><WikiChecklistRow project={project} companyAdmin={admin} alone /><EvalCheckRow project={project} alone /></> : null;
 const refresh = () => { void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); };
 async function skip(row: SetupSkippableRow, skipped: boolean) {
  setBusy(row); setError(undefined);
  try { await api.skip(project, row, skipped); refresh(); }
  catch (caught) { setError(fixedSetupWords(caught, "That couldn't be saved just now. Try again.")); }
  finally { setBusy(undefined); }
 }
 async function evalNone(noEvals: boolean) {
  setBusy("evalNone"); setError(undefined);
  try { await api.evalNone(project, noEvals); refresh(); }
  catch (caught) { setError(fixedSetupWords(caught, "That couldn't be saved just now. Try again.")); }
  finally { setBusy(undefined); }
 }
 const noEvalsButton = canChange ? <Button busy={busy === "evalNone"} data-testid="checklist-eval-no-evals" onClick={() => { void evalNone(true); }}>This project has no AI evals</Button> : null;
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
   {/* L4-T2: Code says the truth: Done only with an approved setup whose check is ready, Needs you while a proposal or a candidate waits or the check failed, Running while the check goes. The review read below is only ever fresher (it is asked again every 5 s while the check goes), so what it says about a waiting setup wins. */}
   <Row name="setupRun" state={review.stage === "none" || hasNewer(runRow) ? runRow.state : review.stage === "checking" ? "running" : "needs_you"} open={open("setupRun") || waitingNewer(runRow) || runRow.state === "running" || runRow.state === "failed" || review.stage !== "none"}>
    <SetupRunRow project={project} row={runRow} onChanged={refresh} review={review} />
   </Row>
   {/* L4-T5 (owner D9): the AI evals row shows only when the setup run found evals. A finished run that found none leaves nothing to confirm: Code marks the row done by itself, and nothing is shown here. */}
   {!(data.evalConfirm.state === "done" && data.evalConfirm.report === "none") && <Row name="evalConfirm" state={data.evalConfirm.state} open={open("evalConfirm")}>
    {data.evalConfirm.blockedBy === "setupRun" ? <p>After the setup run, Rovara looks for AI evals in your repos.</p>
     : data.evalConfirm.report === "no_evals" ? <><p data-testid="checklist-eval-no-evals-set">No AI evals for this project: Rovara checks work with the project's own tests.</p>{canChange && <Button busy={busy === "evalNone"} data-testid="checklist-eval-no-evals-undo" onClick={() => { void evalNone(false); }}>This project has AI evals after all</Button>}</>
     : <EvalCard project={project} fallback={data.evalConfirm.report === "confirmed" ? <p>Rovara runs <code><VisibleText text={data.evalConfirm.confirmedSelection ?? "the confirmed checks"} /></code> before every pull request.</p>
      : data.evalConfirm.report === "reported" ? <>{(data.evalConfirm.suites ?? []).map(suite => <p key={suite.selection}>Rovara will run <code><VisibleText text={suite.selection} /></code> before every pull request.</p>)}<p className="rv-muted" data-testid="checklist-eval-not-yet">Confirming these checks from the web isn't connected yet; a company owner or admin, or this project's admin, confirms them where Rovara asks.</p>{noEvalsButton}</>
      : <><p data-testid="checklist-eval-none">Rovara has not found AI evals in this project yet. Run setup again, or edit the test commands.</p>{noEvalsButton}</>} />}
   </Row>}
   {/* L4-T2 (D10): the project's "AI and spend limit" row is gone. This row shows only when no AI can be called (Code's or Cloud's `needs_you`), and says what to do about it. */}
   {data.aiAndSpend.state !== "done" && <Row name="aiAndSpend" state={data.aiAndSpend.state} open={open("aiAndSpend")}>
    <p data-testid="checklist-ai-needs-you"><strong>{AI_NEEDS_YOU}</strong></p>
    {admin ? <p><Link className="rv-button rv-button-primary" to="/app/admin/agent-ai">Connect an AI</Link></p> : <p className="rv-muted">Ask your company's admins to connect an AI key or choose Rovara's AI.</p>}
   </Row>}
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
