// Company domain verification: the daily re-check, run from the every-minute recovery run that every install has (no schedule of its own). Each domain is due once a day (an hour after a failed
// lookup); most runs find nothing due and read one index partition. A run looks at a few domains at most and stops starting new ones when its share of time is used.
import { recheckDueDomains, type CompanyDomainDeps, type RecheckOutcome } from "./store.js";
import { nodeTxtResolver, type TxtResolver } from "./resolver.js";

/** The most time the recovery run gives the re-check before it stops starting new lookups. One lookup in flight may take up to its own deadline more (resolver.ts). */
export const DOMAIN_RECHECK_BUDGET_MS = 3_000;
/** The most domains one run looks at. */
export const DOMAIN_RECHECK_LIMIT = 2;

let resolver: TxtResolver | undefined;

export function runCompanyDomainRecheck(deps: CompanyDomainDeps, options: { resolver?: TxtResolver; budgetMs?: number } = {}): Promise<RecheckOutcome> {
  return recheckDueDomains(deps, { resolver: options.resolver ?? (resolver ??= nodeTxtResolver()), budgetMs: options.budgetMs ?? DOMAIN_RECHECK_BUDGET_MS, limit: DOMAIN_RECHECK_LIMIT });
}
