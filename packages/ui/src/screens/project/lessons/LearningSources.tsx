// "Where Rovara learns from" (lead 4 L4-LP3W): one row per kind of source, with what it gave in the last 30 days (seen, suggested, kept), one real example, and a Pause for those Code says may pause.
// A paused source is not read at all (owner 2026-11-18): Rovara collects and keeps nothing from it while it is paused, and resuming starts again from then. Lessons already made stay. Code decides who may pause; this only shows the control when it says so. Every word is Cloud's own.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { areasAbsent, SOURCE_FAILED, useLearnedAreasApi, useLearningSources, type LearningSourcesAnswer } from "../../../api/learned-areas.js";
import { learnedKey } from "../../../api/learned.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useIdentityFrozen } from "../write-freeze.js";
import "./areas.css";

type Row = LearningSourcesAnswer["sources"][number];
const plural = (n: number, one: string, many = one + "s") => `${String(n)} ${n === 1 ? one : many}`;
/** "12 seen, 5 suggested, 3 kept" and, once something was suggested, how much of it was kept. */
export function countWords(row: Pick<Row, "seen" | "suggested" | "kept">): string {
 const base = `${String(row.seen)} seen · ${String(row.suggested)} suggested · ${String(row.kept)} kept`;
 return row.suggested === 0 ? base : `${base} (${String(Math.round((row.kept / row.suggested) * 100))}% of suggestions)`;
}
export const PAUSED_WORDS = "Paused. Rovara is not reading this source. Lessons already made stay.";
/** The Pause switch's help text (both states). */
export const PAUSE_HELP = "Rovara stops reading this source while paused. Nothing from the paused time is kept.";

function SourceRow({ project, row, canPause, onExample }: { project: string; row: Row; canPause: boolean; onExample: (lessonId: string) => void }) {
 const frozen = useIdentityFrozen();
 const api = useLearnedAreasApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function set(paused: boolean) {
  if (busy) return;
  setBusy(true);setError(undefined);
  try { await api.setPaused(project, row.key, paused);await query.invalidateQueries({ queryKey: [...learnedKey(project), "learning-sources"] }); }
  catch (failure) { setError(failure instanceof ApiError && failure.status === 403 ? "Only an admin of this project, or an owner or admin of the company, can pause a source." : SOURCE_FAILED); }
  finally { setBusy(false); }
 }
 return <li className="rv-source" data-source={row.key} data-paused={row.paused ? "true" : undefined}>
  <div className="rv-source-head"><b><VisibleText text={row.label} /></b><span className="rv-muted"><VisibleText text={row.detail} /></span></div>
  <p className="rv-source-counts" data-testid={"source-counts-" + row.key}>{countWords(row)}</p>
  {row.example !== undefined && <p className="rv-source-example">Last suggestion: <a href={"#learned-" + row.example.lessonId} onClick={() => { onExample(row.example!.lessonId); }}><VisibleText text={row.example.title} /></a></p>}
  {row.paused && <p className="rv-source-paused" role="status">{PAUSED_WORDS}</p>}
  {canPause && <Switch label={row.paused ? `Resume ${row.label}` : `Pause ${row.label}`} checked={row.paused} disabled={busy || frozen} onCheckedChange={paused => { void set(paused); }} help={PAUSE_HELP} />}
  {error !== undefined && <p role="alert" className="rv-lesson-failed"><VisibleText text={error} /></p>}
 </li>;
}

/** `onExample` takes the person to the lesson's card in the list (the section switches to the full list). */
export function LearningSources({ project, onExample }: { project: string; onExample: (lessonId: string) => void }) {
 const read = useLearningSources(project);
 if (read.isPending) return <Skeleton label="Loading where Rovara learns from" />;
 if (read.isError) {
  if (areasAbsent(read.error)) return null;
  return <div role="alert" className="rv-section-error"><p><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load where Rovara learns from."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>;
 }
 return <section className="rv-sources" aria-labelledby="sources-title" data-testid="learning-sources">
  <h3 id="sources-title">Where Rovara learns from</h3>
  <p className="rv-muted rv-learned-note">What each kind of source gave in the last 30 days. Pausing one stops Rovara reading it, and nothing from the paused time is kept. Lessons already made stay.</p>
  <ul className="rv-source-list">{read.data.sources.map(row => <SourceRow key={row.key} project={project} row={row} canPause={read.data.canPause} onExample={onExample} />)}</ul>
  {read.data.partial === true && <p className="rv-muted rv-learned-note">Rovara counted what it could in the time it had, so these numbers are at least this much.</p>}
  {!read.data.canPause && <p className="rv-muted rv-learned-note">Only an admin of this project, or an owner or admin of the company, can pause a source.</p>}
 </section>;
}
export { plural as sourcePlural };
