// Company domain verification: the daily re-check, run from the every-minute recovery run that every install has (no schedule of its own), AFTER that run's other passes and only from the time they left.
// Each claim is due once a day (an hour after a failed lookup), the first look spread over the day after it was added; most runs find nothing due and read one index partition.
//
// THROUGHPUT: at most DOMAIN_RECHECK_LIMIT claims a run, so about 2,880 looks a day for 1,440 runs. At the daily rhythm that is the most claims one install can keep current (hourly retries after failed
// lookups use the same room). An install with more companies than that, or many lookups failing, would see claims waiting past their day: see DEFERRED-CHECKS (DV-1) before a Cloud cell passes ~1,000 domains.
import { recheckDueDomains, type CompanyDomainDeps, type RecheckOutcome } from "./store.js";
import { nodeTxtResolver, type TxtResolver } from "./resolver.js";

/** The most time the recovery run gives the re-check before it stops starting new lookups. */
export const DOMAIN_RECHECK_BUDGET_MS = 3_000;
/** A lookup in flight may run to its own deadline (resolver.ts, 6 s) after the budget; the re-check starts only with this much to spare in the run. */
export const DOMAIN_RECHECK_LOOKUP_ALLOWANCE_MS = 7_000;
/** The most domains one run looks at. */
export const DOMAIN_RECHECK_LIMIT = 2;

let resolver: TxtResolver | undefined;

/** `remainingMs`: what is left of the recovery run's budget. With less than the allowance plus a second, nothing is looked at. */
export function runCompanyDomainRecheck(deps: CompanyDomainDeps, options: { remainingMs: number; resolver?: TxtResolver }): Promise<RecheckOutcome> {
  const budgetMs = Math.min(DOMAIN_RECHECK_BUDGET_MS, options.remainingMs - DOMAIN_RECHECK_LOOKUP_ALLOWANCE_MS);
  if (budgetMs < 1_000) return Promise.resolve({ checked: 0, verified: 0, lost: 0, released: 0, skipped: 0 });
  return recheckDueDomains(deps, { resolver: options.resolver ?? (resolver ??= nodeTxtResolver()), budgetMs, limit: DOMAIN_RECHECK_LIMIT });
}
