import { Link } from "react-router";
import { paths } from "../paths.js";
import { Banner } from "./Banner.js";
import { Money } from "./Money.js";

/**
 * Shown above the work list when the company's budget for the month is used up (Cloud's own spend read: `remainingUsd` of contract v0's
 * OrgSpendSummaryAddition). New tasks wait in the queue; running tasks finish their current step. An administrator can open the budget settings.
 */
export function BudgetBanner({ remainingUsd, canRaise }: { remainingUsd: number; canRaise: boolean }) {
 if (!(remainingUsd <= 0)) return null;
 return <Banner tone="danger" title="This month's budget is used up" action={canRaise ? <Link className="rv-button rv-button-secondary" to={paths.admin.home + "/money/budgets"}>Raise the limit</Link> : undefined}>
  <p>{remainingUsd < 0 ? <><Money usd={-remainingUsd} /> over. </> : null}New tasks wait in the queue. Running tasks finish their current step. {canRaise ? "" : "Ask a company administrator to raise the limit."}</p>
 </Banner>;
}
