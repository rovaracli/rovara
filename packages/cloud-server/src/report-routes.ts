// The admin portal's "Cost and time" report (design: designs-2026-11-17/cost-report-and-linear-parity.md, Feature A, slice A3). Two routes a company owner or admin reads:
//
//   GET /v1/app/org/report                          the totals, then the tasks grouped by feature and by project
//   GET /v1/app/org/report/features/{featureId}     one feature (or `none`, the tasks with no feature): its numbers and its tasks
//
// Cloud only reads and groups. The rows are Rovara Code's report read (Code PR #913, contract packages/contracts/src/cost-report.ts there), one row per task, asked as the signed-in person
// with their own token:
//
//   GET /v1/app/org/report/tasks?from=&to=&project=&origin=&state=&path=&cursor=&limit=200   (oldest start first; `next` and `hasMore`; Code decides who may and which company)
//   GET /v1/app/org/report/features                                                         (the feature names and states; optional: a Code without it gives "Unnamed feature")
//
// Who and which company: Code's access check now (company-caller.ts), never a parameter, header or cookie. A person who is not a company owner or admin is
// refused here without asking Code for a row; Code checks again on its own route and its refusal is one fixed sentence here (what Code worded is never echoed).
// Nothing the browser sends names a company: the query below keeps six named filters and drops everything else, so it is never forwarded.
//
// What this module never does:
//   - add a person to a row or an answer (`requesterId`, and anything not named in `readRow`, is dropped), rank people, or send a per-person number;
//   - turn token counts into money: the cost is Code's `costMicros` from the ledger, added up as integers and sent as whole cents;
//   - draw a missing number as zero: an unpriced call is counted (`unpricedCalls`) and the total is marked a floor (`costIsFloor`);
//   - return part of a range: more rows than MAX_ROWS, a repeated cursor or one unreadable row refuses the whole answer, in fixed words.
// The wait split and send-backs (slice A4) are not in version 0: Code's rows may carry them, and they are dropped here.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

/** Code's company report routes (Code PR #913, COMPANY_REPORT_TASKS_PATH and COMPANY_REPORT_FEATURES_PATH in its contracts). */
export const CODE_REPORT_TASKS_PATH = "/v1/app/org/report/tasks";
export const CODE_REPORT_FEATURES_PATH = "/v1/app/org/report/features";

/** Code's page size (REPORT_PAGE_MAX), the most tasks and the most calls to Code one answer reads. Past either the whole range is refused, never a part of it. A call looks at up to 1,000 tasks and may give fewer. */
export const REPORT_PAGE_ROWS = 200;
/** "All time" has no `from` of its own; Code needs one on the first call. */
const ALL_TIME_FROM = "1970-01-01T00:00:00.000Z";
export const REPORT_ROWS_MAX = 5_000;
export const REPORT_PAGES_MAX = 50;
/** The tasks one feature detail answer lists; the totals above them count every task. */
export const FEATURE_TASKS_MAX = 500;
/** The id of the group of tasks with no feature. A feature's own id is never this. */
export const NO_FEATURE_ID = "none";

const refusal = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
/** Every answer these routes give other than success. Fixed words only: nothing the request carried and nothing Code worded is echoed. */
export const REPORT_WORDS = Object.freeze({
  notAdmin: refusal(403, "FORBIDDEN", "Only a company owner or admin can read the cost report."),
  badFilter: refusal(400, "CONFIG_INVALID", "That filter isn't one this page offers."),
  notFound: refusal(404, "NOT_FOUND", "That feature doesn't exist, or you can't see it."),
  notConnected: refusal(501, "NOT_ON_CODE_YET", "The cost report isn't connected to Rovara Code yet."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The cost report couldn't be read just now. Try again."),
  unreadable: refusal(502, "RUNTIME_UNAVAILABLE", "Rovara Code sent a cost report Cloud couldn't read."),
  tooLarge: refusal(422, "RANGE_TOO_LARGE", "That range has too many tasks to add up. Choose a shorter date range."),
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The filters

export const ORIGINS = ["linear", "jira", "slack", "web", "tool", "other"] as const;
export const PATHS = ["quick", "full"] as const;
export const TASK_STATES = ["open", "merged", "closed", "failed"] as const;
/** The state filter offers three words; "closed" also takes a task that failed (the report does not hide failed work, it files it with the closed ones). */
export const STATE_FILTERS = ["open", "merged", "closed"] as const;
export const FEATURE_SOURCES = ["moved", "chosen", "tracker", "inherited", "confirmed_at_plan"] as const;
type Origin = (typeof ORIGINS)[number];
type TaskPath = (typeof PATHS)[number];
type TaskState = (typeof TASK_STATES)[number];
type StateFilter = (typeof STATE_FILTERS)[number];
type FeatureSource = (typeof FEATURE_SOURCES)[number];

export interface ReportFilters { from?: string; to?: string; project?: string; origin?: Origin; state?: StateFilter; path?: TaskPath }

const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/u;
/** Code's feature ids (FeatureIdSchema) and task ids (uuids). */
export const FEATURE_ID = /^ft_[a-f0-9]{20}$/u;
export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const NAME_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** One task's cost can be at most $1,000,000: with at most 5,000 tasks the sum stays a safe integer. */
const MAX_TASK_MICROS = 1_000_000_000_000;
const TITLE_MAX = 120, PROJECT_MAX = 200;
export const FEATURE_NAME_MAX = 80;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isInstant = (value: string): boolean => INSTANT.test(value) && !Number.isNaN(Date.parse(value));

/** The six filters of the page from a query, or undefined for a value the page does not offer. Any other name (a company, a person, a limit) is dropped and never forwarded. */
export function parseReportFilters(query: URLSearchParams): ReportFilters | undefined {
  const one = (name: string): string | undefined | null => {
    const all = query.getAll(name);
    return all.length === 0 ? undefined : all.length === 1 && all[0] !== "" ? all[0]! : null;
  };
  const from = one("from"), to = one("to"), project = one("project"), origin = one("origin"), state = one("state"), path = one("path");
  if ([from, to, project, origin, state, path].includes(null)) return undefined;
  if ((from !== undefined && !isInstant(from!)) || (to !== undefined && !isInstant(to!))) return undefined;
  if (from !== undefined && to !== undefined && Date.parse(from!) > Date.parse(to!)) return undefined;
  if (project !== undefined && (Array.from(project!).length > PROJECT_MAX || NAME_UNSAFE.test(project!))) return undefined;
  if (origin !== undefined && !oneOf(ORIGINS, origin)) return undefined;
  if (state !== undefined && !oneOf(STATE_FILTERS, state)) return undefined;
  if (path !== undefined && !oneOf(PATHS, path)) return undefined;
  return {
    ...(from === undefined ? {} : { from: new Date(from!).toISOString() }), ...(to === undefined ? {} : { to: new Date(to!).toISOString() }), ...(project === undefined ? {} : { project: project! }),
    ...(origin === undefined ? {} : { origin: origin }), ...(state === undefined ? {} : { state: state }), ...(path === undefined ? {} : { path: path }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Code's rows, read strictly

/** One task, as the report reads it. Only what the pages draw: no person, no wait split. */
export interface ReportTask {
  taskId: string; project: string; title: string; origin: Origin; path?: TaskPath; state: TaskState;
  feature?: { id: string; source: FeatureSource };
  startedAt: number; firstPrAt?: number; endedAt?: number;
  prsOpened: number; prsMerged: number; prLinks: string[];
  costMicros: number; unpricedCalls: number;
}
export interface ReportFeature { id: string; name: string; state?: "open" | "done"; trackerLink?: { tracker: string; id: string; url?: string } }

const isCount = (value: unknown, max = 1_000_000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
/** Text a person or a tracker wrote, made inert: control and invisible characters out, cut to `max` characters. Undefined when nothing readable is left. */
function inert(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim());
  return cleaned.length === 0 ? undefined : cleaned.slice(0, max).join("");
}
/** A plain https link (no user, no password, no spaces, at most 300 characters), or undefined. */
export function plainHttpsLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300 || /[\s\p{Cc}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.includes(".") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
const instantOf = (value: unknown): number | undefined => (typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : undefined);

/**
 * One of Code's rows, or undefined when any named field is the wrong shape (the whole answer is then refused). Dropped on purpose: `requesterId` and every
 * field not named here. A row that names a company must name the caller's own.
 */
export function readRow(raw: unknown, companyId: string): ReportTask | undefined {
  if (!plain(raw)) return undefined;
  if (Object.hasOwn(raw, "companyId") && raw["companyId"] !== companyId) return undefined;
  const taskId = raw["taskId"], title = inert(raw["title"], TITLE_MAX), project = typeof raw["project"] === "string" ? inert(raw["project"], PROJECT_MAX) : undefined;
  if (typeof taskId !== "string" || !TASK_ID.test(taskId) || project === undefined) return undefined;
  const { origin, path, state } = raw;
  if (!oneOf(ORIGINS, origin) || !oneOf(TASK_STATES, state) || (path !== undefined && !oneOf(PATHS, path))) return undefined;
  const startedAt = instantOf(raw["startedAt"]);
  if (startedAt === undefined) return undefined;
  const firstPrAt = raw["firstPrAt"] === undefined ? undefined : instantOf(raw["firstPrAt"]), endedAt = raw["endedAt"] === undefined ? undefined : instantOf(raw["endedAt"]);
  if ((raw["firstPrAt"] !== undefined && firstPrAt === undefined) || (raw["endedAt"] !== undefined && endedAt === undefined)) return undefined;
  if (!isCount(raw["prsOpened"], 1_000) || !isCount(raw["prsMerged"], 1_000) || !isCount(raw["costMicros"], MAX_TASK_MICROS) || !isCount(raw["unpricedCalls"], 100_000_000)) return undefined;
  // Code leaves `currency` out when the ledger recorded nothing for the task (then the cost is 0 and nothing is unpriced); any other currency than USD is refused whole.
  if (raw["currency"] === undefined ? raw["costMicros"] !== 0 || raw["unpricedCalls"] !== 0 : raw["currency"] !== "USD") return undefined;
  if ((raw["prsMerged"]) > (raw["prsOpened"])) return undefined;
  let feature: ReportTask["feature"];
  if (raw["feature"] !== undefined) {
    const found = raw["feature"];
    if (!plain(found) || typeof found["id"] !== "string" || !FEATURE_ID.test(found["id"]) || found["id"] === NO_FEATURE_ID || !oneOf(FEATURE_SOURCES, found["source"])) return undefined;
    feature = { id: found["id"], source: found["source"] };
  }
  const links = Array.isArray(raw["prLinks"]) ? (raw["prLinks"] as unknown[]).slice(0, 20).flatMap((link) => { const good = plainHttpsLink(link); return good === undefined ? [] : [good]; }) : [];
  return {
    taskId, project, title: title ?? "Untitled task", origin, ...(path === undefined ? {} : { path }), state, ...(feature === undefined ? {} : { feature }), startedAt, ...(firstPrAt === undefined ? {} : { firstPrAt }), ...(endedAt === undefined ? {} : { endedAt }),
    prsOpened: raw["prsOpened"], prsMerged: raw["prsMerged"], prLinks: links, costMicros: raw["costMicros"], unpricedCalls: raw["unpricedCalls"],
  };
}

export function readFeature(raw: unknown): ReportFeature | undefined {
  if (!plain(raw) || typeof raw["id"] !== "string" || !FEATURE_ID.test(raw["id"]) || raw["id"] === NO_FEATURE_ID) return undefined;
  const name = inert(raw["name"], FEATURE_NAME_MAX);
  if (name === undefined) return undefined;
  const link = plain(raw["trackerLink"]) ? raw["trackerLink"] : undefined;
  const tracker = link === undefined ? undefined : inert(link["tracker"], 40), trackerId = link === undefined ? undefined : inert(link["id"], 80), url = link === undefined ? undefined : plainHttpsLink(link["url"]);
  return {
    id: raw["id"], name, ...(raw["state"] === "open" || raw["state"] === "done" ? { state: raw["state"] } : {}),
    ...(tracker !== undefined && trackerId !== undefined ? { trackerLink: { tracker, id: trackerId, ...(url === undefined ? {} : { url }) } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Asking Code

class ReportRefused extends Error { constructor(readonly answer: RouteAnswer) { super("report refused"); } }

/** Code's refusal as one of the fixed answers. */
function refusalOf(error: CodeError): RouteAnswer {
  if (error.status === 403) return REPORT_WORDS.notAdmin;
  if (error.status === 404 || error.status === 501) return REPORT_WORDS.notConnected;
  return REPORT_WORDS.unavailable;
}

/** The rows of the range and how many Code could not read (left out by Code, never shown). */
interface FetchedRows { rows: ReportTask[]; unreadable: number }

/**
 * Every row of the range, call by call as the person (Code's `next` and `hasMore`; a call may give fewer rows than it looked at). A part of a range is never returned: too many rows or too many
 * calls, a cursor that does not move, a duplicate or an unreadable row refuses the whole answer. Rows Code says it could not read are counted and said (`unreadableTasks`), never hidden.
 */
async function fetchRows(context: RouteContext, companyId: string, filters: ReportFilters): Promise<FetchedRows> {
  const rows: ReportTask[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined, unreadable = 0;
  for (let call = 1; call <= REPORT_PAGES_MAX; call += 1) {
    const params = new URLSearchParams();
    // Code takes exactly one of `from` (the first call) and `cursor` (every later one); the cursor is bound to `to` and the other filters, so those go on every call as they were.
    for (const name of ["to", "project", "origin", "state", "path"] as const) if (filters[name] !== undefined) params.set(name, filters[name]);
    if (cursor === undefined) params.set("from", filters.from ?? ALL_TIME_FROM); else params.set("cursor", cursor);
    params.set("limit", String(REPORT_PAGE_ROWS));
    let body: unknown;
    try {
      body = await context.client.json<unknown>(context.session, `${CODE_REPORT_TASKS_PATH}?${params.toString()}`);
    } catch (error) {
      if (error instanceof CodeError) throw new ReportRefused(refusalOf(error));
      throw error;
    }
    if (!plain(body) || !Array.isArray(body["tasks"]) || body["tasks"].length > REPORT_PAGE_ROWS || typeof body["hasMore"] !== "boolean") throw new ReportRefused(REPORT_WORDS.unreadable);
    const next = body["next"];
    if (typeof next !== "string" || next.length > 1_024 || /\p{Cc}/u.test(next)) throw new ReportRefused(REPORT_WORDS.unreadable);
    // `skipped` (rows of the partition that are not this company's) is Code's own count; none of them is in `tasks`.
    const bad = body["unreadable"];
    if (bad !== undefined && !isCount(bad, 100_000_000)) throw new ReportRefused(REPORT_WORDS.unreadable);
    unreadable += bad ?? 0;
    for (const raw of body["tasks"] as unknown[]) {
      const row = readRow(raw, companyId);
      if (row === undefined || seen.has(row.taskId)) throw new ReportRefused(REPORT_WORDS.unreadable);
      seen.add(row.taskId);
      rows.push(row);
    }
    if (rows.length > REPORT_ROWS_MAX) throw new ReportRefused(REPORT_WORDS.tooLarge);
    if (!body["hasMore"]) return { rows, unreadable };
    if (cursors.has(next) || next === cursor) throw new ReportRefused(REPORT_WORDS.unreadable);
    cursors.add(next);
    cursor = next;
  }
  throw new ReportRefused(REPORT_WORDS.tooLarge);
}

/** The company's features by id. A Code that does not serve them, or one that answers something unreadable, gives none (the pages say "Unnamed feature"); a sign-in that ended still ends. */
async function fetchFeatures(context: RouteContext): Promise<Map<string, ReportFeature>> {
  const found = new Map<string, ReportFeature>();
  let body: unknown;
  try {
    body = await context.client.json<unknown>(context.session, CODE_REPORT_FEATURES_PATH);
  } catch (error) {
    if (error instanceof CodeError) return found;
    throw error;
  }
  if (!plain(body) || !Array.isArray(body["features"]) || body["features"].length > 5_000) return found;
  for (const raw of body["features"] as unknown[]) {
    const feature = readFeature(raw);
    if (feature !== undefined) found.set(feature.id, feature);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Adding up

export interface ReportNumbers {
  tasks: number;
  prsOpened: number;
  prsMerged: number;
  /** Whole cents. A group's cents add up to the table's total exactly (see `allocateCents`). */
  costCents: number;
  /** Model calls the ledger could not price. The cost is then a floor: more was spent than shown. */
  unpricedCalls: number;
  costIsFloor: boolean;
  /** All cost in the group divided by merged pull requests, in cents; absent when nothing merged. */
  costPerMergedCents?: number;
  /** From the first task's start to the last merge or close; absent when a closed task has no end. */
  endToEndMs?: number;
  /** True when a task is still open: the time is "so far". */
  endToEndSoFar?: boolean;
  /** The median, over the tasks that opened a pull request, of the time from start to the first one. */
  medianRequestToPrMs?: number;
}
export interface ReportGroup extends ReportNumbers { key: string; name: string; state?: "open" | "done" }

const MICROS_PER_CENT = 10_000;
const centsOf = (micros: number): number => Math.round(micros / MICROS_PER_CENT);

/**
 * Whole cents for each amount, summing exactly to the whole's cents (largest remainder), so a table's rows always add up to its total. Integers only: the
 * amounts are integer micro-dollars and nothing here is a float of dollars.
 */
export function allocateCents(microsList: readonly number[]): number[] {
  const total = microsList.reduce((sum, micros) => sum + micros, 0);
  const target = centsOf(total);
  const floors = microsList.map((micros) => Math.floor(micros / MICROS_PER_CENT));
  const order = microsList.map((micros, at) => ({ at, rest: micros - floors[at]! * MICROS_PER_CENT })).sort((a, b) => b.rest - a.rest || a.at - b.at);
  let missing = target - floors.reduce((sum, cents) => sum + cents, 0);
  const cents = [...floors];
  for (const { at } of order) {
    if (missing <= 0) break;
    cents[at]! += 1;
    missing -= 1;
  }
  return cents;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The numbers of one set of tasks (cost in micro-dollars, converted by the caller's allocation). */
function numbersOf(tasks: readonly ReportTask[], now: number): Omit<ReportNumbers, "costCents"> & { costMicros: number } {
  let costMicros = 0, unpriced = 0, opened = 0, merged = 0, firstStart = Number.POSITIVE_INFINITY, lastEnd = Number.NEGATIVE_INFINITY, open = false, endKnown = true;
  const toPr: number[] = [];
  for (const task of tasks) {
    costMicros += task.costMicros;
    unpriced += task.unpricedCalls;
    opened += task.prsOpened;
    merged += task.prsMerged;
    firstStart = Math.min(firstStart, task.startedAt);
    if (task.firstPrAt !== undefined && task.firstPrAt >= task.startedAt) toPr.push(task.firstPrAt - task.startedAt);
    if (task.state === "open") { open = true; lastEnd = Math.max(lastEnd, now); } else if (task.endedAt !== undefined) lastEnd = Math.max(lastEnd, task.endedAt); else endKnown = false;
  }
  const endToEnd = tasks.length > 0 && endKnown && lastEnd >= firstStart ? lastEnd - firstStart : undefined;
  const medianToPr = median(toPr);
  return {
    tasks: tasks.length, prsOpened: opened, prsMerged: merged, costMicros, unpricedCalls: unpriced, costIsFloor: unpriced > 0,
    ...(merged > 0 ? { costPerMergedCents: centsOf(costMicros / merged) } : {}),
    ...(endToEnd === undefined ? {} : { endToEndMs: endToEnd, endToEndSoFar: open }),
    ...(medianToPr === undefined ? {} : { medianRequestToPrMs: medianToPr }),
  };
}

/** The numbers without the micro-dollar sum (the caller sends whole cents). */
function withoutMicros(value: ReturnType<typeof numbersOf>): Omit<ReportNumbers, "costCents"> {
  const { costMicros, ...rest } = value;
  void costMicros;
  return rest;
}

/** Groups of tasks as a table: each group's numbers, with cents that add up to the total's. Sorted by cost, highest first; the no-feature group is the caller's to put last. */
function tableOf(groups: Array<{ key: string; name: string; state?: "open" | "done"; tasks: ReportTask[] }>, now: number): ReportGroup[] {
  const numbers = groups.map((group) => numbersOf(group.tasks, now));
  const cents = allocateCents(numbers.map((entry) => entry.costMicros));
  return groups.map((group, at) => {
    return { key: group.key, name: group.name, ...(group.state === undefined ? {} : { state: group.state }), ...withoutMicros(numbers[at]!), costCents: cents[at]! };
  }).sort((a, b) => b.costCents - a.costCents || a.name.localeCompare(b.name, "en") || a.key.localeCompare(b.key));
}

const UNNAMED_FEATURE = "Unnamed feature";
const NO_FEATURE_NAME = "No feature";

export interface CostReport {
  range: { from?: string; to?: string };
  asOf: string;
  totals: ReportNumbers;
  /** The company's projects with a task in the range, for the filter. */
  projects: string[];
  byFeature: ReportGroup[];
  byProject: ReportGroup[];
  /** Tasks Code could not read and left out of every number here. Absent when none. */
  unreadableTasks?: number;
}

/** The filters Cloud applies itself (Code takes the range and the project). */
export function applyOwnFilters(rows: readonly ReportTask[], filters: ReportFilters): ReportTask[] {
  return rows.filter((row) =>
    (filters.origin === undefined || row.origin === filters.origin)
    && (filters.path === undefined || row.path === filters.path)
    && (filters.state === undefined || (filters.state === "closed" ? row.state === "closed" || row.state === "failed" : row.state === filters.state)));
}

/** The whole report from the rows. Pure: the clock is the caller's. */
export function buildReport(rows: readonly ReportTask[], features: ReadonlyMap<string, ReportFeature>, filters: ReportFilters, now: Date): CostReport {
  const nowMs = now.getTime();
  const byFeature = new Map<string, ReportTask[]>(), byProject = new Map<string, ReportTask[]>(), none: ReportTask[] = [];
  for (const row of rows) {
    if (row.feature === undefined) none.push(row); else byFeature.set(row.feature.id, [...(byFeature.get(row.feature.id) ?? []), row]);
    byProject.set(row.project, [...(byProject.get(row.project) ?? []), row]);
  }
  const featureGroups = [...byFeature].map(([id, tasks]) => { const known = features.get(id); return { key: id, name: known?.name ?? UNNAMED_FEATURE, ...(known?.state === undefined ? {} : { state: known.state }), tasks }; });
  const projectGroups = [...byProject].map(([name, tasks]) => ({ key: name, name, tasks }));
  // The no-feature group is always the last row, with its own numbers; the cents of the whole table still add up to the total.
  const withNone = none.length === 0 ? featureGroups : [...featureGroups, { key: NO_FEATURE_ID, name: NO_FEATURE_NAME, tasks: none }];
  const featureTable = tableOf(withNone, nowMs);
  const noneAt = featureTable.findIndex((group) => group.key === NO_FEATURE_ID);
  if (noneAt >= 0) featureTable.push(...featureTable.splice(noneAt, 1));
  const totalNumbers = numbersOf(rows, nowMs);
    return {
    range: { ...(filters.from === undefined ? {} : { from: filters.from }), ...(filters.to === undefined ? {} : { to: filters.to }) },
    asOf: now.toISOString(),
    totals: { ...withoutMicros(totalNumbers), costCents: centsOf(totalNumbers.costMicros) },
    projects: [...byProject.keys()].sort((a, b) => a.localeCompare(b, "en")),
    byFeature: featureTable,
    byProject: tableOf(projectGroups, nowMs),
  };
}

export interface FeatureDetail {
  feature: { id: string; name: string; state?: "open" | "done"; trackerLink?: ReportFeature["trackerLink"]; none: boolean };
  range: { from?: string; to?: string };
  asOf: string;
  totals: ReportNumbers;
  /** How the tasks got here: a count for each way a task was filed under the feature. */
  sources: Array<{ source: FeatureSource; count: number }>;
  /** Newest first, at most FEATURE_TASKS_MAX; `tasksTotal` counts them all. */
  tasks: Array<{
    taskId: string; title: string; project: string; origin: Origin; path?: TaskPath; state: TaskState; startedAt: string; costCents: number; unpricedCalls: number;
    prsOpened: number; prsMerged: number; prLinks: string[]; wallMs?: number; wallSoFar?: boolean;
  }>;
  tasksTotal: number;
  unreadableTasks?: number;
}

/** One feature's detail from the rows. Undefined for an id that is neither a feature of the company nor `none`. */
export function buildFeatureDetail(id: string, rows: readonly ReportTask[], features: ReadonlyMap<string, ReportFeature>, filters: ReportFilters, now: Date): FeatureDetail | undefined {
  const nowMs = now.getTime();
  const isNone = id === NO_FEATURE_ID, known = features.get(id);
  const mine = rows.filter((row) => (isNone ? row.feature === undefined : row.feature?.id === id));
  if (!isNone && known === undefined && mine.length === 0) return undefined;
  const numbers = numbersOf(mine, nowMs);
  const totalMicros = numbers.costMicros, rest = withoutMicros(numbers);
  const ordered = [...mine].sort((a, b) => b.startedAt - a.startedAt || a.taskId.localeCompare(b.taskId));
  const shown = ordered.slice(0, FEATURE_TASKS_MAX);
  // Each task's cents, summing to the feature's cents (the list shows at most FEATURE_TASKS_MAX of them, so the sum is of all and the shown ones are a part).
  const cents = allocateCents(ordered.map((task) => task.costMicros));
  const sources = FEATURE_SOURCES.map((source) => ({ source, count: mine.filter((task) => task.feature?.source === source).length })).filter((entry) => entry.count > 0);
  return {
    feature: { id, name: isNone ? NO_FEATURE_NAME : known?.name ?? UNNAMED_FEATURE, ...(known?.state === undefined ? {} : { state: known.state }), ...(known?.trackerLink === undefined ? {} : { trackerLink: known.trackerLink }), none: isNone },
    range: { ...(filters.from === undefined ? {} : { from: filters.from }), ...(filters.to === undefined ? {} : { to: filters.to }) },
    asOf: now.toISOString(),
    totals: { ...rest, costCents: centsOf(totalMicros) },
    sources,
    tasks: shown.map((task, at) => {
      const end = task.state === "open" ? nowMs : task.endedAt;
      return {
        taskId: task.taskId, title: task.title, project: task.project, origin: task.origin, ...(task.path === undefined ? {} : { path: task.path }), state: task.state, startedAt: new Date(task.startedAt).toISOString(),
        costCents: cents[at]!, unpricedCalls: task.unpricedCalls, prsOpened: task.prsOpened, prsMerged: task.prsMerged, prLinks: task.prLinks,
        ...(end !== undefined && end >= task.startedAt ? { wallMs: end - task.startedAt, ...(task.state === "open" ? { wallSoFar: true } : {}) } : {}),
      };
    }),
    tasksTotal: mine.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The routes

/** The caller, or the refusal. Cloud's own check first; Code checks again on its own route. */
async function adminOnly(context: RouteContext): Promise<{ companyId: string; developerId: string } | RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return REPORT_WORDS.notAdmin;
  return { companyId: who.companyId, developerId: who.developerId };
}

/** How many of the person's newest Cloud sessions a feature page matches to its tasks (a bound on the store read, like the Work list's). */
const SESSIONS_LOOKED_AT = 500;

/**
 * The page address of each shown task the signed-in person started in Cloud: Cloud's own record of their session (the company-scoped store, so another company's session never matches). A task
 * started by someone else, or somewhere else, has no address here and its title is not a link; the task page opens only a person's own tasks and sessions. A store that fails gives no links.
 */
async function sessionsOf(context: RouteContext, developerId: string, taskIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    for (const record of (await context.work.startedBy(developerId)).slice(0, SESSIONS_LOOKED_AT)) if (taskIds.has(record.taskId) && !found.has(record.taskId)) found.set(record.taskId, record.sessionId);
  } catch { /* the page still answers, its titles are plain text */ }
  return found;
}

/** The features for the pickers (Move to feature, Merge into), by name: id, name and state only. */
function pickerOf(features: ReadonlyMap<string, ReportFeature>): Array<{ id: string; name: string; state?: "open" | "done" }> {
  return [...features.values()].sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id)).slice(0, 500)
    .map((feature) => ({ id: feature.id, name: feature.name, ...(feature.state === undefined ? {} : { state: feature.state }) }));
}

async function read(context: RouteContext, featureId: string | undefined): Promise<RouteAnswer> {
  try {
    const who = await adminOnly(context);
    if ("status" in who) return who;
    const filters = parseReportFilters(context.query);
    if (filters === undefined) return REPORT_WORDS.badFilter;
    const fetched = await fetchRows(context, who.companyId, filters);
    const rows = applyOwnFilters(fetched.rows, filters);
    const features = await fetchFeatures(context);
    const unreadable = fetched.unreadable > 0 ? { unreadableTasks: fetched.unreadable } : {};
    // `canChange`: the person is a company owner or admin by Code's access answer made just now, the same decision Code makes again on each change. The page draws an action only when it is true.
    const may = { canChange: true as const, features: pickerOf(features) };
    if (featureId === undefined) return { status: 200, body: { ...buildReport(rows, features, filters, context.now()), ...may, ...unreadable } };
    const detail = buildFeatureDetail(featureId, rows, features, filters, context.now());
    if (detail === undefined) return REPORT_WORDS.notFound;
    const links = await sessionsOf(context, who.developerId, new Set(detail.tasks.map((task) => task.taskId)));
    const tasks = detail.tasks.map((task) => (links.has(task.taskId) ? { ...task, sessionId: links.get(task.taskId)! } : task));
    return { status: 200, body: { ...detail, tasks, ...may, ...unreadable } };
  } catch (error) {
    if (error instanceof ReportRefused) return error.answer;
    // Code's access check failing is Code's refusal too: fixed words, never what Code said. An ended sign-in is the handler's.
    if (error instanceof CodeError) return refusalOf(error);
    throw error;
  }
}

export const REPORT_ROUTES: Route[] = [
  // GET /v1/app/org/report?from=&to=&project=&origin=&state=&path=
  { method: "GET", path: /^\/org\/report$/u, answer: (context) => read(context, undefined) },
  // GET /v1/app/org/report/features/{featureId}: a feature's id, or `none` for the tasks with no feature.
  { method: "GET", path: /^\/org\/report\/features\/([A-Za-z0-9_-]{1,64})$/u, answer: (context) => read(context, context.params[0]) },
];
