import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmCard } from "./ConfirmCard.js";
import { SetupApprovalCard } from "./SetupApprovalCard.js";
import { PartialProposal } from "./PartialProposal.js";
import { CommandBox, SteerBox } from "./RunControls.js";
import { RunJournal } from "./RunJournal.js";
import { APPROVAL_WORDS, STOP_WORDS } from "./words.js";
import { SETUP_LOCKS } from "./limits-text.js";
import { setupAgentKey, setupAgentRefetch } from "./SetupReview.js";
import { useHostsStopWords } from "./useHostsStopWords.js";

/**
 * Setup with a run (SH15, behind the `su` switch): Rovara runs the project's own commands in a throw-away sandbox, the page shows what it ran and which addresses it asked for, a maintainer can steer it or run a
 * command, and "Use this setup" proposes what worked. With the switch off the server answers "not found" and this shows nothing at all.
 */
export default function SetupRunSection({ project, settingsRevision, onDecided }: { project: string; settingsRevision: number; /** A candidate was approved (the project's settings changed): the page reads the project again. */ onDecided?: () => void }) {
  const api = useSetupAgentApi();
  const client = useQueryClient();
  const key = setupAgentKey(project);
  const query = useQuery({ queryKey: key, queryFn: () => api.read(project), retry: false, refetchInterval: setupAgentRefetch });
  const [decided, setDecided] = useState<"approved" | "rejected" | "discarded">();
  const [busy, setBusy] = useState<"start" | "stop">(), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const view = query.data;
  // The cause of a stop on addresses is read from the run's address requests; a failed or missing read is "unknown".
  const hostWords = useHostsStopWords(project, view?.stop === "hosts_waiting" && view.status !== "running");
  if (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.code === "INVALID_RESPONSE")) return null;
  if (query.isPending) return null;
  if (query.isError || view === undefined) return <section aria-label="Set up with Rovara"><h3>Set up with Rovara</h3><p role="alert">Couldn't load the setup run.</p><Button onClick={() => { void query.refetch(); }}>Try again</Button></section>;
  async function act(kind: "start" | "stop") {
    setBusy(kind); setError(undefined); setDecided(undefined);
    try { client.setQueryData(key, await (kind === "start" ? api.start(project, requestId) : api.stop(project, requestId))); setRequestId(crypto.randomUUID()); void client.invalidateQueries({ queryKey: ["onboard", "setup-journal", project] }); } catch (caught) { setError(caught instanceof ApiError ? caught.message : "Couldn't do that. Try again."); } finally { setBusy(undefined); }
  }
  const running = view.status === "running";
  const apply = view.apply;
  function finished(reply: { decision: "approved" | "rejected" } | "discarded") {
    setDecided(reply === "discarded" ? "discarded" : reply.decision);
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] });
    void client.invalidateQueries({ queryKey: ["setup-run", project] });
    void client.invalidateQueries({ queryKey: ["setup-checklist", project] });
    if (reply !== "discarded" && reply.decision === "approved") onDecided?.();
  }
  // A company admin turned setup runs off (or the company's locks do not read, which holds every start): nothing can be started, so no start button is offered. A run that is already going keeps its Stop.
  const off = view.companySetupOff === true, unreadable = view.companyLocksUnreadable === true;
  return <section aria-label="Set up with Rovara">
    <h3>Set up with Rovara</h3>
    {off && <p role="status"><strong>{SETUP_LOCKS.AGENT_OFF}</strong>. {unreadable ? SETUP_LOCKS.UNREADABLE_RUNS : SETUP_LOCKS.AGENT_OFF_HELP}</p>}
    {view.status !== "running" && <p>Rovara can run your project's own setup and test commands in a throw-away sandbox with no secrets, see what fails, and propose commands that worked. It uses the model budget of this project.</p>}
    {view.status !== "running" && !off && view.standInWriter !== undefined && <p data-testid="stand-in-writer"><VisibleText text={view.standInWriter.words} /></p>}
    {running && <p role="status">Rovara is setting the project up. You can leave and come back.</p>}
    {view.status === "failed" && view.failure !== undefined && (view.stop === "hosts_waiting" ? <p role="alert" data-testid="hosts-stop">{hostWords}</p> : <p role="alert"><VisibleText text={view.failure} /></p>)}
    {view.status === "ready" && view.stop !== undefined && <p role="status" {...(view.stop === "hosts_waiting" ? { "data-testid": "hosts-stop" } : {})}>{view.stop === "hosts_waiting" ? hostWords : STOP_WORDS[view.stop]}</p>}
    {!running && !off && <Button busy={busy === "start"} onClick={() => { void act("start"); }}>{view.status === "none" ? "Let Rovara run the setup" : "Run it again"}</Button>}
    {running && <Button variant="danger" busy={busy === "stop"} onClick={() => { void act("stop"); }}>Stop</Button>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
    {running && view.sessionId !== undefined && <SteerBox sessionId={view.sessionId} />}
    {running && <CommandBox project={project} onRan={() => { void client.invalidateQueries({ queryKey: ["onboard", "setup-journal", project] }); }} />}
    {view.status !== "none" && <RunJournal project={project} running={running} />}
    {view.status === "failed" && view.stop === "stopped_by_person" && view.proposal !== undefined && view.stoppedBy !== undefined && <PartialProposal view={{ ...view, proposal: view.proposal, stoppedBy: view.stoppedBy }} />}
    {decided !== undefined && apply === undefined && <p role="status" data-testid="setup-decided">{APPROVAL_WORDS[decided]}</p>}
    {apply !== undefined && <SetupApprovalCard project={project} apply={apply} canManage={view.canManage === true} onDecided={reply => { finished(reply); }} onRefresh={() => { void query.refetch(); }} />}
    {apply === undefined && view.status === "ready" && view.proposal !== undefined && <ConfirmCard project={project} view={{ ...view, proposal: view.proposal }} settingsRevision={settingsRevision} onProposed={() => { void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ["onboard", "test-environment", project] }); }} />}
  </section>;
}
