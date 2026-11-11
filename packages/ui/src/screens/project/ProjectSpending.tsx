import "../admin/spending.css";
import { ApiError } from "../../api/errors.js";
import { useProjectSpend } from "../../api/spending.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { Skeleton } from "../../design/Skeleton.js";
import { availableUsd, barShares, heldUsd, isOverAllowance, monthLabel } from "../admin/spending-format.js";

/** An amount in dollars; a non-zero amount under half a cent says so instead of reading as $0.00 (as the company Spending page does). */
function Usd({ usd }: { usd: number }) { return usd > 0 && usd < 0.005 ? <span className="rv-money">&lt;$0.01</span> : <Money usd={usd} />; }

/**
 * The project's Spending tab (switch `rovara.spending` = "v2", and the server saying this person may see the project's spend: `you.canViewSpend`). One project's month: spent, held and what is left,
 * from `GET /v1/app/projects/{p}/spend`. Totals only: the server gives no person rows and none are shown. The formulas are the company Spending page's own (`spending-format.ts`): held is committed
 * minus spent, never below zero; left is the limit minus committed, never below zero, and only where the read gives a limit.
 */
export function ProjectSpending({ project }: { project: string }) {
 const read = useProjectSpend(project, true);
 if (read.isPending) return <Skeleton label="Loading this project's spending" />;
 if (read.isError) {
  const refused = read.error instanceof ApiError && (read.error.status === 403 || read.error.status === 404);
  if (refused) return <section className="rv-project-section" aria-label="Spending"><p role="note">You can't see this project's spending. It is shown to the project's maintainers.</p></section>;
  return <section className="rv-project-section" aria-label="Spending"><p role="alert">Couldn't load this project's spending. No amounts are shown.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 }
 const figures = read.data, left = availableUsd(figures), { spent, held } = barShares(figures);
 return <section className="rv-project-section rv-project-spending" aria-labelledby="rv-project-spend-title">
  <h2 id="rv-project-spend-title">Spending, {monthLabel(figures.month)}</h2>
  <div className="rv-spend-card rv-surface">
   <dl className="rv-spend-figures">
    <div><dt>Spent</dt><dd><Usd usd={figures.spentUsd} /></dd></div>
    <div><dt>Held for work in progress</dt><dd><Usd usd={heldUsd(figures)} /></dd></div>
    <div><dt>Left</dt><dd>{left === undefined ? "No limit set" : <Usd usd={left} />}</dd></div>
   </dl>
   {figures.limitUsd === undefined ? <p>No allowance is set for this project, so there is nothing to measure against.</p> : <>
    <div className="rv-spend-bar" aria-hidden="true"><span className="rv-spend-bar-spent" style={{ width: `${String(spent)}%` }} /><span className="rv-spend-bar-held" style={{ width: `${String(held)}%` }} /></div>
    <p className="rv-spend-legend"><span className="rv-spend-key rv-spend-key-spent" aria-hidden="true" /> Spent <span className="rv-spend-key rv-spend-key-held" aria-hidden="true" /> Held <span>of the project's allowance of <Usd usd={figures.limitUsd} /></span></p>
    {isOverAllowance(figures) && <p role="status" className="rv-spend-over">Spent and held amounts together are past this project's allowance this month.</p>}
   </>}
   <p className="rv-muted">Held is money set aside for AI calls that have not finished yet. Left is the allowance minus what was spent and what is held. These are totals for the project; what each person spent is not shown here.</p>
  </div>
  <p className="rv-muted">Amounts are Rovara's running totals for {monthLabel(figures.month)} (UTC). The AI provider's own limits are what stop work.</p>
 </section>;
}
