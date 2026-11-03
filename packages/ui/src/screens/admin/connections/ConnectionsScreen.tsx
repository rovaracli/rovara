import { z } from "zod";
import { useState } from "react";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import "./connections.css";
import { SlackWorkspaceEvidence } from "./SlackWorkspaceEvidence.js";
import { McpServers } from "./McpServers.js";
import { JiraOrgAdminKey } from "./JiraOrgAdminKey.js";
import { checkedTime, ReadSection, useAdminRead } from "../models/read.js";
const connectionsSchema = z.object({ connections: z.array(z.object({ connectionId: z.string().max(100), type: z.string().max(64), label: z.string().max(200), hasCredential: z.boolean(), identity: z.enum(["service", "personal"]).optional(), updatedAt: z.string().max(40), lastCheck: z.object({ ok: z.boolean(), at: z.string().max(40) }).optional() })).max(1000) });
const githubSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string().max(100), status: z.enum(["active", "suspended", "removed"]) })).max(1000) });
const requestsSchema = z.object({ requests: z.array(z.object({ accountLogin: z.string().max(100).optional(), status: z.string().max(64), requestedAt: z.string().max(40) })).max(1000) });
type ConnectionInfo = z.infer<typeof connectionsSchema>["connections"][number];
type GitHubInfo = z.infer<typeof githubSchema>["installations"][number];
function ConnectionGuidance({ connection: c }: { connection: ConnectionInfo }) {
 const evidence = c.lastCheck === undefined ? "No stored check result was returned." : c.lastCheck.ok ? "The stored check previously passed." : "The stored check failed; its cause is not returned in this view.";
 return <details className="rv-connection-guidance"><summary>Guidance for <VisibleText text={c.label} /></summary>
 <p>{evidence} Current health is unknown.</p>
 <dl><dt>Configuration</dt><dd>{c.type === "cloudwatch" ? "Externally managed setup" : c.hasCredential ? "Credential configured (stored flag)" : "Credential not configured (stored flag)"}</dd>
 <dt>Declared association</dt><dd>{c.identity === "service" ? "Declared service account; vendor authorization is unverified." : c.identity === "personal" ? "Declared personal account; vendor authorization is unverified." : "Account association was not returned."}</dd>
 <dt>Stored check time</dt><dd>{checkedTime(c.lastCheck?.at)}</dd><dt>Configuration changed</dt><dd>{checkedTime(c.updatedAt)}</dd></dl>
 <p>Missing permissions, affected projects and last event delivery: Not returned.</p>
 <ol><li>{c.type === "linear" ? "Ask the workspace administrator to confirm the configured account has the intended workspace and team access." : c.type === "cloudwatch" ? "Ask the installation administrator to review the externally managed setup through the approved operator process." : "Ask a company administrator to review the integration account and vendor permissions through the approved setup process."}</li>
 <li>Review account and credential configuration through the approved setup workflow. A configured flag does not prove validity; do not paste credentials into this page.</li>
 <li>Verify delivery through your team's usual review process before relying on this connection. This page does not perform that check.</li></ol>
 <p>Opening this guidance does not run a vendor check or change configuration.</p>
 </details>;
}
function connectionMatchText(value: string) { return value.normalize("NFKC").toLowerCase(); }
function RegisteredConnections({ connections }: { connections: ConnectionInfo[] }) {
 const [filter, setFilter] = useState("");
 const term = connectionMatchText(filter.trim());
 const shown = connections.filter(c => connectionMatchText(visibleText(c.label)).includes(term) || connectionMatchText(visibleText(c.type)).includes(term));
 return <>
 <TextField type="search" maxLength={200} label="Find registered connections" hint="Filters only names and types in this returned list. It does not check connection health." value={filter} onChange={event => setFilter(event.target.value)} />
 <Button onClick={() => setFilter("")}>Clear connection filter</Button>
 <p role="status" aria-live="polite" aria-atomic="true">{shown.length} of {connections.length} registered connections shown in this returned list.</p>
 {!connections.some(c => c.type === "linear") && <p>Linear: Not configured.</p>}
 {connections.length === 0 ? <p>No registered connections were returned.</p> : shown.length === 0 ? <p>No registered connections match this filter in the returned list.</p> : <DataTable caption="Registered company connections" rows={shown} rowKey={c => c.connectionId} columns={[
 { key: "label", title: "Connection", render: c => <VisibleText text={c.label} /> }, { key: "type", title: "Type", render: c => <VisibleText text={c.type} /> },
 { key: "credential", title: "Credential", render: c => c.type === "cloudwatch" ? "External setup" : c.hasCredential ? "Configured" : "Not configured" },
 { key: "association", title: "Account association", render: c => c.identity === "service" ? "Service account (declared)" : c.identity === "personal" ? "Personal account (declared)" : "Not returned" },
 { key: "check", title: "Stored check", render: c => c.lastCheck === undefined ? "Unknown" : c.lastCheck.ok ? "Previously passed · current health unknown" : "Needs action" },
 { key: "checked", title: "Last check", render: c => checkedTime(c.lastCheck?.at) }, { key: "changed", title: "Changed", render: c => checkedTime(c.updatedAt) },
 ]} />}
 {shown.length > 0 && <><h3>Connection guidance</h3>{shown.map(c => <ConnectionGuidance key={c.connectionId} connection={c} />)}</>}
 <p>Fix connection: ask a company admin to review the vendor integration's account, credential configuration and required permissions. Linear needs an authorized account and workspace access. No credential entry or permission expansion is performed here.</p>
 </>;
}
function GitHubGuidance({ installation: i }: { installation: GitHubInfo }) {
 return <details className="rv-connection-guidance"><summary>GitHub guidance for <VisibleText text={i.accountLogin} /></summary>
 <p>Stored installation state: {i.status === "active" ? "Active" : i.status === "suspended" ? "Suspended" : "Removed"}.</p><p>Current delivery and repository access have not been verified in this view.</p>
 <ol><li>{i.status === "suspended" ? "Ask the GitHub organization owner to review why this installation is suspended before arranging supported reconnection." : i.status === "removed" ? "Ask a company administrator and GitHub organization owner to arrange the approved connection setup again." : "Ask the GitHub organization owner to review this installation's repository selection and permissions."}</li>
 <li>Review access to the intended repositories with the GitHub organization owner. A connected installation request does not verify permissions or delivery.</li></ol>
 <p>Missing permissions, affected projects and last event delivery: Not returned.</p><p>Opening this guidance does not contact GitHub or change an installation.</p>
 </details>;
}
function SlackGuidance() {
 return <details className="rv-connection-guidance"><summary>Slack setup guidance</summary>
 <p>No company-scoped Slack installation, permission or event data is available to this page.</p><p>Installation-wide configuration is not proof of association with this company.</p>
 <ol><li>First, the Slack workspace must be connected to this company. A Rovara operator handles workspace connection; <code>connect-team</code> is operator work.</li>
 <li>On installations with company Slack channel binding support, a company owner or admin binds each channel to a project using the CLI <code>rovara slack bind</code>. This page has no bind control and cannot confirm that support is installed.</li>
 <li>Invite the Rovara bot into that channel with <code>/invite</code>.</li></ol>
 <p>This page cannot see the workspace connection, channel binding or delivery. Permissions and current health remain unknown.</p><p>Opening this guidance makes no Slack request and changes no configuration.</p></details>;
}
export function ConnectionsScreen() {
 const context = useAdminContext();return <ConnectionsView key={`${context.orgId}:${context.developerId}:${context.role}`} canEdit={context.role === "owner" || context.role === "admin"} />;
}
function ConnectionsView({ canEdit }: { canEdit: boolean }) {
 const requests = useAdminRead("github-requests", "/v1/app/github/requests", requestsSchema);
 const registry = useAdminRead("connections", "/v1/app/connections", connectionsSchema), github = useAdminRead("github", "/v1/app/github/installations", githubSchema);
 return <section><PageHeader focusOnMount title="Connections" description="Company configuration and stored checks. No live checks run when you open this page." />
 <h2>GitHub</h2><ReadSection read={github} label="GitHub installations">{data => data.installations.length === 0 ? <p>Not configured. Ask a company admin to arrange the GitHub App connection using a linked GitHub identity.</p> : <><DataTable caption="Company GitHub installations" rows={data.installations} rowKey={i => String(i.installationId)} columns={[{ key: "account", title: "Account", render: i => <VisibleText text={i.accountLogin} /> }, { key: "status", title: "Status", render: i => i.status === "active" ? "Installed · current health unknown" : "Needs action" }]} /><p>Fix connection: a company admin must review the GitHub App installation, suspension and repository permissions with the GitHub organization owner. Stored installation status does not verify delivery.</p><h3>Installation guidance</h3>{data.installations.map(i => <GitHubGuidance key={i.installationId} installation={i} />)}</>}</ReadSection>
 <h3>GitHub installation requests</h3><ReadSection read={requests} label="GitHub installation requests">{data => data.requests.length === 0 ? <p>No installation requests returned.</p> : <ul>{data.requests.map((r, i) => <li key={i}><VisibleText text={r.accountLogin ?? "GitHub organization not yet returned"} />: {r.status === "waiting" ? "Waiting for GitHub admin" : r.status === "connected" ? "Connected request · see installation status" : r.status === "expired" ? "Expired" : r.status === "cancelled" ? "Cancelled" : "Needs action"}. Requested {checkedTime(r.requestedAt)}.</li>)}</ul>}</ReadSection>
 <h2>Slack</h2><p>Unknown. Company-scoped Slack installation, permissions and event health are not available here. Ask an installation administrator to check Slack delivery for this company.</p><SlackWorkspaceEvidence /><SlackGuidance />
 <h2>Registered connections</h2><ReadSection read={registry} label="Registered connections">{data => <><RegisteredConnections connections={data.connections} />{canEdit && <JiraOrgAdminKey connections={data.connections.filter(c => c.type === "jira")} />}</>}</ReadSection><p>Coverage: affected projects, missing permissions and last event delivery are unavailable in this view. A stored successful check is not live validity.</p><McpServers /></section>;
}
