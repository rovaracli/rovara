// Guided onboarding PR 9: the checklist's "Setup run" row and Project settings' "Re-run setup" (DEC 254n item 3, 254o c), on the hosted setup run (Code #844
// through Cloud). What the row says comes from the checklist read (Code #841: state, start, time, cost, commands found, the failing command and its last lines);
// whether this person may start or stop comes from Code's own answer (`canManage`: a company owner or admin, or the project's admin). A re-run only proposes:
// the project's working setup stays until someone confirms a new one.
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSetupChecklist } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { checklistAbsent, fixedSetupWords, setupChecklistKey } from "../../api/setup-checklist.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { RunJournal } from "./RunJournal.js";
import { REVIEW_TEXT, SetupReview, type SetupReviewState } from "./SetupReview.js";

type RunRow = ProjectSetupChecklist["setupRun"];
const minutes = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return `${String(m)} ${m === 1 ? "minute" : "minutes"}`; };
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Start, Run again and Stop, for a person Code says may manage the run (`status`: the checklist's, else the run's own). `againLabel` names the start when a run already ended. */
export function SetupRunControls({ project, status: given, onChanged, againLabel = "Run again", startLabel }: { project: string; status?: RunRow["status"]; onChanged: () => void; againLabel?: string; /** A label that replaces both "Run setup" and `againLabel` (the repair card's "Fix setup ..."). */ startLabel?: string }) {
 const api = useSetupAgentApi(), query = useQueryClient();
 const run = useQuery({ queryKey: ["setup-run", project], queryFn: () => api.read(project), retry: false });
 const [busy, setBusy] = useState<"start" | "stop">(), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
 if (run.isError) return checklistAbsent(run.error) ? <p className="rv-muted" data-testid="setup-run-not-yet">Setting up with Rovara isn't available on this Rovara yet.</p> : null;
 if (run.data === undefined || (run.data as { canManage?: unknown }).canManage !== true) return null;
 const status = given ?? run.data.status;
 async function act(kind: "start" | "stop") {
  setBusy(kind); setError(undefined);
  try {
   query.setQueryData(["setup-run", project], await (kind === "start" ? api.start(project, requestId) : api.stop(project, requestId)));
   setRequestId(crypto.randomUUID());
   void query.invalidateQueries({ queryKey: setupChecklistKey(project) });
   void query.invalidateQueries({ queryKey: ["onboard", "setup-journal", project] });
   onChanged();
  } catch (caught) { setError(fixedSetupWords(caught, "Couldn't do that just now. Try again.")); }
  finally { setBusy(undefined); }
 }
 return <div className="rv-connect-actions" data-testid="setup-run-controls">
  {status === "running"
   ? <Button variant="danger" busy={busy === "stop"} data-testid="setup-run-stop" onClick={() => { void act("stop"); }}>Stop</Button>
   : <Button variant={status === "none" ? "primary" : "secondary"} busy={busy === "start"} data-testid="setup-run-start" onClick={() => { void act("start"); }}>{startLabel ?? (status === "none" ? "Run setup" : againLabel)}</Button>}
  {error !== undefined && <p role="alert" data-testid="setup-run-error"><VisibleText text={error} /></p>}
 </div>;
}

const approvedOn = (at: string | undefined): string => { const date = at === undefined ? undefined : new Date(at); return date === undefined || Number.isNaN(date.getTime()) ? "" : ` on ${date.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })}`; };

/** L4-T2c: the fixed words for a newer proposal that sits beside the approved setup (Code's `newerProposal`; never a word of Code's own). */
export const NEWER_PROPOSAL_WORDS: Readonly<Record<NonNullable<RunRow["newerProposal"]>, string>> = Object.freeze({
 needs_you: "A newer setup proposal is waiting for review",
 checking: "A newer setup proposal is being checked on a fresh machine",
 rejected: "A newer setup proposal was rejected; the approved setup is still in use",
});

/** The approved setup's line: its check is ready (Done), going, failed (with Code's reason) or not run on a fresh machine yet. */
function ApprovedLine({ row }: { row: RunRow }) {
 const status = row.check?.status;
 if (status === "ready") return row.state !== "done" ? null : <p role="status" data-testid="setup-run-approved">Setup approved{approvedOn(row.approvedAt)}. Checked on a fresh machine.</p>;
 if (status === "checking") return <p role="status" data-testid="setup-run-approved-checking"><strong>{REVIEW_TEXT.checking}</strong></p>;
 if (status === "failed") return <p role="alert" data-testid="setup-run-approved-failed"><strong>Needs you: the approved setup failed its check.</strong>{row.check?.failedStep === undefined ? null : <> <VisibleText text={row.check.failedStep} /></>}</p>;
 return <p role="status" data-testid="setup-run-approved-unchecked"><strong>Needs you: the approved setup has not been checked on a fresh machine.</strong></p>;
}

export function SetupRunRow({ project, row, onChanged, review }: { project: string; row: RunRow; onChanged: () => void; /** L4-T1: where a setup of Rovara's waits for a person; its cards are mounted here, so no page change is needed to approve. */ review?: SetupReviewState }) {
 const facts = [
  row.commandsFound === undefined ? undefined : `Commands found: ${String(row.commandsFound.setup)} to set up, ${String(row.commandsFound.tests)} to test.`,
  row.testOutcome === "passed" ? "Tests passed." : row.testOutcome === "failed" ? "Tests failed." : undefined,
  row.elapsedMs === undefined ? undefined : `Took ${minutes(row.elapsedMs)}${row.costCents === undefined ? "" : `, cost ${dollars(row.costCents)}`}.`,
 ].filter((one): one is string => one !== undefined);
 // L4-T2c: a newer proposal beside the approved setup says so in fixed words instead of the review line; its cards (below) are the same ones a first proposal gets.
 const newer = row.approval === "approved" ? row.newerProposal : undefined;
 return <div data-testid="setup-run-row" data-status={row.status}>
  {row.status === "none" && <p>Rovara works out how to install and test this project in a throw-away sandbox with no secrets. It uses this project's AI budget.</p>}
  {row.status === "running" && <p role="status">Rovara is working out how to install and test the project. You can leave and come back.</p>}
  {row.status === "ready" && newer === undefined && (review === undefined || review.stage === "none" ? <p role="status">Rovara found how to set the project up.</p> : <p role="status" data-testid="setup-run-needs-you"><strong>{REVIEW_TEXT[review.stage]}</strong></p>)}
  {newer !== undefined && <p role="status" data-testid="setup-run-newer-proposal" data-newer={newer}>{newer === "needs_you" ? <strong>{NEWER_PROPOSAL_WORDS[newer]}</strong> : NEWER_PROPOSAL_WORDS[newer]}</p>}
  {review !== undefined && <SetupReview project={project} review={review} />}
  {/* L4-T2: what the row says once a person approved a setup: done only with a passing check; otherwise what is wrong with the check. Never while the review cards say what waits. */}
  {row.approval === "approved" && (newer !== undefined || review === undefined || review.stage === "none") && <ApprovedLine row={row} />}
  {row.status === "failed" && row.failure !== undefined && <p role="alert" data-testid="setup-run-failure"><VisibleText text={row.failure} /></p>}
  {facts.length > 0 && <p className="rv-muted" data-testid="setup-run-facts">{facts.join(" ")}</p>}
  {row.failedCommand !== undefined && <div className="rv-checklist-failed" data-testid="setup-run-failed-command">
   <p>Failed: <code><VisibleText text={row.failedCommand.command} /></code> {row.failedCommand.timedOut ? "(timed out)" : row.failedCommand.exitCode === null ? "" : `(exit ${String(row.failedCommand.exitCode)})`}</p>
   {row.failedCommand.lastLines.length > 0 && <pre aria-label="Its last lines"><VisibleText text={row.failedCommand.lastLines.join("\n")} /></pre>}
  </div>}
  {row.status === "ready" && <p className="rv-muted">Running it again only proposes: the working setup stays until someone confirms a new one.</p>}
  <div className="rv-connect-actions">
   <SetupRunControls project={project} status={row.status} onChanged={() => { review?.reset(); onChanged(); }} />
   {row.status === "failed" && <Link className="rv-button" data-testid="setup-run-edit" to={`/app/onboard?project=${encodeURIComponent(project)}&step=setup`}>Edit commands</Link>}
  </div>
  {row.status !== "none" && <details><summary>What Rovara ran</summary><RunJournal project={project} running={row.status === "running"} /></details>}
 </div>;
}
