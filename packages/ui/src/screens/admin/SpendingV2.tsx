import "./spending.css";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { safeConfirmUrl, useSpendingReads, type OrgSpend, type SpendBudget, type SpendRequestRow } from "../../api/spending.js";
import { Button } from "../../design/Button.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { Money } from "../../design/Money.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useAdminContext } from "./AdminLayout.js";
import { SettingsNote } from "./SettingsNote.js";
import { TaskStopEditor } from "./TaskStopEditor.js";
import { approverWords, availableUsd, barShares, heldUsd, isOverAllowance, monthLabel, percentOf, requestKindWords, sourceWords, type Figures } from "./spending-format.js";
/** The Spending page lives at /app/admin/money/budgets today. A spending request is approved on Rovara's confirmation page, which the waiting page links to. */
const WAITING_PATH = "/app/admin/waiting";
const forbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;
const time = (value: string | undefined): string => { const parsed = value === undefined ? Number.NaN : Date.parse(value);return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "Unavailable"; };
const dollars = (microdollars: number): number => microdollars / 1_000_000;
/** An amount in dollars; a non-zero amount under half a cent says so instead of reading as $0.00. */
function Usd({ usd }: { usd: number }) { return usd > 0 && usd < 0.005 ? <span className="rv-money">&lt;$0.01</span> : <Money usd={usd} />; }
/** A read's data, but never after its latest refresh failed: a failed refresh keeps no figures on the page. */
const fresh = <T,>(read: UseQueryResult<T>): T | undefined => read.isError ? undefined : read.data;

/** One read's waiting, restricted and failed states. `restricted` is what to say when the broker answers 403: that person is simply not shown this part. */
function Part<T>({ read, title, restricted, children }: { read: UseQueryResult<T>; title: string; restricted?: ReactNode; children: (data: T) => ReactNode }) {
 if (read.isPending && read.fetchStatus === "idle") return <p className="rv-muted">Checking company access...</p>;
 if (read.isPending) return <Skeleton label={`Loading ${title}`} />;
 if (read.isError && forbidden(read.error) && restricted !== undefined) return <p className="rv-muted" role="note">{restricted}</p>;
 if (read.isError) return <p role="alert">Couldn't load {title}. No current amounts are shown. Refresh to try again.</p>;
 return <>{children(read.data)}</>;
}

function Bar({ figures }: { figures: Figures }) {
 const { spent, held } = barShares(figures);
 return <div className="rv-spend-bar" aria-hidden="true"><span className="rv-spend-bar-spent" style={{ width: `${String(spent)}%` }} /><span className="rv-spend-bar-held" style={{ width: `${String(held)}%` }} /></div>;
}

function ThisMonth({ budget, source }: { budget: SpendBudget; source: UseQueryResult<OrgSpend> }) {
 const figures = budget.org, available = availableUsd(figures);
 return <>
  <div className="rv-spend-card rv-surface">
   <dl className="rv-spend-figures">
    <div><dt>Spent</dt><dd><Usd usd={figures.spentUsd} /></dd></div>
    <div><dt>Held for work in progress</dt><dd><Usd usd={heldUsd(figures)} /></dd></div>
    <div><dt>Available to the company</dt><dd>{available === undefined ? "No limit set" : <Usd usd={available} />}</dd></div>
   </dl>
   {figures.limitUsd === undefined ? <p>No monthly allowance is set for the company, so there is nothing to measure against.</p> : <>
    <Bar figures={figures} />
    <p className="rv-spend-legend"><span className="rv-spend-key rv-spend-key-spent" aria-hidden="true" /> Spent <span className="rv-spend-key rv-spend-key-held" aria-hidden="true" /> Held <span>of the company's allowance of <Usd usd={figures.limitUsd} /></span></p>
    {isOverAllowance(figures) && <p role="status" className="rv-spend-over">Spent and held amounts together are past the company's allowance this month.</p>}
   </>}
   <p className="rv-muted">Held is money set aside for AI calls that have not finished yet. Available to the company is the allowance minus what was spent and what is held. It is the company's figure, not yours: your own allowance may be smaller.</p>
  </div>
  <h3>Where the money comes from</h3>
  <Part read={source} title="the split by source" restricted="The split by source is shown to company owners and admins.">{data => data.bySource.length === 0 ? <p>No AI spending is recorded for this month yet.</p> : <ul className="rv-spend-list" aria-label="Spending by source">{data.bySource.map(row => <li key={row.source}><span><VisibleText text={sourceWords(row.source)} /></span><span><Usd usd={row.spentUsd} /> <span className="rv-muted">({String(percentOf(row.spentUsd, figures.spentUsd))}% of spent)</span></span></li>)}</ul>}</Part>
 </>;
}

type PersonRow = { id: string; name: ReactNode; spentUsd: number; allowance: ReactNode };
const personColumns: readonly Column<PersonRow>[] = [
 { key: "person", title: "Person", render: row => row.name }, { key: "spent", title: "Spent", render: row => <Usd usd={row.spentUsd} /> }, { key: "allowance", title: "Allowance", render: row => row.allowance },
];
type ProjectRow = OrgSpend["byProject"][number];
const projectColumns: readonly Column<ProjectRow>[] = [
 { key: "project", title: "Project", render: row => <VisibleText text={row.project} /> }, { key: "spent", title: "Spent", render: row => <Usd usd={row.spentUsd} /> }, { key: "held", title: "Held", render: row => <Usd usd={heldUsd(row)} /> },
];

export function SpendingV2() {
 const host = useAppHost(), { orgId, developerId, role, checking } = useAdminContext();
 const reads = useSpendingReads({ orgId, developerId, role, enabled: !checking });
 const { budget, orgSpend, requests, settings, members } = reads;
 const busy = checking || reads.all.some(read => read.isFetching);
 // A failed refresh keeps no figures on the page: every figure below comes from `fresh`, which is undefined after an error.
 const budgetData = fresh(budget), orgSpendData = fresh(orgSpend), settingsData = fresh(settings), membersData = fresh(members);
 const names = new Map((membersData?.members ?? []).map(member => [member.developerId, member.name]));
 const settingsOk = settingsData !== undefined && settingsData.orgId === orgId ? settingsData : undefined;
 const memberDefault = settingsOk?.memberDefaultMonthly;
 const defaultAllowance = memberDefault === undefined ? "Company default (not available)" : memberDefault.kind === "unlimited" ? "No limit set" : <Usd usd={dollars(memberDefault.microdollars)} />;
 const own = budgetData?.member;
 const ownAllowance = own === undefined ? "Unavailable" : own.limitUsd === undefined ? "No limit set" : <Usd usd={own.limitUsd} />;
 // Each person's own allowance, as the settings read lists it (owners and admins only, and only when someone has one). With the list in the answer, every other person is labelled as on the company default; without it, nothing is added.
 const overrideList = settingsOk?.memberOverrides, overrideOf = new Map((overrideList ?? []).map(entry => [entry.developerId, entry.microdollars] as const));
 const allowanceOf = (id: string): ReactNode => { const own = overrideOf.get(id);return own !== undefined ? <><Usd usd={dollars(own)} /> <span className="rv-muted">(own allowance)</span></> : overrideList === undefined ? defaultAllowance : <>{defaultAllowance} <span className="rv-muted">(company default)</span></>; };
 const namesLoaded = membersData !== undefined;
 const people: PersonRow[] = (orgSpendData?.byMember ?? []).map(row => {
  const name = names.get(row.developerId), mine = row.developerId === developerId;
  return { id: row.developerId, name: mine ? <>{name === undefined ? "You" : <VisibleText text={name} />} <span className="rv-muted">(you)</span></> : name !== undefined ? <VisibleText text={name} /> : namesLoaded ? "Former member" : members.isError ? "Name unavailable" : "Loading name", spentUsd: row.spentUsd, allowance: mine ? ownAllowance : allowanceOf(row.developerId) };
 });
 const overrides = settingsOk?.memberOverrideCount ?? 0;
 const openRequests = (rows: SpendRequestRow[]) => rows.filter(row => row.status === "PENDING");
 const requestColumns: readonly Column<SpendRequestRow>[] = [
  { key: "what", title: "Request", render: row => requestKindWords(row.kind) },
  { key: "amount", title: "Amount", render: row => row.amountUsd === undefined ? "Not provided" : <Usd usd={row.amountUsd} /> },
  { key: "why", title: "Reason", render: row => row.reason === undefined || row.reason === "" ? "No reason given" : <VisibleText text={row.reason} /> },
  { key: "who", title: "Who can approve", render: row => approverWords(row.approverRole) },
  { key: "asked", title: "Asked", render: row => time(row.createdAt) },
  { key: "open", title: "Action", render: row => { const link = safeConfirmUrl(row.confirmUrl, host.origin);return link === undefined ? <Link className="rv-spend-link" to={WAITING_PATH}>Approve in Waiting for people</Link> : <Button onClick={() => { host.openExternal(link); }}>Open to review</Button>; } },
 ];
 return <section aria-busy={busy} className="rv-spending">
  <PageHeader focusOnMount title="Spending" description="What the company has spent this month, what is held for work in progress, and what is left." actions={<Button aria-disabled={busy} onClick={() => { if (!busy) reads.all.forEach(read => { void read.refetch(); }); }}>Refresh spending</Button>} />
  <SettingsNote area="money" />
  {checking && <p role="status">Checking company access...</p>}
  <section aria-labelledby="rv-spend-month" className="rv-spend-block"><h2 id="rv-spend-month">This month{budgetData === undefined ? "" : `: ${monthLabel(budgetData.month)}`}</h2><Part read={budget} title="this month's spending">{data => <ThisMonth budget={data} source={orgSpend} />}</Part></section>

  <section aria-labelledby="rv-spend-people" className="rv-spend-block">
   <h2 id="rv-spend-people">People</h2>
   <Part read={orgSpend} title="spending by person" restricted={<>Spending by person is shown to company owners and admins. You see your own spending{own === undefined ? "." : <>: <Usd usd={own.spentUsd} /> spent, <Usd usd={heldUsd(own)} /> held, allowance {own.limitUsd === undefined ? "not set" : <Usd usd={own.limitUsd} />}.</>}</>}>{() => people.length === 0 ? <p>No one has spent anything this month yet.</p> : <>
    {members.isError && <p role="note">Names are unavailable right now, so people are not named. Refresh to try again.</p>}
    <DataTable caption="Spending by person this month" columns={personColumns} rows={people} rowKey={row => row.id} />
    <p className="rv-muted">{overrideList !== undefined ? "A person's own allowance is shown where one is set. Everyone else shows the company default for a member." : <>The allowance shown for other people is the company default for a member{overrides > 0 ? `. ${String(overrides)} ${overrides === 1 ? "person has" : "people have"} their own allowance, which is not shown here` : ""}.</>}</p>
   </>}</Part>
  </section>

  <section aria-labelledby="rv-spend-projects" className="rv-spend-block">
   <h2 id="rv-spend-projects">Projects</h2>
   <Part read={orgSpend} title="spending by project" restricted="Spending by project is shown to company owners and admins.">{data => data.byProject.length === 0 ? <p>No project has spent anything this month yet.</p> : <>
    <DataTable caption="Spending by project this month" columns={projectColumns} rows={data.byProject} rowKey={row => row.project} />
    <p className="rv-muted">These are totals for what each project used. Projects do not get an allowance of their own; the company and member allowances apply.</p>
   </>}</Part>
  </section>

  <section aria-labelledby="rv-spend-requests" className="rv-spend-block">
   <h2 id="rv-spend-requests">Requests</h2>
   <Part read={requests} title="spending requests">{data => { const open = openRequests(data.spendRequests);return open.length === 0 ? <p>No spending requests are waiting for you.</p> : <DataTable caption="Spending requests waiting" columns={requestColumns} rows={open} rowKey={row => row.spendRequestId} />; }}</Part>
   <p><Link className="rv-spend-link" to={WAITING_PATH}>See everything waiting for people</Link></p>
   <p className="rv-muted">Requests are approved on Rovara's confirmation page, never from this list. Who can approve is checked again when a request is opened.</p>
  </section>

  <section aria-labelledby="rv-spend-limits" className="rv-spend-block">
   <h2 id="rv-spend-limits">Limits</h2>
   <Part read={settings} title="monthly limits" restricted="Monthly limits are shown to company owners and admins.">{() => settingsOk === undefined ? <p role="alert">Couldn't load monthly limits. No current amounts are shown. Refresh to try again.</p> : <>
    <dl className="rv-spend-limits">
     <div><dt>Company, each month</dt><dd>{settingsOk.orgMonthly.kind === "unlimited" ? "No limit set" : <Usd usd={dollars(settingsOk.orgMonthly.microdollars)} />}</dd></div>
     <div><dt>Each member, each month</dt><dd>{settingsOk.memberDefaultMonthly.kind === "unlimited" ? "No limit set" : <Usd usd={dollars(settingsOk.memberDefaultMonthly.microdollars)} />}</dd></div>
     <div><dt>People with their own allowance</dt><dd>{String(settingsOk.memberOverrideCount)}</dd></div>
    </dl>
    {budgetData?.org.limitUsd !== undefined && settingsOk.orgMonthly.kind === "limited" && Math.round(budgetData.org.limitUsd * 1_000_000) !== settingsOk.orgMonthly.microdollars && <p>This month's company allowance, with approved top-ups, is <Usd usd={budgetData.org.limitUsd} />.</p>}
   </>}</Part>
   <p className="rv-muted">Limits can't be changed in the web yet.</p>
  </section>

  {(role === "owner" || role === "admin") && <TaskStopEditor />}
  {budgetData !== undefined && <p className="rv-muted">Amounts are Rovara's running totals for {monthLabel(budgetData.month)} (UTC). The AI provider's own limits are what stop work.</p>}
 </section>;
}
