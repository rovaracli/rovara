import { useState } from "react";
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
export const AUDIENCE_OPTIONS = [{ value: "project", label: T.SRC_AUDIENCE_PROJECT }, { value: "maintainers", label: T.SRC_AUDIENCE_MAINTAINERS }] as const;
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

interface Props { project: string; row: Row; offered: SourcesAdminViewData["offered"]; skipped: number; notify: (text: string) => void }

/** One source of the project: what it keeps and who sees it, with the controls an editor has. The server decides every rule; this only sends what changed, with the revision it read. */
export function SourceRow({ project, row, offered, skipped, notify }: Props) {
 const writer = useSourceWrite(project), [confirming, setConfirming] = useState(false), id = "source-" + (row.kind + "-" + row.scope).replace(/[^A-Za-z0-9]/gu, "-").slice(0, 80);
 const remove = async () => {
  const reply = await writer.send({ action: "remove", source: row.kind, scope: row.scope, expectedRevision: row.revision });
  if (reply !== undefined) notify(T.SRC_REMOVED);else setConfirming(false);
 };
 return <li><section className="rv-lessons-source" aria-labelledby={id}>
  <h3 id={id}>{kindWords(row.kind)} <span className="rv-muted"><VisibleText text={row.scope} /></span></h3>
  <p>{T.STATUS}: {row.enabled ? T.SOURCE_ON : T.SOURCE_OFF} · {healthWords(row.health)}</p>
  {row.paused && <Banner title={T.SOURCE_PAUSED} tone="warning" />}
  {skipped > 0 && <p className="rv-muted">{String(skipped)} {T.SRC_SKIPPED}</p>}
  <RowControls key={String(row.revision)} row={row} offered={offered} writer={writer} notify={notify} />
  {confirming ? <div role="group" aria-label={T.SRC_REMOVE} className="rv-lessons-actions"><p>{T.SRC_REMOVE_ASK}</p><Button variant="danger" busy={writer.busy} onClick={() => { void remove(); }}>{T.SRC_REMOVE_YES}</Button><Button disabled={writer.busy} onClick={() => { setConfirming(false); }}>{T.SRC_REMOVE_NO}</Button></div>
   : <div className="rv-lessons-actions"><Button variant="quiet" onClick={() => { writer.clear();setConfirming(true); }}>{T.SRC_REMOVE}</Button></div>}
  {writer.error !== undefined && <div role="alert"><p>{writer.error}</p>{writer.reauth && <Button onClick={writer.signInAgain}>{T.SRC_SIGN_IN}</Button>}</div>}
 </section></li>;
}

function RowControls({ row, offered, writer, notify }: { row: Row; offered: SourcesAdminViewData["offered"]; writer: ReturnType<typeof useSourceWrite>; notify: (text: string) => void }) {
 const rovara = row.kind === "rovara", choices = offeredFor(offered, row.kind);
 const [retention, setRetention] = useState(""), [audience, setAudience] = useState<string>(row.audience), [enabled, setEnabled] = useState(row.enabled), [exclude, setExclude] = useState(row.exclude.join("\n")), [problem, setProblem] = useState<string>();
 const lines = [...new Set(exclude.split("\n").map(line => line.trim()).filter(line => line !== ""))];
 const retentionChanged = retention !== "" && retention !== row.retention, audienceChanged = !rovara && audience !== row.audience, enabledChanged = enabled !== row.enabled, excludeChanged = !sameList(lines, row.exclude);
 const lowered = retentionChanged && (RANK[retention] ?? 0) < (RANK[row.retention] ?? 0);
 const save = async () => {
  if (lines.length > 200 || lines.some(line => line.length > 300)) { setProblem(T.SRC_EXCLUDE_TOO_MANY);return; }
  setProblem(undefined);
  const reply = await writer.send({ action: "change", source: row.kind, scope: row.scope, expectedRevision: row.revision, ...(retentionChanged ? { retention } : {}), ...(audienceChanged ? { audienceDefault: audience } : {}), ...(enabledChanged ? { enabled } : {}), ...(excludeChanged ? { exclude: lines } : {}) });
  if (reply === undefined) return;
  notify(reply.status === "needs_approval" ? T.SRC_NEEDS_SECOND : lowered ? T.SRC_SAVED + " " + T.SRC_LOWERED : T.SRC_SAVED);
 };
 return <fieldset className="rv-lessons-edit" disabled={writer.busy}><legend>{T.SRC_SAVE}</legend>
  <Select label={T.SRC_RETENTION} value={retention === "" ? (choices.includes(row.retention) ? row.retention : "") : retention} placeholder={retentionWords(row.retention)} options={choices.map(mode => ({ value: mode, label: retentionWords(mode) }))} onValueChange={setRetention} />
  {lowered && <p className="rv-muted">{T.SRC_LOWERED}</p>}
  {rovara ? <p className="rv-muted">{T.WHO_SEES}: {T.SRC_ROVARA_AUDIENCE}</p> : <Select label={T.SRC_AUDIENCE} value={audience} options={AUDIENCE_OPTIONS} onValueChange={setAudience} />}
  <Switch label={T.SRC_ON} checked={enabled} onCheckedChange={setEnabled} />
  <TextArea label={T.SRC_EXCLUDE} hint={T.SRC_EXCLUDE_HINT} value={exclude} onChange={event => { setExclude(event.target.value); }} rows={3} {...(problem === undefined ? {} : { error: problem })} />
  <div className="rv-lessons-actions"><Button variant="primary" busy={writer.busy} disabled={!(retentionChanged || audienceChanged || enabledChanged || excludeChanged)} onClick={() => { void save(); }}>{T.SRC_SAVE}</Button></div>
 </fieldset>;
}
