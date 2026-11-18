// L4-U5 (setup-upkeep-plan.md step 3c): the "Setup needs repair" card on a project's page, and the "Re-check setup" button for the people who maintain the setup. Silent when the setup works. The card says what the
// chat thread and the admins' notice say, in the same words (`SETUP_REPAIR_SENTENCES`): the title, the sentence with the check's own failing step, and ONE action that fits ("Fix setup" with what it costs, or
// "Approve new setup" while a checked fix waits). Information budget: shown by default the title, the sentence, the action and "Re-check setup"; one click away what changed; never hashes, logs or digests. A person
// who may not act reads the same words and "The project's admins have been asked to fix it." The cost words are on this page only (Slack and Linear carry none). Code decides who may; this page only asks.
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SETUP_REPAIR_SENTENCES, type SetupRepairView } from "@agentx/contracts/web";
import { fixedSetupRepairWords, setupRepairKey, useSetupRepairApi } from "../../api/setup-repair.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SetupRunControls } from "./SetupRunRow.js";
import "./setup-repair.css";

function useSetupRepair(project: string) {
 const api = useSetupRepairApi();
 return useQuery({ queryKey: setupRepairKey(project), queryFn: () => api.read(project), retry: false, refetchOnWindowFocus: false });
}

/** "Re-check setup" for a person who manages the project's setup (Code's plain check, no AI). `onStarted` runs after Code took the start. */
export function RecheckSetupButton({ project, view }: { project: string; view: SetupRepairView }) {
 const api = useSetupRepairApi(), query = useQueryClient();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [started, setStarted] = useState(false), [requestId, setRequestId] = useState(() => crypto.randomUUID());
 if (!view.canManage) return null;
 async function recheck() {
  setBusy(true); setError(undefined);
  try {
   await api.recheck(project, requestId);
   setStarted(true); setRequestId(crypto.randomUUID());
   void query.invalidateQueries({ queryKey: setupRepairKey(project) });
   void query.invalidateQueries({ queryKey: setupChecklistKey(project) });
  } catch (caught) { setError(fixedSetupRepairWords(caught, "Couldn't start the check just now. Try again.")); }
  finally { setBusy(false); }
 }
 return <span className="rv-setup-recheck" data-testid="setup-recheck">
  <Button busy={busy} data-testid="setup-recheck-button" onClick={() => { void recheck(); }}>{SETUP_REPAIR_SENTENCES.recheck}</Button>
  {started && <span role="status" className="rv-muted" data-testid="setup-recheck-started"> Checking setup again.</span>}
  {error !== undefined && <span role="alert" data-testid="setup-recheck-error"> <VisibleText text={error} /></span>}
 </span>;
}

/** The project's setup page card: nothing while the setup works (or while Code has no such read). */
export function SetupRepairCard({ project }: { project: string }) {
 const read = useSetupRepair(project), query = useQueryClient();
 if (read.isPending || read.isError || read.data === undefined) return null;
 const view = read.data;
 const card = view.repair;
 if (card === undefined) return null;
 const action = card.actions[0];
 const onChanged = () => { void query.invalidateQueries({ queryKey: setupRepairKey(project) }); void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); };
 return <section className="rv-setup-repair" aria-labelledby="rv-setup-repair-title" data-testid="setup-repair-card" data-fix-ready={card.fixReady ? "true" : "false"}>
  <h2 id="rv-setup-repair-title">{SETUP_REPAIR_SENTENCES.title}</h2>
  <p data-testid="setup-repair-body"><VisibleText text={SETUP_REPAIR_SENTENCES.body(card.step)} /></p>
  <div className="rv-setup-repair-actions">
   {action?.id === "fix_setup" && <SetupRunControls project={project} againLabel={SETUP_REPAIR_SENTENCES.fixLabel} startLabel={SETUP_REPAIR_SENTENCES.fixLabel} onChanged={onChanged} />}
   {action?.id === "approve_new_setup" && <Link className="rv-button rv-button-primary" data-testid="setup-repair-approve" to={`/app/onboard?project=${encodeURIComponent(project)}&step=setup`}>{SETUP_REPAIR_SENTENCES.approveNewSetup}</Link>}
   <RecheckSetupButton project={project} view={view} />
  </div>
  {action === undefined && <p className="rv-muted" data-testid="setup-repair-reader">{SETUP_REPAIR_SENTENCES.readerNote}</p>}
  {card.changed !== undefined && <details><summary>{SETUP_REPAIR_SENTENCES.changedLabel}</summary><p data-testid="setup-repair-changed"><VisibleText text={card.changed} /></p></details>}
 </section>;
}

/** "Re-check setup" on its own (Project settings, next to "Re-run setup"): shown only to a person Code says may manage the project's setup. */
export function RecheckSetupRow({ project }: { project: string }) {
 const read = useSetupRepair(project);
 if (read.data === undefined) return null;
 return <RecheckSetupButton project={project} view={read.data} />;
}
