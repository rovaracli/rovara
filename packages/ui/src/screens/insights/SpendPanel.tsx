import { useState } from "react";
import { useInsightsSpend, type InsightsOverview, type InsightsSpend } from "../../api/insights.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { Money } from "../../design/Money.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { availableUsd, barShares, heldUsd, isOverAllowance, monthLabel } from "../admin/spending-format.js";
import { recentMonths } from "./insights-format.js";
import { NotReady, Panel, Reading } from "./parts.js";

type ProjectRow = InsightsSpend["byProject"][number];
type PersonRow = NonNullable<InsightsSpend["byPerson"]>[number];
/** An amount in dollars; a non-zero amount under half a cent says so instead of reading as $0.00. */
function Usd({ usd }: { usd: number }) { return usd > 0 && usd < 0.005 ? <span className="rv-money">&lt;$0.01</span> : <Money usd={usd} />; }
function Bar({ row }: { row: ProjectRow }) {
 const { spent, held } = barShares(row);
 return <div className="rv-ins-spendbar" aria-hidden="true"><span className="rv-ins-spendbar-spent" style={{ width: `${String(spent)}%` }} /><span className="rv-ins-spendbar-held" style={{ width: `${String(held)}%` }} /></div>;
}
export function SpendPanel({ overview, person, project }: { overview: InsightsOverview; person: string | undefined; project: string | undefined }) {
 const now = Date.parse(overview.asOf), months = recentMonths(now, 6), [month, setMonth] = useState<string>(months[0]!);
 const outcomes = overview.panels.spend.outcomesStatus;
 const read = useInsightsSpend({ person, project, month, enabled: true });
 const since = overview.panels.shipped.collectingSince;
 return <Panel id="ins-spend" title="Spend vs outcomes" intro="What each project spent, and what it shipped for that money.">
  <Select label="Month" value={month} onValueChange={setMonth} options={months.map(value => ({ value, label: monthLabel(value) }))} />
  <Reading read={read} title="spending">{data => {
   const outcomeStatus = data.outcomes.status === "ready" ? outcomes : data.outcomes.status, outcomesReady = outcomeStatus === "ready";
   const columns: Column<ProjectRow>[] = [
    { key: "project", title: "Project", render: row => <VisibleText text={row.project} /> },
    { key: "spent", title: "Spent", render: row => <Usd usd={row.spentUsd} /> },
    { key: "held", title: "Held for work in progress", render: row => <Usd usd={heldUsd(row)} /> },
    { key: "limit", title: "Left of the allowance", render: row => { const left = availableUsd(row);return left === undefined ? "No limit set" : <Usd usd={left} />; } },
    { key: "people", title: "People", render: row => row.people === null ? "Not counted yet" : row.people === 1 ? "1 person" : String(row.people) },
    { key: "shipped", title: "Shipped", render: row => row.shipped === null ? "Not recorded yet" : String(row.shipped) },
    { key: "cost", title: "Cost per shipped item", render: row => row.costPerShippedUsd === null ? "Not available yet" : <Usd usd={row.costPerShippedUsd} /> },
   ];
   const people: Column<PersonRow>[] = [{ key: "person", title: "Person", render: row => <VisibleText text={row.name} /> }, { key: "spent", title: "Spent", render: row => <Usd usd={row.spentUsd} /> }, { key: "limit", title: "Allowance", render: row => row.limitUsd === undefined ? "No limit set" : <Usd usd={row.limitUsd} /> }];
   const totals = data.totals;
   return <>
    <h3>{monthLabel(data.month)}</h3>
    {totals !== undefined && <dl className="rv-ins-figures"><div><dt>Spent</dt><dd><Usd usd={totals.spentUsd} /></dd></div><div><dt>Held for work in progress</dt><dd><Usd usd={heldUsd(totals)} /></dd></div><div><dt>Left of the allowance</dt><dd>{availableUsd(totals) === undefined ? "No limit set" : <Usd usd={availableUsd(totals)!} />}</dd></div></dl>}
    {totals !== undefined && isOverAllowance(totals) && <p role="status" className="rv-ins-over">Spent and held amounts together are past the company&apos;s allowance this month.</p>}
    {!outcomesReady && <NotReady what="Shipped counts and cost per shipped item" status={outcomeStatus} collectingSince={since} now={now} />}
    {data.byProject.length === 0 ? <p>No spending is recorded for {monthLabel(data.month)} yet.</p> : <>
     <ul className="rv-ins-bars rv-ins-spendlist" aria-label="Spending by project, bars show spent and held against each allowance">{data.byProject.map(row => <li key={row.project}><span className="rv-ins-bar-label"><VisibleText text={row.project} /></span>{row.limitUsd !== undefined && <Bar row={row} />}<span className="rv-ins-bar-text"><Usd usd={row.spentUsd} /></span></li>)}</ul>
     <DataTable caption="Spending and outcomes by project" columns={columns} rows={data.byProject} rowKey={row => row.project} />
     {data.byProject.some(row => row.people === 1) && data.byPerson === undefined && <p className="rv-muted">A project with 1 person: its total is that one person&apos;s spend.</p>}
    </>}
    {data.byPerson !== undefined && <>
     <h3>By person</h3>
     {data.byPerson.length === 0 ? <p>No one has spent anything in {monthLabel(data.month)} yet.</p> : <DataTable caption="Spending by person" columns={people} rows={data.byPerson} rowKey={row => row.developerId} />}
    </>}
   </>;
  }}</Reading>
 </Panel>;
}
