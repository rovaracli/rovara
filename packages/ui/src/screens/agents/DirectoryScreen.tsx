import { Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AgentIdSchema, AgentScopeSchema } from "@agentx/contracts/web";
import { useAgents, useAgent, type AgentScope } from "../../api/agents.js";
import { ApiError } from "../../api/errors.js";
import { paths } from "../../paths.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Tabs } from "../../design/Tabs.js";
import { Dialog } from "../../design/Dialog.js";
import { TextField } from "../../design/TextField.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAgentMembers } from "./agent-context.js";
import { useAgentPublishOn } from "./publish-flags.js";
import { FavouriteStar, PublishDirectoryExtras, PublishRequestsLink } from "./publish-lazy.js";
import { AgentProfileScreen } from "./AgentProfileScreen.js";
import { DesktopBuilderNote, useIsPhone } from "./agent-phone.js";
import "./agents.css";
const scopes = [{ value: "all", label: "All" }, { value: "mine", label: "Mine" }, { value: "shared", label: "Shared with me" }, { value: "builtin", label: "Built in" }] as const;
export function DirectoryScreen() {
 const { id } = useParams(), location = useLocation(), phone = useIsPhone();
 const state: unknown = location.state;
 // On a phone the profile is its own page, never a tray over the list: a tray would leave the list behind it in the reading order.
 const contextual = !phone && typeof state === "object" && state !== null && "fromDirectory" in state && state.fromDirectory === true;
 return id !== undefined && !contextual ? <AgentProfileScreen key={id} id={id} /> : <DirectoryList selected={id} />;
}
function DirectoryList({ selected }: { selected: string | undefined }) {
 const [params, setParams] = useSearchParams(), scope = AgentScopeSchema.safeParse(params.get("scope") ?? "all"), currentScope: AgentScope = scope.success ? scope.data : "all", project = params.get("project") ?? undefined, search = params.get("q") ?? "";
 const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set()), query = useQueryClient(), root = useRef<HTMLElement>(null), publishOn = useAgentPublishOn();
 useEffect(() => query.getQueryCache().subscribe(event => {
  if (event.type !== "updated" || event.action.type !== "error") return;
  const key: unknown = event.query.queryKey;
  if (!Array.isArray(key) || key.length !== 2 || key[0] !== "agent") return;
  const error: unknown = event.query.state.error, id: unknown = key[1];
  if (typeof id !== "string" || !(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return;
  setDenied(old => old.has(id) ? old : new Set([...old, id]));void query.invalidateQueries({ queryKey: ["agents"] });
 }), [query]);
 async function refresh() { const result = await read.refetch();if (!result.isError) setDenied(new Set()); }
 const read = useAgents(currentScope, project), profile = useAgent(selected), location = useLocation(), navigate = useNavigate(), opener = useRef<HTMLAnchorElement | null>(null), phone = useIsPhone();
 const members = useAgentMembers(read.data !== undefined && !read.isError), memberNames = new Map(members.isError ? [] : members.data?.members.map(member => [member.developerId, member.name]));
 const agents = (read.isError ? [] : read.data?.agents ?? []).filter(agent => !denied.has(agent.agentId)), agentNames = new Map(agents.map(agent => [agent.agentId, agent.name])), filtered = agents.filter(agent => (agent.name + " " + agent.description).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 function update(key: string, value: string) { const next = new URLSearchParams(params);if (value) next.set(key, value);else next.delete(key);setParams(next, { replace: true }); }
 return <section ref={root} className="rv-agent-directory"><PageHeader title="Agent directory" description="Find a method your team can use, inspect it, and put it to work." actions={<>{publishOn && <Suspense fallback={null}><PublishRequestsLink /></Suspense>}<Link className="rv-button rv-button-primary" to={paths.newAgent}>New agent</Link></>} /><DesktopBuilderNote />
 {/* RULING Q46: project is the owning roster scope, not a combined global scope. */}
 {project === undefined && <Tabs label="Agent scope" value={currentScope} onValueChange={value => update("scope", value)} items={scopes.map(item => ({ ...item, content: null }))} />}
 {denied.size > 0 && <p>Some workflows are no longer available. <Button variant="quiet" busy={read.isFetching} onClick={() => { void refresh(); }}>Refresh workflows</Button></p>}
 {publishOn && search === "" && <Suspense fallback={null}><PublishDirectoryExtras project={project} /></Suspense>}
 <TextField label="Find in these workflows" value={search} onChange={event => update("q", event.target.value)} />
 {project && <p>On <VisibleText text={project} /></p>}{read.isPending ? <Skeleton label="Loading shared workflows" /> : read.isError ? <><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load workflows. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></> : <>
 <p className="rv-muted">{agents.length} available{search ? "; searching only this loaded list" : ""}</p>
 <ul className="rv-agent-list" aria-label="Shared workflows">{filtered.map(agent => <li key={agent.agentId}><div><h2>{AgentIdSchema.safeParse(agent.agentId).success ? <Link to={paths.agent(agent.agentId) + location.search} {...(phone ? {} : { state: { fromDirectory: true } })} onClick={event => { opener.current = event.currentTarget; }}><VisibleText text={agent.name} /></Link> : <VisibleText text={agent.name} />}</h2><p><VisibleText text={agent.description} /></p><p className="rv-muted">{agent.builtin ? "Built in" : agent.owner?.kind === "project" ? <>Owned by <VisibleText text={String(agent.owner.project)} /></> : agent.owner?.kind === "member" ? <>Owned by <VisibleText text={memberNames.get(String(agent.owner.developerId)) ?? "Team member"} /></> : "Owner unavailable"}{agent.extends && <> · Built on <VisibleText text={agentNames.get(agent.extends.agentId) ?? agent.extends.agentId} /> v{agent.extends.version}</>}{agent.updateAvailable && " · Update available"}</p></div><div>{agent.disabled && <p>Turned off in your company</p>}{agent.status === "archived" && <p>Archived</p>}{publishOn && AgentIdSchema.safeParse(agent.agentId).success && <Suspense fallback={null}><FavouriteStar agentId={agent.agentId} name={agent.name} /></Suspense>}</div></li>)}</ul>{filtered.length === 0 && <p>{search ? "No loaded workflows match your search." : "No workflows in this view yet."}</p>}</>}
 <Dialog title={profile.isError ? "Workflow details" : profile.data?.agent.name ?? "Workflow details"} className="rv-agent-profile-tray" modal={false} open={selected !== undefined} onOpenChange={open => { if (!open) void navigate(-1); }} onCloseAutoFocus={event => { event.preventDefault();if (opener.current?.isConnected) opener.current.focus();else root.current?.querySelector<HTMLElement>("h1")?.focus(); }}>
 {selected && <AgentProfileScreen key={selected} id={selected} contextual />}</Dialog>
 </section>;
}
