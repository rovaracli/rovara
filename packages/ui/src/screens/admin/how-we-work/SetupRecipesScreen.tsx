import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createSetupRecipesApi, type SetupRecipe } from "../../../api/setup-recipes.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { ShareRecipeForm } from "./ShareRecipeForm.js";
import { useAdminContext } from "../AdminLayout.js";
import "./how-we-work.css";

import { RECIPES_TEXT } from "./recipes-text.js";
export { RECIPES_TEXT };

const problem = (error: unknown): { message: string; reauth: boolean; stale: boolean } => error instanceof ApiError
 ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED", stale: error.code === "CHANGE_STALE" } : { message: RECIPES_TEXT.FAILED, reauth: false, stale: false };
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

type Command = SetupRecipe["setup"][number];
const Commands = ({ title, commands }: { title: string; commands: readonly Command[] }) => commands.length === 0 ? null : <><p>{title}</p><ul>{commands.map((command, index) => <li key={index}><code><VisibleText text={command.line} /></code> <span className="rv-muted">(up to {String(Math.round(command.timeoutSeconds / 60))} min)</span></li>)}</ul></>;

/** The WHOLE body an approval pins: every command with its directory and time limit, every check's select arguments and report, coverage and SARIF paths, the hosts, the image and the fingerprint. */
function RecipeBody({ recipe }: { recipe: SetupRecipe }) {
 return <>
  <p className="rv-muted">Fits projects with <VisibleText text={recipe.match.markerFiles.join(", ")} />{recipe.match.registryHosts.length > 0 && <> using <VisibleText text={recipe.match.registryHosts.join(", ")} /></>}. Build systems: <VisibleText text={recipe.buildSystems.join(", ")} />{recipe.toolchains.length > 0 && <>; <VisibleText text={recipe.toolchains.map(item => item.tool + " " + item.version).join(", ")} /></>}.</p>
  <Commands title="Setup commands" commands={recipe.setup} />
  <Commands title="Update commands" commands={recipe.update} />
  {recipe.checks.length > 0 && <><p>Checks</p><ul>{recipe.checks.map(check => <li key={check.id}><VisibleText text={check.label} /> (<VisibleText text={check.kind} />): <code><VisibleText text={check.command.line} /></code> <span className="rv-muted">(up to {String(Math.round(check.command.timeoutSeconds / 60))} min)</span>
   {check.selectArgs !== undefined && <div>Runs only the selected tests by adding: <code><VisibleText text={check.selectArgs.join(" ")} /></code></div>}
   {check.reportPath !== undefined && <div>Test report: <code><VisibleText text={check.reportPath} /></code></div>}
   {check.coveragePath !== undefined && <div>Coverage report: <code><VisibleText text={check.coveragePath} /></code></div>}
   {check.sarifPath !== undefined && <div>Scan report (SARIF): <code><VisibleText text={check.sarifPath} /></code></div>}
  </li>)}</ul></>}
  {recipe.approvedHosts.length > 0 && <p>Websites it asks for: <VisibleText text={recipe.approvedHosts.join(", ")} /></p>}
  {recipe.devcontainerBaseImage !== undefined && <p>Dev container image: <code><VisibleText text={recipe.devcontainerBaseImage} /></code></p>}
 </>;
}

/** Who proposed a waiting recipe and from which project, and which approved recipe an approval would replace for matching projects. */
function Provenance({ recipe }: { recipe: SetupRecipe }) {
 return <>
  <p className="rv-muted">Proposed by <VisibleText text={recipe.proposedBy} />{recipe.sourceProject !== undefined && <> from the project <VisibleText text={recipe.sourceProject} /></>}{recipe.fromProject && recipe.sourceProject === undefined && " from a project"}.</p>
  {recipe.replaces.length > 0 && <p role="status"><strong>Approving replaces</strong> {recipe.replaces.map((other, index) => <span key={other.recipeId}>{index > 0 && ", "}<VisibleText text={other.label} /></span>)} for matching projects: a project is offered one recipe for its fingerprint.</p>}
 </>;
}

function ScopeEditor({ recipe, projects, busy, onSave, onCancel }: { recipe: SetupRecipe; projects: readonly string[]; busy: boolean; onSave: (projects: string[]) => void; onCancel: () => void }) {
 const [chosen, setChosen] = useState<string[]>(recipe.scope.kind === "projects" ? recipe.scope.projects : []);
 return <fieldset><legend>{RECIPES_TEXT.CHANGE_WHO}</legend>
  {projects.map(name => <Checkbox key={name} label={visibleText(name)} checked={chosen.includes(name)} onCheckedChange={checked => { setChosen(checked === true ? [...chosen, name] : chosen.filter(item => item !== name)); }} />)}
  <p className="rv-muted">{RECIPES_TEXT.ALL_BLANK}</p>
  <div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { onSave(chosen); }}>{RECIPES_TEXT.SAVE_WHO}</Button><Button disabled={busy} onClick={onCancel}>{RECIPES_TEXT.CANCEL}</Button></div>
 </fieldset>;
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
  <p className="rv-admin-link-row"><Link to="/app/admin/how-we-work">{RECIPES_TEXT.BACK}</Link></p>
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{RECIPES_TEXT.SIGN_IN_AGAIN}</Button></>}</p>}
  <p role="status">{note ?? ""}</p>
  {read.isPending ? <Skeleton label="Loading setup recipes" /> : notOn ? <p role="status">{RECIPES_TEXT.NOT_ON}</p> : state === undefined ? <div><p role="alert">{RECIPES_TEXT.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   {state.unreadable.length > 0 && <section aria-label={RECIPES_TEXT.UNREADABLE} className="rv-hww-company-card"><h2>{RECIPES_TEXT.UNREADABLE}</h2><p>{RECIPES_TEXT.UNREADABLE_HELP}</p>
    {state.unreadable.map(id => <div key={id} className="rv-hww-company-actions"><code><VisibleText text={id} /></code><Button variant="danger" busy={busy === "remove:" + id} disabled={busy !== undefined} onClick={() => { void run("remove:" + id, () => api.removeUnreadable(id), "Removed.") }}>Remove</Button></div>)}</section>}
   <h2>{RECIPES_TEXT.WAITING}</h2>
   {state.recipes.filter(recipe => recipe.status === "proposed").length === 0 ? <p className="rv-muted">{RECIPES_TEXT.NONE_WAITING}</p> : <div className="rv-hww-company-cards">
    {state.recipes.filter(recipe => recipe.status === "proposed").map(recipe => <section key={recipe.recipeId} aria-label={visibleText(recipe.label)} className="rv-hww-company-card">
     <h2><VisibleText text={recipe.label} /></h2><Provenance recipe={recipe} /><RecipeBody recipe={recipe} />
     <p className="rv-muted">{RECIPES_TEXT.APPROVE_HELP}</p>
     <div className="rv-hww-company-actions"><Button variant="primary" busy={busy === "approve:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("approve:" + recipe.recipeId, () => api.approve(recipe), "Approved.") }}>{RECIPES_TEXT.APPROVE}</Button><Button variant="danger" busy={busy === "revoke:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("revoke:" + recipe.recipeId, () => api.revoke(recipe), "Rejected.") }}>{RECIPES_TEXT.REJECT}</Button></div>
    </section>)}
   </div>}
   <h2>{RECIPES_TEXT.APPROVED}</h2>
   {state.recipes.filter(recipe => recipe.status === "approved").length === 0 ? <p className="rv-muted">{RECIPES_TEXT.NONE_APPROVED}</p> : <div className="rv-hww-company-cards">
    {state.recipes.filter(recipe => recipe.status === "approved").map(recipe => <section key={recipe.recipeId} aria-label={visibleText(recipe.label)} className="rv-hww-company-card">
     <h2><VisibleText text={recipe.label} /></h2><p><VisibleText text={scopeText(recipe)} /></p><RecipeBody recipe={recipe} />
     {editing === recipe.recipeId
      ? <ScopeEditor recipe={recipe} projects={state.projects} busy={busy === "scope:" + recipe.recipeId} onCancel={() => { setEditing(undefined); }} onSave={projects => { void run("scope:" + recipe.recipeId, () => api.setScope(recipe, projects), "Saved.") }} />
      : <div className="rv-hww-company-actions"><Button disabled={busy !== undefined} onClick={() => { setEditing(recipe.recipeId); }}>{RECIPES_TEXT.CHANGE_WHO}</Button><Button variant="danger" busy={busy === "revoke:" + recipe.recipeId} disabled={busy !== undefined} onClick={() => { void run("revoke:" + recipe.recipeId, () => api.revoke(recipe), "Stopped.") }}>{RECIPES_TEXT.STOP}</Button></div>}
    </section>)}
   </div>}
   <ShareRecipeForm projects={state.projects} markerFiles={state.markerFiles} busy={busy === "share"} onShare={input => run("share", async () => { await api.share(input); }, RECIPES_TEXT.SHARED)} />
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
  <p className="rv-admin-link-row"><Link to="/app/admin/how-we-work/recipes">Open setup recipes</Link></p>
 </section>;
}
