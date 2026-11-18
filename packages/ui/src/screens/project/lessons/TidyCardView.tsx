import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TidyCard } from "../../../api/graduation.js";
import { NOT_NOW, TIDY_CONFIRM, tidyTitle, tidyUseWords, tidyWords } from "../../../api/graduation.js";
import { useLearnedApi } from "../../../api/learned.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { failureWords, refreshIfStale, refreshLessons } from "./graduation-shared.js";

/** The tidy card: the 10 least used lessons, each with its use count and a checkbox; one confirm retires the chosen ones. */
export function TidyCardView({ project, tidy }: { project: string; tidy: TidyCard }) {
  const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set()), [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string }>({ kind: "idle" });
  const busy = state.kind === "busy", ids = tidy.lessons.map(lesson => lesson.lessonId).filter(id => chosen.has(id));
  async function run(write: () => Promise<string>) {
    setState({ kind: "busy" });
    try { const text = await write();setState({ kind: "done", text });announce(`${tidyTitle(tidy.lessons.length)} ${text}`);refreshLessons(query, project); }
    catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Nothing was changed.") });setConfirming(false);refreshIfStale(failure, query, project); }
  }
  return <article className="rv-permanent rv-tidy" aria-labelledby="tidy-title" data-testid="tidy-card">
    <h3 id="tidy-title">{tidyTitle(tidy.lessons.length)}</h3>
    {state.kind === "done" ? <p role="status" className="rv-learned-note" data-testid="tidy-result"><VisibleText text={state.text} /></p> : <>
      <p className="rv-muted">These lessons have been used least. Choose the ones Rovara should stop giving to tasks.</p>
      <ul className="rv-tidy-list" aria-label="Least used lessons">{tidy.lessons.map(lesson => <li key={lesson.lessonId}>
        <Checkbox label={visibleText(lesson.title)} checked={chosen.has(lesson.lessonId)} disabled={busy || confirming} onCheckedChange={value => setChosen(old => { const next = new Set(old); if (value === true) next.add(lesson.lessonId); else next.delete(lesson.lessonId); return next; })} />
        <span className="rv-muted rv-tidy-use">{tidyUseWords(lesson)}</span></li>)}</ul>
      {confirming ? <div className="rv-lesson-actions" role="group" aria-label="Confirm retiring">
        <p data-testid="tidy-confirm">{TIDY_CONFIRM(ids.length)}</p>
        <Button variant="danger" busy={busy} onClick={() => { void run(async () => tidyWords(await api.tidyRetire(project, ids))); }}>{`Retire ${String(ids.length)} ${ids.length === 1 ? "lesson" : "lessons"}`}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button></div>
      : <div className="rv-lesson-actions">
        <Button variant="danger" disabled={ids.length === 0 || busy} onClick={() => setConfirming(true)}>Retire chosen</Button>
        <Button variant="quiet" disabled={busy} onClick={() => { void run(async () => { await api.tidyLater(project);return "Okay. Rovara won't ask again this period."; }); }}>{NOT_NOW}</Button></div>}
    </>}
    {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
  </article>;
}
