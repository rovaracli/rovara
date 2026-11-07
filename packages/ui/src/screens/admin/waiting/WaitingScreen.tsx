import "./waiting.css";
import { SettingsNote } from "../SettingsNote.js";
import { useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { useAppHost } from "../../../host.js";
import { isConfirmUrl } from "../../../text/links.js";
import { useAdminContext } from "../AdminLayout.js";
import { checkedTime, ReadSection, useAdminRead } from "../models/read.js";
const text = z.string().max(200);
function readers(origin: string) {
 const link = z.string().max(2048).optional().transform(value => value !== undefined && !value.includes("?") && isConfirmUrl(value, origin) ? value : undefined);
 return {
  approvals: z.object({ approvals: z.array(z.object({ approvalId: text, kind: text, status: z.literal("PENDING"), createdAt: text, confirmUrl: link })).max(1000) }),
  spend: z.object({ spendRequests: z.array(z.object({ spendRequestId: text, status: z.literal("PENDING"), createdAt: text, confirmUrl: link, amountUsd: z.number().finite().nonnegative().optional() })).max(1000) }),
 };
}
const waitingTimestamp = z.string().datetime({ offset: true });
function waitingAge(createdAt: string, readAt: number) {
 const created = Date.parse(createdAt);
 if (!waitingTimestamp.safeParse(createdAt).success || !Number.isFinite(created) || !Number.isFinite(readAt) || readAt <= 0 || created > readAt) return "unknown";
 const elapsed = readAt - created;
 return elapsed < 86400000 ? "recent" : elapsed < 604800000 ? "week" : "older";
}
interface WaitingRow { id: string; kind: string; createdAt: string; confirmUrl: string | undefined; amount?: number }
export function WaitingScreen() {
 const { orgId, developerId, role } = useAdminContext();
 return <ScopedWaiting key={`${orgId}:${developerId}:${role}`} />;
}
function ScopedWaiting() {
 const host = useAppHost(), schemas = useMemo(() => readers(host.origin), [host.origin]), [kind, setKind] = useState("all"), [age, setAge] = useState("all");
 const approvals = useAdminRead("approvals", "/v1/app/approvals?status=PENDING", schemas.approvals), spend = useAdminRead("spend-requests", "/v1/app/spend-requests", schemas.spend);
 function table(rows: WaitingRow[], label: string, readAt: number) { const visible = rows.filter(row => (kind === "all" || kind === row.kind) && (age === "all" || age === waitingAge(row.createdAt, readAt)));return <><p role="status" aria-label={`${label} shown in this list`} aria-live="polite" aria-atomic="true">{label}: {visible.length} of {rows.length} shown in this list.</p>{visible.length === 0 ? <p>No pending items visible to you in this list and filter.</p> : <DataTable caption="Pending items visible to you" rows={visible} rowKey={r => r.id} columns={[
 { key: "why", title: "Why waiting", render: r => r.kind === "spend" ? "Spending request" : "Approval" }, { key: "who", title: "Who can act", render: () => "Eligible approvers, confirmed when opened" },
 { key: "time", title: "Created", render: r => checkedTime(r.createdAt) }, { key: "amount", title: "Requested amount", render: r => r.amount === undefined ? "Not provided" : `$${r.amount.toFixed(2)}` },
 { key: "open", title: "Action", render: r => r.confirmUrl === undefined ? "Confirmation link unavailable" : <Button onClick={() => { if (r.confirmUrl !== undefined && !r.confirmUrl.includes("?") && isConfirmUrl(r.confirmUrl, host.origin)) host.openExternal(r.confirmUrl); }}>Open confirmation</Button> },
 ]} />}</>; }
 return <section className="rv-admin-waiting"><PageHeader focusOnMount title="Waiting for people" description="Only work returned for your existing permissions. This queue gives no extra access to private content." /><SettingsNote area="waiting" />
 <p>Partial coverage: approvals and spending requests only. Questions, plan reviews, merge readiness and handoff blockers are not included yet. No company-wide total is available.</p>
 <div className="rv-field"><label htmlFor="waiting-kind">Kind</label><select id="waiting-kind" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All kinds</option><option value="approval">Approvals</option><option value="spend">Spending requests</option></select></div>
 <div className="rv-field"><label htmlFor="waiting-age">Age at list read</label><select id="waiting-age" aria-describedby="waiting-age-help" value={age} onChange={event => setAge(event.target.value)}><option value="all">All ages</option><option value="recent">Under 1 day</option><option value="week">1 to under 7 days</option><option value="older">7 days or more</option><option value="unknown">Age unavailable</option></select><p id="waiting-age-help">Age uses this device's clock when each list was read. An incorrect clock can affect these ages; unusable or future dates have unavailable age.</p></div>
 <Button onClick={() => { setKind("all");setAge("all"); }}>Clear list filters</Button>
 <h2>Approvals</h2><Button aria-disabled={approvals.isFetching} onClick={() => { if (!approvals.isFetching) void approvals.refetch({ cancelRefetch: false }); }}>Refresh approvals</Button><ReadSection read={approvals} label="Approvals">{data => <><p>Approvals returned to you. This is not a company total.</p>{table(data.approvals.map(row => ({ id: row.approvalId, kind: "approval", createdAt: row.createdAt, confirmUrl: row.confirmUrl })), "Approvals", approvals.dataUpdatedAt)}</>}</ReadSection>
 <h2>Spending requests</h2><Button aria-disabled={spend.isFetching} onClick={() => { if (!spend.isFetching) void spend.refetch({ cancelRefetch: false }); }}>Refresh spending requests</Button><ReadSection read={spend} label="Spending requests">{data => <><p>Spending requests returned to you. This list may be capped.</p>{table(data.spendRequests.map(row => ({ id: row.spendRequestId, kind: "spend", createdAt: row.createdAt, confirmUrl: row.confirmUrl, ...(row.amountUsd === undefined ? {} : { amount: row.amountUsd }) })), "Spending requests", spend.dataUpdatedAt)}</>}</ReadSection>
 <p>Pending does not confirm delivery. If an item disappears, refresh its owning confirmation page; disappearance is not proof of approval. Opening this queue creates no confirmation tickets.</p></section>;
}
