import { z } from "zod";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { checkedTime, ReadSection, useAdminRead } from "../models/read.js";
const connectionsSchema = z.object({ connections: z.array(z.object({ connectionId: z.string().max(100), type: z.string().max(64), label: z.string().max(200), hasCredential: z.boolean(), identity: z.enum(["service", "personal"]).optional(), updatedAt: z.string().max(40), lastCheck: z.object({ ok: z.boolean(), at: z.string().max(40) }).optional() })).max(1000) });
const githubSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string().max(100), status: z.enum(["active", "suspended", "removed"]) })).max(1000) });
const requestsSchema = z.object({ requests: z.array(z.object({ accountLogin: z.string().max(100).optional(), status: z.string().max(64), requestedAt: z.string().max(40) })).max(1000) });
export function ConnectionsScreen() {
 const requests = useAdminRead("github-requests", "/v1/app/github/requests", requestsSchema);
 const registry = useAdminRead("connections", "/v1/app/connections", connectionsSchema), github = useAdminRead("github", "/v1/app/github/installations", githubSchema);
 return <section><PageHeader focusOnMount title="Connections" description="Company configuration and stored checks. No live checks run when you open this page." />
 <h2>GitHub</h2><ReadSection read={github} label="GitHub installations">{data => data.installations.length === 0 ? <p>Not configured. Ask a company admin to arrange the GitHub App connection using a linked GitHub identity.</p> : <><DataTable caption="Company GitHub installations" rows={data.installations} rowKey={i => String(i.installationId)} columns={[{ key: "account", title: "Account", render: i => <VisibleText text={i.accountLogin} /> }, { key: "status", title: "Status", render: i => i.status === "active" ? "Installed · current health unknown" : "Needs action" }]} /><p>Fix connection: a company admin must review the GitHub App installation, suspension and repository permissions with the GitHub organization owner. Stored installation status does not verify delivery.</p></>}</ReadSection>
 <h3>GitHub installation requests</h3><ReadSection read={requests} label="GitHub installation requests">{data => data.requests.length === 0 ? <p>No installation requests returned.</p> : <ul>{data.requests.map((r, i) => <li key={i}><VisibleText text={r.accountLogin ?? "GitHub organization not yet returned"} />: {r.status === "waiting" ? "Waiting for GitHub admin" : r.status === "connected" ? "Connected request · see installation status" : r.status === "expired" ? "Expired" : r.status === "cancelled" ? "Cancelled" : "Needs action"}. Requested {checkedTime(r.requestedAt)}.</li>)}</ul>}</ReadSection>
 <h2>Slack</h2><p>Unknown. Company-scoped Slack installation, permissions and event health are not available here. Ask an installation administrator to check Slack delivery for this company.</p>
 <h2>Registered connections</h2><ReadSection read={registry} label="Registered connections">{data => <>
 {!data.connections.some(c => c.type === "linear") && <p>Linear: Not configured.</p>}
 {data.connections.length === 0 ? <p>No registered connections were returned.</p> : <DataTable caption="Registered company connections" rows={data.connections} rowKey={c => c.connectionId} columns={[
 { key: "label", title: "Connection", render: c => <VisibleText text={c.label} /> }, { key: "type", title: "Type", render: c => <VisibleText text={c.type} /> },
 { key: "credential", title: "Credential", render: c => c.type === "cloudwatch" ? "External setup" : c.hasCredential ? "Configured" : "Not configured" },
 { key: "association", title: "Account association", render: c => c.identity === "service" ? "Service account (declared)" : c.identity === "personal" ? "Personal account (declared)" : "Not returned" },
 { key: "check", title: "Stored check", render: c => c.lastCheck === undefined ? "Unknown" : c.lastCheck.ok ? "Previously passed · current health unknown" : "Needs action" },
 { key: "checked", title: "Last check", render: c => checkedTime(c.lastCheck?.at) }, { key: "changed", title: "Changed", render: c => checkedTime(c.updatedAt) },
 ]} />}
 <p>Fix connection: ask a company admin to review the vendor integration's account, credential configuration and required permissions. Linear needs an authorized account and workspace access. No credential entry or permission expansion is performed here.</p>
 </>}</ReadSection><p>Coverage: affected projects, missing permissions and last event delivery are unavailable in this view. A stored successful check is not live validity.</p></section>;
}
