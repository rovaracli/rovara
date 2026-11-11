// UX3: the one Connections page of company settings. Every connection a company gives Rovara is a row here: GitHub, AI provider, Slack, email, Linear, Jira, cloud and
// monitoring tools, and test services. Each row says its state (a tick, or "Needs attention" with why and the fix), who connected it and which projects use it, and
// opens its setup in place: plain fields, one "Check it works", nothing elsewhere. Other places that used to set a connection up now link here (`?open=<row>`).
// Who may connect or change anything is unchanged: owners and admins. A member sees the state and why they can't change it.
import { z } from "zod";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AppProjectsResponseSchema, GithubInstallationsResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { SettingsNote } from "../SettingsNote.js";
import { ProviderSetup } from "../models/ProviderSetup.js";
import { modelSourcesSnapshot } from "../models/source-order.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { GithubConnectPanel } from "../../onboarding/steps/GithubConnectPanel.js";
import "./connections.css";
import { SlackWorkspaceEvidence, useSlackEvidence } from "./SlackWorkspaceEvidence.js";
import { McpServers } from "./McpServers.js";
import { JiraOrgAdminKey } from "./JiraOrgAdminKey.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { AddTracker, RegistryItems, runCheck, type CheckResult } from "./RegistryItems.js";
import { AddMonitoring } from "./AddMonitoring.js";
import { githubSummary, groupSummary, providerSummary, slackSummary, type CardSummary, type ConnectionUsage, type GithubInstall, type RegistryConnection, projectsUsing, trackerUsedBy, usedByLine, whoWhen } from "./connection-state.js";
const connectionsSchema = z.object({ connections: z.array(z.object({ connectionId: z.string().max(100), type: z.string().max(64), label: z.string().max(200), hasCredential: z.boolean(), access: z.string().max(20).optional(), identity: z.enum(["service", "personal"]).optional(), createdBy: z.string().max(100).optional(), createdAt: z.string().max(40).optional(), updatedAt: z.string().max(40), lastCheck: z.object({ ok: z.boolean(), at: z.string().max(40) }).optional(), ticketUpdates: z.string().max(40).optional() })).max(1000) });
const githubSchema = { parse(value: unknown) { return { installations: GithubInstallationsResponseReaderSchema.parse(value).installations.map(i => ({ installationId: i.installationId, accountLogin: i.accountLogin, status: i.status, connectedBy: i.connectedBy, connectedAt: i.connectedAt })) }; } };
const requestsSchema = z.object({ requests: z.array(z.object({ accountLogin: z.string().max(100).optional(), status: z.string().max(64), requestedAt: z.string().max(40) })).max(1000) });
const membersSchema = { parse(value: unknown) { const data = z.object({ members: z.array(z.object({ developerId: z.string().max(100), name: z.string().max(200) })).max(10000) }).parse(value);return { members: data.members.map(member => ({ developerId: member.developerId, name: member.name })) }; } };
const projectsSchema = { parse(value: unknown) { return { projects: AppProjectsResponseSchema.parse(value).projects.filter(p => p.status !== "archived").map(p => ({ name: p.name, repositories: p.repositories.map(r => r.fullName) })) }; } };
const usageList = (key: string) => z.array(z.object({ [key]: z.string().max(100), projects: z.array(z.string().max(200)).max(200) })).max(1000);
const usageSchema = z.object({ complete: z.boolean(), connections: usageList("connectionId"), sources: usageList("sourceId") }) as unknown as z.ZodType<ConnectionUsage>;
const OBSERVABILITY = ["sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"];
const CARDS = ["github", "ai-provider", "slack", "email", "linear", "jira", "cloud", "test-services", "tools"] as const;
type CardId = (typeof CARDS)[number];
const READ_ONLY_WHY = "Only a company owner or admin can connect or change this. You can see its state.";
const projectWords = (names: readonly string[], none: string) => names.length === 0 ? none : names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${String(names.length - 6)} more` : names.join(", ");
export function ConnectionsScreen() {
  const context = useAdminContext();
  return <ConnectionsView key={`${context.orgId}:${context.developerId}:${context.role}`} canEdit={context.role === "owner" || context.role === "admin"} />;
}
function ConnectionsView({ canEdit }: { canEdit: boolean }) {
  const host = useAppHost(), context = useAdminContext();
  const [params, setParams] = useSearchParams(), asked = params.get("open"), initial = CARDS.find(card => card === asked) ?? (params.has("github_link") ? "github" : undefined);
  const [open, setOpen] = useState<CardId | undefined>(initial), [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const requests = useAdminRead("github-requests", "/v1/app/github/requests", requestsSchema);
  const registry = useAdminRead("connections", "/v1/app/connections", connectionsSchema), github = useAdminRead("github", "/v1/app/github/installations", githubSchema);
  const sources = useAdminRead("sources", "/v1/app/org/model-sources", modelSourcesSnapshot.extend({ orgId: z.literal(context.orgId).optional(), developerId: z.literal(context.developerId).optional(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), available: z.array(z.enum(["anthropic", "openai", "openrouter", "bedrock", "endpoint"])).max(5).optional() }));
  const members = useAdminRead("member-names", "/v1/app/org/members", membersSchema), projects = useAdminRead("connection-projects", "/v1/app/projects", projectsSchema);
  // Exact "used by" (which projects the viewer may see use each AI provider and connection). If it can't be read, or is not complete, the cards keep their careful company-wide wording.
  const usageRead = useAdminRead("connection-usage", "/v1/app/connection-usage", usageSchema, { stable: true }), usage = usageRead.data;
  const slack = useSlackEvidence();
  // Names only once the members list has been read: before that (or if it can't be read) who connected a thing is not shown, never guessed.
  const names = useMemo(() => members.isSuccess ? new Map(members.data.members.map(member => [member.developerId, member.name] as const)) : undefined, [members.isSuccess, members.data]);
  const projectList = projects.data?.projects ?? [];
  const toggle = (card: CardId) => { setOpen(current => current === card ? undefined : card);if (asked !== null) setParams({}, { replace: true }); };
  const connections: RegistryConnection[] = registry.data?.connections ?? [];
  const messages: Record<string, string> = {};
  for (const [id, result] of Object.entries(checks)) if (result.state === "failed") messages[id] = result.message;
  async function check(connectionId: string) {
    setChecks(current => ({ ...current, [connectionId]: { state: "busy" } }));
    const result = await runCheck(host, connectionId);
    setChecks(current => ({ ...current, [connectionId]: result }));
    void registry.refetch();
  }
  const refresh = () => { void registry.refetch(); };
  const ofType = (...types: string[]) => connections.filter(connection => types.includes(connection.type));
  const installs: GithubInstall[] = github.data?.installations ?? [];
  const githubCard = githubSummary(installs, requests.data?.requests ?? []);
  const slackRefused = slack.error instanceof ApiError && ([401, 403, 404, 503].includes(slack.error.status) || slack.error.code === "INVALID_RESPONSE");
  const slackRead = slack.isPending ? { status: "loading" as const } : slackRefused ? { status: "refused" as const } : slack.data === undefined || slack.isError ? { status: "unavailable" as const } : { status: "ok" as const, associations: slack.data.associationCount };
  const failedSources = new Set(Object.entries(checks).filter(([, result]) => result.state === "failed").map(([id]) => id));
  const providerCard = providerSummary(sources.data?.sources ?? [], sources.data?.available, failedSources);
  const linearCard = groupSummary(ofType("linear"), messages, "Linear"), jiraCard = groupSummary(ofType("jira"), messages, "Jira");
  const cloudItems = ofType(...OBSERVABILITY);
  const cloudCard: CardSummary = cloudItems.length === 0 ? { state: "not_connected", why: "Rovara can't see your cloud and monitoring tools. This is optional." } : groupSummary(cloudItems, messages, "your cloud tools");
  const toolItems = ofType("mcp");
  const githubBy = installs.filter(install => install.status === "active").map(install => `${whoWhen(install.connectedBy, install.connectedAt, names)}${installs.filter(other => other.status === "active").length > 1 ? ` (${install.accountLogin})` : ""}`).join("; ");
  const githubUsers = projectList.filter(project => project.repositories.some(repo => installs.some(install => repo.toLowerCase().startsWith(`${install.accountLogin.toLowerCase()}/`)))).map(project => project.name);
  const byOf = (list: readonly RegistryConnection[]) => list.length === 0 ? undefined : [...new Set(list.map(connection => whoWhen(connection.createdBy, connection.createdAt, names)))].join("; ");
  const common = { canChange: canEdit, readOnlyReason: READ_ONLY_WHY };
  const idsOf = (list: readonly RegistryConnection[]) => list.map(connection => connection.connectionId);
  const isTracker = (list: readonly RegistryConnection[]) => list.length > 0 && list.every(connection => connection.type === "linear" || connection.type === "jira");
  const usedOfConnections = (list: readonly RegistryConnection[], words: { none: string; unknown: string }) => {
    if (list.length === 0) return words.none;
    const projects = projectsUsing(usage, "connections", idsOf(list));
    return (isTracker(list) ? trackerUsedBy(projects, list, canEdit) : undefined) ?? usedByLine(projects, { none: "No project uses it yet.", unknown: words.unknown }, canEdit);
  };
  const usedForItem = (connection: RegistryConnection) => {
    const projects = projectsUsing(usage, "connections", [connection.connectionId]);
    return projects === undefined ? undefined : (isTracker([connection]) ? trackerUsedBy(projects, [connection], canEdit) : undefined) ?? usedByLine(projects, { none: "No project uses it yet.", unknown: "" }, canEdit);
  };
  const providerIds = (sources.data?.sources ?? []).map(source => source.sourceId);
  const aiUsedBy = providerIds.length === 0 ? "No provider added yet. Work runs on Rovara's own models." : usedByLine(projectsUsing(usage, "sources", providerIds), { none: "No project uses your providers yet.", unknown: "Every project (company-wide). Your own provider's key pays for the work that uses it." }, canEdit);
  return <section className="rv-conn-page"><PageHeader focusOnMount title="Connections" description="Everything your company has connected to Rovara, in one place. Open a row to set it up or fix it here." />
    <SettingsNote area="connections" />
    <ul className="rv-conn-list">
      <ConnectionCard {...common} id="github" name="GitHub" summary={githubCard} by={installs.some(install => install.status === "active") ? githubBy : undefined} usedBy={githubUsers.length === 0 ? "No project yet. Projects work on repositories from the connected GitHub." : projectWords(githubUsers, "")} open={open === "github"} onToggle={() => { toggle("github"); }} actionWords={githubCard.state === "connected" ? "Manage GitHub" : githubCard.state === "attention" ? "Fix GitHub" : "Connect GitHub"}>
        <ReadSection read={github} label="GitHub installations">{data => data.installations.length === 0 ? <p>No GitHub account is connected yet.</p> : <ul>{data.installations.map(install => <li key={install.installationId}><VisibleText text={install.accountLogin} />: {install.status === "active" ? "Installed" : install.status === "suspended" ? "Suspended on GitHub" : "Removed from GitHub"}</li>)}</ul>}</ReadSection>
        <ReadSection read={requests} label="GitHub installation requests">{data => data.requests.length === 0 ? <p>No installation requests waiting.</p> : <ul>{data.requests.map((request, index) => <li key={index}><VisibleText text={request.accountLogin ?? "A GitHub organization"} />: {request.status === "waiting" ? "waiting for your GitHub admin" : request.status === "connected" ? "approved" : request.status === "expired" ? "expired" : request.status === "cancelled" ? "cancelled" : "needs attention"}</li>)}</ul>}</ReadSection>
        {canEdit && <GithubConnectPanel requested={(requests.data?.requests ?? []).some(request => request.status === "waiting")} returnTo="/app/admin/connections" refresh={() => { void github.refetch();void requests.refetch(); }} />}
      </ConnectionCard>
      <ConnectionCard {...common} id="ai-provider" name="AI provider" summary={providerCard} usedBy={aiUsedBy} open={open === "ai-provider"} onToggle={() => { toggle("ai-provider"); }} actionWords={providerCard.state === "connected" ? "Manage AI provider" : providerCard.state === "attention" ? "Fix AI provider" : "Add an AI provider"}>
        <ReadSection read={sources} label="AI providers">{data => <><ProviderSetup available={data.available} sources={data.sources} revision={data.orgId === context.orgId && data.developerId === context.developerId ? data.revision : undefined} canEdit={canEdit} onChanged={() => { void sources.refetch(); }} onChecked={(id, ok) => { setChecks(current => ({ ...current, [id]: ok ? { state: "ok" } : { state: "failed", message: "its last check failed" } })); }} />{usage?.complete === true && data.sources.length > 0 && <ul aria-label="Which projects use each provider">{data.sources.map(source => <li key={source.sourceId}><VisibleText text={source.label} />: <VisibleText text={usedByLine(projectsUsing(usage, "sources", [source.sourceId]), { none: "No project uses it yet.", unknown: "" }, canEdit)} /></li>)}</ul>}<p><Link to="/app/admin/models/sources">Choose which provider is tried first</Link></p></>}</ReadSection>
      </ConnectionCard>
      <ConnectionCard {...common} id="slack" name="Slack" summary={slackSummary(slackRead)} usedBy="Projects with a linked Slack channel. Link a channel from a project's Slack channels." open={open === "slack"} onToggle={() => { toggle("slack"); }} actionWords="Set up Slack">
        <SlackWorkspaceEvidence />
        <ol><li>Your Slack workspace is connected to the company once, by a Rovara operator (<code>rovara admin slack connect-team</code>). That step is not something a company admin can do here.</li>
          <li>Link a channel to a project from <Link to="/app/admin/projects">Projects</Link>, open the project, then Slack channels.</li>
          <li>In Slack, invite the Rovara bot to that channel with <code>/invite @Rovara</code>.</li></ol>
      </ConnectionCard>
      <ConnectionCard {...common} id="email" name="Email" summary={{ state: "built_in", why: "Rovara sends invitations and sign-in codes from its own address. There is nothing to connect." }} usedBy="Everyone in the company." open={open === "email"} onToggle={() => { toggle("email"); }} actionWords="See how email works">
        <p>Invitations go to the address you type, and the invite link also works if you share it yourself. Sign-in codes go to the person signing in.</p>
        <p>To let people with your company's email addresses join, verify your domain under <Link to="/app/admin/domains">Company domains</Link> (owners only).</p>
      </ConnectionCard>
      <ConnectionCard {...common} id="linear" name="Linear" summary={linearCard} by={byOf(ofType("linear"))} usedBy={usedOfConnections(ofType("linear"), { none: "Nothing connected yet.", unknown: "Every project that uses Linear tickets (company-wide connection)." })} open={open === "linear"} onToggle={() => { toggle("linear"); }} actionWords={linearCard.state === "not_connected" ? "Connect Linear" : linearCard.state === "attention" ? "Fix Linear" : "Manage Linear"}>
        <RegistryItems usedBy={usedForItem} connections={ofType("linear")} names={names} canChange={canEdit} checks={checks} onCheck={id => { void check(id); }} onChanged={refresh} />
        {canEdit && <AddTracker kind="linear" onAdded={id => { refresh();void check(id); }} />}
      </ConnectionCard>
      <ConnectionCard {...common} id="jira" name="Jira" summary={jiraCard} by={byOf(ofType("jira"))} usedBy={usedOfConnections(ofType("jira"), { none: "Nothing connected yet.", unknown: "Every project that uses Jira tickets (company-wide connection)." })} open={open === "jira"} onToggle={() => { toggle("jira"); }} actionWords={jiraCard.state === "not_connected" ? "Connect Jira" : jiraCard.state === "attention" ? "Fix Jira" : "Manage Jira"}>
        <RegistryItems usedBy={usedForItem} connections={ofType("jira")} names={names} canChange={canEdit} checks={checks} onCheck={id => { void check(id); }} onChanged={refresh} />
        {canEdit && <AddTracker kind="jira" onAdded={id => { refresh();void check(id); }} />}
        {canEdit && <JiraOrgAdminKey connections={ofType("jira")} />}
      </ConnectionCard>
      <ConnectionCard {...common} id="cloud" name="Cloud and monitoring" summary={cloudCard} by={byOf(cloudItems)} usedBy={usedOfConnections(cloudItems, { none: "Nothing connected yet.", unknown: "Projects that look at errors and metrics (company-wide connection)." })} open={open === "cloud"} onToggle={() => { toggle("cloud"); }} actionWords={cloudCard.state === "not_connected" ? "See cloud tools" : "Manage cloud tools"}>
        {cloudItems.length === 0 ? <p>No cloud or monitoring tool is connected. Amazon CloudWatch, Sentry, Datadog, Grafana, Vercel and PagerDuty are supported; they are read only.</p> : <RegistryItems usedBy={usedForItem} connections={cloudItems} names={names} canChange={canEdit} checks={checks} onCheck={id => { void check(id); }} onChanged={refresh} />}
        {canEdit && <AddMonitoring onAdded={(id, needsRoleSetup) => { refresh();void usageRead.refetch();if (!needsRoleSetup) void check(id); }} />}
      </ConnectionCard>
      <ConnectionCard {...common} id="test-services" name="Test services" summary={{ state: "per_project", why: "Each project sets up its own test environment and test services, because they depend on the project's code." }} usedBy={projectWords(projectList.map(project => project.name), "No projects yet.")} open={open === "test-services"} onToggle={() => { toggle("test-services"); }} actionWords="Open a project's test setup">
        {projectList.length === 0 ? <p>Create a project first, then set up its test environment.</p> : <ul>{projectList.map(project => <li key={project.name}><Link to={`/app/onboard?project=${encodeURIComponent(project.name)}&step=setup`}>Test setup for <VisibleText text={project.name} /></Link></li>)}</ul>}
      </ConnectionCard>
      <ConnectionCard {...common} id="tools" name="Other tools" summary={toolItems.length === 0 ? { state: "not_connected", why: "No other tool is connected. This is optional." } : groupSummary(toolItems, messages, "your tools")} by={byOf(toolItems)} usedBy={usedOfConnections(toolItems, { none: "Nothing connected yet.", unknown: "Projects that add one of these as a source of context." })} open={open === "tools"} onToggle={() => { toggle("tools"); }} actionWords="See other tools">
        <RegistryItems usedBy={usedForItem} connections={toolItems} names={names} canChange={canEdit} checks={checks} onCheck={id => { void check(id); }} onChanged={refresh} />
        <McpServers />
      </ConnectionCard>
    </ul>
    {registry.isError && <p role="alert">Couldn't read your saved connections. <Button onClick={refresh}>Try again</Button></p>}
  </section>;
}
