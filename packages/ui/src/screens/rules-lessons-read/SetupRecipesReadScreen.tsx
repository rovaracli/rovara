import { servedReadState } from "../../api/served-read.js";
import { useState, type ReactNode } from "react";
import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { Chip, Held, Notice, ReadHeader, Row, Rows, when } from "./parts.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { Button } from "../../design/Button.js";
import { Link } from "react-router";
import { ScopeEditor, useRecipeActions } from "../admin/how-we-work/recipe-actions.js";
import { ShareRecipeForm } from "../admin/how-we-work/ShareRecipeForm.js";
import { RECIPES_TEXT } from "../admin/how-we-work/recipes-text.js";
const tick = <svg className="g4-icon g4-icon-ok" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5" /></svg>;
const Spec = ({ title, children }: { title: string; children: ReactNode }) => <li className="g4-spec">{tick}<div><h4>{title}</h4>{children}</div></li>;
const Commands = ({ commands }: { commands: readonly { line: string; timeoutSeconds: number }[] }) => <>{commands.map((command, i) => <p key={i}><code><VisibleText text={command.line} /></code> · up to {command.timeoutSeconds} seconds</p>)}</>;
const statusWords = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);
/** Recipes: the list with an Open button per row, then what is in the one opened (the first until a row is opened). Opening only chooses what to read. */
export function SetupRecipesReadScreen() {
 const { api, identityStale } = useReadContext(), read = useAreaRead(["recipes"], api.recipes), [opened, setOpened] = useState<string>();
 const served = servedReadState(read), shown = served.data, frozen = served.staleSince !== undefined || identityStale, act = useRecipeActions(() => read.refetch(), frozen);
 return <div className="g4-page"><ReadHeader crumbs={["Company"]} title="Setup recipes" meta={shown === undefined ? undefined : `${shown.recipes.length} ${shown.recipes.length === 1 ? "recipe" : "recipes"}`} />
 {act.error !== undefined && <p className="g4-failed" role="alert"><VisibleText text={act.error} /></p>}
 <p className="g4-quiet" role="status">{act.note ?? ""}</p>
 <ReadState read={read} scope="page" refName="SETUP-RECIPES" safe={act.wrote ? RECIPES_TEXT.CHANGE_WENT_THROUGH : undefined}>{data => {
  const recipe = data.recipes.find(one => one.recipeId === opened) ?? data.recipes[0];
  return <>
  <p className="g4-intro">A recipe is a project&#8217;s recorded setup, saved so that a new project with the same kind of repo can start from it. A recipe is a starting point: the new project&#8217;s own setup run still has to pass before any task starts. <Link to="/app/admin/how-we-work">Back to How we work</Link></p>
  {data.unreadable.length > 0 && <section aria-label={RECIPES_TEXT.UNREADABLE} className="g4-unreadable"><Notice>Some recipes couldn&#8217;t be read. This list is incomplete. {RECIPES_TEXT.UNREADABLE_HELP}</Notice>
   {data.unreadable.map(id => <div key={id} className="g4-actions"><code><VisibleText text={id} /></code><Button variant="danger" busy={act.busy === "remove:" + id} disabled={act.busy !== undefined || frozen} onClick={() => { void act.run("remove:" + id, () => act.api.removeUnreadable(id), "Removed."); }}>Remove</Button></div>)}</section>}
  {recipe === undefined ? <Held>No readable recipes were returned.</Held> : <>
  <ul className="g4-list g4-recipes" aria-label="Recipes">{data.recipes.map(one => <li key={one.recipeId} aria-current={one.recipeId === recipe.recipeId ? "true" : undefined}>
   <div className="g4-recipe-main"><h2><VisibleText text={one.label} /> <Chip>{statusWords(one.status)}</Chip></h2>
    <p className="g4-quiet">Proposed by <VisibleText text={one.proposedBy} />{one.sourceProject !== undefined && <> · from <VisibleText text={one.sourceProject} /></>} · {when(one.updatedAt)}</p>
    <p className="g4-quiet">{one.scope.kind === "company" ? "Available to all company projects" : <VisibleText text={"Projects: " + one.scope.projects.join(", ")} />} · {one.setup.length} setup {one.setup.length === 1 ? "command" : "commands"}, {one.match.markerFiles.length} marker {one.match.markerFiles.length === 1 ? "file" : "files"}</p></div>
   <Button onClick={() => setOpened(one.recipeId)} aria-pressed={one.recipeId === recipe.recipeId} aria-label={visibleText("Open " + one.label)}>Open</Button>
  </li>)}</ul>
  <p className="g4-quiet g4-foot g4-after-list">Changing or removing a recipe never changes a project that already used it. Projects keep their own saved setup.</p>
  <section className="g4-detail" aria-label={visibleText(recipe.label)}>
   <h2>What is in <VisibleText text={recipe.label} /></h2>
   <p className="g4-quiet">Revision {recipe.revision} · {when(recipe.updatedAt)}</p>
   {recipe.status === "proposed" && <>
    <p className="g4-quiet">Proposed by <VisibleText text={recipe.proposedBy} />{recipe.sourceProject !== undefined && <> from the project <VisibleText text={recipe.sourceProject} /></>}{recipe.fromProject && recipe.sourceProject === undefined && " from a project"}.</p>
    {recipe.replaces.length > 0 && <p role="status"><strong>Approving replaces</strong> {recipe.replaces.map((other, index) => <span key={other.recipeId}>{index > 0 && ", "}<VisibleText text={other.label} /></span>)} for matching projects: a project is offered one recipe for its fingerprint.</p>}</>}
   <ul className="g4-specs" aria-label={visibleText(recipe.label + " contents")}>
    {recipe.setup.length > 0 && <Spec title="Setup commands"><Commands commands={recipe.setup} /></Spec>}
    {recipe.update.length > 0 && <Spec title="Update commands"><Commands commands={recipe.update} /></Spec>}
    <Spec title="Marker files that say when it fits"><p><code><VisibleText text={recipe.match.markerFiles.join(" · ")} /></code></p></Spec>
    <Spec title="Package registries that say when it fits"><p>{recipe.match.registryHosts.length === 0 ? "None listed" : <code><VisibleText text={recipe.match.registryHosts.join(" · ")} /></code>}</p></Spec>
    <Spec title="Build systems"><p><code><VisibleText text={recipe.buildSystems.join(" · ")} /></code></p></Spec>
    {recipe.toolchains.length > 0 && <Spec title="Toolchains">{recipe.toolchains.map((tool, i) => <p key={i}><VisibleText text={tool.tool + " " + tool.version} /></p>)}</Spec>}
    {recipe.checks.map(check => <Spec key={check.id} title={visibleText(check.label)}><p><VisibleText text={check.kind} /> · <code><VisibleText text={check.command.line} /></code> · up to {check.command.timeoutSeconds} seconds</p>{check.selectArgs !== undefined && <p>Select arguments: <code><VisibleText text={check.selectArgs.join(" ")} /></code></p>}{check.reportPath !== undefined && <p>Report: <code><VisibleText text={check.reportPath} /></code></p>}{check.coveragePath !== undefined && <p>Coverage: <code><VisibleText text={check.coveragePath} /></code></p>}{check.sarifPath !== undefined && <p>SARIF: <code><VisibleText text={check.sarifPath} /></code></p>}</Spec>)}
    <Spec title="Requested addresses"><p>{recipe.approvedHosts.length === 0 ? "None listed" : <code><VisibleText text={recipe.approvedHosts.join(" · ")} /></code>}</p></Spec>
    {recipe.devcontainerBaseImage !== undefined && <Spec title="Machine image"><p>Image: <code><VisibleText text={recipe.devcontainerBaseImage} /></code></p></Spec>}
   </ul>
   <h3 className="g4-never">Never shared</h3><p className="g4-quiet g4-never-text">Secret values and tokens · the saved machine itself · anything from the repo’s code. A project that uses the recipe adds its own secrets and builds its own machine.</p>
   <Rows label="Who can use it"><Row label="Who can use it"><p>{recipe.scope.kind === "company" ? "Any project in the company." : <VisibleText text={"Only these projects: " + recipe.scope.projects.join(", ")} />}</p></Row><Row label="Projects using it"><Held>We can&#8217;t tell yet which projects use it.</Held></Row></Rows>
  <Rows label="Recipe actions"><Row label="Actions">{recipe.status === "proposed" ? <><p className="g4-quiet">{RECIPES_TEXT.APPROVE_HELP}</p><div className="g4-actions"><Button variant="primary" busy={act.busy === "approve:" + recipe.recipeId} disabled={act.busy !== undefined || frozen} onClick={() => { void act.run("approve:" + recipe.recipeId, () => act.api.approve(recipe), "Approved."); }}>{RECIPES_TEXT.APPROVE}</Button><Button variant="danger" busy={act.busy === "revoke:" + recipe.recipeId} disabled={act.busy !== undefined || frozen} onClick={() => { void act.run("revoke:" + recipe.recipeId, () => act.api.revoke(recipe), "Rejected."); }}>{RECIPES_TEXT.REJECT}</Button></div></>
    : recipe.status === "approved" ? act.editing === recipe.recipeId ? <ScopeEditor recipe={recipe} projects={data.projects} busy={act.busy === "scope:" + recipe.recipeId} frozen={frozen} onCancel={() => act.setEditing(undefined)} onSave={projects => { void act.run("scope:" + recipe.recipeId, () => act.api.setScope(recipe, projects), "Saved."); }} />
     : <div className="g4-actions"><Button disabled={act.busy !== undefined || frozen} onClick={() => act.setEditing(recipe.recipeId)}>{RECIPES_TEXT.CHANGE_WHO}</Button><Button variant="danger" busy={act.busy === "revoke:" + recipe.recipeId} disabled={act.busy !== undefined || frozen} onClick={() => { void act.run("revoke:" + recipe.recipeId, () => act.api.revoke(recipe), "Stopped."); }}>{RECIPES_TEXT.STOP}</Button></div>
    : <Held>Nothing can be changed for a recipe in this state.</Held>}</Row></Rows>
  </section></>}
  <ShareRecipeForm projects={data.projects} markerFiles={data.markerFiles} busy={act.busy === "share"} frozen={frozen} onShare={input => act.run("share", async () => { await act.api.share(input); }, RECIPES_TEXT.SHARED)} /></>;
 }}</ReadState></div>;
}
