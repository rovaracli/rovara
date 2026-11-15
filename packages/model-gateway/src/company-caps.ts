import type { Caps, CapsScope, CapsSource } from "./caps.js";
import { GATEWAY_COMPANY_BUDGET_FIELDS, GATEWAY_COMPANY_BUDGET_MAX, GATEWAY_COMPANY_LEARNING_BUDGET_FIELD, GATEWAY_COMPANY_LESSONS_GATE, GATEWAY_COMPANY_SETTINGS } from "./deploy.js";
import type { Dynamo } from "./dynamo.js";
import type { LessonsSwitch } from "./learning-route.js";
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
 * kind"), always under the company's monthly cap. The learning cap (`learningMonthlyUsdMicros`, DEC 226) rides along in `learningMonth` for the
 * learning route only; absent in an older row, it is left out. A row that is not this company's, or a budget that is not null or a whole number of micro-dollars up to
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
    // The learning cap (DEC 226): whole micro-dollars, or absent in an older row (the learning default applies). Anything else refuses.
    const learning = budgets[GATEWAY_COMPANY_LEARNING_BUDGET_FIELD];
    if (learning !== undefined && !(whole(learning) && learning <= GATEWAY_COMPANY_BUDGET_MAX)) return UNAVAILABLE;
    return {
      task: task ?? NO_CAP,
      projectMonth: project ?? NO_CAP,
      ...(member === null || member === undefined ? {} : { personMonth: member }),
      companyMonth: company,
      ...(learning === undefined ? {} : { learningMonth: learning as number }),
    };
  }
}

/**
 * The company's lessons switch (DEC 226), from the same company backend settings item the budgets come from (#52): on only when
 * `settings.featureGates.lessons` is exactly true on this company's own row. Fail closed: no row, another company's row, no gate,
 * or any other value is off. The read is strongly consistent, so an admin's "off" applies to the very next learning call. A failed
 * read throws (the learning route answers 503 and sends nothing). Turning a gate on is a loosening change in the backend, so it
 * goes through the company's decision rules there.
 */
export class CompanyLessonsSwitch implements LessonsSwitch {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async isOn(cid: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof cid !== "string" || !COMPANY.test(cid)) return false;
    const item = await this.db.get(this.table, { pk: `${GATEWAY_COMPANY_SETTINGS.partitionPrefix}${cid}`, sk: GATEWAY_COMPANY_SETTINGS.sortKey }, { consistent: true, ...(signal === undefined ? {} : { signal }) });
    if (item === undefined || item.companyId !== cid) return false;
    const gates = record(record(item.settings)?.featureGates);
    return gates !== undefined && Object.hasOwn(gates, GATEWAY_COMPANY_LESSONS_GATE) && gates[GATEWAY_COMPANY_LESSONS_GATE] === true;
  }
}
