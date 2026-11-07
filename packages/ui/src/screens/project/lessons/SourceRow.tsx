import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { lessonsKey, useLessonsApi } from "../../../api/lessons.js";
import type { SourcesAdminViewData } from "../../../api/record-sources.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Switch } from "../../../design/Switch.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T, healthWords, kindWords, retentionWords } from "./lessons-text.js";
import { useSourceWrite } from "./use-source-write.js";

type Row = SourcesAdminViewData["sources"][number];
const RANK: Readonly<Record<string, number>> = { A: 0, B: 1, C: 2, D: 3 };
/** The retention the server offers for a kind (a code-host row is offered what `codehost` is). */
export const offeredFor = (offered: SourcesAdminViewData["offered"], kind: string): readonly string[] => offered[kind] ?? offered[kind.split(":")[0]!] ?? [];
/** The Public notes line: what Rovara keeps, with "Slack's API terms" as a real link (design 4.3), opened in a new tab and without the opener. The sentence itself is one constant (`T.SRC_NOTES_NOTE`). */
export function NotesNote() {
 const at = T.SRC_NOTES_NOTE.indexOf(T.SRC_NOTES_LINK_TEXT);
 return <p className="rv-muted">{T.SRC_NOTES_NOTE.slice(0, at)}<a href={T.SRC_NOTES_LINK} target="_blank" rel="noopener noreferrer">{T.SRC_NOTES_LINK_TEXT}</a>{T.SRC_NOTES_NOTE.slice(at + T.SRC_NOTES_LINK_TEXT.length)}</p>;
}
/** The Public notes switch with its note. When the company only allows live reading for Slack (retention B is not offered) the switch cannot be turned ON and says why (one fixed reason); a row already at B can still be switched off. */
export function NotesSwitch({ checked, onChange, offered }: { checked: boolean; onChange: (next: boolean) => void; offered: boolean }) {
 return <><Switch label={T.SRC_NOTES_SWITCH} checked={checked} onCheckedChange={onChange} disabled={!offered && !checked} />{!offered && <p className="rv-muted">{T.SRC_NOTES_LIVE_ONLY}</p>}<NotesNote /></>;
}
export const AUDIENCE_OPTIONS = [{ value: "project", label: T.SRC_AUDIENCE_PROJECT }, { value: "maintainers", label: T.SRC_AUDIENCE_MAINTAINERS }] as const;
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

interface Props { project: string; row: Row; offered: SourcesAdminViewData["offered"]; skipped: number; notesSwitch: boolean; notify: (text: string) => void }

/** One source of the project: what it keeps and who sees it, with the controls an editor has. The server decides every rule; this only sends what changed, with the revision it read. */
export function SourceRow({ project, row, offered, skipped, notesSwitch, notify }: Props) {
 const writer = useSourceWrite(project), [confirming, setConfirming] = useState(false), id = "source-" + (row.kind + "-" + row.scope).replace(/[^A-Za-z0-9]/gu, "-").slice(0, 80);
 const remove = async () => {
  const reply = await writer.send({ action: "remove", source: row.kind, scope: row.scope, expectedRevision: row.revision });
  if (reply !== undefined) notify(T.SRC_REMOVED);else setConfirming(false);
 };
 return <li><section className="rv-lessons-source" aria-labelledby={id}>
  <h3 id={id}>{kindWords(row.kind)} <span className="rv-muted"><VisibleText text={row.scope} /></span></h3>
  <p>{T.STATUS}: {row.enabled ? T.SOURCE_ON : T.SOURCE_OFF} · {healthWords(row.health)}</p>
  {row.paused && <><Banner title={T.SOURCE_PAUSED} tone="warning" /><ResumeSource project={project} row={row} notify={notify} /></>}
  {skipped > 0 && <p className="rv-muted">{String(skipped)} {T.SRC_SKIPPED}</p>}
  <RowControls key={String(row.revision)} row={row} offered={offered} notesSwitch={notesSwitch} writer={writer} notify={notify} />
  {confirming ? <div role="group" aria-label={T.SRC_REMOVE} className="rv-lessons-actions"><p>{T.SRC_REMOVE_ASK}</p><Button variant="danger" busy={writer.busy} onClick={() => { void remove(); }}>{T.SRC_REMOVE_YES}</Button><Button disabled={writer.busy} onClick={() => { setConfirming(false); }}>{T.SRC_REMOVE_NO}</Button></div>
   : <div className="rv-lessons-actions"><Button variant="quiet" onClick={() => { writer.clear();setConfirming(true); }}>{T.SRC_REMOVE}</Button></div>}
  {writer.error !== undefined && <div role="alert"><p>{writer.error}</p></div>}
 </section></li>;
}

/** UX-4b: Resume, for a source the learning loop paused. The lessons it held are settled again and wait for a maintainer; nothing goes live from here. */
function ResumeSource({ project, row, notify }: { project: string; row: Row; notify: (text: string) => void }) {
 const api = useLessonsApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>();
 const resume = async () => {
  setBusy(true);setProblem(undefined);
  try {
   const result = await api.resume(project, row.kind, row.scope);
   notify(result.resumed ? T.SRC_RESUMED + (result.settled > 0 ? " " + String(result.settled) + " " + T.SRC_RESUMED_HELD : "") : T.SRC_RESUME_GONE);
   await query.invalidateQueries({ queryKey: lessonsKey(project) });
  } catch (error) { setProblem(error instanceof ApiError && error.code === "FORBIDDEN" ? T.SRC_RESUME_FORBIDDEN : T.SRC_RESUME_FAILED); }
  finally { setBusy(false); }
 };
 return <div className="rv-lessons-actions"><Button variant="primary" busy={busy} onClick={() => { void resume(); }}>{T.SRC_RESUME}</Button>{problem !== undefined && <p role="alert">{problem}</p>}</div>;
}

function RowControls({ row, offered, notesSwitch, writer, notify }: { row: Row; offered: SourcesAdminViewData["offered"]; notesSwitch: boolean; writer: ReturnType<typeof useSourceWrite>; notify: (text: string) => void }) {
 // In the Public edition a Slack row has no retention choice: "notes with links" is a switch (off: A, read live only; on: B with the opt-in).
 const rovara = row.kind === "rovara", choices = offeredFor(offered, row.kind), notesMode = notesSwitch && row.kind === "slack", notesWas = row.retention === "B" && row.notesOptIn === true;
 const [retention, setRetention] = useState(""), [audience, setAudience] = useState<string>(row.audience), [enabled, setEnabled] = useState(row.enabled), [notes, setNotes] = useState(notesWas), [exclude, setExclude] = useState(row.exclude.join("\n")), [problem, setProblem] = useState<string>();
 const lines = [...new Set(exclude.split("\n").map(line => line.trim()).filter(line => line !== ""))];
 const retentionChanged = !notesMode && retention !== "" && retention !== row.retention, notesChanged = notesMode && notes !== notesWas, audienceChanged = !rovara && audience !== row.audience, enabledChanged = enabled !== row.enabled, excludeChanged = !sameList(lines, row.exclude);
 const lowered = (retentionChanged && (RANK[retention] ?? 0) < (RANK[row.retention] ?? 0)) || (notesChanged && !notes);
 const save = async () => {
  if (lines.length > 200 || lines.some(line => line.length > 300)) { setProblem(T.SRC_EXCLUDE_TOO_MANY);return; }
  setProblem(undefined);
  const reply = await writer.send({ action: "change", source: row.kind, scope: row.scope, expectedRevision: row.revision, ...(retentionChanged ? { retention } : {}), ...(notesChanged ? { retention: notes ? "B" : "A", notesOptIn: notes ? true : null } : {}), ...(audienceChanged ? { audienceDefault: audience } : {}), ...(enabledChanged ? { enabled } : {}), ...(excludeChanged ? { exclude: lines } : {}) });
  if (reply === undefined) return;
  notify(lowered ? T.SRC_SAVED + " " + T.SRC_LOWERED : T.SRC_SAVED);
 };
 return <fieldset className="rv-lessons-edit" disabled={writer.busy}><legend>{T.SRC_SAVE}</legend>
  {notesMode ? <NotesSwitch checked={notes} onChange={setNotes} offered={choices.includes("B")} />
   : <Select label={T.SRC_RETENTION} value={retention === "" ? (choices.includes(row.retention) ? row.retention : "") : retention} placeholder={retentionWords(row.retention)} options={choices.map(mode => ({ value: mode, label: retentionWords(mode) }))} onValueChange={setRetention} />}
  {lowered && <p className="rv-muted">{T.SRC_LOWERED}</p>}
  {rovara ? <p className="rv-muted">{T.WHO_SEES}: {T.SRC_ROVARA_AUDIENCE}</p> : <Select label={T.SRC_AUDIENCE} value={audience} options={AUDIENCE_OPTIONS} onValueChange={setAudience} />}
  <Switch label={T.SRC_ON} checked={enabled} onCheckedChange={setEnabled} />
  <TextArea label={T.SRC_EXCLUDE} hint={T.SRC_EXCLUDE_HINT} value={exclude} onChange={event => { setExclude(event.target.value); }} rows={3} {...(problem === undefined ? {} : { error: problem })} />
  <div className="rv-lessons-actions"><Button variant="primary" busy={writer.busy} disabled={!(retentionChanged || notesChanged || audienceChanged || enabledChanged || excludeChanged)} onClick={() => { void save(); }}>{T.SRC_SAVE}</Button></div>
 </fieldset>;
}
