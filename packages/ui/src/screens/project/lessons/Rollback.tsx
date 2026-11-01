import { useState } from "react";
import { useLessonsApi, type LessonsView } from "../../../api/lessons.js";
import { Button } from "../../../design/Button.js";
import type { Decided } from "./LessonCard.js";
import { T, dateWords, failureText, isStale } from "./lessons-text.js";

/** Going back to an earlier lesson set. Everything restored waits for approval again. */
export function Rollback({ project, view, onDone }: { project: string; view: LessonsView; onDone: (result: Decided) => Promise<void> | void }) {
 const api = useLessonsApi(), [busy, setBusy] = useState<number>(), [error, setError] = useState<string>(), [confirm, setConfirm] = useState<number>();
 async function go(target: number) {
  if (busy !== undefined) return;
  setBusy(target);setError(undefined);
  try { await api.rollback(project, { targetSetVersion: target, expectedSetVersion: view.setVersion });setConfirm(undefined);await onDone({ message: T.ROLLED_BACK, reload: true }); }
  catch (failure) { setError(failureText(failure, "Couldn't go back. Try again."));if (isStale(failure)) await onDone({ reload: true }); }
  finally { setBusy(undefined); }
 }
 if (view.snapshots.length === 0) return <p className="rv-muted">{T.ROLLBACK_NONE}</p>;
 return <div><p className="rv-muted">{T.ROLLBACK_HINT}</p><ul className="rv-lessons-rollback" aria-label={T.ROLLBACK}>{[...view.snapshots].reverse().map(snapshot => <li key={snapshot.setVersion}>
  <span>{dateWords(snapshot.at)} · {String(snapshot.lessons)} {snapshot.lessons === 1 ? "lesson" : "lessons"}</span>{" "}
  {confirm === snapshot.setVersion ? <><Button variant="danger" busy={busy === snapshot.setVersion} onClick={() => { void go(snapshot.setVersion); }}>{T.ROLLBACK_SEND}</Button> <Button onClick={() => setConfirm(undefined)}>{T.CANCEL}</Button></>
   : <Button onClick={() => setConfirm(snapshot.setVersion)} aria-label={"Go back to the set of " + dateWords(snapshot.at)}>{T.ROLLBACK}</Button>}
 </li>)}</ul>{error !== undefined && <p role="alert">{error}</p>}</div>;
}
