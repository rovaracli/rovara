import { useState } from "react";
import type { ShareInput } from "../../../api/setup-recipes.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { Select } from "../../../design/Select.js";
import { TextField } from "../../../design/TextField.js";
import { visibleText } from "../../../design/VisibleText.js";
import { RECIPES_TEXT } from "./recipes-text.js";

const split = (text: string): string[] => text.split(",").map(part => part.trim()).filter(part => part !== "");

/**
 * Share a project's setup as a company recipe. On the company screen the project is chosen (`projects`); on a project's own page it is fixed (`project`), and its repositories are a list (`repositories`). Every name that
 * comes from the server is shown through `visibleText`, so a hidden character in a project or repository name is visible in the label and in what a screen reader says.
 */
export function ShareRecipeForm({ project, projects, repositories, markerFiles, busy, onShare }: {
  project?: string; projects?: readonly string[]; repositories?: readonly string[]; markerFiles: readonly string[]; busy: boolean; onShare: (input: ShareInput) => Promise<boolean>;
}) {
 const [chosen, setChosen] = useState(project ?? ""), [repositoryId, setRepositoryId] = useState(""), [label, setLabel] = useState(""), [systems, setSystems] = useState(""), [tools, setTools] = useState(""), [markers, setMarkers] = useState<string[]>([]), [registries, setRegistries] = useState(""), [hosts, setHosts] = useState("");
 const ready = chosen !== "" && repositoryId.trim() !== "" && label.trim() !== "" && split(systems).length > 0 && markers.length > 0;
 async function submit() {
  const toolchains = split(tools).map(item => { const [tool = "", version = ""] = item.split(/[\s=]+/u); return { tool, version }; });
  const shared = await onShare({ project: chosen, repositoryId: repositoryId.trim(), label: label.trim(), buildSystems: split(systems), toolchains, markerFiles: markers, registryHosts: split(registries), approvedHosts: split(hosts) });
  if (shared) { setLabel("");setSystems("");setTools("");setMarkers([]);setRegistries("");setHosts(""); }
 }
 return <form aria-label={RECIPES_TEXT.SHARE_HEADING} className="rv-hww-company-card" onSubmit={event => { event.preventDefault();if (ready) void submit(); }}>
  <h2>{RECIPES_TEXT.SHARE_HEADING}</h2><p className="rv-muted">{RECIPES_TEXT.SHARE_NOTE}</p>
  {project === undefined && <Select label="Project" value={chosen} options={(projects ?? []).map(name => ({ value: name, label: visibleText(name) }))} onValueChange={setChosen} />}
  {repositories === undefined
   ? <TextField label="Repository" hint="The repository's name in that project." value={repositoryId} onChange={event => { setRepositoryId(event.target.value); }} autoComplete="off" maxLength={200} />
   : <Select label="Repository" value={repositoryId} options={repositories.map(name => ({ value: name, label: visibleText(name) }))} onValueChange={setRepositoryId} />}
  <TextField label="Recipe name" hint="Do not use a repository's name." value={label} onChange={event => { setLabel(event.target.value); }} autoComplete="off" maxLength={80} />
  <TextField label="Build systems" hint="Comma separated, for example python." value={systems} onChange={event => { setSystems(event.target.value); }} autoComplete="off" />
  <TextField label="Tool versions" hint="Comma separated, for example python 3.12." value={tools} onChange={event => { setTools(event.target.value); }} autoComplete="off" />
  <fieldset><legend>Files that mark a matching project</legend>{markerFiles.map(name => <Checkbox key={name} label={visibleText(name)} checked={markers.includes(name)} onCheckedChange={checked => { setMarkers(checked === true ? [...markers, name] : markers.filter(item => item !== name)); }} />)}</fieldset>
  <TextField label="Package registries" hint="Comma separated hosts the project installs from." value={registries} onChange={event => { setRegistries(event.target.value); }} autoComplete="off" />
  <TextField label="Websites to share" hint="Comma separated. Only websites the project already allows are kept." value={hosts} onChange={event => { setHosts(event.target.value); }} autoComplete="off" />
  <div className="rv-hww-company-actions"><Button type="submit" variant="primary" busy={busy} disabled={!ready}>{RECIPES_TEXT.SHARE_BUTTON}</Button></div>
 </form>;
}
