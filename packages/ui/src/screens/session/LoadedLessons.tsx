import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { useLessonsApi, useLoadedLessons, type LoadedLessonRow } from "../../api/lessons.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { T, failureText, stagesWords, typeWords } from "../project/lessons/lessons-text.js";

const WHY: Readonly<Record<string, string>> = { scope: "matched this project's scope", similar: "similar to the task", path: "matched a file the task touches" };
const CITATION: Readonly<Record<string, string>> = {
 valid: "Its code reference still holds", moved: "Its code moved; the new place was used", stale_dropped: "Not used: the code it cites is gone", unchecked_dropped: "Not used: its code reference couldn't be checked in time",
 unchecked: "Its code reference wasn't checked", none: "It doesn't cite code",
};
const word = (table: Readonly<Record<string, string>>, key: string, fallback: string): string => Object.hasOwn(table, key) ? table[key]! : fallback;

function Row({ taskId, row, canMark }: { taskId: string; row: LoadedLessonRow; canMark: boolean }) {
 const api = useLessonsApi(), query = useQueryClient(), [marked, setMarked] = useState<"helpful" | "wrong_here">(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function mark(kind: "helpful" | "wrong_here") {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await api.mark(taskId, row.lessonId, kind);setMarked(kind);await query.invalidateQueries({ queryKey: ["task", taskId, "lessons"] }); }
  catch (failure) { setError(failureText(failure, "Couldn't save that. Try again.")); }
  finally { setBusy(false); }
 }
 const label = row.visible && row.title !== undefined ? row.title : T.LOADED_HIDDEN;
 return <li>
  <span className={row.visible ? undefined : "rv-muted"}><VisibleText text={label} /></span>{" "}
  <span className="rv-muted">{[row.type === undefined ? "" : typeWords(row.type), "Chosen because it " + word(WHY, row.why, "matched"), word(CITATION, row.citation, "Not checked")].filter(part => part !== "").join(" · ")}{row.helpful !== undefined && row.harmful !== undefined ? ` · Helpful ${String(row.helpful)}, wrong ${String(row.harmful)}` : ""}</span>
  {canMark && row.canMark && marked === undefined && <> <Button variant="quiet" busy={busy} onClick={() => { void mark("helpful"); }} aria-label={"Helpful: " + label}>{T.HELPFUL}</Button> <Button variant="quiet" busy={busy} onClick={() => { void mark("wrong_here"); }} aria-label={"Wrong here: " + label}>{T.WRONG}</Button></>}
  {marked !== undefined && <span role="status"> {T.LOADED_THANKS}</span>}
  {error !== undefined && <span role="alert"> {error}</span>}
 </li>;
}

/** The lessons a task loaded, per step. A lesson from a source this person can't see is a row with no words. Shown inside "What the agent loaded". */
export function LoadedLessons({ taskId }: { taskId: string }) {
 const read = useLoadedLessons(taskId, true);
 if (read.isPending) return null;
 // The route is not there (learning not set up here), or this person can't open it: nothing is said about lessons.
 if (read.isError) return read.error instanceof ApiError && read.error.code !== "NOT_FOUND" && read.error.status !== 404 ? <p className="rv-muted">The lessons could not be loaded right now.</p> : null;
 const groups = new Map<string, LoadedLessonRow[]>();
 for (const row of read.data.lessons) { const key = row.stage + "|" + String(row.round);groups.set(key, [...(groups.get(key) ?? []), row]); }
 return <section aria-label={T.LOADED_TITLE}>
  <h4>{T.LOADED_TITLE}</h4>
  {groups.size === 0 ? <p className="rv-muted">{T.LOADED_NONE}</p> : [...groups.entries()].map(([key, rows]) => <div key={key}>
   <p><strong>{stagesWords([rows[0]!.stage])}{rows[0]!.round > 1 ? `, round ${String(rows[0]!.round)}` : ""}</strong></p>
   <ul className="rv-loaded-list" aria-label={"Lessons loaded: " + stagesWords([rows[0]!.stage])}>{rows.map(row => <Row key={row.lessonId + row.version} taskId={taskId} row={row} canMark={true} />)}</ul>
  </div>)}
 </section>;
}
