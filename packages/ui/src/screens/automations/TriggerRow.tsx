// exp/automations: one trigger as a row: what starts it, where it stands (on, paused, waiting for an admin, turned off with the reason), its last result, and, for people who may change it,
// pause, resume, change, delete (with an in-page question) and its activity. Pausing is at once; resuming waits for a confirmation, and the answer says so.
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { chainKey, useAutomationsApi, type ProjectTriggerRead } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StatusDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { paths } from "../../paths.js";
import { ActionNote, noteOf, problemNote, type Note } from "./ActionNote.js";
import { outcomeWords, specWords, triggerState } from "./automation-text.js";
import { TriggerDialog } from "./TriggerDialog.js";

const STATE_DOT = { on: "succeeded", paused: "paused", waiting: "waiting", refused: "failed" } as const;
/** The page a run or a task is on, when its id is one a session page can open. */
export function sessionLink(runId?: string, taskId?: string): string | undefined {
  for (const id of [runId, taskId]) if (id !== undefined && SessionIdSchema.safeParse(id).success) return paths.session(id);
  return undefined;
}

export type RowTrigger = ProjectTriggerRead;

function Activity({ chainId, triggerId }: { chainId: string; triggerId: string }) {
  const api = useAutomationsApi(), read = useQuery({ queryKey: chainKey(chainId, "activity:" + triggerId), queryFn: () => api.activity(chainId, triggerId), retry: false });
  if (read.isPending) return <Skeleton label="Loading activity" />;
  if (read.isError) return <ActionNote note={problemNote(read.error)} />;
  if (read.data.activity.length === 0) return <p className="rv-muted">Nothing has happened yet.</p>;
  return <ul className="rv-auto-activity" aria-label="Activity">{read.data.activity.map((entry, index) => {
    const link = sessionLink(entry.runId, entry.taskId);
    return <li key={index}><span><RelativeTime at={entry.at} /></span> <strong>{outcomeWords(entry.outcome, entry.reason)}</strong>{link !== undefined && <> <Link to={link}>{entry.runId !== undefined ? "Open the run" : "Open the task"}</Link></>}<span className="rv-muted"> <VisibleText text={entry.eventKey} /></span></li>;
  })}</ul>;
}

export function TriggerRow({ trigger, chainId, canEdit, onChanged, showTarget = false }: { trigger: RowTrigger; chainId: string | undefined; canEdit: boolean; onChanged: () => void; showTarget?: boolean }) {
  const api = useAutomationsApi(), state = triggerState(trigger), [note, setNote] = useState<Note>(), [busy, setBusy] = useState<string>(), [editing, setEditing] = useState(false), [asking, setAsking] = useState(false), [activity, setActivity] = useState(false), sending = useRef(false);
  const link = sessionLink(trigger.lastRunId, trigger.lastTaskId), editable = canEdit && chainId !== undefined;
  async function run(label: string, work: () => Promise<Note>) {
    if (sending.current) return;
    sending.current = true;setBusy(label);setNote(undefined);
    try { setNote(await work());onChanged(); } catch (error) { setNote(problemNote(error)); }
    finally { sending.current = false;setBusy(undefined); }
  }
  // A pause is the same trigger with `enabled: false`; the spec, hook and rate are sent back as they are, so nothing else changes.
  const put = (enabled: boolean) => api.putTrigger(chainId!, trigger.triggerId, { project: trigger.project, spec: trigger.spec, enabled, maxRunsPerHour: trigger.maxRunsPerHour, ...(trigger.hookId === undefined ? {} : { hookId: trigger.hookId }) });
  const pause = () => run("pause", async () => noteOf(await put(false), "Paused. It won't start anything until it is resumed."));
  const resume = () => run("resume", async () => noteOf(await put(true), "It is on."));
  const remove = () => run("delete", async () => { await api.deleteTrigger(chainId!, trigger.triggerId);setAsking(false);return { kind: "done", text: "The trigger is deleted." }; });
  return <li className="rv-auto-row">
    <div className="rv-auto-row-head">
      <div><strong><VisibleText text={specWords(trigger.spec)} /></strong>{showTarget && trigger.target.kind === "chain" && <span className="rv-muted"> starts <Link to={"/app/chains/" + encodeURIComponent(trigger.target.chainId)}><VisibleText text={trigger.targetName ?? "a chain you can't see"} /></Link></span>}{showTarget && trigger.target.kind === "agent" && <span className="rv-muted"> starts <VisibleText text={trigger.targetName ?? "an agent"} /></span>}</div>
      <StatusDot status={STATE_DOT[state.kind]} words={state.words} />
    </div>
    {state.reason !== undefined && <p className="rv-muted">Why: <VisibleText text={state.reason} /></p>}
    {trigger.scheduleStatus === "pending" && trigger.enabled && <p className="rv-muted">Its schedule is still being set up.</p>}
    <p className="rv-muted">{trigger.lastFiredAt === undefined ? "It hasn't started anything yet." : <>Last started <RelativeTime at={trigger.lastFiredAt} />{link !== undefined && <> · <Link to={link}>{trigger.lastRunId !== undefined ? "Open the run" : "Open the task"}</Link></>}</>}</p>
    <div className="rv-auto-controls">
      {editable && state.kind === "on" && <Button busy={busy === "pause"} onClick={() => { void pause(); }}>Pause</Button>}
      {editable && state.kind !== "on" && <Button busy={busy === "resume"} onClick={() => { void resume(); }}>{state.kind === "waiting" ? "Ask again" : "Resume"}</Button>}
      {editable && <Button onClick={() => { setEditing(true); }}>Change</Button>}
      {editable && <Button variant="danger" onClick={() => { setAsking(true); }}>Delete</Button>}
      {chainId !== undefined && <Button variant="quiet" aria-expanded={activity} onClick={() => { setActivity(value => !value); }}>{activity ? "Hide activity" : "Activity"}</Button>}
    </div>
    {!asking && <ActionNote note={note} />}
    {activity && chainId !== undefined && <Activity chainId={chainId} triggerId={trigger.triggerId} />}
    {editing && chainId !== undefined && <TriggerDialog chainId={chainId} project={trigger.project} trigger={trigger} open onOpenChange={open => { if (!open) setEditing(false); }} onSaved={saved => { setNote(saved);onChanged(); }} />}
    <Dialog title="Delete this trigger?" description="It will stop starting runs. This can't be undone." open={asking} onOpenChange={open => { setAsking(open);if (!open) setNote(undefined); }}>
      <ActionNote note={note} />
      <div className="rv-actions"><Button variant="danger" busy={busy === "delete"} onClick={() => { void remove(); }}>Delete trigger</Button><Button onClick={() => { setAsking(false); }}>Keep it</Button></div>
    </Dialog>
  </li>;
}
