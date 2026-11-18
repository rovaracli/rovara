import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TICKET_UPDATE_LEVELS, TICKET_UPDATE_LEVEL_WORDS, TICKET_WRITE_ACCESS_WORDS, TicketUpdatesViewSchema, ticketUpdateLevelOf, type TicketUpdateLevel } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { Button } from "../../design/Button.js";

const reader = { parse: (value: unknown) => TicketUpdatesViewSchema.parse(value) };
const labels: Record<TicketUpdateLevel, string> = { status_only: "Status only", decisions: "Decisions", plan_decisions: "Plan + decisions", full: "Full" };

export function TicketUpdatesSettings({ project }: { project: string }) {
 const host = useAppHost(), api = createApiClient(host), query = useQueryClient(), key = ["ticket-updates", project];
 const read = useQuery({ queryKey: key, queryFn: () => api.get(`/v1/app/projects/${encodeURIComponent(project)}/intake/updates`, reader), retry: false });
 const [level, setLevel] = useState<TicketUpdateLevel>(), [comments, setComments] = useState<boolean>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 if (read.isPending) return <p role="status">Loading Linear sharing settings…</p>;
 if (read.isError || read.data === undefined) return <section className="rv-project-section" aria-label="Linear sharing"><h2>Linear sharing</h2><p role="alert">Couldn't load the ticket sharing settings. Try again.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const view = read.data, currentLevel = level ?? ticketUpdateLevelOf(view.settings), currentComments = comments ?? view.settings.comments;
 async function save() {
  setBusy(true);setError(undefined);setSaved(false);
  try {
   await api.sendAnswer("PUT", `/v1/app/projects/${encodeURIComponent(project)}/intake/updates`, { requestId: globalThis.crypto.randomUUID(), settings: { ...view.settings, comments: currentComments, level: currentLevel } }, reader, { retry: "never" });
   setLevel(undefined);setComments(undefined);setSaved(true);await query.invalidateQueries({ queryKey: key });
  } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the ticket sharing settings."); }
  finally { setBusy(false); }
 }
 const changed = currentLevel !== ticketUpdateLevelOf(view.settings) || currentComments !== view.settings.comments;
 return <section className="rv-project-section" aria-label="Linear sharing" data-testid="ticket-updates-settings">
  <h2>Linear sharing</h2>
  <p>Linear comments are visible to everyone who can see the ticket.</p>
  {view.access.filter(access => access.state === "needs_write_access").map(access => <p key={access.tracker} className="rv-muted">{TICKET_WRITE_ACCESS_WORDS[access.tracker]}</p>)}
  {!view.canEdit && <p className="rv-muted">Only company owners and admins, or this project's admins, can change these settings.</p>}
  <fieldset disabled={!view.canEdit || busy}>
   <legend>What Rovara can write on Linear tickets</legend>
   {TICKET_UPDATE_LEVELS.map(value => <label key={value} className="rv-choice"><input type="radio" name={`ticket-update-level-${project}`} value={value} checked={currentLevel === value} onChange={() => { setLevel(value);setSaved(false); }} /><span><strong>{labels[value]}</strong><br />{TICKET_UPDATE_LEVEL_WORDS[value]}</span></label>)}
   <label className="rv-choice"><input type="checkbox" checked={currentComments} onChange={event => { setComments(event.target.checked);setSaved(false); }} /><span><strong>Post comments</strong><br />Turn this off to stop all ticket comments.</span></label>
  </fieldset>
  {view.canEdit && <Button variant="primary" busy={busy} disabled={!changed} onClick={() => { void save(); }}>Save sharing settings</Button>}
  {saved && <p role="status">Linear sharing settings saved.</p>}
  {error !== undefined && <p role="alert">{error}</p>}
  <p className="rv-muted">Tasks only their owner can see always stay at status-only on Linear.</p>
 </section>;
}
