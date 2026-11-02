import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { knownFailingKey, useKnownFailingApi, useKnownFailingMarks, type MarkRef } from "../../api/known-failing.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { KF as T, SHOWN_AT_FIRST, countText, markedText } from "./known-failing-text.js";
import "./learning.css";

const keyOf = (mark: MarkRef) => [mark.checkId, mark.name, mark.markedBy, mark.markedAt, String(mark.epoch)].join("\u0000");
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * The project's marked tests, with Undo (KF-1). Only a maintainer reaches it, and only while the four test results are on; the server decides both and the page asks for the list only then. Undo makes results stricter, so it asks no
 * second person. The press names the mark by everything stored with it; a mark that changed meanwhile answers "already removed or changed" and the list is read again. Loaded lazily: nothing of it is in the first page.
 */
export function KnownFailingMarks({ project }: { project: string }) {
 const read = useKnownFailingMarks(project), api = useKnownFailingApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState<string>(), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>(), [all, setAll] = useState(false);
 if (read.isPending) return <section className="rv-learning" aria-label={T.HEADING}><Skeleton label={T.LOADING} /></section>;
 if (read.data === undefined) return <section className="rv-learning" aria-label={T.HEADING}><h3>{T.HEADING}</h3><p role="alert">{T.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button></section>;
 const { marks, max } = read.data, shown = all ? marks : marks.slice(0, SHOWN_AT_FIRST);
 async function undo(mark: MarkRef) {
  if (sending.current) return;
  sending.current = true;setBusy(keyOf(mark));setMessage(undefined);
  try {
   const answer = await api.undo(project, { name: mark.name, checkId: mark.checkId, markedBy: mark.markedBy, markedAt: mark.markedAt, epoch: mark.epoch });
   // The undo's own answer is the new list, so a failed re-read cannot leave the removed mark on screen.
   query.setQueryData(knownFailingKey(project), { max: answer.max, marks: answer.marks });setMessage({ kind: "status", text: T.UNDONE });
  } catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") { await query.invalidateQueries({ queryKey: knownFailingKey(project) });setMessage({ kind: "alert", text: T.CHANGED }); }
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(undefined); }
 }
 return <section className="rv-learning" aria-label={T.HEADING} aria-busy={busy !== undefined}>
  <h3>{T.HEADING}</h3>
  <p className="rv-muted">{T.HELP}</p>
  <p><strong>{countText(marks.length, max)}</strong></p>
  {marks.length >= max && <p role="status">{T.FULL}</p>}
  {marks.length === 0 ? <p>{T.NONE}</p> : <ul className="rv-learning-list" aria-label={T.HEADING}>{shown.map(mark => <li key={keyOf(mark)}>
   <p><code><VisibleText text={mark.name} /></code></p>
   <p className="rv-muted">Check <VisibleText text={mark.checkId} /> · <VisibleText text={markedText(mark.markedByName, mark.markedByYou, dayOf(mark.markedAt))} /></p>
   <Button busy={busy === keyOf(mark)} disabled={busy !== undefined} aria-label={`${T.UNDO} ${mark.name}`} onClick={() => { void undo(mark); }}>{T.UNDO}</Button>
  </li>)}</ul>}
  {marks.length > SHOWN_AT_FIRST && <Button onClick={() => setAll(value => !value)}>{all ? T.SHOW_FEWER : `${T.SHOW_ALL} (${String(marks.length)})`}</Button>}
  <p className="rv-muted">{T.NIGHTLY}</p>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} /></p>}
 </section>;
}
