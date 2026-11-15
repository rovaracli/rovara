import { Link } from "react-router";
import { AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { isNotConnected, spendSummary } from "../../api/admin-company.js";
import { Banner } from "../../design/Banner.js";
import { Money } from "../../design/Money.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { useAdminContext } from "./AdminLayout.js";
import { ADMIN_GROUPS } from "./admin-nav.js";
import { NotConnected, SpendMeter, Stat } from "./parts.js";
import { useAdminRead } from "./models/read.js";
import { useOrgSpendRead } from "./spending/SpendingSummary.js";
import { GatewayReadinessBanner, useGatewayReadiness } from "./spending/GatewayReadiness.js";

/** The admin Overview (Hybrid 1, DEC 223): this month's money and who is in the company at a glance, then the five groups. Every number is read; none is made up. */
export function AdminOverview() {
 const { company, role } = useAdminContext(), spend = useOrgSpendRead(), members = useAdminRead("overview-members", "/v1/app/org/members", AppOrgMembersResponseReaderSchema);
 const readiness = useGatewayReadiness(), summary = spend.data === undefined ? undefined : spendSummary(spend.data);
 const admins = members.data?.members.filter(member => member.role === "owner" || member.role === "admin").length;
 return <section><PageHeader focusOnMount title="Administration" description={`Everything for ${company} in five groups: people, money, rules, connections and oversight.`} />
  <GatewayReadinessBanner readiness={readiness} />
  {summary?.state === "over" && <Banner tone="danger" title="This month's budget is used up" action={<Link className="rv-button rv-button-secondary" to="/app/admin/money/budgets">Open Spending</Link>}><p>New tasks wait in the queue. Running tasks finish their current step.</p></Banner>}
  <div className="rv-stats" role="group" aria-label="At a glance">
   {spend.isPending ? <Skeleton label="Loading this month's spending" /> : summary === undefined || summary.state === "unknown" ? <div className="rv-stat" style={{ gridColumn: "span 2" }}><span className="rv-stat-label">This month</span>{isNotConnected(spend.error) || summary?.state === "unknown" ? <NotConnected what="Spending numbers" /> : <p role="alert">Couldn't load spending. <Link to="/app/admin/money/budgets">Open Spending</Link></p>}</div> : <>
    <Stat label="Spent this month" {...(summary.limitUsd === undefined ? {} : { note: <>of <Money usd={summary.limitUsd} /></> })}>{summary.spentUsd === undefined ? "Unavailable" : <Money usd={summary.spentUsd} />}</Stat>
    <Stat label="Left this month" {...(summary.state === "over" ? { tone: "bad" as const } : summary.state === "near" ? { tone: "warn" as const } : {})} note={summary.limitUsd === undefined ? "No company limit is set" : undefined}>{summary.remainingUsd === undefined ? "Unavailable" : summary.remainingUsd < 0 ? <>−<Money usd={-summary.remainingUsd} /></> : <Money usd={summary.remainingUsd} />}</Stat>
   </>}
   {members.isPending ? <Skeleton label="Loading company members" /> : members.data === undefined ? <div className="rv-stat"><span className="rv-stat-label">People</span><span className="rv-muted">{isNotConnected(members.error) ? "Not connected yet" : "Unavailable"}</span></div> : <Stat label="People" note={admins === undefined ? undefined : `${admins} owners and admins`}>{members.data.members.length}</Stat>}
  </div>
  {summary?.usedFraction !== undefined && <SpendMeter used={(summary.spentUsd ?? 0) / (summary.limitUsd ?? 1)} held={summary.heldFraction ?? 0} bad={summary.state === "over"} caption label={`${Math.round(summary.usedFraction * 100)}% of this month's limit used or held`} />}
  <div className="rv-admin-groups">{ADMIN_GROUPS.filter(group => role === "owner" || group.links.some(link => link.ownerOnly !== true)).map(group => <section key={group.id} className="rv-admin-card" aria-label={group.title + " overview"}><div className="rv-section-head"><h2>{group.title}</h2></div><ul>{group.links.filter(link => link.ownerOnly !== true || role === "owner").map(link => <li key={link.to}><Link to={link.to} aria-label={`Open ${link.label}`}>{link.label}</Link><span>{link.blurb}</span></li>)}</ul></section>)}</div>
 </section>;
}
