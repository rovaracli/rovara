// Slice 5 "Outside tools": the project's tickets from Linear, Jira and GitHub, in the project's settings (its own chunk). People who can start tasks see the tickets that wait, with why, and press
// Start or Not this one. Maintainers set the watched sources (each failing one says why) and what Rovara writes back to the ticket that started a task. Ticket words are shown as text only.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_TICKET_STATUSES, INTAKE_SOURCE_ERROR_WORDS, INTAKE_WAIT_REASON_WORDS, TICKET_UPDATE_MOMENTS, TICKET_WRITE_ACCESS_WORDS, SessionIdSchema,
  type IntakeChannelRef, type IntakeSourceView, type TicketUpdatesSettings, type TicketUpdateMoment,
} from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createIntakeApi } from "../../api/intake.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";

const TRACKER: Readonly<Record<string, string>> = { jira: "Jira", github: "GitHub", linear: "Linear" };
const MOMENT_LABEL: Readonly<Record<TicketUpdateMoment, string>> = { started: "Work started", plan_ready: "Plan ready", pr_opened: "Pull request opened", merged: "Merged", closed: "Closed" };
const failure = (message: unknown): string => (message instanceof ApiError ? message.message : "Couldn't complete this. Try again.");
const systemOf = (ref: IntakeChannelRef): string => (ref.channel === "jira" ? "jira" : ref.channel === "github_issue" ? "github" : ref.system ?? "tracker");
const sourceWords = (source: IntakeSourceView): string => {
  const what = `${TRACKER[systemOf(source.ref)] ?? "Tracker"}: ${source.ref.when.label === undefined ? "assigned to Rovara" : `label "${source.ref.when.label}"`}${source.ref.connection === undefined ? "" : ` (connection ${source.ref.connection})`}`;
  if (!source.failing) return `${what}. Working.`;
  const code = source.lastError ?? "SEARCH_FAILED";
  return `${what}. Failing${source.failingSince === undefined ? "" : ` since ${new Date(source.failingSince).toLocaleString()}`}: ${INTAKE_SOURCE_ERROR_WORDS[code] ?? INTAKE_SOURCE_ERROR_WORDS["SEARCH_FAILED"]!}`;
};

export function TicketsSection({ project, canStart, canEdit }: { project: string; canStart: boolean; canEdit: boolean }) {
  const host = useAppHost(), api = useMemo(() => createIntakeApi(host), [host]), query = useQueryClient();
  const list = useQuery({ queryKey: ["project", project, "intake"], queryFn: () => api.list(project), enabled: canStart });
  const updates = useQuery({ queryKey: ["project", project, "ticket-updates"], queryFn: () => api.updates(project) });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [draft, setDraft] = useState<TicketUpdatesSettings>();
  const [label, setLabel] = useState(""), [tracker, setTracker] = useState("jira"), [connection, setConnection] = useState("");
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);setError(undefined);
    try { await work(); } catch (problem) { setError(failure(problem)); } finally { setBusy(false); }
  }
  const act = (itemId: string, action: "start" | "dismiss") => run(async () => {
    const answer = await api.act(api.itemPath(project, itemId, action), action);
    await query.invalidateQueries({ queryKey: ["project", project, "intake"] });
    if ("started" in answer && answer.started && SessionIdSchema.safeParse(answer.sessionId).success) host.navigate("/s/" + answer.sessionId);
    else if ("started" in answer && !answer.started) setError("Rovara couldn't start this ticket yet. Try again later.");
  });
  const sources = list.data?.sources ?? [];
  const saveSources = (next: IntakeChannelRef[]) => run(async () => { await api.saveSources(project, next);await query.invalidateQueries({ queryKey: ["project", project, "intake"] });setLabel("");setConnection(""); });
  const addSource = () => {
    const trimmed = label.trim();
    if (trimmed === "") { setError("Name the label that asks Rovara for work.");return; }
    const named = connection.trim() === "" ? {} : { connection: connection.trim() };
    const ref: IntakeChannelRef = tracker === "linear" ? { channel: "tracker", system: "linear", when: { label: trimmed }, ...named } : { channel: tracker === "github" ? "github_issue" : "jira", when: { label: trimmed }, poll: {}, ...named };
    void saveSources([...sources.map((source) => source.ref), ref]);
  };
  const settings = draft ?? updates.data?.settings;
  const setMoment = (moment: TicketUpdateMoment, value: string) => settings !== undefined && setDraft({ ...settings, statuses: { ...settings.statuses, [moment]: value === "" ? undefined : value } });
  const editable = canEdit && updates.data?.canEdit === true;
  // Ticket intake isn't served on this install (the routes answer 404): say so quietly, once, instead of an alert per read.
  const unavailable = (problem: unknown) => problem instanceof ApiError && problem.status === 404;
  if (unavailable(updates.error) && (!canStart || unavailable(list.error))) return <section id="tickets" className="rv-project-section"><h2>Tickets from Linear, Jira and GitHub</h2><p className="rv-muted">Tickets from outside tools aren't available here.</p></section>;
  return <section id="tickets" className="rv-project-section"><h2>Tickets from Linear, Jira and GitHub</h2>
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
    {canStart && <><h3>Waiting to start</h3>{list.isPending ? <p className="rv-muted">Loading</p> : list.isError ? <p role="alert"><VisibleText text={failure(list.error)} /></p> : (list.data?.items.length ?? 0) === 0 ? <p className="rv-muted">No tickets are waiting.</p>
      : <ul>{list.data.items.map((item) => <li key={item.itemId}><p><VisibleText text={`${TRACKER[item.system] ?? "Tracker"} ${item.id}: ${item.title || "(no title)"}`} /></p><p className="rv-muted"><VisibleText text={INTAKE_WAIT_REASON_WORDS[item.reason]} /></p><Button aria-label={`Start ${item.id}`} disabled={busy} onClick={() => { void act(item.itemId, "start"); }}>Start</Button> <Button aria-label={`Not this one: ${item.id}`} disabled={busy} onClick={() => { void act(item.itemId, "dismiss"); }}>Not this one</Button></li>)}</ul>}
      <h3>Watched sources</h3>{sources.length === 0 ? <p className="rv-muted">No watched sources. Tickets still arrive through your tracker's webhook when one is set up.</p>
        : <ul>{sources.map((source) => <li key={source.sourceId}><VisibleText text={sourceWords(source)} />{editable && <> <Button disabled={busy} onClick={() => { void saveSources(sources.filter((other) => other.sourceId !== source.sourceId).map((other) => other.ref)); }}>Remove</Button></>}</li>)}</ul>}
      {editable && sources.length < 8 && <fieldset><legend>Watch a tracker</legend>
        <label>Tracker <select value={tracker} onChange={(event) => setTracker(event.target.value)}><option value="jira">Jira</option><option value="linear">Linear</option><option value="github">GitHub issues</option></select></label>
        <TextField label="Label that asks for work" maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} />
        <TextField label="Connection (optional)" hint="Only when your company has more than one connection for this tracker." maxLength={64} value={connection} onChange={(event) => setConnection(event.target.value)} />
        <Button disabled={busy} onClick={addSource}>Add source</Button></fieldset>}</>}
    <h3>What Rovara writes back</h3>
    {updates.isError ? <p role="alert"><VisibleText text={failure(updates.error)} /></p> : settings === undefined ? <p className="rv-muted">Loading</p> : <>
      <p className="rv-muted">Only to the ticket that started a task: its title, the moment and a link to the task. Nothing else from the task leaves Rovara, and a task only its owner can see never writes to a public GitHub issue.</p>
      {updates.data?.access.filter((entry) => entry.state === "needs_write_access").map((entry) => <p key={entry.tracker} role="status"><VisibleText text={TICKET_WRITE_ACCESS_WORDS[entry.tracker]} /></p>)}
      <Checkbox label="Comment on the ticket when work starts, the plan is ready, the pull request opens, and it merges or closes" checked={settings.comments} disabled={!editable || busy} onCheckedChange={(value) => setDraft({ ...settings, comments: value === true })} />
      <Checkbox label="Also change the ticket's status" checked={settings.changeStatus} disabled={!editable || busy} onCheckedChange={(value) => setDraft({ ...settings, changeStatus: value === true })} />
      {settings.changeStatus && TICKET_UPDATE_MOMENTS.map((moment) => <TextField key={moment} label={`${MOMENT_LABEL[moment]}: status`} hint={DEFAULT_TICKET_STATUSES[moment] === undefined ? "Leave empty to keep the status" : `Default: ${DEFAULT_TICKET_STATUSES[moment]}`} maxLength={60} disabled={!editable || busy} value={settings.statuses[moment] ?? ""} onChange={(event) => setMoment(moment, event.target.value)} />)}
      {editable && draft !== undefined && <Button disabled={busy} onClick={() => { void run(async () => { const saved = await api.saveUpdates(project, draft);query.setQueryData(["project", project, "ticket-updates"], saved);setDraft(undefined); }); }}>Save</Button>}
    </>}
  </section>;
}
