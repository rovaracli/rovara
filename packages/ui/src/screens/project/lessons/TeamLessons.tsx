// "Team lessons for this area" on a wiki page (lead 4 L4-LP3W): the approved lessons an agent is told in this page's area, so a person reads what agents are told there, with the same ids and words.
// Code decides what is listed (approved, active, readable by the whole project, not flagged) and which pages have an area; a page with none shows nothing. Each lesson has "Ask to retire".
// A lesson's words are the team's notes written from tasks and repository text: shown as text, never as markup, and the agent is told them as notes, not commands.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { areasAbsent, useTeamLessons, type TeamLessonsAnswer } from "../../../api/learned-areas.js";
import { useLearnedApi } from "../../../api/learned.js";
import { ApiError } from "../../../api/errors.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import "./areas.css";

type Row = TeamLessonsAnswer["lessons"][number];
const TYPE_WORDS: Record<string, string> = { fact: "Fact", convention: "Convention", pitfall: "Pitfall", procedure: "Procedure", preference: "Preference", review_check: "Review check" };
export const areaWords = (area: NonNullable<TeamLessonsAnswer["area"]>) => (area.folder === "" ? `${area.repo} (the whole repository)` : `${area.repo}/${area.folder}/`);

function LessonRow({ project, row }: { project: string; row: Row }) {
 const api = useLearnedApi(), announce = useAnnounce(), query = useQueryClient(), [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
 async function ask() {
  setState("busy");
  try { await api.askRetire(project, row.lessonId);setState("done");announce(`${row.statement}: asked. The people who decide lessons will see your request.`);void query.invalidateQueries({ queryKey: ["learned", "project", project] }); }
  catch { setState("error"); }
 }
 return <li className="rv-team-lesson" data-lesson-id={row.lessonId}>
  <p className="rv-team-lesson-head"><b><VisibleText text={row.statement} /></b> <span className="rv-team-lesson-meta"><code>{row.id}</code> · {TYPE_WORDS[row.type] ?? "Lesson"} · team-approved</span></p>
  {row.why !== "" && <p className="rv-team-lesson-why"><VisibleText text={row.why} /></p>}
  {row.detail !== "" && row.detail !== row.why && <details><summary>The full lesson</summary><p className="rv-team-lesson-detail"><VisibleText text={row.detail} /></p></details>}
  {row.scopeLabel !== "" && <p className="rv-muted rv-team-lesson-scope"><VisibleText text={row.scopeLabel} /></p>}
  {state === "done" ? <p role="status" className="rv-learned-note">Asked. The people who decide lessons will see your request.</p>
   : <Button variant="quiet" busy={state === "busy"} aria-label={`Ask to retire: ${row.statement}`} onClick={() => { void ask(); }}>Ask to retire</Button>}
  {state === "error" && <p role="alert" className="rv-lesson-failed">That didn't go through. Reload to check where it stands.</p>}
 </li>;
}

export function TeamLessons({ project, pageId }: { project: string; pageId: string }) {
 const read = useTeamLessons(project, pageId);
 if (read.isPending) return <Skeleton label="Loading team lessons" />;
 // Not served yet, lessons off for the company, or the answer would not read: the page simply has no such section (the page itself is unchanged).
 if (read.isError) return areasAbsent(read.error) || (read.error instanceof ApiError && read.error.code === "INVALID_RESPONSE") ? null : <p className="rv-muted" role="status">Team lessons could not be read just now.</p>;
 const { area, lessons, moreLessons, note } = read.data;
 if (area === undefined) return null;
 return <section className="rv-team-lessons" aria-labelledby="team-lessons-title" data-testid="team-lessons">
  <h2 id="team-lessons-title" className="rv-wiki-h2">Team lessons for this area ({lessons.length + moreLessons})</h2>
  <p className="rv-muted rv-team-lessons-note">{note} <span>Area: <code><VisibleText text={areaWords(area)} /></code></span></p>
  {lessons.length === 0 ? <p className="rv-muted">No team lessons for this area yet. When people keep a lesson that fits here, it shows on this page.</p>
   : <ul className="rv-team-lesson-list" aria-label="Team lessons for this area">{lessons.map(row => <LessonRow key={row.lessonId} project={project} row={row} />)}</ul>}
  {moreLessons > 0 && <p className="rv-muted rv-learned-note">{moreLessons} more apply here and are not listed. Browse them under Learned, by code area.</p>}
 </section>;
}
