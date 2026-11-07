import { useEffect, useState } from "react";
import { parseSlackPlaceInput } from "@agentx/contracts/web";
import { useQueryClient } from "@tanstack/react-query";
import { sourceOptionsRoot } from "../../../api/record-source-options.js";
import { sourcesAdminKey, type SourcesAdminViewData } from "../../../api/record-sources.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Switch } from "../../../design/Switch.js";
import { visibleText } from "../../../design/VisibleText.js";
import { PlacePicker } from "./PlacePicker.js";
import { AddRovaraSteps, LinkSlackButton } from "./SlackChannelHelp.js";
import { AUDIENCE_OPTIONS, NotesSwitch, offeredFor } from "./SourceRow.js";
import { T, retentionWords } from "./lessons-text.js";
import { useSourceWrite } from "./use-source-write.js";

type Kind = "repository" | "rovara" | "slack" | "linear" | "jira";
const SOURCE_OF: Readonly<Record<Kind, string>> = { repository: "github", rovara: "rovara", slack: "slack", linear: "linear", jira: "jira" };
const KIND_WORDS: Readonly<Record<Kind, string>> = { repository: T.SRC_KIND_REPO, rovara: T.SRC_KIND_ROVARA, slack: T.SRC_KIND_SLACK, linear: T.SRC_KIND_LINEAR, jira: T.SRC_KIND_JIRA };

/** The place and the places above it, itself first (`slack:T1/C9` -> `slack:T1/C9`, `slack:T1`): the same rule as the server's `scopeAndAncestors`, kept here so the screen does not pull the keys module into the web bundle. */
const withAncestors = (scope: string): string[] => { const out = [scope];for (let at = scope.lastIndexOf("/"); at > 0; at = scope.lastIndexOf("/")) { scope = scope.slice(0, at);out.push(scope); } return out; };

/** The clearing row the place matches, or undefined: the place, or one above or below it, of a removed source whose data is still being cleared. It is what the server refuses (`refuseWhileRemoving`), so the form never disagrees with it. */
const clearingMatch = (view: SourcesAdminViewData, source: string, scope: string) => {
 const above = new Set(withAncestors(scope));
 // A Slack channel is known by its ID (they are unique, and the view holds only this company's rows): a pasted bare ID, a link or a place of any team matches the clearing row that ends in the same ID.
 const channel = source === "slack" ? parseSlackPlaceInput(scope)?.channelId : undefined;
 return (view.clearing ?? []).find(place => place.source === source && (above.has(place.scope) || place.scope.startsWith(scope + "/") || (channel !== undefined && place.scope.endsWith("/" + channel))));
};
const isClearing = (view: SourcesAdminViewData, source: string, scope: string): boolean => clearingMatch(view, source, scope) !== undefined;

/** The kinds this person can add now: only what the server offers a retention for, a repository only from the project's own list (minus the ones already added), the Rovara row once. */
function addableKinds(view: SourcesAdminViewData): Kind[] {
 const have = new Set(view.sources.map(row => row.kind + "|" + row.scope)), kinds: Kind[] = [];
 if (offeredFor(view.offered, "github").length > 0 && (view.repositories ?? []).some(repository => !have.has("github|" + repository.scope))) kinds.push("repository");
 if (offeredFor(view.offered, "rovara").length > 0 && !view.sources.some(row => row.kind === "rovara")) kinds.push("rovara");
 for (const kind of ["slack", "linear", "jira"] as const) if (offeredFor(view.offered, kind).length > 0) kinds.push(kind);
 return kinds;
}

/** Add a source: pick the kind, then the place, how long to keep it and who sees it. The server checks the place (and classifies a Slack channel); this never says what a channel is. */
export function SourceAdd({ project, view, notify }: { project: string; view: SourcesAdminViewData; notify: (text: string) => void }) {
 const writer = useSourceWrite(project), query = useQueryClient(), kinds = addableKinds(view), [formKey, setFormKey] = useState(0);
 const [kind, setKind] = useState<string>(""), [place, setPlace] = useState(""), [retention, setRetention] = useState(""), [audience, setAudience] = useState<string>("maintainers"), [enabled, setEnabled] = useState(true), [notes, setNotes] = useState(false);
 const chosen = kinds.find(candidate => candidate === kind), choices = chosen === undefined ? [] : offeredFor(view.offered, SOURCE_OF[chosen]);
 // In the Public edition Slack has no retention choice: "notes with links" is a switch (off: A, read live only; on: B with the opt-in). Enterprise never shows it.
 const notesMode = chosen === "slack" && view.notesSwitch === true;
 const repositories = (view.repositories ?? []).filter(repository => !view.sources.some(row => row.kind === "github" && row.scope === repository.scope));
 const scope = chosen === "rovara" ? "rovara:project/" + project : place.trim();
 // A place that was just removed is refused up front, in the server's own words (it refuses too).
 const match = chosen === undefined ? undefined : clearingMatch(view, SOURCE_OF[chosen], scope), clearingNow = match !== undefined;
 // The worker may have finished since the view was read: when the person picks or types a place that matches a clearing row, read the view once more. Keyed on the clearing row, not on the typed text, so one match is one read.
 const matchedPlace = match === undefined ? "" : match.source + "|" + match.scope;
 // The lists read for the pickers live as long as this form: they go when it closes, and after an add (a place just added is no longer free).
 useEffect(() => () => { query.removeQueries({ queryKey: sourceOptionsRoot(project) }); }, [project, query]);
 useEffect(() => { if (matchedPlace !== "") void query.invalidateQueries({ queryKey: sourcesAdminKey(project) }); }, [matchedPlace, project, query]);
 if (kinds.length === 0) return <section aria-label={T.SRC_ADD} className="rv-lessons-section"><h3>{T.SRC_ADD}</h3><p className="rv-muted">{T.SRC_ADD_NONE}</p></section>;
 const chosenRetention = notesMode ? (notes ? "B" : "A") : retention;
 const ready = chosen !== undefined && chosenRetention !== "" && choices.includes(chosenRetention) && scope !== "" && !clearingNow;
 const add = async () => {
  if (chosen === undefined) return;
  const reply = await writer.send({ action: "add", source: SOURCE_OF[chosen], scope, retention: chosenRetention, ...(notesMode && notes ? { notesOptIn: true } : {}), audienceDefault: chosen === "rovara" ? "maintainers" : audience, enabled });
  if (reply === undefined) return;
  notify(T.SRC_ADDED);
  query.removeQueries({ queryKey: sourceOptionsRoot(project) });
  setKind("");setPlace("");setRetention("");setNotes(false);setAudience("maintainers");setEnabled(true);setFormKey(formKey + 1);
 };
 return <section aria-label={T.SRC_ADD} className="rv-lessons-section"><h3>{T.SRC_ADD}</h3>
  <fieldset key={formKey} className="rv-lessons-edit" disabled={writer.busy}><legend>{T.SRC_ADD}</legend>
   <Select label={T.SRC_ADD_KIND} value={kind} placeholder={T.SRC_CHOOSE} options={kinds.map(candidate => ({ value: candidate, label: KIND_WORDS[candidate] }))} onValueChange={next => { setKind(next);setPlace("");setRetention("");setNotes(false); }} />
   {chosen === "repository" && <Select label={T.SRC_REPO} value={place} placeholder={T.SRC_CHOOSE} options={repositories.map(repository => isClearing(view, "github", repository.scope) ? { value: repository.scope, label: visibleText(repository.name) + " " + T.SRC_BEING_REMOVED, disabled: true } : { value: repository.scope, label: visibleText(repository.name) })} onValueChange={setPlace} />}
   {chosen === "slack" && <p className="rv-muted">{T.SRC_INVITE_FIRST}</p>}
   {(chosen === "slack" || chosen === "linear" || chosen === "jira") && <PlacePicker key={chosen} project={project} kind={chosen} value={place} onChange={setPlace} unavailable={candidate => isClearing(view, SOURCE_OF[chosen], candidate)} />}
   {clearingNow && <p role="alert">{T.SRC_ERR_REMOVAL}</p>}
   {chosen !== undefined && <>
    {notesMode ? <NotesSwitch checked={notes} onChange={setNotes} offered={choices.includes("B")} />
     : <Select label={T.SRC_RETENTION} value={retention} placeholder={T.SRC_CHOOSE} options={choices.map(mode => ({ value: mode, label: retentionWords(mode) }))} onValueChange={setRetention} />}
    {chosen === "rovara" ? <p className="rv-muted">{T.WHO_SEES}: {T.SRC_ROVARA_AUDIENCE}</p> : <Select label={T.SRC_AUDIENCE} value={audience} options={AUDIENCE_OPTIONS} onValueChange={setAudience} />}
    <Switch label={T.SRC_ON} checked={enabled} onCheckedChange={setEnabled} />
   </>}
   <div className="rv-lessons-actions"><Button variant="primary" busy={writer.busy} disabled={!ready} onClick={() => { void add(); }}>{T.SRC_ADD_SEND}</Button></div>
  </fieldset>
  {writer.error !== undefined && <div role="alert"><p>{writer.error}</p></div>}
  {writer.code === "SLACK_NOT_LINKED" && <LinkSlackButton />}
  {writer.code === "SLACK_INVITE_NEEDED" && <AddRovaraSteps onRefresh={() => { void query.invalidateQueries({ queryKey: sourceOptionsRoot(project) });writer.clear(); }} />}
 </section>;
}
