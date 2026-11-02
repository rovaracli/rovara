import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createSetupRecipesApi, type SetupRecipe, type SetupRecipesState } from "../../../api/setup-recipes.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import "./how-we-work.css";

export const RECIPES_TEXT = {
 TITLE: "Setup recipes",
 NOTE: "A recipe is the generic part of a setup that worked, kept for your company. Rovara offers it to a new project whose files look the same, as a starting point only: the project still proves it and a maintainer still confirms it. A recipe never holds a repository name, a secret or an account.",
 NOT_ADMIN: "Only a company owner or admin can see or change setup recipes.",
 NOT_ON: "Setup recipes are not turned on for this company.",
 LOAD_FAILED: "Couldn't load the setup recipes.",
 WAITING: "Waiting for approval",
 NONE_WAITING: "Nothing is waiting for approval.",
 APPROVED: "Offered to projects",
 NONE_APPROVED: "No recipe is offered yet.",
 APPROVE: "Approve this recipe",
 APPROVE_HELP: "You approve exactly what is shown here, the commands included. You need to have signed in within the last 10 minutes.",
 REJECT: "Reject",
 STOP: "Stop offering",
 CHANGE_WHO: "Change who it is offered to",
 EVERY_PROJECT: "Every project of the company",
 ONLY_THESE: "Only these projects: ",
 SAVE_WHO: "Save",
 CANCEL: "Cancel",
 ALL_BLANK: "Leave every box empty to offer it to every project.",
 SHARE_HEADING: "Share a project's setup",
 SHARE_NOTE: "Builds a recipe from the project's approved test environment. It is offered to nobody until an admin approves it. Only websites the project already allows can be shared.",
 SHARE_BUTTON: "Share as company recipe",
 SHARED: "Shared. It is waiting for approval above.",
 STALE: "That recipe changed. The list was read again; check it and try again.",
 FAILED: "Rovara couldn't complete this request. Try again.",
 SIGN_IN_AGAIN: "Sign in again",
 BACK: "Back to How we work",
} as const;

const problem = (error: unknown): { message: string; reauth: boolean; stale: boolean } => error instanceof ApiError
 ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED", stale: error.code === "CHANGE_STALE" } : { message: RECIPES_TEXT.FAILED, reauth: false, stale: false };
const split = (text: string): string[] => text.split(",").map(part => part.trim()).filter(part => part !== "");
const scopeText = (recipe: SetupRecipe): string => recipe.scope.kind === "company" ? RECIPES_TEXT.EVERY_PROJECT : RECIPES_TEXT.ONLY_THESE + recipe.scope.projects.join(", ");

/** The reads the screen and the How we work link share (a refusal as "not found" means the switch is off). */
export function useSetupRecipes(enabled = true) {
 const host = useAppHost(), api = useMemo(() => createSetupRecipesApi(host), [host]);
 return { api, read: useQuery({ queryKey: ["admin", "setup-recipes"], queryFn: () => api.list(), enabled, refetchOnWindowFocus: false, retry: false }) };
}

export function SetupRecipesScreen() {
 const { role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title={RECIPES_TEXT.TITLE} /><p role="alert">{RECIPES_TEXT.NOT_ADMIN}</p></section>;
 return <Recipes />;
}

function RecipeBody({ recipe }: { recipe: SetupRecipe }) {
 return <>
  <p className="rv-muted">Fits projects with <VisibleText text={recipe.match.markerFiles.join(", ")} />{recipe.match.registryHosts.length > 0 && <> using <VisibleText text={recipe.match.registryHosts.join(", ")} /></>}. Build systems: <VisibleText text={recipe.buildSystems.join(", ")} />{recipe.toolchains.length > 0 && <>; <VisibleText text={recipe.toolchains.map(item => item.tool + " " + item.version).join(", ")} /></>}.</p>
  {recipe.setup.length > 0 && <><p>Setup commands</p><ul>{recipe.setup.map((text, index) => <li key={index}><code><VisibleText text={text} /></code></li>)}</ul></>}
  {recipe.checks.length > 0 && <><p>Checks</p><ul>{recipe.checks.map(check => <li key={check.id}><VisibleText text={check.label} />: <code><VisibleText text={check.command} /></code></li>)}</ul></>}
  {recipe.approvedHosts.length > 0 && <p>Websites it asks for: <VisibleText text={recipe.approvedHosts.join(", ")} /></p>}
  {recipe.devcontainerBaseImage !== undefined && <p>Dev container image: <code><VisibleText text={recipe.devcontainerBaseImage} /></code></p>}
 </>;
}

function ScopeEditor({ recipe, projects, busy, onSave, onCancel }: { recipe: SetupRecipe; projects: readonly string[]; busy: boolean; onSave: (projects: string[]) => void; onCancel: () => void }) {
 const [chosen, setChosen] = useState<string[]>(recipe.scope.kind === "projects" ? recipe.scope.projects : []);
 return <fieldset><legend>{RECIPES_TEXT.CHANGE_WHO}</legend>
  {projects.map(name => <Checkbox key={name} label={name} checked={chosen.includes(name)} onCheckedChange={checked => { setChosen(checked === true ? [...chosen, name] : chosen.filter(item => item !== name)); }} />)}
  <p className="rv-muted">{RECIPES_TEXT.ALL_BLANK}</p>
  <div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { onSave(chosen); }}>{RECIPES_TEXT.SAVE_WHO}</Button><Button disabled={busy} onClick={onCancel}>{RECIPES_TEXT.CANCEL}</Button></div>
 </fieldset>;
}

function ShareForm({ state, busy, onShare }: { state: SetupRecipesState; busy: boolean; onShare: (input: Parameters<ReturnType<typeof createSetupRecipesApi>["share"]>[0]) => Promise<boolean> }) {
 const [project, setProject] = useState(""), [repositoryId, setRepositoryId] = useState(""), [label, setLabel] = useState(""), [systems, setSystems] = useState(""), [tools, setTools] = useState(""), [markers, setMarkers] = useState<string[]>([]), [registries, setRegistries] = useState(""), [hosts, setHosts] = useState("");
 const ready = project !== "" && repositoryId.trim() !== "" && label.trim() !== "" && split(systems).length > 0 && markers.length > 0;
 async function submit() {
  const toolchains = split(tools).map(item => { const [tool = "", version = ""] = item.split(/[\s=]+/u); return { tool, version }; });
  const shared = await onShare({ project, repositoryId: repositoryId.trim(), label: label.trim(), buildSystems: split(systems), toolchains, markerFiles: markers, registryHosts: split(registries), approvedHosts: split(hosts) });
  if (shared) { setLabel("");setSystems("");setTools("");setMarkers([]);setRegistries("");setHosts(""); }
 }
 return <form aria-label={RECIPES_TEXT.SHARE_HEADING} className="rv-hww-company-card" onSubmit={event => { event.preventDefault();if (ready) void submit(); }}>
  <h2>{RECIPES_TEXT.SHARE_HEADING}</h2><p className="rv-muted">{RECIPES_TEXT.SHARE_NOTE}</p>
  <Select label="Project" value={project} options={state.projects.map(name => ({ value: name, label: name }))} onValueChange={setProject} />
  <TextField label="Repository" hint="The repository's name in that project." value={repositoryId} onChange={event => { setRepositoryId(event.target.value); }} autoComplete="off" maxLength={200} />
  <TextField label="Recipe name" hint="Do not use a repository's name." value={label} onChange={event => { setLabel(event.target.value); }} autoComplete="off" maxLength={80} />
  <TextField label="Build systems" hint="Comma separated, for example python." value={systems} onChange={event => { setSystems(event.target.value); }} autoComplete="off" />
  <TextField label="Tool versions" hint="Comma separated, for example python 3.12." value={tools} onChange={event => { setTools(event.target.value); }} autoComplete="off" />
  <fieldset><legend>Files that mark a matching project</legend>{state.markerFiles.map(name => <Checkbox key={name} label={name} checked={markers.includes(name)} onCheckedChange={checked => { setMarkers(checked === true ? [...markers, name] : markers.filter(item => item !== name)); }} />)}</fieldset>
  <TextField label="Package registries" hint="Comma separated hosts the project installs from." value={registries} onChange={event => { setRegistries(event.target.value); }} autoComplete="off" />
  <TextField label="Websites to share" hint="Comma separated. Only websites the project already allows are kept." value={hosts} onChange={event => { setHosts(event.target.value); }} autoComplete="off" />
  <div className="rv-hww-company-actions"><Button type="submit" variant="primary" busy={busy} disabled={!ready}>{RECIPES_TEXT.SHARE_BUTTON}</Button></div>
 </form>;
}

function Recipes() {
 const { api, read } = useSetupRecipes(), host = useAppHost(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<ReturnType<typeof problem>>(), [note, setNote] = useState<string>(), [editing, setEditing] = useState<string>();
 useEffect(() => () => { void query.cancelQueries({ queryKey: ["admin", "setup-recipes"] }); }, [query]);
 async function run(label: string, work: () => Promise<void>, done?: string): Promise<boolean> {
  if (sending.current) return false;
  sending.current = true;setBusy(label);setError(undefined);setNote(undefined);
  try { await work();setEditing(undefined);if (done !== undefined) setNote(done);await read.refetch();return true; }
  catch (caught) { const seen = problem(caught);setError(seen.stale ? { ...seen, message: RECIPES_TEXT.STALE } : seen);if (seen.stale) await read.refetch();return false; }
  finally { sending.current = false;setBusy(undefined); }
 }
 const notOn = read.error instanceof ApiError && read.error.status === 404;
 const state = read.data;
 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title={RECIPES_TEXT.TITLE} description={RECIPES_TEXT.NOTE} />
  <p><Link to="/app/admin/how-we-work">{RECIPES_TEXT.BACK}</Link></p>
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{RECIPES_TEXT.SIGN_IN_AGAIN}</Button></>}</p>}
  <p role="status">{note ?? ""}</p>
  {read.isPending ? <Skeleton label="Loading setup recipes" /> : notOn ? <p role="status">{RECIPES_TEXT.NOT_ON}</p> : state === undefined ? <div><p role="alert">{RECIPES_TEXT.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   <h2>{RECIPES_TEXT.WAITING}</h2>
   {state.recipes.filter(recipe => recipe.status === "proposed").length === 0 ? <p className="rv-muted">{RECIPES_TEXT.NONE_WAITING}</p> : <div className="rv-hww-company-cards">
    {state.recipes.filter(recipe => recipe.status === "proposed").map(recipe => <section key={recipe.recipeId} aria-label={recipe.label} className="rv-hww-company-card">
     <h2><VisibleText text={recipe.label} /></h2><RecipeBody recipe={recipe} />
     <p className="rv-muted">{RECIPES_TEXT.APPROVE_HELP}</p>
     <div className="rv-hww-company-actions"><Button variant="primary" busy={busy === "approve:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("approve:" + recipe.recipeId, () => api.approve(recipe), "Approved.") }}>{RECIPES_TEXT.APPROVE}</Button><Button variant="danger" busy={busy === "revoke:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("revoke:" + recipe.recipeId, () => api.revoke(recipe), "Rejected.") }}>{RECIPES_TEXT.REJECT}</Button></div>
    </section>)}
   </div>}
   <h2>{RECIPES_TEXT.APPROVED}</h2>
   {state.recipes.filter(recipe => recipe.status === "approved").length === 0 ? <p className="rv-muted">{RECIPES_TEXT.NONE_APPROVED}</p> : <div className="rv-hww-company-cards">
    {state.recipes.filter(recipe => recipe.status === "approved").map(recipe => <section key={recipe.recipeId} aria-label={recipe.label} className="rv-hww-company-card">
     <h2><VisibleText text={recipe.label} /></h2><p><VisibleText text={scopeText(recipe)} /></p><RecipeBody recipe={recipe} />
     {editing === recipe.recipeId
      ? <ScopeEditor recipe={recipe} projects={state.projects} busy={busy === "scope:" + recipe.recipeId} onCancel={() => { setEditing(undefined); }} onSave={projects => { void run("scope:" + recipe.recipeId, () => api.setScope(recipe, projects), "Saved.") }} />
      : <div className="rv-hww-company-actions"><Button disabled={busy !== undefined} onClick={() => { setEditing(recipe.recipeId); }}>{RECIPES_TEXT.CHANGE_WHO}</Button><Button variant="danger" busy={busy === "revoke:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("revoke:" + recipe.recipeId, () => api.revoke(recipe), "Stopped.") }}>{RECIPES_TEXT.STOP}</Button></div>}
    </section>)}
   </div>}
   <ShareForm state={state} busy={busy === "share"} onShare={input => run("share", async () => { await api.share(input); }, RECIPES_TEXT.SHARED)} />
  </>}
 </section>;
}

/** On the company How we work page: a link to the recipes, shown only when the server has them on (and for an admin). A refusal or a failed read shows nothing. */
export function SetupRecipesLink() {
 const { role } = useAdminContext(), { read } = useSetupRecipes(role === "owner" || role === "admin");
 if (read.data === undefined) return null;
 const waiting = read.data.recipes.filter(recipe => recipe.status === "proposed").length;
 return <section aria-label={RECIPES_TEXT.TITLE} className="rv-hww-company-card rv-hww-suggestions"><h2>{RECIPES_TEXT.TITLE}</h2>
  <p className="rv-muted">Share a setup that worked with the company's other projects.</p>
  {waiting > 0 && <p role="status">{waiting === 1 ? "1 recipe is waiting for approval." : String(waiting) + " recipes are waiting for approval."}</p>}
  <p><Link to="/app/admin/how-we-work/recipes">Open setup recipes</Link></p>
 </section>;
}
