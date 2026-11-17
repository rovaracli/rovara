// Guided onboarding PR 11 (design 3d, DEC 254k): a project's Linear team. "Connect Linear" the first time (once per company), then "Pick a Linear team". One
// component for the project checklist (optional, "Set up later"; PR 9 places it) and for Project settings (add, change, remove).
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntegrationsApi } from "../../api/integrations.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { LinearConnectButton } from "./LinearConnect.js";
import { readFailure } from "./read-failure.js";
import "./connect.css";

type Mode = "checklist" | "settings";
interface Props { project: string; mode: Mode; canEdit: boolean; skipped?: boolean; onSkip?: () => void; onUndoSkip?: () => void }
export type LinearRowState = "done" | "optional" | "skipped";

export function LinearTeamRow({ project, mode, canEdit, skipped = false, onSkip, onUndoSkip }: Props) {
 const api = useIntegrationsApi(), query = useQueryClient();
 const status = useQuery({ queryKey: ["linear", "status"], queryFn: api.linearStatus, retry: false });
 const connected = status.data?.status === "connected";
 const team = useQuery({ queryKey: ["linear", "team", project], queryFn: () => api.projectTeam(project), enabled: connected && canEdit, retry: false });
 const [editing, setEditing] = useState(false), [chosen, setChosen] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [note, setNote] = useState<string>();
 const picked = team.data?.team ?? undefined;
 async function act(run: () => Promise<unknown>, done: string) {
  setBusy(true);setError(undefined);
  try { await run();setNote(done);setEditing(false);setChosen(undefined);void query.invalidateQueries({ queryKey: ["linear", "team", project] }); }
  catch (e) { setError(e instanceof Error ? e.message : "Linear's teams could not be read just now; try again."); }
  finally { setBusy(false); }
 }
 const state: LinearRowState = picked !== undefined ? "done" : skipped ? "skipped" : "optional";
 const wrap = (children: ReactNode) => <section className="rv-connect-row" aria-label="Linear" data-testid="linear-row" data-state={state}><h3>Linear {mode === "checklist" && <span className="rv-connect-optional">{state === "done" ? "Done" : state === "skipped" ? "Skipped (optional)" : "Optional"}</span>}</h3>{children}</section>;
 if (status.isPending) return wrap(<p>Checking Linear…</p>);
 if (status.isError) return wrap(<><p data-testid="linear-read-error"><VisibleText text={readFailure(status.error, "Couldn't read the Linear connection just now; try again.")} /></p><Button onClick={() => { void status.refetch(); }}>Try again</Button></>);
 if (mode === "checklist" && skipped && picked === undefined) return wrap(<><p data-testid="linear-skipped">Skipped. You can connect Linear later in Project settings.</p>{onUndoSkip !== undefined && <Button onClick={onUndoSkip}>Set it up now</Button>}</>);
 if (!connected) return wrap(<>
  <p data-testid="linear-not-connected">{status.data.status === "needs_reconnect" ? "Linear needs reconnecting." : "Connect Linear once for your company, then pick this project's team."}</p>
  {canEdit && <div className="rv-connect-actions"><LinearConnectButton label={status.data.workspace === undefined ? "Connect Linear" : "Reconnect Linear"} />{mode === "checklist" && onSkip !== undefined && <Button data-testid="linear-skip" onClick={onSkip}>Set up later</Button>}</div>}
 </>);
 const workspaceLine = status.data.workspace === undefined ? null : <p className="rv-connect-note">Linear workspace: <VisibleText text={status.data.workspace.name} /></p>;
 if (!canEdit) return wrap(<>{workspaceLine}<p>A company owner or admin, or this project's admin, can pick its Linear team.</p></>);
 if (team.isPending) return wrap(<p>Loading Linear teams…</p>);
 if (team.isError) return wrap(<><p data-testid="linear-error"><VisibleText text={readFailure(team.error, "Linear's teams could not be read just now; try again.")} /></p><Button onClick={() => { void team.refetch(); }}>Try again</Button></>);
 if (picked !== undefined && !editing) return wrap(<>
  {workspaceLine}
  <p role="status" data-testid="linear-team">Team: <strong><VisibleText text={`${picked.name} (${picked.key})`} /></strong></p>
  <div className="rv-connect-actions"><Button data-testid="linear-team-change" onClick={() => { setEditing(true);setNote(undefined); }}>Change</Button><Button busy={busy} data-testid="linear-team-remove" onClick={() => { void act(() => api.clearTeam(project), "Linear team removed."); }}>Remove</Button></div>
  {error !== undefined && <p role="alert" data-testid="linear-error"><VisibleText text={error} /></p>}
 </>);
 return wrap(<>
  {workspaceLine}
  {note !== undefined && <p role="status" data-testid="linear-note"><VisibleText text={note} /></p>}
  <Select label="Linear team" value={chosen ?? picked?.id ?? ""} onValueChange={setChosen} options={team.data.teams.map(one => ({ value: one.id, label: `${one.name} (${one.key})` }))} placeholder="Pick a Linear team" />
  <div className="rv-connect-actions">
   <Button variant="primary" busy={busy} disabled={chosen === undefined || chosen === picked?.id} data-testid="linear-team-save" onClick={() => { if (chosen !== undefined) void act(() => api.pickTeam(project, chosen), "Linear team saved."); }}>Use this team</Button>
   {editing && <Button onClick={() => setEditing(false)}>Cancel</Button>}
   {mode === "checklist" && onSkip !== undefined && picked === undefined && <Button data-testid="linear-skip" onClick={onSkip}>Set up later</Button>}
  </div>
  {team.data.teams.length === 0 && <p>The Linear workspace has no teams Rovara can see.</p>}
  {error !== undefined && <p role="alert" data-testid="linear-error"><VisibleText text={error} /></p>}
 </>);
}
