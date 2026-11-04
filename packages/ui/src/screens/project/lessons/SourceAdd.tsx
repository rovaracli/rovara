import { useState } from "react";
import type { SourcesAdminViewData } from "../../../api/record-sources.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Switch } from "../../../design/Switch.js";
import { TextField } from "../../../design/TextField.js";
import { visibleText } from "../../../design/VisibleText.js";
import { AUDIENCE_OPTIONS, offeredFor } from "./SourceRow.js";
import { T, retentionWords } from "./lessons-text.js";
import { useSourceWrite } from "./use-source-write.js";

type Kind = "repository" | "rovara" | "slack" | "linear" | "jira";
const SOURCE_OF: Readonly<Record<Kind, string>> = { repository: "github", rovara: "rovara", slack: "slack", linear: "linear", jira: "jira" };
const KIND_WORDS: Readonly<Record<Kind, string>> = { repository: T.SRC_KIND_REPO, rovara: T.SRC_KIND_ROVARA, slack: T.SRC_KIND_SLACK, linear: T.SRC_KIND_LINEAR, jira: T.SRC_KIND_JIRA };
const PLACE_WORDS: Readonly<Record<"slack" | "linear" | "jira", { label: string; hint: string }>> = { slack: { label: T.SRC_PLACE_SLACK, hint: T.SRC_HINT_SLACK }, linear: { label: T.SRC_PLACE_LINEAR, hint: T.SRC_HINT_LINEAR }, jira: { label: T.SRC_PLACE_JIRA, hint: T.SRC_HINT_JIRA } };

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
 const writer = useSourceWrite(project), kinds = addableKinds(view), [formKey, setFormKey] = useState(0);
 const [kind, setKind] = useState<string>(""), [place, setPlace] = useState(""), [retention, setRetention] = useState(""), [audience, setAudience] = useState<string>("maintainers"), [enabled, setEnabled] = useState(true);
 if (kinds.length === 0) return <section aria-label={T.SRC_ADD} className="rv-lessons-section"><h3>{T.SRC_ADD}</h3><p className="rv-muted">{T.SRC_ADD_NONE}</p></section>;
 const chosen = kinds.find(candidate => candidate === kind), choices = chosen === undefined ? [] : offeredFor(view.offered, SOURCE_OF[chosen]);
 const repositories = (view.repositories ?? []).filter(repository => !view.sources.some(row => row.kind === "github" && row.scope === repository.scope));
 const scope = chosen === "rovara" ? "rovara:project/" + project : place.trim();
 const ready = chosen !== undefined && retention !== "" && choices.includes(retention) && scope !== "";
 const add = async () => {
  if (chosen === undefined) return;
  const reply = await writer.send({ action: "add", source: SOURCE_OF[chosen], scope, retention, audienceDefault: chosen === "rovara" ? "maintainers" : audience, enabled });
  if (reply === undefined) return;
  notify(reply.status === "needs_approval" ? T.SRC_NEEDS_SECOND : T.SRC_ADDED);
  setKind("");setPlace("");setRetention("");setAudience("maintainers");setEnabled(true);setFormKey(formKey + 1);
 };
 return <section aria-label={T.SRC_ADD} className="rv-lessons-section"><h3>{T.SRC_ADD}</h3>
  <fieldset key={formKey} className="rv-lessons-edit" disabled={writer.busy}><legend>{T.SRC_ADD}</legend>
   <Select label={T.SRC_ADD_KIND} value={kind} placeholder={T.SRC_CHOOSE} options={kinds.map(candidate => ({ value: candidate, label: KIND_WORDS[candidate] }))} onValueChange={next => { setKind(next);setPlace("");setRetention(""); }} />
   {chosen === "repository" && <Select label={T.SRC_REPO} value={place} placeholder={T.SRC_CHOOSE} options={repositories.map(repository => ({ value: repository.scope, label: visibleText(repository.name) }))} onValueChange={setPlace} />}
   {(chosen === "slack" || chosen === "linear" || chosen === "jira") && <TextField label={PLACE_WORDS[chosen].label} hint={PLACE_WORDS[chosen].hint} value={place} maxLength={300} autoComplete="off" onChange={event => { setPlace(event.target.value); }} />}
   {chosen !== undefined && <>
    <Select label={T.SRC_RETENTION} value={retention} placeholder={T.SRC_CHOOSE} options={choices.map(mode => ({ value: mode, label: retentionWords(mode) }))} onValueChange={setRetention} />
    {chosen === "rovara" ? <p className="rv-muted">{T.WHO_SEES}: {T.SRC_ROVARA_AUDIENCE}</p> : <Select label={T.SRC_AUDIENCE} value={audience} options={AUDIENCE_OPTIONS} onValueChange={setAudience} />}
    <Switch label={T.SRC_ON} checked={enabled} onCheckedChange={setEnabled} />
   </>}
   <div className="rv-lessons-actions"><Button variant="primary" busy={writer.busy} disabled={!ready} onClick={() => { void add(); }}>{T.SRC_ADD_SEND}</Button></div>
  </fieldset>
  {writer.error !== undefined && <div role="alert"><p>{writer.error}</p>{writer.reauth && <Button onClick={writer.signInAgain}>{T.SRC_SIGN_IN}</Button>}</div>}
 </section>;
}
