// Spending, the top of the page (Hybrid 1, DEC 223): real amounts first. Spent this month, held for running work, what is left, then by project. Per-person spending is on People and limits.
// The numbers are Cloud's own read (`GET /v1/app/org/spend`, contract v0 `OrgSpendSummaryAddition` plus the optional additions in api/admin-company.ts). A number Cloud
// did not send is not drawn; a page Cloud does not serve says "not connected yet".
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router";
import { ORG_SPEND_PATH, isNotConnected, lineState, readOrgSpend, spendSummary, type OrgSpendRead, type ProjectSpend } from "../../../api/admin-company.js";
import { ApiError, apiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { Money } from "../../../design/Money.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { AdminSection, NotConnected, SpendMeter, Stat } from "../parts.js";
import { GatewayReadinessBanner, useGatewayReadiness } from "./GatewayReadiness.js";
import { useAdminContext } from "../AdminLayout.js";

/**
 * The spending read, scoped to the signed-in person, company and role like every admin read (dropped when access is lost). It goes straight to the transport, not
 * through the api client: a late answer of 401 after the company or person changed must never start a sign-in redirect for the new scope (the page's own budget read
 * and the identity check do that).
 */
export function useOrgSpendRead() {
 const host = useAppHost(), query = useQueryClient(), { orgId, developerId, role } = useAdminContext(), key = ["admin", "lane-c", "org-spend", orgId, developerId, role];
 useEffect(() => () => { void query.cancelQueries({ queryKey: key, exact: true }); query.removeQueries({ queryKey: key, exact: true }); }, [query, orgId, developerId, role]); // eslint-disable-line react-hooks/exhaustive-deps
 return useQuery({
  queryKey: key, gcTime: 0, enabled: (role === "owner" || role === "admin"), retry: false,
  queryFn: async () => {
   let response;
   try { response = await host.transport.request({ method: "GET", path: ORG_SPEND_PATH }); } catch { throw new ApiError(0, "NETWORK_ERROR", "Couldn't reach Rovara. Check your connection and try again."); }
   if (response.status < 200 || response.status >= 300) throw apiError(response.status, response.body, host.origin);
   try { return readOrgSpend(response.body); } catch { throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page."); }
  },
 });
}

const monthName = (month: string | undefined) => { const at = month === undefined ? Number.NaN : Date.parse(month + "-01T00:00:00Z"); return Number.isNaN(at) ? "this month" : new Date(at).toLocaleString("en-US", { month: "long", timeZone: "UTC" }); };
const dayName = (iso: string) => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });

function LeftFlag({ spent, limit, held }: { spent: number; limit: number | undefined; held?: number }) {
 const line = lineState(spent, limit, held);
 if (line.state === "over" && (line.leftUsd ?? 0) === 0) return <span className="rv-spend-flag" data-tone="bad">At the limit</span>;
 if (line.state === "over") return <span className="rv-spend-flag" data-tone="bad">Over by <Money usd={-(line.leftUsd ?? 0)} /></span>;
 if (line.state === "near") return <span className="rv-spend-flag"><Money usd={line.leftUsd ?? 0} /> left</span>;
 return null;
}
function LimitCell({ spent, limit, held }: { spent: number; limit: number | undefined; held?: number }) {
 const line = lineState(spent, limit, held);
 if (limit === undefined || line.fraction === undefined) return <span className="rv-muted">No limit set</span>;
 return <div className="rv-spend-cell"><SpendMeter used={Math.min(1, spent / limit)} held={(held ?? 0) / limit} bad={line.state === "over"} label={`${Math.round(line.fraction * 100)}% of the limit used`} /><span><Money usd={limit} /><LeftFlag spent={spent} limit={limit} {...(held === undefined ? {} : { held })} /></span></div>;
}
const projectColumns: readonly Column<ProjectSpend>[] = [
 { key: "project", title: "Project", render: row => <b><VisibleText text={row.name} /></b> },
 { key: "spent", title: "Spent", render: row => <span className="rv-num"><Money usd={row.spentUsd} /></span> },
 { key: "held", title: "Held", render: row => row.heldUsd === undefined ? <span className="rv-muted">Unavailable</span> : <span className="rv-num"><Money usd={row.heldUsd} /></span> },
 { key: "limit", title: "Monthly limit", render: row => <LimitCell spent={row.spentUsd} limit={row.limitUsd} {...(row.heldUsd === undefined ? {} : { held: row.heldUsd })} /> },
 { key: "stop", title: "Task stop", render: row => row.taskStopUsd === undefined ? <span className="rv-muted">Not set</span> : <span className="rv-num"><Money usd={row.taskStopUsd} />{row.locked === true && <span className="rv-id-chip link"> company lock</span>}</span> },
 { key: "merged", title: "Merged", render: row => row.mergedCount === undefined ? "Unavailable" : <span className="rv-num">{row.mergedCount}</span> },
 { key: "paid", title: "Paid from", render: row => row.paidFrom === undefined ? "Unavailable" : <VisibleText text={row.paidFrom} /> },
];

export function SpendingSummary({ read }: { read: UseQueryResult<OrgSpendRead> }) {
 const readiness = useGatewayReadiness();
 const summary = useMemo(() => (read.data === undefined ? undefined : spendSummary(read.data)), [read.data]);
 if (read.isPending) return <Skeleton label="Loading spending" />;
 if (read.isError) {
  if (isNotConnected(read.error)) return <><GatewayReadinessBanner readiness={readiness} /><AdminSection title="This month"><NotConnected what="Company spending">Try again later.</NotConnected></AdminSection></>;
  const forbidden = read.error instanceof ApiError && read.error.status === 403;
  return <><GatewayReadinessBanner readiness={readiness} /><AdminSection title="This month"><div role="alert" className="rv-banner rv-banner-danger" data-testid="spend-error"><span><b>{forbidden ? "You don't have permission to view spending." : "Couldn't load spending."}</b> No amounts are shown.</span><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Try again</Button></div></AdminSection></>;
 }
 const data = read.data, s = summary!, month = monthName(data.month);
 if (s.state === "unknown") return <><GatewayReadinessBanner readiness={readiness} /><AdminSection title="This month"><NotConnected what="This month's spending numbers" /></AdminSection></>;
 return <>
  <GatewayReadinessBanner readiness={readiness} />
  {s.state === "over" && <Banner tone="danger" title="This month's budget is used up" action={<Link className="rv-button rv-button-secondary" to="/app/admin/ai-spending">Raise the limit</Link>}><p>{s.overUsd > 0 ? <><Money usd={s.overUsd} /> over. </> : null}New tasks wait in the queue. Running tasks finish their current step.</p></Banner>}
  {s.state === "near" && <Banner tone="warning" title="Close to this month's limit"><p><Money usd={s.remainingUsd ?? 0} /> left of <Money usd={s.limitUsd ?? 0} />.{data.runsOutOn !== undefined ? ` At this pace it runs out on ${dayName(data.runsOutOn)}.` : ""}</p></Banner>}
  <div className="rv-stats" aria-label={`Spending in ${month}`} role="group">
   <Stat label={`Spent in ${month}`} {...(s.limitUsd === undefined ? {} : { note: <>of <Money usd={s.limitUsd} /></> })}>{s.spentUsd === undefined ? "Unavailable" : <Money usd={s.spentUsd} />}</Stat>
   {s.heldUsd !== undefined && <Stat label="Held for running work" note="Set aside until the work ends">{<Money usd={s.heldUsd} />}</Stat>}
   <Stat label="Left this month" {...(s.state === "over" ? { tone: "bad" as const } : s.state === "near" ? { tone: "warn" as const } : {})} note={s.limitUsd === undefined ? "No company limit is set" : s.state === "over" ? "Used up" : data.runsOutOn !== undefined ? `Runs out around ${dayName(data.runsOutOn)}` : undefined}>{s.remainingUsd === undefined ? "Unavailable" : s.remainingUsd < 0 ? <>−<Money usd={-s.remainingUsd} /></> : <Money usd={s.remainingUsd} />}</Stat>
   {data.costPerMergedChangeUsd !== undefined && <Stat label="Cost per merged change" {...(data.mergedCount === undefined ? {} : { note: `${data.mergedCount} merged` })}><Money usd={data.costPerMergedChangeUsd} /></Stat>}
  </div>
  <p>Not yet confirmed: {data.provisionalMicros === undefined ? "Unavailable" : <Money usd={data.provisionalMicros / 1_000_000} />}</p>
  <p className="rv-muted">Spent includes estimated charges. Not yet confirmed shows estimated amounts still held, already included in Held for running work.</p>
  {s.usedFraction !== undefined && <SpendMeter used={(s.spentUsd ?? 0) / (s.limitUsd ?? 1)} held={s.heldFraction ?? 0} bad={s.state === "over"} caption label={`${Math.round(s.usedFraction * 100)}% of this month's limit used or held`} />}
  <AdminSection title="By project">{data.projects === undefined ? <NotConnected what="Spending by project" /> : data.projects.length === 0 ? <p className="rv-muted">No project has spent anything this month.</p> : <DataTable caption="Spending by project" columns={projectColumns} rows={data.projects} rowKey={row => row.name} />}</AdminSection>
  <AdminSection title="People and limits" note="Only owners and admins see this."><p className="rv-muted">Each person's spending this month against their own limit is on <Link to="/app/admin/money/people">People and limits</Link>.</p></AdminSection>
  <p className="rv-muted"><Link to="/app/admin/audit">Changes to limits are recorded in the audit.</Link></p>
 </>;
}
