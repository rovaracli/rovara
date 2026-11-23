// How people correct a machine-written wiki page (lead 4 C1; designs-2026-11-17/project-wiki-ux.md section 5, the demo's Mark wrong, Add a note, lesson offer and disputed list).
// Every control is drawn from what Code says THIS person may do (api `corrections`): a person who cannot do something is never shown the button, so there is no dead button. Code
// decides again on every call. A refusal is shown in a fixed sentence (never the server's other text). Wiki text and people's words are drawn as plain text.
import { useId, useRef, useState, type ReactNode } from "react";
import { wikiNoteLooksLikeRule } from "@agentx/contracts/web";
import { fixedCorrectionWords, useWikiApi, useWikiRefresh, type WikiCorrectionsResponse, type WikiNoteState, type WikiPageResponse, type WikiShownNote } from "../../../api/wiki.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { RelativeTime } from "../../../design/RelativeTime.js";
import { Select } from "../../../design/Select.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T } from "./wiki-text.js";

/** One write at a time per control: busy while it runs, the fixed words when it is refused. */
export function useAct(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(undefined);
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try { await work(); return true; } catch (failure) { setError(failure ?? new Error("failed")); return false; } finally { await refresh().catch(() => undefined); setBusy(false); }
  };
  return { busy, error, run, clear: () => { setError(undefined); } };
}
export function Failed({ error }: { error: unknown }) {
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

export function NoteCard({ project, id, note, state }: { project: string; id: string; note: WikiShownNote; state: WikiNoteState | undefined }) {
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

/**
 * The reason box for a Mark wrong: one mark for each claim in `claimIds` (the whole page for "page"). With `choices` the person picks which of those statements are wrong first
 * (none picked by default; nothing is sent until at least one is ticked); each ticked statement is one mark, the same request the old paragraph mark sent.
 */
export function MarkForm({ project, id, claimIds, choices, onDone }: { project: string; id: string; claimIds: readonly string[] | "page"; choices?: readonly { claimId: string; text: string }[]; onDone: () => void }) {
  const api = useWikiApi(), refresh = useWikiRefresh(project), act = useAct(async () => { await refresh(); });
  const sending = useRef(false), [reason, setReason] = useState(""), [picked, setPicked] = useState<ReadonlySet<string>>(new Set()), [needPick, setNeedPick] = useState(false), field = useId();
  const submit = async () => {
    const words = reason.trim();
    const ids = choices === undefined ? claimIds : choices.map(choice => choice.claimId).filter(claimId => picked.has(claimId));
    if (ids !== "page" && ids.length === 0) { setNeedPick(true); return; }
    // One send at a time: a second submit while the first is on its way (a double click, Enter twice) sends nothing more.
    if (sending.current) return;
    sending.current = true;
    try {
      const saved = await act.run(async () => {
        for (const claimId of ids === "page" ? [undefined] : ids) await api.markWrong(project, id, { ...(claimId === undefined ? {} : { claimId }), ...(words === "" ? {} : { reason: words }) });
      });
      if (saved) onDone();
    } finally { sending.current = false; }
  };
  return (
    <form className="rv-wiki-form" data-testid="wiki-mark-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {choices !== undefined && <fieldset className="rv-wiki-claimpick" data-testid="wiki-mark-claims"><legend>{T.MARK_PICK}</legend>{choices.map(choice => <Checkbox key={choice.claimId} label={choice.text} checked={picked.has(choice.claimId)} onCheckedChange={on => { setNeedPick(false); setPicked(on === true ? new Set([...picked, choice.claimId]) : new Set([...picked].filter(claimId => claimId !== choice.claimId))); }} />)}{needPick && <p role="alert" className="rv-wiki-pnote rv-wiki-pnote-flag">{T.MARK_PICK_NONE}</p>}</fieldset>}
      {claimIds === "page" && <p className="rv-wiki-markpage">{T.MARK_PAGE_LINE}</p>}
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
