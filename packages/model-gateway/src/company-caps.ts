import type { Caps, CapsScope, CapsSource } from "./caps.js";
import { GATEWAY_COMPANY_BUDGET_FIELDS, GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_SETTINGS } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";

/**
 * The caps a call is held to, read from the Cloud company backend's budgets (deploy.ts GATEWAY_COMPANY_SETTINGS): the company's
 * monthly cap, each member's monthly cap, each project's monthly cap and each task's cap, in micro-dollars, null for "no cap of
 * this kind". The backend's admin API (PUT /org/settings) writes them; the gateway only reads, on every call, so a lowered cap
 * applies to the next call.
 *
 * A company with no settings row, or with no company monthly cap (null), has set no ceiling: its calls are refused (503 "model
 * access unavailable") rather than run uncapped on Rovara's provider key. The backend's default settings hold every budget null,
 * so saving any other setting must not open unlimited spend; the other three nulls keep the backend's meaning ("no cap of this
 * kind"), always under the company's monthly cap. A row that is not this company's, or a budget that is not null or a whole number of micro-dollars up to
 * the backend's own ceiling, refuses the same way. A failed read throws (the call stops before anything is reserved or sent).
 */
export const NO_CAP = Number.MAX_SAFE_INTEGER;
/** What `validCaps` refuses: the server answers 503 and sends nothing. */
const UNAVAILABLE = Object.freeze({}) as unknown as Caps;

export class CompanyBudgetCaps implements CapsSource {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> {
    if (record(scope) === undefined || typeof scope.cid !== "string" || !COMPANY.test(scope.cid)) return UNAVAILABLE;
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${scope.cid}`, sk: GATEWAY_COMPANY_SETTINGS.sortKey }, { consistent: false, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined || item.companyId !== scope.cid) return UNAVAILABLE;
    const budgets = record(record(item.settings)?.budgets);
    if (budgets === undefined) return UNAVAILABLE;
    const value = (name: typeof GATEWAY_COMPANY_BUDGET_FIELDS[number]): number | null | undefined => {
      const v = budgets[name];
      return v === null ? null : whole(v) && v <= GATEWAY_COMPANY_BUDGET_MAX ? v : undefined;
    };
    const [company, member, project, task] = GATEWAY_COMPANY_BUDGET_FIELDS.map(value);
    if ([company, member, project, task].some((v) => v === undefined) || company === null || company === undefined) return UNAVAILABLE;
    return {
      task: task ?? NO_CAP,
      projectMonth: project ?? NO_CAP,
      ...(member === null || member === undefined ? {} : { personMonth: member }),
      companyMonth: company,
    };
  }
}
