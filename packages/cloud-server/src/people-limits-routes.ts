// Lead 4 slice A6 (cost report design Feature A6, decision D2): the admin's "People and limits" read.
//
//   GET /org/people-limits[?project=<name>]    every current member's spend this month against their limit, by name; one project's people when asked
//
// Who: a company owner or admin (Code's company role from its access check made now, company-caller.ts; never Code's install `administrator` flag).
// Never a plain member. The company is the one Code names for the person: nothing the request carries (query, header, body) ever names a company,
// a month or a person, and a query member this route does not know is refused, not ignored.
//
// What it shows: per person, spend this month against the limit that applies (their own override, else the company default), as whole cents.
// What it never shows: a merged count, a task count, speed, quality, a rank or a total. The row has five fields and the server sends no other, so a
// custom client cannot build a ranking either. Rows are in NAME order only. These numbers live on this one route and this one page (design A7 rules 2 and 3).
//
// Where the numbers come from:
//   - the people: Code's company member list, as this admin (current members only; a row filed under another company refuses the whole list);
//   - the limit: Cloud's own spend limit overrides and the company default (company-store.ts), the same items the model gateway enforces;
//   - the spend: the model gateway's person-month meter rows, through a `PersonSpendReader` (gateway-meter-read.ts). The meter has one row per person
//     and month, not per project, so a project filter narrows WHICH people are listed (the people Code lists on that project); a person's spend is
//     still their whole month. Code's cost report keeps no person id and is not read here.
// Fail closed: a list, setting, override or meter row that does not read refuses the whole answer in fixed words. A person is never drawn as $0
// because their number could not be read. No answer echoes what the request carried or what a lower layer said.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused as notCaller } from "./company-caller.js";
import { SPEND_LIMIT_SCOPES, companySettings, spendLimitDef, type CompanyStore } from "./company-store.js";
import { CODE_MEMBERS_PATH, MEMBER_LIST_PAGES_MAX } from "./member-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

/** The gateway's person-month spend, in micro-dollars, for these people in one company and month. A person with no row is absent (spent nothing). Throws when it cannot say. */
export interface PersonSpendReader {
  companyMonth?(companyId: string, month: string): Promise<{ spentMicros: number; reservedMicros: number; committed: number; provisionalMicros?: number } | undefined>;
  provisionalTotal?(companyId: string, month: string): Promise<number | undefined>;
  monthSpend(companyId: string, month: string, personIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

type Words = Readonly<{ status: number; body: Readonly<{ error: Readonly<{ code: string; message: string }> }> }>;
const refusal = (status: number, code: string, message: string): Words => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const PEOPLE_LIMITS_WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "People and limits isn't set up on this Cloud."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company owner or admin can see people's spending."),
  invalid: refusal(400, "CONFIG_INVALID", "That request isn't in the shape this page sends."),
  projectNotFound: refusal(404, "NOT_FOUND", "That project doesn't exist, or you can't use it."),
  /** Code's own words when it refuses this person a project's members (developer-routes.ts CLIENT_MEMBERS_NOT_ALLOWED, Code #1022). */
  membersNotAllowed: refusal(403, "FORBIDDEN", "Only a company owner or admin, or the project's admin, can see and change its members."),
  unreadable: refusal(503, "RUNTIME_UNAVAILABLE", "The company's people and limits couldn't be read just now. Try again."),
  spendUnreadable: refusal(503, "RUNTIME_UNAVAILABLE", "People's spending couldn't be read just now. Nothing is shown rather than a wrong amount. Try again."),
  tooLong: refusal(503, "RUNTIME_UNAVAILABLE", "Your company has too many members to show here."),
});
const W = PEOPLE_LIMITS_WORDS;

const PERSON_ID = /^[a-f0-9]{64}$/u;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const NAME_MAX = 200;
const NAME_UNSAFE = /[\p{Cc}\p{Cf}]/u;
const PAGE = 100;
/** The most people one answer holds (Code's list is bounded the same way) and the most projects listed for the filter. */
const PEOPLE_MAX = MEMBER_LIST_PAGES_MAX * PAGE;
const PROJECTS_MAX = 200;
const MICROS_PER_CENT = 10_000;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface Listed { developerId: string; name: string }

/** Every current member Code lists for this company, or a refusal. Removed people are left out; a row filed under another company refuses the list. */
async function companyPeople(context: RouteContext, companyId: string): Promise<Listed[] | RouteAnswer> {
  const people: Listed[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MEMBER_LIST_PAGES_MAX) return W.tooLong;
    let answer: unknown;
    try {
      const query = new URLSearchParams({ limit: String(PAGE), ...(cursor === undefined ? {} : { cursor }) });
      answer = await context.client.json<unknown>(context.session, `${CODE_MEMBERS_PATH}?${query.toString()}`);
    } catch (error) {
      if (!(error instanceof CodeError)) throw error;
      return W.unreadable;
    }
    if (!plain(answer) || !Array.isArray(answer["members"]) || answer["members"].length > PAGE || typeof answer["more"] !== "boolean") return W.unreadable;
    for (const row of answer["members"] as unknown[]) {
      if (!plain(row) || row["companyId"] !== companyId || typeof row["personId"] !== "string" || !PERSON_ID.test(row["personId"])) return W.unreadable;
      if (row["revokedAt"] !== undefined || seen.has(row["personId"])) continue;
      seen.add(row["personId"]);
      const given = typeof row["name"] === "string" ? row["name"].trim() : "";
      people.push({ developerId: row["personId"], name: given !== "" && Array.from(given).length <= NAME_MAX && !NAME_UNSAFE.test(given) ? given : "Unnamed person" });
    }
    if (!answer["more"]) return people;
    const next = answer["cursor"];
    if (typeof next !== "string" || !CURSOR.test(next) || next === cursor) return W.unreadable;
    cursor = next;
  }
}

/** The ids Code lists on one project (as this admin), or the not-found / unreadable answer. */
async function projectPeople(context: RouteContext, project: string): Promise<Set<string> | RouteAnswer> {
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, `/v1/dev/client/projects/${encodeURIComponent(project)}/members`);
  } catch (error) {
    if (!(error instanceof CodeError)) throw error;
    // Code's 403 is its own refusal of this person for this project's members (Code #1022 CLIENT_MEMBERS_NOT_ALLOWED), said in Code's fixed words; never "no such project".
    if (error.status === 403) return W.membersNotAllowed;
    return error.status === 404 ? W.projectNotFound : W.unreadable;
  }
  if (!plain(answer) || !Array.isArray(answer["members"]) || answer["members"].length > PEOPLE_MAX) return W.unreadable;
  const ids = new Set<string>();
  for (const row of answer["members"] as unknown[]) {
    if (!plain(row) || typeof row["developerId"] !== "string" || !PERSON_ID.test(row["developerId"])) return W.unreadable;
    ids.add(row["developerId"]);
  }
  return ids;
}

/** The company's person overrides in micro-dollars by person, or undefined when they do not read as exactly this company's. */
async function personOverrides(store: CompanyStore, companyId: string): Promise<Map<string, number> | undefined> {
  const kind = SPEND_LIMIT_KINDS_PERSON;
  const listed = await store.spendLimits(companyId);
  if (listed.partial) return undefined;
  const found = new Map<string, number>();
  for (const limit of listed.limits[kind]) {
    if (limit.companyId !== companyId || limit.kind !== kind || !SPEND_LIMIT_SCOPES.person.id.test(limit.id) || !whole(limit.monthlyUsdMicros)) return undefined;
    found.set(limit.id, limit.monthlyUsdMicros);
  }
  return found;
}
const SPEND_LIMIT_KINDS_PERSON = "person_month" as const;
// The kind's own table entry says it is a person's: keep this module honest if the table changes.
if (spendLimitDef(SPEND_LIMIT_KINDS_PERSON).scope !== "person") throw new Error("person_month is no longer a person limit");

const byName = (a: Listed, b: Listed): number => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name, "en") || (a.developerId < b.developerId ? -1 : a.developerId > b.developerId ? 1 : 0);

/** The one `project` member, or undefined for none; `null` when the query is anything this route does not take. */
function projectOf(query: URLSearchParams): string | undefined | null {
  const keys = [...query.keys()];
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== "project") return null;
  const value = query.get("project");
  return value !== null && PROJECT_NAME.test(value) ? value : null;
}

async function readPeopleLimits(context: RouteContext): Promise<RouteAnswer> {
  // Who first: a plain member learns nothing, not even whether this Cloud has the feature.
  const who = await companyCaller(context);
  if (notCaller(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return W.forbidden;
  const backend = context.company;
  const meter = backend?.peopleSpend;
  if (backend === undefined || meter === undefined) return W.off;
  const project = projectOf(context.query);
  if (project === null) return W.invalid;

  const listed = await companyPeople(context, who.companyId);
  if (!Array.isArray(listed)) return listed;
  let shown = listed;
  if (project !== undefined) {
    const onProject = await projectPeople(context, project);
    if (!(onProject instanceof Set)) return onProject;
    // Only people who are also this company's members: Code's project list is never trusted to name them.
    shown = listed.filter((person) => onProject.has(person.developerId));
  }

  let defaultMicros: number | null, overrides: Map<string, number> | undefined;
  try {
    const settings = await companySettings(backend.store, who.companyId);
    if (settings === undefined) return W.unreadable;
    defaultMicros = spendLimitDef(SPEND_LIMIT_KINDS_PERSON).defaultOf(settings.settings.budgets);
    overrides = await personOverrides(backend.store, who.companyId);
  } catch { return W.unreadable; }
  if (overrides === undefined || (defaultMicros !== null && !whole(defaultMicros))) return W.unreadable;

  const month = context.now().toISOString().slice(0, 7);
  const ids = shown.map((person) => person.developerId);
  let spent: ReadonlyMap<string, number>;
  try { spent = ids.length === 0 ? new Map() : await meter.monthSpend(who.companyId, month, ids); } catch { return W.spendUnreadable; }
  const asked = new Set(ids);
  const spentMicros = (id: string): number | undefined => {
    const value = spent.get(id);
    return value === undefined ? 0 : whole(value) ? value : undefined;
  };
  for (const [id, value] of spent) if (asked.has(id) && !whole(value)) return W.spendUnreadable;

  const people = [...shown].sort(byName).map((person) => {
    const own = overrides.get(person.developerId);
    const limit = own ?? defaultMicros;
    return {
      developerId: person.developerId, name: person.name,
      // Spend rounds up to the cent (never understated), a limit rounds down (never overstated).
      spentCents: Math.ceil(spentMicros(person.developerId)! / MICROS_PER_CENT),
      limitCents: limit === null ? null : Math.floor(limit / MICROS_PER_CENT),
      limitSource: own !== undefined ? "own" as const : defaultMicros !== null ? "company_default" as const : "none" as const,
    };
  });
  const projects = who.access.projects.flatMap((entry) => (typeof entry?.name === "string" && PROJECT_NAME.test(entry.name) ? [entry.name] : [])).sort().slice(0, PROJECTS_MAX);
  return { status: 200, body: { month, ...(project === undefined ? {} : { project }), projects, people } };
}

export const PEOPLE_LIMITS_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/people-limits$/u, answer: readPeopleLimits },
];
