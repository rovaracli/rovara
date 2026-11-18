import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PATHS_HELP, bothPlacesWords, parsePaths, plainPath } from "../../../api/graduation.js";
import { useLearnedApi, useLessonPages, type LessonItem } from "../../../api/learned.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { failureWords, refreshIfStale, refreshLessons } from "./graduation-shared.js";

const MAX = 20;
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((one, index) => one === [...b].sort()[index]);
/** What is wrong with one path field, in words, or undefined. */
export function pathsProblem(paths: string[]): string | undefined {
  if (paths.length === 0) return "Give at least one path.";
  if (paths.length > MAX) return `At most ${String(MAX)} paths.`;
  if (paths.some(one => !plainPath(one))) return "Use plain paths such as src/billing/**, with no leading slash and no \"..\".";
  return undefined;
}

/**
 * The third answer to a conflict: both lessons are right, each in its own place. Two path fields (this new lesson, and the older one it contradicts, named by title when
 * it is in view); the older lesson will apply only to its new place. Then the waiting lesson is kept as usual. For people who may keep it.
 */
export function BothPlaces({ project, lesson }: { project: string; lesson: LessonItem }) {
  const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
  const [open, setOpen] = useState(false), [cardText, setCardText] = useState(lesson.scope.paths.join("\n")), [otherText, setOtherText] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string }>({ kind: "idle" });
  // The older lesson is named by title when it is in view (the approved list); its id is never shown.
  const approved = useLessonPages(project, "approved", open), older = approved.data?.pages.flatMap(one => one.lessons).find(one => one.id === lesson.contradicts);
  const cardPaths = parsePaths(cardText), otherPaths = parsePaths(otherText), busy = state.kind === "busy";
  const cardProblem = pathsProblem(cardPaths), otherProblem = pathsProblem(otherPaths);
  const sameProblem = cardProblem === undefined && otherProblem === undefined && same(cardPaths, otherPaths) ? "The two lessons need different places. Change one of them." : undefined;
  const olderName = older === undefined ? "the older lesson" : `"${older.title}"`;
  async function save() {
    if (busy || cardProblem !== undefined || otherProblem !== undefined || sameProblem !== undefined) return;
    setState({ kind: "busy" });
    try {
      const text = bothPlacesWords(await api.bothPlaces(project, lesson.id, { version: lesson.version, cardPaths, otherPaths }));
      setState({ kind: "done", text });announce(`${lesson.title}: ${text}`);refreshLessons(query, project);
    } catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Nothing was changed.") });refreshIfStale(failure, query, project, announce); }
  }
  if (state.kind === "done") return <p role="status" className="rv-learned-note" data-testid="both-places-result"><VisibleText text={state.text} /></p>;
  return <div className="rv-both-places">
    {!open ? <Button variant="quiet" aria-label={visibleText(`Both, in different places: ${lesson.title}`)} onClick={() => setOpen(true)}>Both, in different places</Button> : <form className="rv-retire-form" aria-label={visibleText(`Both, in different places: ${lesson.title}`)} onSubmit={event => { event.preventDefault();void save(); }}>
      <p className="rv-lesson-relation">Both lessons can be right when they apply in different places. <VisibleText text={older === undefined ? "The older lesson" : olderName} /> will apply only to its new place.</p>
      <TextArea label={visibleText(`Where "${lesson.title}" applies`)} hint={PATHS_HELP} rows={3} value={cardText} disabled={busy} {...(cardProblem === undefined ? {} : { error: cardProblem })} onChange={event => setCardText(event.target.value)} />
      <TextArea label={visibleText(`Where ${olderName} will apply from now on`)} hint={PATHS_HELP} rows={3} value={otherText} disabled={busy} {...(otherProblem === undefined ? {} : { error: otherProblem })} onChange={event => setOtherText(event.target.value)} />
      {sameProblem !== undefined && <p role="alert" className="rv-lesson-failed">{sameProblem}</p>}
      <div className="rv-lesson-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={cardProblem !== undefined || otherProblem !== undefined || sameProblem !== undefined}>Save both</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>}
    {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
  </div>;
}
