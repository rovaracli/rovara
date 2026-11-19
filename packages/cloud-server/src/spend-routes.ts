// Company Spending uses the gateway's enforced month, with the existing read-only meter permission.
// The company and role come only from Code's fresh access check; browser selectors are refused.
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { companySettings } from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
const failure = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const unavailable = () => failure(503, "RUNTIME_UNAVAILABLE", "Company spending is unavailable right now. Try again.");
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
async function spending(context: RouteContext): Promise<RouteAnswer> {
 const who = await companyCaller(context);
 if (refused(who)) return who;
 if (!isCompanyAdmin(who.companyRole)) return failure(403, "FORBIDDEN", "Only a company owner or admin can view company spending.");
 if (context.query.size !== 0) return failure(400, "CONFIG_INVALID", "This page does not accept spending selectors.");
 const backend = context.company, meter = backend?.peopleSpend;
 if (backend === undefined || meter?.companyMonth === undefined) return unavailable();
 const month = context.now().toISOString().slice(0, 7);
 try {
  const settings = await companySettings(backend.store, who.companyId);
  if (settings === undefined) return unavailable();
  const totals = await meter.companyMonth(who.companyId, month);
  if (context.now().toISOString().slice(0, 7) !== month || ![totals.spentMicros, totals.reservedMicros, totals.committed].every(whole) || (totals.provisionalMicros !== undefined && !whole(totals.provisionalMicros))) return unavailable();
  const limit = settings.settings.budgets.companyMonthlyUsdMicros;
  return { status: 200, body: {
   month, spentThisMonthUsd: totals.spentMicros / 1_000_000, heldUsd: totals.reservedMicros / 1_000_000,
   ...(limit === null ? {} : { limitUsd: limit / 1_000_000, remainingUsd: (limit - totals.committed) / 1_000_000 }),
   ...(totals.provisionalMicros === undefined ? {} : { provisionalMicros: totals.provisionalMicros }),
  } };
 } catch { return unavailable(); }
}
export const SPEND_ROUTES: Route[] = [{ method: "GET", path: /^\/org\/spend$/u, answer: spending }];
