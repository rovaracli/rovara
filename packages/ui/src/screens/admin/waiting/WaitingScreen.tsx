import "./waiting.css";
import { useMemo, useState } from "react";
import { z } from "zod";
import { PageHeader } from "../../../design/PageHeader.js";
import { DataTable } from "../../../design/DataTable.js";
import { useAppHost } from "../../../host.js";
import { isConfirmUrl } from "../../../text/links.js";
import { checkedTime, ReadSection, useAdminRead } from "../models/read.js";
const text = z.string().max(200);
function readers(origin: string) {
 const link = z.string().max(2048).optional().transform(value => value !== undefined && !value.includes("?") && isConfirmUrl(value, origin) ? value : undefined);
 return {
  approvals: z.object({ approvals: z.array(z.object({ approvalId: text, kind: text, status: z.literal("PENDING"), createdAt: text, confirmUrl: link })).max(1000) }),
  spend: z.object({ spendRequests: z.array(z.object({ spendRequestId: text, status: z.literal("PENDING"), createdAt: text, confirmUrl: link, amountUsd: z.number().finite().nonnegative().optional() })).max(1000) }),
 };
}
interface WaitingRow { id: string; kind: string; createdAt: string; confirmUrl: string | undefined; amount?: number }
export function WaitingScreen() {
 const host = useAppHost(), schemas = useMemo(() => readers(host.origin), [host.origin]), [kind, setKind] = useState("all");
 const approvals = useAdminRead("approvals", "/v1/app/approvals?status=PENDING", schemas.approvals), spend = useAdminRead("spend-requests", "/v1/app/spend-requests", schemas.spend);
 function table(rows: WaitingRow[]) { const visible = rows.filter(row => kind === "all" || kind === row.kind);return visible.length === 0 ? <p>No pending items visible to you in this list and filter.</p> : <DataTable caption="Pending items visible to you" rows={visible} rowKey={r => r.id} columns={[
 { key: "why", title: "Why waiting", render: r => r.kind === "spend" ? "Spending request" : "Approval" }, { key: "who", title: "Who can act", render: () => "Eligible approvers, confirmed when opened" },
 { key: "time", title: "Created", render: r => checkedTime(r.createdAt) }, { key: "amount", title: "Requested amount", render: r => r.amount === undefined ? "Not provided" : `$${r.amount.toFixed(2)}` },
 { key: "open", title: "Action", render: r => r.confirmUrl === undefined ? "Confirmation link unavailable" : <a href={r.confirmUrl}>Open confirmation</a> },
 ]} />; }
 return <section className="rv-admin-waiting"><PageHeader focusOnMount title="Waiting for people" description="Only work returned for your existing permissions. This queue gives no extra access to private content." />
 <p>Partial coverage: approvals and spending requests only. Questions, plan reviews, merge readiness and handoff blockers are not included yet. No company-wide total is available.</p>
 <div className="rv-field"><label htmlFor="waiting-kind">Kind</label><select id="waiting-kind" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All kinds</option><option value="approval">Approvals</option><option value="spend">Spending requests</option></select></div>
 <h2>Approvals</h2><ReadSection read={approvals} label="Approvals">{data => <><p>{data.approvals.length} approvals visible in this list. This is not a company total.</p>{table(data.approvals.map(row => ({ id: row.approvalId, kind: "approval", createdAt: row.createdAt, confirmUrl: row.confirmUrl })))}</>}</ReadSection>
 <h2>Spending requests</h2><ReadSection read={spend} label="Spending requests">{data => <><p>{data.spendRequests.length} spending requests visible in this list. This list may be capped.</p>{table(data.spendRequests.map(row => ({ id: row.spendRequestId, kind: "spend", createdAt: row.createdAt, confirmUrl: row.confirmUrl, ...(row.amountUsd === undefined ? {} : { amount: row.amountUsd }) })))}</>}</ReadSection>
 <p>Pending does not confirm delivery. If an item disappears, refresh its owning confirmation page; disappearance is not proof of approval. Opening this queue creates no confirmation tickets.</p></section>;
}
