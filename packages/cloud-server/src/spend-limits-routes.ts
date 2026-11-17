// Lead 3 B1 (DEC 254t b): monthly spending limits for one project or one person, over the company default.
//
//   GET /org/spend-limits                          the company defaults (the Budgets in the company settings), the overrides, and how many more fit
//   PUT /org/spend-limits/projects/{project}       {expectedVersion, monthlyUsd: number | null}   null removes the override (the default applies again)
//   PUT /org/spend-limits/people/{developer id}    the same, for one person
//
// The defaults are `settings.budgets` (PUT /org/settings writes them: a fresh step-up on EVERY write, and the company's decision rules for a
// loosening one). An override is one item per project or person in the Companies table (company-store.ts SpendLimit); the model gateway
// reads it on every call and holds the call to it (model-gateway company-caps.ts). The company's monthly cap stays the outer bound.
//
// Who: company admins only (Code's access check made now), reads included. Never a plain member.
// Step-up: only when the change RAISES what the project or person may spend. Raising means the new effective limit (the override, or the
// default when the override is removed; no limit counts as the highest) is above the current effective limit. Lowering needs none. The
// decision is made on a fresh read, and the write is conditional on exactly what was read (the override's version and amount, and the
// settings version the default came from), so a change that races is refused, never decided on stale data. A raise also honours the
// company's own rules: a company that forbids loosening (`setting.loosen` with allow false) cannot raise a limit here either, and its
// sign-in window applies. (Its "second person" rule is NOT applied here: see the DONE note, question 2.)
// Every change is audited (`company.budget.changed`, subject `spend_limit:<kind>:<id>`, a fixed-word detail).
// Fail closed: a limit or settings row that does not read, a failed read or write, or a project Code does not know answers a fixed refusal.
// No answer ever echoes what the browser sent or what a lower layer said.
import { recordCloudAction } from "./audit-log.js";
import { CodeError } from "./code-client.js";
import { plainObject, settingsDecision } from "./company-settings.js";
import {
  COMPANY_ID, CompanyStoreConflict, SPEND_LIMITS_MAX, SPEND_LIMIT_ID, SPEND_LIMIT_MICROS_MAX, companySettings,
  type CompanyStore, type SpendLimit, type SpendLimitKind,
} from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp } from "./step-up.js";

const BODY_BYTES_MAX = 1_024;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SPEND_LIMIT_WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Spending limits aren't set up on this Cloud."),
  noCompany: refusal(403, "FORBIDDEN", "Your sign-in doesn't belong to a company Cloud knows."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change spending limits."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  ruled: refusal(403, "FORBIDDEN", "Your company's rules don't allow raising a limit."),
  invalid: refusal(400, "CONFIG_INVALID", "Send the amount in dollars, from 0 to 1,000,000 with at most two decimals, or null to remove the limit."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  projectNotFound: refusal(404, "NOT_FOUND", "That project doesn't exist, or you can't use it."),
  stale: refusal(409, "CONFLICT", "This limit changed since you opened it. Refresh and try again."),
  tooMany: refusal(409, "CONFLICT", "There are too many limits of this kind. Remove some first."),
  unreadable: refusal(503, "RUNTIME_UNAVAILABLE", "The spending limits couldn't be read. Ask an installation administrator to check them."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Spending limits are unavailable right now. Try again."),
});
const W = SPEND_LIMIT_WORDS;
/** The audit record's detail: fixed words. */
const AUDIT_DETAIL = Object.freeze({ raised: "raised", lowered: "lowered", removed: "removed" });

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Dollars (a number with at most two decimals, 0 to 1,000,000) as whole micro-dollars; undefined for anything else. */
export function dollarsToMicros(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > SPEND_LIMIT_MICROS_MAX / 1_000_000) return undefined;
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) return undefined;
  return cents * 10_000;
}
const usd = (micros: number | null) => (micros === null ? null : micros / 1_000_000);

interface Admin { companyId: string; developerId: string; name: string; store: CompanyStore }

/** A company admin of a company Cloud knows, from Code's access check made now. A RouteAnswer when refused. */
async function admin(context: RouteContext): Promise<Admin | RouteAnswer> {
  const backend = context.company;
  if (backend === undefined) return W.off;
  const access = await context.client.access(context.session);
  const said = (access as { companyId?: unknown }).companyId;
  let companyId: string;
  if (said !== undefined) {
    if (typeof said !== "string" || !COMPANY_ID.test(said)) return W.noCompany;
    companyId = said;
  } else if (backend.companyId !== undefined && COMPANY_ID.test(backend.companyId)) companyId = backend.companyId;
  else return W.noCompany;
  if (access.administrator !== true || !/^[a-f0-9]{64}$/u.test(access.developerId)) return W.forbidden;
  return { companyId, developerId: access.developerId, name: access.displayName, store: backend.store };
}
const refused = (value: Admin | RouteAnswer): value is RouteAnswer => "status" in value;

const row = (limit: SpendLimit) => ({ id: limit.id, monthlyUsd: limit.monthlyUsdMicros / 1_000_000, version: limit.version, updatedAt: limit.updatedAt, updatedBy: limit.updatedBy });

async function view(who: Admin): Promise<RouteAnswer> {
  let settings, limits;
  try {
    settings = await companySettings(who.store, who.companyId);
    if (settings === undefined) return W.unreadable;
    limits = await who.store.spendLimits(who.companyId);
  } catch { return W.unreadable; }
  const b = settings.settings.budgets;
  return ok({
    companyId: who.companyId, canChange: true, settingsVersion: settings.version,
    defaults: { companyMonthlyUsd: usd(b.companyMonthlyUsdMicros), memberMonthlyUsd: usd(b.memberMonthlyUsdMicros), projectMonthlyUsd: usd(b.projectMonthlyUsdMicros), taskUsd: usd(b.taskUsdMicros) },
    projects: limits.projects.map(row), people: limits.people.map(row), partial: limits.partial, max: { projects: SPEND_LIMITS_MAX.project, people: SPEND_LIMITS_MAX.person },
  });
}

async function readLimits(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  return refused(who) ? who : view(who);
}

/** Whether Code knows the project for this person (Code scopes it to the person's company). Code's refusal of any kind is "no"; anything else is an outage. */
async function projectKnown(context: RouteContext, project: string): Promise<boolean | undefined> {
  try {
    await context.client.json<unknown>(context.session, `/v1/dev/client/projects/${encodeURIComponent(project)}`);
    return true;
  } catch (error) {
    if (error instanceof CodeError && (error.status === 404 || error.status === 403)) return false;
    return undefined;
  }
}

const INFINITY = Number.POSITIVE_INFINITY;

async function change(context: RouteContext, kind: SpendLimitKind): Promise<RouteAnswer> {
  const who = await admin(context);
  if (refused(who)) return who;
  const id = context.params[0]!;
  if (!SPEND_LIMIT_ID[kind].test(id)) return W.invalid;
  const body = context.body;
  if (Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BODY_BYTES_MAX) return W.tooLarge;
  if (!plainObject(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, "expectedVersion") || !Object.hasOwn(body, "monthlyUsd") || !whole(body["expectedVersion"])) return W.invalid;
  const asked = body["monthlyUsd"] === null ? null : dollarsToMicros(body["monthlyUsd"]);
  if (asked === undefined) return W.invalid;
  // Setting a limit names a project Code knows (as this person, in their company). Removing one needs no such check: a project that is gone
  // can still have its limit cleaned up.
  if (kind === "project" && asked !== null) {
    const known = await projectKnown(context, id);
    if (known === undefined) return W.unavailable;
    if (!known) return W.projectNotFound;
  }
  // A fresh read of everything the decision depends on.
  let settings, current: SpendLimit | undefined;
  try {
    settings = await companySettings(who.store, who.companyId);
    if (settings === undefined) return W.unreadable;
    current = await who.store.spendLimit(who.companyId, kind, id);
  } catch { return W.unreadable; }
  if (current !== undefined && (current.companyId !== who.companyId || current.kind !== kind || current.id !== id)) return W.unreadable;
  if (body["expectedVersion"] !== (current?.version ?? 0)) return W.stale;

  const budgets = settings.settings.budgets;
  const fallback = (kind === "project" ? budgets.projectMonthlyUsdMicros : budgets.memberMonthlyUsdMicros) ?? INFINITY;
  const before = current?.monthlyUsdMicros ?? fallback;
  const after = asked ?? fallback;
  const raises = after > before;
  // Nothing changes (same effective limit, same override or none): answered without a write.
  if (after === before && (current !== undefined) === (asked !== null)) return view(who);
  if (raises) {
    // The company's own rules: a company that forbids loosening can't raise a limit; its sign-in window applies.
    const decision = settingsDecision(settings.settings, true, "requirement", who.developerId);
    if (!decision.allow) return W.ruled;
    if (freshStepUp(context.session.accessToken, context.now().getTime(), decision.signInMaxAgeSeconds) === undefined) return W.stepUp;
  }
  if (current === undefined) {
    // A new override: only while the company is under the bound for this kind.
    let have;
    try { have = await who.store.spendLimits(who.companyId); } catch { return W.unreadable; }
    if (have.partial || (kind === "project" ? have.projects.length : have.people.length) >= SPEND_LIMITS_MAX[kind]) return W.tooMany;
  }
  const basis = { override: current === undefined ? undefined : { version: current.version, monthlyUsdMicros: current.monthlyUsdMicros }, settingsVersion: settings.version };
  try {
    if (asked === null) await who.store.removeSpendLimit(who.companyId, kind, id, basis);
    else await who.store.putSpendLimit({ companyId: who.companyId, kind, id, monthlyUsdMicros: asked, updatedAt: context.now().toISOString(), updatedBy: who.developerId }, basis);
  } catch (error) { return error instanceof CompanyStoreConflict ? W.stale : W.unavailable; }
  if (context.audit !== undefined) {
    try {
      await recordCloudAction(context.audit, {
        companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action: "company.budget.changed", via: "web",
        subject: `spend_limit:${kind}:${id}`, ...(kind === "project" ? { project: id } : {}),
        detail: asked === null ? AUDIT_DETAIL.removed : raises ? AUDIT_DETAIL.raised : AUDIT_DETAIL.lowered,
      }, context.now);
    } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action: "company.budget.changed", companyId: who.companyId })); }
  }
  return view(who);
}

/** Added to the route table with the company routes (the same Companies table). The ids in the paths are strict: anything else is no route. */
export const SPEND_LIMIT_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/spend-limits$/u, answer: readLimits },
  { method: "PUT", path: /^\/org\/spend-limits\/projects\/([a-z][a-z0-9-]{0,62})$/u, answer: (context) => change(context, "project") },
  { method: "PUT", path: /^\/org\/spend-limits\/people\/([a-f0-9]{64})$/u, answer: (context) => change(context, "person") },
];
