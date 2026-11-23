import type { ReactNode } from "react";
import { Link } from "react-router";
import { isNotConnected, spendSummary } from "../../api/admin-company.js";
import { Banner } from "../../design/Banner.js";
import { Money } from "../../design/Money.js";
import { PageHeader } from "../../design/PageHeader.js";
import { visibleText } from "../../design/VisibleText.js";
import { HeldState } from "../../design/HeldState.js";
import { useOrgSpendRead } from "../admin/spending/SpendingSummary.js";
import { GatewayReadinessBanner, useGatewayReadiness } from "../admin/spending/GatewayReadiness.js";
import { CompanyRepeatsLine } from "../project/lessons/RepeatsLine.js";
import { useCompanyReadScope } from "./ReadEntry.js";
import { ReadState, shownFacts } from "./ReadState.js";
import { Chevron, ReadSection, Rows } from "./parts.js";
import { membersReader, useCompanyRead } from "./read-model.js";

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
const names = (list: readonly string[]) => list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]!}`;

function Destination({ to, label, title, children }: { to: string; label: string; title: string; children: ReactNode }) {
 return <li><Link aria-label={label} to={to}><div><h3>{title}</h3><p>{children}</p></div><Chevron /></Link></li>;
}

/** This month's money, read from the same spending read the Spending page uses; never an invented amount. */
function MoneyLine() {
 const spend = useOrgSpendRead(), summary = spend.data === undefined ? undefined : spendSummary(spend.data);
 if (spend.isPending) return <span>Reading this month&apos;s spending</span>;
 if (!spend.isError && spend.data?.empty === true) return <span>No AI spending recorded yet this month</span>;
 if (summary === undefined || summary.state === "unknown") return isNotConnected(spend.error) || summary?.state === "unknown" ? <span data-testid="not-connected">Spending numbers aren&apos;t connected yet</span> : <span role="alert" data-testid="spend-error">Couldn&apos;t load spending.</span>;
 return <span data-testid="overview-spend">{summary.spentUsd === undefined ? "Spent this month: unavailable" : <><Money usd={summary.spentUsd} /> spent this month</>}
  {summary.limitUsd === undefined ? " · no company limit is set" : <> of <Money usd={summary.limitUsd} /></>}
  {summary.remainingUsd !== undefined && summary.limitUsd !== undefined && (summary.remainingUsd < 0 ? <> · <Money usd={-summary.remainingUsd} /> over</> : <> · <Money usd={summary.remainingUsd} /> left</>)}</span>;
}
function OverBudget() {
 const spend = useOrgSpendRead(), summary = spend.data === undefined ? undefined : spendSummary(spend.data);
 if (summary?.state !== "over") return null;
 return <Banner tone="danger" title="This month's budget is used up" action={<Link className="rv-button rv-button-secondary" to="/app/admin/money/budgets">Open Spending</Link>}><p>New tasks wait in the queue. Running tasks finish their current step.</p></Banner>;
}

export function CompanyOverviewReadScreen() {
// The company pages list does not wait for the member read (like the page it replaces, the money line has its own read); the people count appears only when the member read is confirmed.
 const scope = useCompanyReadScope(), members = useCompanyRead(scope, "members", "/v1/app/org/members", membersReader), readiness = useGatewayReadiness();
 const known = shownFacts(members).data;
 return <ReadState read={members} label="Company overview" code="COMPANY-HOME-READ-FAILED"
  header={(data, readAt) => {
   const owners = data?.members.filter(member => member.role === "owner").map(member => visibleText(member.name)) ?? [];
   const meta = data === undefined ? undefined : [owners.length > 0 ? `Owners: ${names(owners)}` : undefined, people(data.members.length), readAt === undefined ? undefined : `Read\u00a0from\u00a0Rovara\u00a0${readAt}`].filter(Boolean).join(" · ");
   return <PageHeader focusOnMount title={scope.company} {...(meta === undefined ? {} : { meta })} />;
  }}
  before={<><GatewayReadinessBanner readiness={readiness} /><OverBudget /><CompanyRepeatsLine enabled={!members.isPending} /></>}
  after={<>  <ReadSection title="Company pages">
   <Rows label="Company destinations">
    <Destination to="/app/admin/people" label="Open People" title="People">{known === undefined ? "Roles and project access" : <><span data-testid="overview-people">{people(known.members.length)}</span> · {known.members.filter(member => member.role === "owner" || member.role === "admin").length} owners and admins · roles and project access</>}</Destination>
    <Destination to="/app/admin/money/budgets" label="Open Spending" title="Money"><MoneyLine /> · limits, who pays, the report</Destination>
    <Destination to="/app/admin/connections" label="Open Connections" title="Connections">GitHub, Slack, Linear, AI provider</Destination>
    <Destination to="/app/admin/how-we-work" label="Open How we work" title="Rules">How we work: company defaults that apply to every project</Destination>
    <Destination to="/app/admin/audit" label="Open company audit" title="Audit">Who changed what</Destination>
    <Destination to="/app/admin/settings" label="Open company settings" title="Settings">Company rules, who may start work and nightly upkeep</Destination>
    <Destination to="/app/agents" label="Open Agents" title="Agents">A read-only directory of what runs {visibleText(scope.company)}&apos;s tasks</Destination>
   </Rows>
   <p className="rv-car-note">Each fact is read from the page it opens. Nothing is edited on this page. Every company page is also in the menu.</p>
  </ReadSection>
 </>}>{() => <>
  <ReadSection title="Needs an owner or admin">
   <Rows label="Needs an owner or admin"><li aria-disabled="true"><div><h3>Open items for this company</h3><p>Rovara can&apos;t show what is waiting on an owner or admin yet.</p></div><HeldState /></li></Rows>
   <p className="rv-car-note">Decisions on tasks are not here. They are in Inbox, where Company-wide shows everyone&apos;s.</p>
  </ReadSection>
 </>}</ReadState>;
}
