import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmCard } from "./ConfirmCard.js";
import { PartialProposal } from "./PartialProposal.js";
import { CommandBox, SteerBox } from "./RunControls.js";
import { RunJournal } from "./RunJournal.js";
import { STOP_WORDS } from "./words.js";

/**
 * Setup with a run (SH15, behind the `su` switch): Rovara runs the project's own commands in a throw-away sandbox, the page shows what it ran and which websites it asked for, a maintainer can steer it or run a
 * command, and "Use this setup" proposes what worked. With the switch off the server answers "not found" and this shows nothing at all.
 */
export default function SetupRunSection({ project, settingsRevision }: { project: string; settingsRevision: number }) {
  const api = useSetupAgentApi();
  const client = useQueryClient();
  const key = ["onboard", "setup-agent", project];
  const query = useQuery({ queryKey: key, queryFn: () => api.read(project), retry: false, refetchInterval: current => (current.state.data?.status === "running" ? 4000 : false) });
  const [busy, setBusy] = useState<"start" | "stop">(), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const view = query.data;
  if (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.code === "INVALID_RESPONSE")) return null;
  if (query.isPending) return null;
  if (query.isError || view === undefined) return <section aria-label="Set up with Rovara"><h3>Set up with Rovara</h3><p role="alert">Couldn't load the setup run.</p><Button onClick={() => { void query.refetch(); }}>Try again</Button></section>;
  async function act(kind: "start" | "stop") {
    setBusy(kind); setError(undefined);
    try { client.setQueryData(key, await (kind === "start" ? api.start(project, requestId) : api.stop(project, requestId))); setRequestId(crypto.randomUUID()); void client.invalidateQueries({ queryKey: ["onboard", "setup-journal", project] }); } catch (caught) { setError(caught instanceof ApiError ? caught.message : "Couldn't do that. Try again."); } finally { setBusy(undefined); }
  }
  const running = view.status === "running";
  return <section aria-label="Set up with Rovara">
    <h3>Set up with Rovara</h3>
    {view.status !== "running" && <p>Rovara can run your project's own setup and test commands in a throw-away sandbox with no secrets, see what fails, and propose commands that worked. It uses the model budget of this project.</p>}
    {running && <p role="status">Rovara is setting the project up. You can leave and come back.</p>}
    {view.status === "failed" && view.failure !== undefined && <p role="alert"><VisibleText text={view.failure} /></p>}
    {view.status === "ready" && view.stop !== undefined && <p role="status">{STOP_WORDS[view.stop]}</p>}
    {!running && <Button busy={busy === "start"} onClick={() => { void act("start"); }}>{view.status === "none" ? "Let Rovara run the setup" : "Run it again"}</Button>}
    {running && <Button variant="danger" busy={busy === "stop"} onClick={() => { void act("stop"); }}>Stop</Button>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
    {running && view.sessionId !== undefined && <SteerBox sessionId={view.sessionId} />}
    {running && <CommandBox project={project} onRan={() => { void client.invalidateQueries({ queryKey: ["onboard", "setup-journal", project] }); }} />}
    {view.status !== "none" && <RunJournal project={project} running={running} />}
    {view.status === "failed" && view.stop === "stopped_by_person" && view.proposal !== undefined && view.stoppedBy !== undefined && <PartialProposal view={{ ...view, proposal: view.proposal, stoppedBy: view.stoppedBy }} />}
    {view.status === "ready" && view.proposal !== undefined && <ConfirmCard project={project} view={{ ...view, proposal: view.proposal }} settingsRevision={settingsRevision} onProposed={() => { void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] }); }} />}
  </section>;
}
