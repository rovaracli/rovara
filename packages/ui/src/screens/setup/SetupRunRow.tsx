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

type RunRow = ProjectSetupChecklist["setupRun"];
const minutes = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return `${String(m)} ${m === 1 ? "minute" : "minutes"}`; };
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Start, Run again and Stop, for a person Code says may manage the run (`status`: the checklist's, else the run's own). `againLabel` names the start when a run already ended. */
export function SetupRunControls({ project, status: given, onChanged, againLabel = "Run again" }: { project: string; status?: RunRow["status"]; onChanged: () => void; againLabel?: string }) {
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
   : <Button variant={status === "none" ? "primary" : "secondary"} busy={busy === "start"} data-testid="setup-run-start" onClick={() => { void act("start"); }}>{status === "none" ? "Run setup" : againLabel}</Button>}
  {error !== undefined && <p role="alert" data-testid="setup-run-error"><VisibleText text={error} /></p>}
 </div>;
}

export function SetupRunRow({ project, row, onChanged }: { project: string; row: RunRow; onChanged: () => void }) {
 const facts = [
  row.commandsFound === undefined ? undefined : `Commands found: ${String(row.commandsFound.setup)} to set up, ${String(row.commandsFound.tests)} to test.`,
  row.testOutcome === "passed" ? "Tests passed." : row.testOutcome === "failed" ? "Tests failed." : undefined,
  row.elapsedMs === undefined ? undefined : `Took ${minutes(row.elapsedMs)}${row.costCents === undefined ? "" : `, cost ${dollars(row.costCents)}`}.`,
 ].filter((one): one is string => one !== undefined);
 return <div data-testid="setup-run-row" data-status={row.status}>
  {row.status === "none" && <p>Rovara works out how to install and test this project in a throw-away sandbox with no secrets. It uses this project's AI budget.</p>}
  {row.status === "running" && <p role="status">Rovara is working out how to install and test the project. You can leave and come back.</p>}
  {row.status === "ready" && <p role="status">Rovara found how to set the project up.</p>}
  {row.status === "failed" && row.failure !== undefined && <p role="alert" data-testid="setup-run-failure"><VisibleText text={row.failure} /></p>}
  {facts.length > 0 && <p className="rv-muted" data-testid="setup-run-facts">{facts.join(" ")}</p>}
  {row.failedCommand !== undefined && <div className="rv-checklist-failed" data-testid="setup-run-failed-command">
   <p>Failed: <code><VisibleText text={row.failedCommand.command} /></code> {row.failedCommand.timedOut ? "(timed out)" : row.failedCommand.exitCode === null ? "" : `(exit ${String(row.failedCommand.exitCode)})`}</p>
   {row.failedCommand.lastLines.length > 0 && <pre aria-label="Its last lines"><VisibleText text={row.failedCommand.lastLines.join("\n")} /></pre>}
  </div>}
  {row.status === "ready" && <p className="rv-muted">Running it again only proposes: the working setup stays until someone confirms a new one.</p>}
  <div className="rv-connect-actions">
   <SetupRunControls project={project} status={row.status} onChanged={onChanged} />
   {row.status === "failed" && <Link className="rv-button" data-testid="setup-run-edit" to={`/app/onboard?project=${encodeURIComponent(project)}&step=setup`}>Edit commands</Link>}
  </div>
  {row.status !== "none" && <details><summary>What Rovara ran</summary><RunJournal project={project} running={row.status === "running"} /></details>}
 </div>;
}
