import { AgentOrigin } from "./AgentOrigin.js";
import { Suspense, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentShareInputSchema, LEVEL_WORDS, StepSettingsSchema, ROVARA_CODE_AGENT_ID } from "@agentx/cloud-contracts/web";
import { useAgent, useAgentApi, useAgentSpend, useAgentVersions, type ReadAgent } from "../../api/agents.js";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { useLive, mergeLiveTiles } from "../../api/live.js";
import { ApiError } from "../../api/errors.js";
import { paths } from "../../paths.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Money } from "../../design/Money.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "../live/live.css";
import { NotFound } from "../../shell/NotFound.js";
import { SessionTile } from "../live/SessionTile.js";
import { AgentShareDialog } from "./AgentShareDialog.js";
import { OwnerDialog } from "./OwnerDialog.js";
import { UpdateAvailableBanner } from "./UpdateAvailableBanner.js";
import { AgentStartDialog } from "./AgentStartDialog.js";
import { agentAllows } from "./agent-access.js";
import { DesktopBuilderNote, useIsPhone } from "./agent-phone.js";
import { useAgentMembers, failureText } from "./agent-context.js";
import { useAgentPublishOn } from "./publish-flags.js";
import { FavouriteStar, ProfilePublishing } from "./publish-lazy.js";
export function AgentProfileScreen({ id: supplied, contextual = false }: { id?: string; contextual?: boolean }) {
 const params = useParams(), id = supplied ?? params.id ?? "", read = useAgent(id), query = useQueryClient(), members = useAgentMembers(read.data !== undefined && !read.isError), [versionsOpen, setVersionsOpen] = useState(false), [workOpen, setWorkOpen] = useState(false), [spendOpen, setSpendOpen] = useState(false), phone = useIsPhone(), location = useLocation(), publishOn = useAgentPublishOn();
 if (read.isPending) return <Skeleton label="Loading workflow" />;
 if (read.error instanceof ApiError && read.error.status === 404) return <NotFound />;
 if (read.isError || read.data === undefined) return <section><h1 tabIndex={-1}>Workflow unavailable</h1><p role="alert"><VisibleText text={failureText(read.error, "Couldn't load this workflow. Try again.")} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const profile = read.data, agent = profile.agent, recipe = profile.current?.recipe, editable = !agent.builtin && agentAllows(agent, "edit"), names = new Map(members.isError ? [] : members.data?.members.map(member => [member.developerId, member.name]));
 const owner = agent.builtin ? "Your company" : agent.owner?.kind === "project" ? String(agent.owner.project) : agent.owner?.kind === "member" ? names.get(String(agent.owner.developerId)) ?? "Team member" : "Owner unavailable";
 return <section className="rv-agent-profile">{phone && !contextual && <Link className="rv-button rv-button-quiet rv-agent-back" to={paths.directory + location.search}>All agents</Link>}{!contextual ? <PageHeader title={agent.name} description={agent.description} focusOnMount /> : <p><VisibleText text={agent.description} /></p>}
 <div className="rv-actions">{agent.status === "active" && !agent.disabled && agentAllows(agent, "use") && agent.agentId !== ROVARA_CODE_AGENT_ID && <AgentStartDialog agent={agent} />}{editable && <><Link className="rv-button" to={paths.agentEdit(agent.agentId)}>Edit</Link><Link className="rv-button" to={paths.agentEdit(agent.agentId) + "?panel=test"}>Test</Link></>}<AgentShareDialog agent={agent} />{publishOn && <Suspense fallback={null}><FavouriteStar agentId={agent.agentId} name={agent.name} /></Suspense>}</div>{editable && <DesktopBuilderNote />}
 {/* PLAN6: Rovara Code's dedicated start stays with its excluded project-code flow. */}
 {agent.disabled && <p>Turned off in your company</p>}{agent.status === "archived" && <p>Archived</p>}
 <p className="rv-muted">Owned by <VisibleText text={owner} />{profile.current && <> · Version {profile.current.version}</>}</p>{agent.accountable && <p>Accountable: <VisibleText text={names.get(agent.accountable.developerId) ?? "Team member"} /></p>}
 {publishOn && <Suspense fallback={null}><ProfilePublishing profile={profile} initialAsk={new URLSearchParams(location.search).get("publish") === "1"} initialTarget={new URLSearchParams(location.search).get("to") ?? undefined} /></Suspense>}
 <ProfileUpdate agent={agent} />
 <section aria-labelledby="rv-agent-purpose"><h2 id="rv-agent-purpose">What it does</h2>{profile.current?.problem && <p role="alert"><VisibleText text={profile.current.problem} /></p>}{recipe === undefined ? <p>No readable published method yet.</p> : <>
 {recipe.instructions.map((layer, index) => <section key={index} className="rv-agent-section"><h3>From <VisibleText text={layer.agentName} /></h3><p className="rv-agent-instructions"><VisibleText text={layer.text} /></p></section>)}
 <h3>Skills</h3>{recipe.skills.length === 0 ? <p>No skills added.</p> : <ul>{recipe.skills.map(skill => <li key={skill.skillId}><VisibleText text={skill.name} /> · <VisibleText text={skill.description} /></li>)}</ul>}
 <h3>Tools</h3>{recipe.tools.length === 0 ? <p>No connector tools granted.</p> : <ul>{recipe.tools.map((tool, index) => <li key={index}><VisibleText text={"type" in tool.connector ? String(tool.connector.type) : String(tool.connector.name)} /> · {tool.access === "read" ? "read" : tool.access === "read_write" ? "read and write" : "Access unavailable"}{tool.tools && <> · <VisibleText text={tool.tools.join(", ")} /></>}</li>)}</ul>}
 </>}{/* RULING Q45: changed describes the draft as a whole, not individual published fields. */}{profile.current?.changed && <p>★ Draft has unpublished changes</p>}</section>
 <details className="rv-agent-section" open><summary>How it runs</summary>{recipe && <><ol className="rv-agent-steps">{recipe.steps.map(step => <li key={step.id}><strong><VisibleText text={step.name} /></strong><StepModels settings={step.settings} /></li>)}</ol><p>Autonomy: {recipe.autonomy === "suggest" ? "Suggest" : recipe.autonomy === "prepare" ? "Prepare" : recipe.autonomy === "run" ? "Run" : "Unavailable"}</p></>}
 <dl className="rv-agent-facts"><dt>Max per run</dt><dd>{agent.maxPerRunUsd === undefined ? "No limit" : <Money usd={agent.maxPerRunUsd} />}</dd><dt>Monthly budget</dt><dd>{agent.monthlyBudgetUsd === undefined ? "No limit" : <Money usd={agent.monthlyBudgetUsd} />}</dd><dt>Suggested from recent runs</dt><dd><Money usd={profile.suggestedMaxPerRunUsd} /></dd></dl></details>
 <details className="rv-agent-section" onToggle={event => setVersionsOpen(event.currentTarget.open)}><summary>Sharing and versions</summary><p>Owned by <VisibleText text={owner} /></p><OwnerDialog agent={agent} />{versionsOpen && <><SharesSummary agent={agent} names={names} /><VersionList id={id} names={names} current={agent.currentVersion??profile.current?.version} /></>}</details>
 <details className="rv-agent-section" onToggle={event => setWorkOpen(event.currentTarget.open)}><summary>Working on now</summary>{workOpen && <CurrentWork id={id} />}</details>
 <details className="rv-agent-section" onToggle={event => setSpendOpen(event.currentTarget.open)}><summary>Spend this month</summary>{spendOpen && <Spend id={id} />}</details>
 {!agent.builtin && agentAllows(agent, "manage") && agent.status === "active" && <Archive agent={agent} onChanged={() => query.invalidateQueries({ queryKey: ["agent", id], exact: true })} />}
 </section>;
}
function VersionList({ id, names,current }: { id: string; names: ReadonlyMap<string, string>;current:number|undefined }) { const read = useAgentVersions(id);return read.isPending ? <Skeleton label="Loading versions" /> : read.isError ? <p role="alert">Couldn't load versions.</p> : <><DesktopBuilderNote text="Comparing versions works best on a larger screen." /><ol className="rv-agent-versions">{read.data.versions.map(version => <li key={version.version}><Link to={paths.agentEdit(id) + "?from=" + (current??version.version) + "&to=" + version.version}>Version {version.version}</Link>{version.publishedAt && <> · <time dateTime={version.publishedAt}><VisibleText text={Number.isFinite(Date.parse(version.publishedAt)) ? new Date(version.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Date unavailable"} /></time></>}{version.releasedIn && <> · <VisibleText text={version.releasedIn} /></>}{version.publishedBy && <> · <VisibleText text={names.get(version.publishedBy) ?? "Team member"} /></>}{(version.note ?? version.notes) && <p><VisibleText text={version.note ?? version.notes ?? ""} /></p>}<AgentOrigin origin={version.origin}/></li>)}</ol></>; }
function CurrentWork({ id }: { id: string }) { const read = useLive("all"), query = useQueryClient(), host = useAppHost(), [connection, setConnection] = useState("connecting"), ready = read.data !== undefined && !read.isError;
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 const tiles = read.isError ? [] : (read.data === undefined ? [] : mergeLiveTiles(read.data.pages)).filter(tile => tile.agent?.agentId === id).slice(0, 20);return read.isPending ? <Skeleton label="Loading current work" /> : read.isError ? <p role="alert">Couldn't load current work.</p> : <>{connection === "reconnecting" && <p className="rv-muted">Reconnecting. Showing the last update.</p>}{tiles.map(tile => <SessionTile key={tile.sessionId} tile={tile} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />)}{tiles.length === 0 && <p>{read.hasNextPage ? "No work for this workflow in the loaded sessions." : "No visible work running for this workflow."}</p>}{read.hasNextPage && tiles.length < 20 && <Button busy={read.isFetchingNextPage} onClick={() => { void read.fetchNextPage(); }}>Load more sessions</Button>}</>; }
function Spend({ id }: { id: string }) { const [month] = useState(() => new Date().toISOString().slice(0, 7)), read = useAgentSpend(id, month);return read.isPending ? <Skeleton label="Loading spending" /> : read.isError ? <p role="alert">Couldn't load spending.</p> : <><p><VisibleText text={read.data.month} /> · <Money usd={read.data.totalUsd} /></p><dl className="rv-agent-facts"><dt>Started by people</dt><dd><Money usd={read.data.byOrigin.person} /></dd><dt>Autonomous</dt><dd><Money usd={read.data.byOrigin.autonomous} /></dd><dt>Test runs</dt><dd><Money usd={read.data.byOrigin.test} /></dd></dl><h3>Recent runs</h3>{read.data.recentRuns.length === 0 ? <p>No visible recent runs.</p> : <ul>{read.data.recentRuns.map((run, index) => <li key={index}><VisibleText text={run.project} /> · <Money usd={run.usd} /> · <VisibleText text={run.lastAt} /></li>)}</ul>}</>; }
function Archive({ agent, onChanged }: { agent: ReadAgent; onChanged: () => Promise<unknown> }) { const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), sending = useRef(false), api = useAgentApi();async function archive() { if (sending.current) return;sending.current = true;setBusy(true);try { const result = await api.archive(agent.agentId);if (result.kind !== "done") { setError("This change is waiting for confirmation. The workflow has not changed.");return; }await onChanged();setOpen(false); } catch (failure) { setError(failureText(failure, "Couldn't archive this workflow.")); } finally { sending.current = false;setBusy(false); } }return <Dialog title="Archive this workflow?" className="rv-agent-dialog" open={open} onOpenChange={value => { if (!busy) setOpen(value); }} trigger={<Button variant="quiet">Archive</Button>}><p>Its versions remain available, and new work cannot use it.</p><Button variant="danger" busy={busy} onClick={() => { void archive(); }}>Archive workflow</Button>{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog>; }

function StepModels({ settings }: { settings: Record<string, unknown> }) { const model = StepSettingsSchema.shape.model.safeParse(settings.model), fallback = StepSettingsSchema.shape.fallbackModel.safeParse(settings.fallbackModel);return <p>{model.success && model.data ? <VisibleText text={model.data.provider + " / " + model.data.modelId} /> : settings.model === undefined || settings.model === null ? "Uses the project's model selection" : "Model unavailable"}{fallback.success && fallback.data && <> · Fallback: <VisibleText text={fallback.data.provider + " / " + fallback.data.modelId} /></>}</p>; }

function SharesSummary({ agent, names }: { agent: ReadAgent; names: ReadonlyMap<string, string> }) {
 const api = useAgentApi(), allowed = agentAllows(agent, "manage") && !agent.builtin, read = useQuery({ queryKey: ["agent", agent.agentId, "shares"], enabled: allowed, queryFn: () => api.shares(agent.agentId) });
 if (agent.builtin) return <p>Built in for your company.</p>;
 if (!allowed) return <p>Sharing details are available to this workflow's manager.</p>;
 if (read.isPending) return <Skeleton label="Loading sharing" />;
 if (read.isError) return <p role="alert">Couldn't load sharing.</p>;
 return read.data.shares.length === 0 ? <p>No explicit shares.</p> : <ul>{read.data.shares.map((share, index) => { const parsed = AgentShareInputSchema.safeParse({ principal: share.principal, level: share.level });if (!parsed.success) return <li key={index}>Access unavailable</li>;const principal = parsed.data.principal;return <li key={index}><VisibleText text={principal.kind === "org" ? "Everyone in your company" : principal.kind === "project" ? principal.project : names.get(principal.developerId) ?? "Team member"} /> · {LEVEL_WORDS[parsed.data.level]}</li>; })}</ul>;
}

function ProfileUpdate({ agent }: { agent: ReadAgent }) {
 const api = useAgentApi(), metadata = useQuery({ queryKey: ["agents", "all", undefined], enabled: !agent.builtin && agentAllows(agent, "edit"), queryFn: () => api.list("all") });
 // RULING Q47: updateAvailable exists on the canonical list, not getAgent. Never take access from this summary.
 const summary = metadata.isError ? undefined : metadata.data?.agents.find(item => item.agentId === agent.agentId);
 return <UpdateAvailableBanner agent={{ ...agent, ...(summary?.updateAvailable === undefined ? {} : { updateAvailable: summary.updateAvailable }) }} />;
}
