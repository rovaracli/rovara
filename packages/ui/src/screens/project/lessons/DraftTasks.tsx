import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CheckDraft } from "../../../api/graduation.js";
import { taskIdFrom } from "../../../api/graduation.js";
import { useLearnedApi } from "../../../api/learned.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { failureWords, refreshIfStale, refreshLessons } from "./graduation-shared.js";

/**
 * One draft task: text the person starts themselves (nothing here starts a task). Copy the request, start it in the box at the top of this page, then say which task it
 * was by pasting its page link or id; or drop the draft.
 */
function Draft({ project, draft }: { project: string; draft: CheckDraft }) {
  const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string }>({ kind: "idle" });
  const [link, setLink] = useState(""), [asking, setAsking] = useState(false), [copied, setCopied] = useState<"yes" | "no">();
  const taskId = taskIdFrom(link), busy = state.kind === "busy";
  async function run(write: () => Promise<unknown>, text: string) {
    setState({ kind: "busy" });
    try { await write();setState({ kind: "done", text });announce(`${draft.title}: ${text}`);refreshLessons(query, project); }
    catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Nothing was changed.") });refreshIfStale(failure, query, project); }
  }
  async function copy() {
    // What is copied is what is shown: hidden control and format characters are left out.
    try { await navigator.clipboard.writeText(draft.request.replace(/[\p{Cc}\p{Cf}]/gu, character => (character === "\n" || character === "\t" ? character : "")));setCopied("yes"); } catch { setCopied("no"); }
  }
  return <li><article className="rv-lesson" aria-labelledby={"draft-" + draft.id} data-draft-id={draft.id}>
    <header className="rv-lesson-head"><h4 id={"draft-" + draft.id}><VisibleText text={draft.title} /></h4></header>
    {state.kind === "done" ? <p role="status" className="rv-learned-note"><VisibleText text={state.text} /></p> : <>
      <p className="rv-lesson-body rv-draft-request" data-testid="draft-request"><VisibleText text={draft.request} /></p>
      {draft.paths.length > 0 && <p className="rv-muted"><VisibleText text={"Code paths: " + draft.paths.join(", ")} /></p>}
      <div className="rv-lesson-actions">
        <Button aria-label={visibleText(`Copy the request: ${draft.title}`)} disabled={busy} onClick={() => { void copy(); }}>Copy</Button>
        <Button variant="quiet" aria-label={visibleText(`I started it: ${draft.title}`)} disabled={busy} onClick={() => setAsking(true)}>I started it</Button>
        <Button variant="quiet" aria-label={visibleText(`Drop it: ${draft.title}`)} busy={busy} onClick={() => { void run(() => api.draftDismiss(project, draft.id), "Dropped."); }}>Drop it</Button>
      </div>
      {copied === "yes" && <p role="status" className="rv-muted">Copied. Paste it into the start box at the top of this page, or into your own tool.</p>}
      {copied === "no" && <p role="status" className="rv-muted">Couldn't copy. Select the request above and copy it yourself.</p>}
      {asking && <form className="rv-retire-form" onSubmit={event => { event.preventDefault();if (taskId !== undefined) void run(() => api.draftStarted(project, draft.id, taskId), "Saved. Thanks for starting it."); }}>
        <TextField label={visibleText(`Link to the task you started from "${draft.title}"`)} hint="Paste the link to your task page, or its id." value={link} onChange={event => setLink(event.target.value)} {...(link.trim() !== "" && taskId === undefined ? { error: "That isn't a task link or id. It holds one long id like 123e4567-e89b-12d3-a456-426614174000." } : {})} />
        <Button type="submit" variant="primary" busy={busy} disabled={taskId === undefined}>Save</Button>
        <Button variant="quiet" disabled={busy} onClick={() => { setAsking(false);setLink(""); }}>Cancel</Button></form>}
    </>}
    {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
  </article></li>;
}

export function DraftTasks({ project, drafts }: { project: string; drafts: CheckDraft[] }) {
  if (drafts.length === 0) return null;
  return <section className="rv-draft-tasks" aria-labelledby="draft-tasks-title" data-testid="draft-tasks">
    <h3 id="draft-tasks-title">Draft tasks</h3>
    <p className="rv-muted">Rovara wrote these but never starts them. Copy the request, start it yourself, then tell Rovara you did.</p>
    <ul className="rv-learned-list">{drafts.map(draft => <Draft key={draft.id} project={project} draft={draft} />)}</ul>
  </section>;
}
