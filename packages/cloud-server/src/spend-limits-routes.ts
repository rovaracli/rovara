// Lead 3 B1 (DEC 254t b): monthly spending limits for one project or one person, over the company default.
//
//   GET /org/spend-limits                          the company defaults (the Budgets in the company settings), the overrides of every kind, and how many more fit
//   PUT /org/spend-limits/projects/{project}       {expectedVersion, monthlyUsd: number | null}   null removes the override (the default applies again)
//   PUT /org/spend-limits/people/{developer id}    the same, for one person
// The kinds (and their paths and list members) come from one table, SPEND_LIMIT_KINDS (company-store.ts): a new kind is an entry there, not new code here.
//
// The defaults are `settings.budgets` (PUT /org/settings writes them: a fresh step-up on EVERY write, and the company's decision rules for a
// loosening one). An override is one item per project or person in the Companies table (company-store.ts SpendLimit); the model gateway
// reads it on every call and holds the call to it (model-gateway company-caps.ts). The company's monthly cap stays the outer bound.
//
// Who: a company owner or admin (Code's company role from its access check made now, company-caller.ts; never Code's install `administrator` flag),
// reads included. Never a plain member. The company is the one Code names for the person: nothing the browser sends and no deployment-wide
// default ever names it.
// Step-up: only when the change RAISES what the project or person may spend. Raising means the new effective limit (the override, or the
// default when the override is removed; no limit counts as the highest) is above the current effective limit. Lowering needs none. The
// decision is made on a fresh read, and the write is conditional on exactly what was read (the override's version and amount, and the
// settings version the default came from), so a change that races is refused, never decided on stale data. A raise also honours the
// company's own rules for a loosening, asked as PUT /org/settings asks them: a company that forbids it (`setting.loosen` with allow false) cannot raise
// a limit here either; one that needs a second person or two approvals (the DEFAULT rules do) cannot raise one here, so the raise is refused in fixed words
// (raise the company default in Company settings, which has the second-admin flow; lowering stays free); its `deciders` are enforced (the verdict stage);
// its sign-in window applies.
// Every change is audited (`company.budget.changed`, subject `spend_limit:<kind>:<id>`, a fixed-word detail with the effective limit before and after).
// Fail closed: a limit or settings row that does not read, a failed read or write, a project Code does not know, or a person Code does not list in
// the company answers a fixed refusal.
// No answer ever echoes what the browser sent or what a lower layer said.
import { recordCloudAction } from "./audit-log.js";
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused as notCaller } from "./company-caller.js";
import { plainObject, settingsDecision } from "./company-settings.js";
import {
  CompanyStoreConflict, SPEND_LIMIT_KINDS, SPEND_LIMIT_SCOPES, SPEND_LIMIT_MICROS_MAX, companySettings, spendLimitDef,
  type CompanyStore, type SpendLimit, type SpendLimitKind, type SpendLimitScope,
} from "./company-store.js";
import { CODE_MEMBERS_PATH, MEMBER_LIST_PAGES_MAX } from "./member-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp } from "./step-up.js";

const BODY_BYTES_MAX = 1_024;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SPEND_LIMIT_WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Spending limits aren't set up on this Cloud."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change spending limits."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  ruled: refusal(403, "FORBIDDEN", "Your company's rules don't allow raising a limit."),
  secondPerson: refusal(403, "SECOND_PERSON_REQUIRED", "Raising this limit needs a second admin under your company's rules. Ask an owner to change the rules, or raise the company default in Company settings."),
  invalid: refusal(400, "CONFIG_INVALID", "Send the amount in dollars, from 0 to 1,000,000 with at most two decimals, or null to remove the limit."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  projectNotFound: refusal(404, "NOT_FOUND", "That project doesn't exist, or you can't use it."),
  personNotFound: refusal(404, "NOT_FOUND", "That person isn't in your company."),
  stale: refusal(409, "CONFLICT", "This limit changed since you opened it. Refresh and try again."),
  tooMany: refusal(409, "CONFLICT", "There are too many limits of this kind. Remove some first."),
  unreadable: refusal(503, "RUNTIME_UNAVAILABLE", "The spending limits couldn't be read. Ask an installation administrator to check them."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "Spending limits are unavailable right now. Try again."),
});
const W = SPEND_LIMIT_WORDS;
/** The audit record's detail: fixed words (which way the effective limit went, and whether the change removed the override), then the effective limit before and after in micro-dollars ("none": no limit). */
const AUDIT_WORD = Object.freeze({ raised: "raised", lowered: "lowered", removedRaised: "removed_raised", removedLowered: "removed_lowered" });
const micros = (value: number) => (Number.isFinite(value) ? String(value) : "none");

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

/** A company owner or admin, from Code's access check made now. A RouteAnswer when refused (no company, a plain member, no company backend). */
async function admin(context: RouteContext): Promise<Admin | RouteAnswer> {
  const backend = context.company;
  if (backend === undefined) return W.off;
  const who = await companyCaller(context);
  if (notCaller(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return W.forbidden;
  return { companyId: who.companyId, developerId: who.developerId, name: who.name, store: backend.store };
}
const refused = (value: Admin | RouteAnswer): value is RouteAnswer => "status" in value;

const row = (limit: SpendLimit) => ({ id: limit.id, monthlyUsd: limit.monthlyUsdMicros / 1_000_000, version: limit.version, updatedAt: limit.updatedAt, updatedBy: limit.updatedBy });

async function view(who: Admin): Promise<RouteAnswer> {
  let settings, listed;
  try {
    settings = await companySettings(who.store, who.companyId);
    if (settings === undefined) return W.unreadable;
    listed = await who.store.spendLimits(who.companyId);
  } catch { return W.unreadable; }
  const b = settings.settings.budgets;
  return ok({
    companyId: who.companyId, canChange: true, settingsVersion: settings.version,
    defaults: { companyMonthlyUsd: usd(b.companyMonthlyUsdMicros), memberMonthlyUsd: usd(b.memberMonthlyUsdMicros), projectMonthlyUsd: usd(b.projectMonthlyUsdMicros), taskUsd: usd(b.taskUsdMicros) },
    // Each kind's rows under its own list member, and its bound under the same name.
    ...Object.fromEntries(SPEND_LIMIT_KINDS.map((def) => [def.listKey, listed.limits[def.kind].map(row)])),
    partial: listed.partial, max: Object.fromEntries(SPEND_LIMIT_KINDS.map((def) => [def.listKey, def.max])),
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

/** Whether Code lists the person as a current member of the company (its own list, as this admin; Code scopes it to their company). undefined: it could not tell. */
async function personKnown(context: RouteContext, companyId: string, personId: string): Promise<boolean | undefined> {
  const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  let cursor: string | undefined;
  for (let page = 0; page < MEMBER_LIST_PAGES_MAX; page += 1) {
    let answer: unknown;
    try {
      const query = new URLSearchParams({ limit: "100", ...(cursor === undefined ? {} : { cursor }) });
      answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}?${query.toString()}`);
    } catch { return undefined; }
    if (!plain(answer) || !Array.isArray(answer["members"]) || answer["members"].length > 100 || typeof answer["more"] !== "boolean") return undefined;
    for (const row of answer["members"] as unknown[]) {
      if (!plain(row) || row["companyId"] !== companyId || typeof row["personId"] !== "string") return undefined;
      if (row["personId"] === personId && row["revokedAt"] === undefined) return true;
    }
    if (!answer["more"]) return false;
    const next = answer["cursor"];
    if (typeof next !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(next) || next === cursor) return undefined;
    cursor = next;
  }
  return undefined;
}

/** What each scope's id must be known as, and the answer when it is not. */
const KNOWN: Record<SpendLimitScope, (context: RouteContext, companyId: string, id: string) => Promise<boolean | undefined>> = {
  project: (context, _companyId, id) => projectKnown(context, id),
  person: (context, companyId, id) => personKnown(context, companyId, id),
};
const NOT_FOUND: Record<SpendLimitScope, RouteAnswer> = { project: W.projectNotFound, person: W.personNotFound };

const INFINITY = Number.POSITIVE_INFINITY;

async function change(context: RouteContext, kind: SpendLimitKind): Promise<RouteAnswer> {
  const who = await admin(context);
  if (refused(who)) return who;
  const id = context.params[0]!;
  const def = spendLimitDef(kind);
  if (!SPEND_LIMIT_SCOPES[def.scope].id.test(id)) return W.invalid;
  const body = context.body;
  if (Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BODY_BYTES_MAX) return W.tooLarge;
  if (!plainObject(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, "expectedVersion") || !Object.hasOwn(body, "monthlyUsd") || !whole(body["expectedVersion"])) return W.invalid;
  const asked = body["monthlyUsd"] === null ? null : dollarsToMicros(body["monthlyUsd"]);
  if (asked === undefined) return W.invalid;
  // Setting a limit names a project Code knows (as this person, in their company) or a person Code lists in the company. Removing one needs no
  // such check: a project or person that is gone can still have its limit cleaned up.
  if (asked !== null) {
    const known = await KNOWN[def.scope](context, who.companyId, id);
    if (known === undefined) return W.unavailable;
    if (!known) return NOT_FOUND[def.scope];
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

  const fallback = def.defaultOf(settings.settings.budgets) ?? INFINITY;
  const before = current?.monthlyUsdMicros ?? fallback;
  const after = asked ?? fallback;
  const raises = after > before;
  // Nothing changes (same effective limit, same override or none): answered without a write.
  if (after === before && (current !== undefined) === (asked !== null)) return view(who);
  if (raises) {
    // The company's own rules for a loosening, asked as PUT /org/settings asks them (company-routes.ts changeSettings): a company that forbids it can't
    // have a limit raised; one that needs a second person (or two approvals) can't have it raised here (a raise waits for a second admin only through
    // the company default in Company settings); the `deciders` are enforced by asking for the verdict; and its sign-in window applies.
    const required = settingsDecision(settings.settings, true, "requirement", who.developerId);
    if (!required.allow) return W.ruled;
    if (required.secondPerson) return W.secondPerson;
    const decision = settingsDecision(settings.settings, true, "verdict", who.developerId);
    if (!decision.allow) return W.ruled;
    if (freshStepUp(context.session.accessToken, context.now().getTime(), decision.signInMaxAgeSeconds) === undefined) return W.stepUp;
  }
  if (current === undefined) {
    // A new override: only while the company is under the bound for this kind.
    let have;
    try { have = await who.store.spendLimits(who.companyId); } catch { return W.unreadable; }
    if (have.partial || have.limits[kind].length >= def.max) return W.tooMany;
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
        subject: `spend_limit:${kind}:${id}`, ...(def.scope === "project" ? { project: id } : {}),
        detail: `${asked === null ? (raises ? AUDIT_WORD.removedRaised : AUDIT_WORD.removedLowered) : raises ? AUDIT_WORD.raised : AUDIT_WORD.lowered} from=${micros(before)} to=${micros(after)}`,
      }, context.now);
    } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action: "company.budget.changed", companyId: who.companyId })); }
  }
  return view(who);
}

/** Added to the route table with the company routes (the same Companies table). The ids in the paths are strict: anything else is no route. One PUT route per kind, from the table. */
export const SPEND_LIMIT_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/spend-limits$/u, answer: readLimits },
  ...SPEND_LIMIT_KINDS.map((def): Route => ({ method: "PUT", path: new RegExp(`^\\/org\\/spend-limits\\/${def.segment}\\/(${SPEND_LIMIT_SCOPES[def.scope].idSource})$`, "u"), answer: (context) => change(context, def.kind) })),
];
