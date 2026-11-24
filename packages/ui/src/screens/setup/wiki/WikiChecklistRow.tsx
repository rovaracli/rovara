// The wiki panel on the setup page (lead 4 W6; DEC 254zi, 254zza): ONE row of the project's setup checklist (no second setup page). It shows the free file map's forecast (pages, no dollars),
// "Tell Rovara what matters", Build / Stop / Continue with progress and the report, "Give the wiki to agents" (off by default), Refresh now, Delete wiki, and the one "Nightly upkeep" switch with its
// monthly cap. Everything is read from Code through Cloud and Code decides who may act: a person who may not sees where the wiki stands and no control. The row is not counted in the checklist's progress
// (Code computes that) and is absent altogether while Code has no wiki build.
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WIKI_SETUP_CODE_WORDS } from "@agentx/contracts/web";
import { fixedWikiSetupWords, useWikiSetupApi, wikiSetupAbsent, wikiSetupKey, type WikiSetupBuild, type WikiSetupMap, type WikiSetupMapView } from "../../../api/wiki-setup.js";
import { ApiError } from "../../../api/errors.js";
import { servedReadState } from "../../../api/served-read.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { StatusPill, type StatusTone } from "../../../design/StatusDot.js";
import { Switch } from "../../../design/Switch.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { NightlyUpkeep } from "./NightlyUpkeep.js";
import { T, rowStateOf, skippedLine, type RowState } from "./wiki-setup-text.js";
import "./wiki-setup.css";

const PILL: Readonly<Record<RowState, { label: string; tone: StatusTone }>> = Object.freeze({
  done: { label: "Done", tone: "ok" }, needs_you: { label: "Needs you", tone: "wait" }, running: { label: "Running", tone: "run" }, optional: { label: "Optional", tone: "idle" },
});

type ActionName = "map" | "build" | "stop" | "continue" | "refresh" | "agents" | "delete";

function Facts({ items }: { items: Array<[string, string | number]> }) {
  return <dl className="rv-wikis-facts">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}

function Forecast({ map, canManage, mayBuild, keyMissing, chipsOn, onChip, notes, onNotes, disabled }: { map: WikiSetupMap; keyMissing: boolean; mayBuild: boolean; canManage: boolean; chipsOn: (id: string, fallback: boolean) => boolean; onChip: (id: string, on: boolean) => void; notes: string; onNotes: (value: string) => void; disabled: boolean }) {
  const first = map.chips.filter((chip) => chip.kind === "write_first"), skip = map.chips.filter((chip) => chip.kind !== "write_first");
  const chipGroup = (title: string, chips: typeof map.chips) => chips.length === 0 ? null : (
    <fieldset className="rv-wikis-chips" disabled={!canManage || disabled}><legend>{title}</legend>
      {chips.map((chip) => <Checkbox key={chip.id} label={chip.label} checked={chipsOn(chip.id, chip.defaultOn)} onCheckedChange={(on) => { onChip(chip.id, on === true); }} />)}
    </fieldset>
  );
  return <>
    <p>{mayBuild ? T.FORECAST_LEDE : T.FORECAST_LEDE_VIEWER}</p>
    <div className="rv-wikis-table"><table>
      <thead><tr><th scope="col">Repo</th><th scope="col" className="r">Files</th><th scope="col" className="r">Pages expected</th></tr></thead>
      <tbody>{map.repositories.map((repo) => <tr key={repo.name}>
        <th scope="row"><VisibleText text={repo.name} />{repo.status !== "ok" && <span className="rv-muted"> (<VisibleText text={repo.partial ?? repo.unavailable ?? ""} />)</span>}</th>
        <td className="r">{repo.files.toLocaleString("en-US")}</td><td className="r">{repo.status === "unavailable" || map.forecast.pages === 0 ? "0" : String(repo.pages.modules + 1)}{repo.pages.modulesCapped ? "+" : ""}</td>
      </tr>)}</tbody>
      <tfoot><tr><th scope="row">{T.TOTAL}</th><td className="r">{map.forecast.files.toLocaleString("en-US")}</td><td className="r" data-testid="wiki-forecast-pages">{map.forecast.pages}{map.forecast.pagesCapped ? "+" : ""}</td></tr></tfoot>
    </table></div>
    {!map.forecast.complete && <p className="rv-muted" data-testid="wiki-forecast-partial">{T.FORECAST_PARTIAL}</p>}
    <details className="rv-wikis-matters" data-testid="wiki-matters">
      <summary>{T.MATTERS}</summary>
      <div><p className="rv-muted">{T.MATTERS_HINT}</p>{chipGroup(T.CHIPS_FIRST, first)}{chipGroup(T.CHIPS_SKIP, skip)}
        <TextArea label={T.NOTES_LABEL} placeholder={T.NOTES_PLACEHOLDER} value={notes} maxLength={2000} disabled={!canManage || disabled} onChange={(event) => { onNotes(event.target.value); }} />
      </div>
    </details>
    <p className="rv-muted">{keyMissing ? T.SPENDS_NO_KEY : T.SPENDS}</p>
    <p className="rv-muted">{T.FREE_MAP}</p>
  </>;
}

export function WikiChecklistRow({ project, companyAdmin, alone = false, startOpen = false, bare = false }: { project: string; companyAdmin: boolean; /** Only the body: the Setup tab's "Also for this project" row names it and opens it. */ bare?: boolean; /** On its own (a finished checklist leaves the project page): the row brings its own list. */ alone?: boolean; /** Open before any build (the Wiki tab's empty state shows the row to build from). */ startOpen?: boolean }) {
  const api = useWikiSetupApi(), query = useQueryClient();
  const build = useQuery({ queryKey: wikiSetupKey(project, "build"), queryFn: () => api.build(project), retry: false, refetchInterval: (current) => (current.state.data?.status === "running" ? 4_000 : false) });
  const map = useQuery({ queryKey: wikiSetupKey(project, "map"), queryFn: () => api.map(project), retry: false, staleTime: 60_000 });
  const [busy, setBusy] = useState<ActionName>(), [error, setError] = useState<string>(), [deleted, setDeleted] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [notes, setNotes] = useState(""), [touched, setTouched] = useState<Record<string, boolean>>({});
  // One request id per action until it succeeds: a retry after a failure repeats the same id, which Code answers with the state and never does twice.
  const ids = useRef(new Map<ActionName, string>());
  if (build.isError && wikiSetupAbsent(build.error)) return null;
  const title = <span className="rv-checklist-title">{T.TITLE}</span>;
  const wrap = (state: RowState, body: ReactNode, open = false) => {
    if (bare) return <div className="rv-checklist-body rv-wikis" data-testid="project-wiki-bare" data-state={state}>{body}</div>;
    const pill = PILL[state];
    const row = <li className="rv-checklist-row" data-testid="checklist-row-wiki" data-state={state}>
      <details open={open}><summary>{title} <StatusPill tone={pill.tone} label={pill.label} /></summary><div className="rv-checklist-body rv-wikis">{body}</div></details>
    </li>;
    return alone ? <ol className="rv-checklist-rows" data-testid="project-wiki-only">{row}</ol> : row;
  };
  if (build.isPending) return wrap("optional", <Skeleton label={T.LOADING} />);
  // Rule #14: what the row shows of a failed re-read is the last facts and one line, and nothing can be started from them; an access signal wipes them.
  const shownBuild = servedReadState(build).data;
  if (shownBuild === undefined) return wrap("optional", <><p role="alert" data-testid="wiki-setup-error"><VisibleText text={fixedWikiSetupWords(build.error, T.UNAVAILABLE)} /></p><Button onClick={() => { void build.refetch(); }}>{T.RETRY}</Button></>, true);
  const readFresh = !build.isError && build.failureCount === 0;
  const view: WikiSetupBuild = shownBuild, canManage = view.canManage && readFresh;
  const mapView: WikiSetupMapView | undefined = map.data, ready = mapView?.status === "ready" ? mapView.map : undefined;

  async function act<T>(name: ActionName, run: (requestId: string) => Promise<T>, then: (answer: T) => void) {
    // Refused again at send time: the build read must still be a success (never the last facts of a failed one).
    const latest = query.getQueryState(wikiSetupKey(project, "build"));
    if (latest === undefined || latest.status !== "success" || latest.fetchFailureCount > 0) { setError(T.SEND_REFUSED); return; }
    setBusy(name); setError(undefined);
    const requestId = ids.current.get(name) ?? crypto.randomUUID();
    ids.current.set(name, requestId);
    try {
      const answer = await run(requestId);
      ids.current.delete(name);
      then(answer);
      // The Wiki tab reads the same pages: it must not show an older answer.
      void query.invalidateQueries({ queryKey: ["wiki", project] });
    } catch (caught) {
      setError(fixedWikiSetupWords(caught, caught instanceof ApiError && caught.status === 401 ? T.UNAVAILABLE : T.ACT_FAILED));
      void query.invalidateQueries({ queryKey: wikiSetupKey(project, "build") });
    } finally { setBusy(undefined); }
  }
  const setBuild = (next: WikiSetupBuild) => { query.setQueryData(wikiSetupKey(project, "build"), next); };
  const post = (name: Exclude<ActionName, "map" | "delete" | "build" | "agents">, call: (requestId: string) => Promise<WikiSetupBuild>) => { void act(name, call, (next) => { setDeleted(false); setBuild(next); }); };
  const chipsOn = (id: string, fallback: boolean) => touched[id] ?? fallback;

  const mapFiles = () => { void act("map", () => api.makeMap(project), (next) => { query.setQueryData(wikiSetupKey(project, "map"), next); }); };
  const start = () => {
    if (ready === undefined) return;
    const on = ready.chips.filter((chip) => chipsOn(chip.id, chip.defaultOn)).map((chip) => chip.id);
    void act("build", (requestId) => api.start(project, { requestId, ...(notes.trim() === "" ? {} : { notes }), chipsOn: on }), (next) => { setDeleted(false); setBuild(next); });
  };

  const state = rowStateOf(view);
  const hasPages = view.wiki.pages > 0;
  const keyMissing = view.aiKey === "missing";
  const running = view.status === "running";
  if (running && confirmDelete) setConfirmDelete(false);
  const head = <>
    <p className="rv-muted">{T.SUBTITLE}</p>
    {!view.canManage && <p data-testid="wiki-setup-read-only">{T.READ_ONLY}</p>}
    {view.canManage && !readFresh && <p role="status" data-testid="wiki-setup-reconnecting">{T.RECONNECTING}</p>}
    {deleted && <p role="status" data-testid="wiki-setup-deleted">{T.DELETED}</p>}
    {error !== undefined && readFresh && <p role="alert" data-testid="wiki-setup-action-error"><VisibleText text={error} /></p>}
  </>;

  let main: ReactNode;
  if (running) {
    const planned = view.summary?.pagesPlanned ?? 0, written = view.summary?.pagesWritten ?? 0;
    main = <section aria-label={T.RUNNING} data-testid="wiki-setup-running">
      <div className="rv-wikis-line"><h3>{T.RUNNING}</h3>{canManage && <Button variant="danger" busy={busy === "stop"} data-testid="wiki-setup-stop" onClick={() => { post("stop", (id) => api.stop(project, id)); }}>{T.STOP}</Button>}</div>
      {planned > 0 ? <p className="rv-wikis-progress"><progress max={planned} value={Math.min(written, planned)} aria-label={T.PROGRESS} /> <span data-testid="wiki-setup-progress">{T.PAGES_OF(written, planned)}</span></p> : <p className="rv-muted">Mapping and planning the pages.</p>}
      <p className="rv-muted">Pages show in the wiki as soon as they are written. You can leave this page.</p>
    </section>;
  } else if (view.status === "none") {
    main = <section aria-label="Before the build" data-testid="wiki-setup-forecast">
      {map.isPending ? <Skeleton label="Loading the file map" />
        : map.isError ? <p role="status" data-testid="wiki-setup-map-error"><VisibleText text={wikiSetupAbsent(map.error) ? T.MAP_UNAVAILABLE : fixedWikiSetupWords(map.error, T.UNAVAILABLE)} /></p>
        : ready === undefined ? <><p>{canManage ? T.NO_MAP : T.NO_MAP_VIEWER}</p>{canManage && <Button variant="primary" busy={busy === "map"} data-testid="wiki-setup-map" onClick={mapFiles}>{T.MAP_FILES}</Button>}</>
        : <>
          <Forecast map={ready} canManage={canManage} mayBuild={view.canManage} keyMissing={keyMissing} chipsOn={chipsOn} onChip={(id, on) => { setTouched((now) => ({ ...now, [id]: on })); }} notes={notes} onNotes={(value) => { setNotes(value.replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "")); }} disabled={busy !== undefined} />
          {canManage && <div className="rv-wikis-actions">
            <Button variant="primary" busy={busy === "build"} disabled={keyMissing || ready.forecast.pages === 0} data-testid="wiki-setup-build" onClick={start}>{T.BUILD}</Button>
            <Button busy={busy === "map"} data-testid="wiki-setup-map" onClick={mapFiles}>{T.MAP_AGAIN}</Button>
          </div>}
          {canManage && !keyMissing && ready.forecast.pages === 0 && <p role="status" data-testid="wiki-setup-no-pages">{T.NO_PAGES}</p>}
          {canManage && keyMissing && <p data-testid="wiki-setup-connect-key"><VisibleText text={view.connectKey ?? T.CONNECT_KEY_LINK} /> {companyAdmin ? <Link to="/app/admin/ai-spending">{T.CONNECT_KEY_LINK}</Link> : T.CONNECT_KEY_ASK}</p>}
        </>}
    </section>;
  } else {
    const message = view.message;
    const skipped = ready === undefined ? undefined : skippedLine(ready.repositories);
    const folders = ready?.repositories.flatMap((repo) => repo.skippedFolders.map((folder) => `${repo.name}/${folder.replace(/^\/+/u, "")}`)) ?? [];
    main = <section aria-label="Build result" data-testid="wiki-setup-result" data-status={view.status}>
      {message !== undefined && <p role="status" className={view.status === "built" ? "rv-wikis-ok" : "rv-wikis-stopped"} data-testid="wiki-setup-message"><b><VisibleText text={message} /></b>{view.stoppedBy !== undefined && view.stop === "stopped_by_person" && <> <VisibleText text={T.STOPPED_BY(view.stoppedBy.name)} /></>}</p>}
      {view.status === "stopped" && view.canContinue === true && canManage && view.stop === "budget_used" && <p className="rv-muted" data-testid="wiki-setup-raise-cap"><VisibleText text={T.RAISE_CAP} /></p>}
      {view.status === "stopped" && view.canContinue === true && canManage && view.stop !== "budget_used" && <div className="rv-wikis-actions"><Button variant="primary" busy={busy === "continue"} data-testid="wiki-setup-continue" onClick={() => { post("continue", (id) => api.continue(project, id)); }}>{T.CONTINUE}</Button><span className="rv-muted">{T.CONTINUE_NOTE}</span></div>}
      {view.status === "stopped" && (keyMissing || view.stop === "needs_ai_key") && canManage && <p data-testid="wiki-setup-connect-key"><VisibleText text={view.connectKey ?? WIKI_SETUP_CODE_WORDS.connectKey} /> {companyAdmin ? <Link to="/app/admin/ai-spending">{T.CONNECT_KEY_LINK}</Link> : T.CONNECT_KEY_ASK}</p>}
      {view.summary !== undefined && <div data-testid="wiki-setup-report"><h3>{T.REPORT}</h3>
        <Facts items={[[T.PAGES_WRITTEN, view.summary.pagesWritten], ...(view.summary.pagesKeptFromEarlier > 0 ? [[T.PAGES_KEPT, view.summary.pagesKeptFromEarlier] as [string, number]] : []), [T.CLAIMS_KEPT, view.summary.claimsKept], [T.CLAIMS_DROPPED, view.summary.claimsDropped]]} />
        <p className="rv-muted">{T.DROPPED_NOTE}</p>
        {skipped !== undefined && <p className="rv-muted" data-testid="wiki-setup-skipped">{T.SKIPPED}: {skipped}.</p>}
        {folders.length > 0 && <details className="rv-wikis-matters"><summary>{T.SKIPPED_FOLDERS}</summary><ul>{folders.map((folder) => <li key={folder}><code><VisibleText text={folder} /></code></li>)}</ul></details>}
      </div>}
      {hasPages && <p><Link className="rv-button rv-button-secondary" data-testid="wiki-setup-open" to={`/app/projects/${encodeURIComponent(project)}?tab=wiki`}>{T.OPEN}</Link></p>}
    </section>;
  }

  const controls = hasPages && canManage ? <section aria-label="Wiki settings" className="rv-wikis-controls" data-testid="wiki-setup-controls">
    <div className="rv-wikis-setting"><div>
      <h3>{T.AGENTS}</h3><p className="rv-muted">{T.AGENTS_TEXT}</p><p className="rv-muted" data-testid="wiki-setup-agents-state">{view.agents.on ? T.AGENTS_ON : T.AGENTS_OFF}</p></div>
      <Switch label={T.AGENTS} checked={view.agents.on} disabled={busy !== undefined} onCheckedChange={(on) => { void act("agents", (id) => api.agents(project, id, on), (next) => { setBuild(next); }); }} />
    </div>
    <div className="rv-wikis-setting"><div>
      <h3>{T.REFRESH}</h3><p className="rv-muted">{T.REFRESH_TEXT} <span data-testid="wiki-setup-refresh-count">{view.wiki.refreshPages > 0 ? T.REFRESH_SOME(view.wiki.refreshPages) : T.REFRESH_NONE}</span></p></div>
      <Button busy={busy === "refresh"} disabled={running || keyMissing} data-testid="wiki-setup-refresh" onClick={() => { post("refresh", (id) => api.refresh(project, id)); }}>{T.REFRESH}</Button>
    </div>
    <div className="rv-wikis-setting"><div>
      <h3>{T.DELETE}</h3><p className="rv-muted">{T.DELETE_TEXT}</p>
      {running && <p className="rv-muted">{T.DELETE_RUNNING}</p>}
      {confirmDelete && !running && <div className="rv-wikis-actions" role="group" aria-label="Confirm deleting the wiki"><span>{T.DELETE_ASK}</span>
        <Button variant="danger" busy={busy === "delete"} data-testid="wiki-setup-delete-yes" onClick={() => { void act("delete", (id) => api.delete(project, id), (answer) => { setBuild(answer.view); setConfirmDelete(false); setDeleted(true); void query.invalidateQueries({ queryKey: wikiSetupKey(project, "map") }); }); }}>{T.DELETE_YES}</Button>
        <Button data-testid="wiki-setup-delete-no" onClick={() => { setConfirmDelete(false); }}>{T.CANCEL}</Button></div>}
    </div>
      {!confirmDelete && <Button variant="danger" disabled={running || busy !== undefined} data-testid="wiki-setup-delete" onClick={() => { setConfirmDelete(true); }}>{T.DELETE}</Button>}
    </div>
  </section> : hasPages ? <p data-testid="wiki-setup-agents-state">{view.agents.on ? "Agents use the wiki. " + T.AGENTS_ON : "Agents do not use the wiki. " + T.AGENTS_OFF}</p> : null;

  return wrap(state, <>
    {head}
    {main}
    {controls}
    <NightlyUpkeep project={project} companyAdmin={companyAdmin} />
  </>, view.status !== "none" || startOpen);
}
