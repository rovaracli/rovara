// How people correct a machine-written wiki page (lead 4 C1; designs-2026-11-17/project-wiki-ux.md section 5, the demo's Mark wrong, Add a note, lesson offer and disputed list).
// Every control is drawn from what Code says THIS person may do (api `corrections`): a person who cannot do something is never shown the button, so there is no dead button. Code
// decides again on every call. A refusal is shown in a fixed sentence (never the server's other text). Wiki text and people's words are drawn as plain text.
import { useId, useState, type ReactNode } from "react";
import { wikiNoteLooksLikeRule } from "@agentx/contracts/web";
import { fixedCorrectionWords, useWikiApi, useWikiDisputed, useWikiGaps, useWikiRefresh, type WikiCorrectionsResponse, type WikiNoteState, type WikiPageResponse, type WikiShownNote } from "../../../api/wiki.js";
import { Button } from "../../../design/Button.js";
import { RelativeTime } from "../../../design/RelativeTime.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T } from "./wiki-text.js";

/** One write at a time per control: busy while it runs, the fixed words when it is refused. */
function useAct(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(undefined);
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try { await work(); return true; } catch (failure) { setError(failure ?? new Error("failed")); return false; } finally { await refresh().catch(() => undefined); setBusy(false); }
  };
  return { busy, error, run, clear: () => { setError(undefined); } };
}
function Failed({ error }: { error: unknown }) {
  return error === undefined ? null : <p role="alert" className="rv-wiki-pnote rv-wiki-pnote-flag"><VisibleText text={fixedCorrectionWords(error, T.ACTION_FAILED)} /></p>;
}

export interface CorrectionsView { you: WikiCorrectionsResponse["you"]; states: ReadonlyMap<string, WikiNoteState> }
export const viewOf = (data: WikiCorrectionsResponse | undefined): CorrectionsView | undefined => (data === undefined ? undefined : { you: data.you, states: new Map(data.notes.map((state) => [state.noteId, state])) });

/** The files this page cites, once each: a note may point at one. */
export function citedFiles(res: WikiPageResponse): Array<{ repo: string; path: string }> {
  const seen = new Set<string>(), out: Array<{ repo: string; path: string }> = [];
  for (const claim of res.page.claims) for (const cite of claim.citations) {
    const key = `${cite.repo}/${cite.path}`;
    if (!seen.has(key)) { seen.add(key); out.push({ repo: cite.repo, path: cite.path }); }
  }
  return out;
}

function NoteForm({ project, id, files, onDone }: { project: string; id: string; files: ReadonlyArray<{ repo: string; path: string }>; onDone: () => void }) {
  const api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(async () => { await refresh(); });
  const [text, setText] = useState(""), [file, setFile] = useState("");
  const chosen = files.find((one) => `${one.repo}/${one.path}` === file);
  const submit = async () => {
    if (text.trim() === "") return;
    const saved = await act.run(async () => { await api.addNote(project, id, { text: text.trim(), ...(chosen === undefined ? {} : { file: chosen }) }); });
    if (saved) onDone();
  };
  return (
    <form className="rv-wiki-form" data-testid="wiki-note-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <TextArea autoFocus label={T.NOTE_FORM_LABEL} hint={T.NOTE_FORM_HINT} value={text} maxLength={2000} rows={4} onChange={(event) => { setText(event.target.value); }} />
      {files.length > 0 && <Select label={T.NOTE_FILE_LABEL} value={file} onValueChange={setFile} placeholder={T.NOTE_NO_FILE} options={[{ value: "", label: T.NOTE_NO_FILE }, ...files.map((one) => ({ value: `${one.repo}/${one.path}`, label: `${one.repo}/${one.path}` }))]} />}
      <Failed error={act.error} />
      <div className="rv-wiki-row"><Button variant="primary" type="submit" busy={act.busy} disabled={text.trim() === ""}>{T.NOTE_PIN}</Button><Button onClick={onDone}>{T.CANCEL}</Button></div>
    </form>
  );
}

function NoteCard({ project, id, note, state }: { project: string; id: string; note: WikiShownNote; state: WikiNoteState | undefined }) {
  const api = useWikiApi(), refresh = useWikiRefresh(project);
  // One action at a time per card, with one alert: a new action clears the old error.
  const act = useAct(async () => { await refresh(); });
  const [sent, setSent] = useState(false);
  const rule = state?.canSuggestLesson === true && wikiNoteLooksLikeRule(note.text);
  return (
    <div role="group" className="rv-wiki-tnote" aria-label={`${T.NOTE_FROM} ${note.author}`} data-note={note.noteId}>
      <span className="rv-wiki-who"><b>{T.NOTE_FROM} <VisibleText text={note.author} /></b>, <RelativeTime at={note.createdAt} />. {note.approval === "approved" ? T.NOTE_APPROVED : T.NOTE_PENDING}</span>
      <p className="rv-wiki-text"><VisibleText text={note.text} /></p>
      {note.file !== undefined && <p className="rv-wiki-who">{T.NOTE_FILE} <code><VisibleText text={`${note.file.repo}/${note.file.path}`} /></code></p>}
      {state?.mayBeOutOfDate === true && <p className="rv-wiki-pnote rv-wiki-pnote-stale" data-testid="wiki-note-stale"><b>{T.STALE}</b> {T.NOTE_OUT_OF_DATE} {T.NOTE_OUT_OF_DATE_ASK}</p>}
      {rule && !sent && <div className="rv-wiki-offer" data-testid="wiki-lesson-offer"><span>{T.LESSON_OFFER}</span><Button busy={act.busy} onClick={() => { void act.run(async () => { await api.suggestLesson(project, id, note.noteId); setSent(true); }); }}>{T.LESSON_SUGGEST}</Button></div>}
      {sent && <p role="status" className="rv-wiki-who">{T.LESSON_SENT}</p>}
      <Failed error={act.error} />
      {(state?.canApprove === true || state?.canDelete === true) && (
        <div className="rv-wiki-row">
          {state.canDelete && state.mayBeOutOfDate && <Button busy={act.busy} data-testid="wiki-note-acknowledge" aria-label={`${T.NOTE_ACK}: ${[...note.text.replace(/\s+/gu, " ")].slice(0, 40).join("")}`} onClick={() => { void act.run(async () => { await api.acknowledgeNote(project, id, note.noteId); }); }}>{T.NOTE_ACK}</Button>}
          {state.canApprove && <Button variant="primary" busy={act.busy} onClick={() => { void act.run(async () => { await api.approveNote(project, id, note.noteId); }); }}>{T.NOTE_APPROVE}</Button>}
          {state.canDelete && <Button variant="quiet" busy={act.busy} aria-label={`${T.NOTE_REMOVE}: ${[...note.text.replace(/\s+/gu, " ")].slice(0, 40).join("")}`} onClick={() => { void act.run(async () => { await api.deleteNote(project, id, note.noteId); }); }}>{T.NOTE_REMOVE}</Button>}
        </div>
      )}
    </div>
  );
}

/** The pinned notes at the top of a page, with Add a note for people who may. The notes show for everyone; controls only for those Code says may use them. */
export function PageNotes({ project, res, view }: { project: string; res: WikiPageResponse; view: CorrectionsView | undefined }) {
  const [open, setOpen] = useState(false);
  const id = res.page.pageId;
  if (view === undefined && res.notes.length === 0) return null;
  return (
    <section aria-label="Pinned notes">
      {view?.you.addNote === true && !open && <div className="rv-wiki-row"><Button data-testid="wiki-add-note" onClick={() => { setOpen(true); }}>{T.ADD_NOTE}</Button></div>}
      {view?.you.addNote === true && open && <NoteForm project={project} id={id} files={citedFiles(res)} onDone={() => { setOpen(false); }} />}
      {view !== undefined && !view.you.addNote && <p className="rv-muted rv-wiki-small" data-testid="wiki-readonly">{T.VIEWERS_READ}</p>}
      {res.notes.map((note) => <NoteCard key={note.noteId} project={project} id={id} note={note} state={view?.states.get(note.noteId)} />)}
    </section>
  );
}

/** The reason box for a Mark wrong: one mark for each claim the text rests on that is not already marked, or one for the whole page. */
export function MarkForm({ project, id, claimIds, onDone }: { project: string; id: string; claimIds: readonly string[] | "page"; onDone: () => void }) {
  const api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(async () => { await refresh(); });
  const [reason, setReason] = useState(""), field = useId();
  const submit = async () => {
    const words = reason.trim();
    const saved = await act.run(async () => {
      for (const claimId of claimIds === "page" ? [undefined] : claimIds) await api.markWrong(project, id, { ...(claimId === undefined ? {} : { claimId }), ...(words === "" ? {} : { reason: words }) });
    });
    if (saved) onDone();
  };
  return (
    <form className="rv-wiki-form" data-testid="wiki-mark-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <TextField autoFocus id={field} label={T.MARK_LABEL} value={reason} maxLength={500} placeholder={T.MARK_PLACEHOLDER} onChange={(event) => { setReason(event.target.value); }} />
      <Failed error={act.error} />
      <div className="rv-wiki-row"><Button variant="primary" type="submit" busy={act.busy}>{T.MARK_WRONG}</Button><Button onClick={onDone}>{T.CANCEL}</Button></div>
    </form>
  );
}

/** The "Mark this page wrong" control under the page's meta line (for people who may mark). */
export function PageMark({ project, res, view, marked }: { project: string; res: WikiPageResponse; view: CorrectionsView | undefined; marked: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  if (view?.you.markWrong !== true || marked) return null;
  return (
    <div className="rv-wiki-pageact">
      {!open && <Button variant="quiet" data-testid="wiki-mark-page" onClick={() => { setOpen(true); }}>{T.MARK_PAGE_WRONG}</Button>}
      {open && <MarkForm project={project} id={res.page.pageId} claimIds="page" onDone={() => { setOpen(false); }} />}
    </div>
  );
}

/** The marks still open after a page was written again (maintainers): who marked what and why, with a way to close them once the code was checked. */
export function DisputedList({ project, open, back }: { project: string; open: (id: string) => void; back: () => void }) {
  const read = useWikiDisputed(project, true), api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(async () => { await refresh(); });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  if (read.isPending) return <Skeleton label={T.DISPUTED_LOADING} />;
  if (read.isError || read.data === undefined) return <div><p role="alert" data-testid="wiki-disputed-error"><VisibleText text={fixedCorrectionWords(read.error, T.ACTION_FAILED)} /></p><Button onClick={back}>{T.DISPUTED_BACK}</Button></div>;
  const pages = new Map<string, { title: string; items: typeof read.data.items }>();
  for (const item of read.data.items) { const group = pages.get(item.pageId) ?? { title: item.pageTitle, items: [] }; group.items = [...group.items, item]; pages.set(item.pageId, group); }
  return (
    <section className="rv-wiki-art" aria-label={T.DISPUTED_TITLE} data-testid="wiki-disputed">
      <p className="rv-wiki-crumb">{T.DISPUTED}</p>
      <h2 className="rv-wiki-h1">{T.DISPUTED_TITLE}</h2>
      <p className="rv-wiki-lede">{T.DISPUTED_HINT}</p>
      <Failed error={act.error} />
      {read.data.more && <p className="rv-wiki-who" data-testid="wiki-disputed-more">{T.DISPUTED_MORE}</p>}
      {closed.size > 0 && <p role="status" className="rv-wiki-who" data-testid="wiki-disputed-closed">{T.DISPUTED_RESOLVED}</p>}
      {pages.size === 0 && <p className="rv-wiki-lede" data-testid="wiki-disputed-empty">{T.DISPUTED_NONE}</p>}
      {[...pages.entries()].map(([pageId, group]) => (
        <div key={pageId} className="rv-wiki-tnote" role="group" aria-label={group.title} data-page={pageId}>
          <b><VisibleText text={group.title} /></b>
          <ul>{group.items.map((item) => (
            <li key={item.flagId}>
              {item.claimText !== undefined ? <VisibleText text={item.claimText} /> : <>The whole page</>}
              <span className="rv-wiki-who"> Marked by <VisibleText text={item.markedBy} />, <RelativeTime at={item.markedAt} />.{item.reason !== undefined && <> Reason: <VisibleText text={item.reason} /></>}</span>
            </li>
          ))}</ul>
          <div className="rv-wiki-row">
            <Button onClick={() => { open(pageId); }}>{T.DISPUTED_OPEN}</Button>
            <Button variant="primary" busy={act.busy} onClick={() => { void act.run(async () => { await api.resolveMarks(project, pageId); setClosed(new Set([...closed, pageId])); }); }}>{T.DISPUTED_RESOLVE}</Button>
          </div>
        </div>
      ))}
      <div className="rv-wiki-row"><Button onClick={back}>{T.DISPUTED_BACK}</Button></div>
    </section>
  );
}

/** The questions the wiki could not answer (maintainers): topics with how many different people asked and the day it was last asked. Nobody is named; the words are drawn as plain text. */
export function GapsList({ project, back }: { project: string; back: () => void }) {
  const read = useWikiGaps(project, true);
  if (read.isPending) return <Skeleton label={T.GAPS_LOADING} />;
  if (read.isError || read.data === undefined) return <div><p role="alert" data-testid="wiki-gaps-error"><VisibleText text={fixedCorrectionWords(read.error, T.ACTION_FAILED)} /></p><Button onClick={back}>{T.GAPS_BACK}</Button></div>;
  return (
    <section className="rv-wiki-art" aria-label={T.GAPS_TITLE} data-testid="wiki-gaps">
      <p className="rv-wiki-crumb">{T.GAPS}</p>
      <h2 className="rv-wiki-h1">{T.GAPS_TITLE}</h2>
      <p className="rv-wiki-lede">{T.GAPS_HINT}</p>
      {read.data.more && <p className="rv-wiki-who" data-testid="wiki-gaps-more">{T.GAPS_MORE}</p>}
      {read.data.items.length === 0 && <p className="rv-wiki-lede" data-testid="wiki-gaps-empty">{T.GAPS_NONE}</p>}
      <ul>{read.data.items.map((item, index) => (
        <li key={`${String(index)}:${item.topic}`} data-kind={item.kind}>
          <b><VisibleText text={item.topic} /></b>
          <span className="rv-wiki-who"> {Object.hasOwn(T.GAPS_KIND, item.kind) ? T.GAPS_KIND[item.kind] : item.kind}. Asked by {String(item.people)} {item.people === 1 ? "person" : "people"}, {String(item.questions)} {item.questions === 1 ? "time" : "times"}; last on <VisibleText text={item.lastAskedAt} />.</span>
        </li>
      ))}</ul>
      <div className="rv-wiki-row"><Button onClick={back}>{T.GAPS_BACK}</Button></div>
    </section>
  );
}
