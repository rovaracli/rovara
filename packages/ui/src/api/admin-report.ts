// The Cost and time report's read layer (Feature A, slice A3). What `GET /v1/app/org/report` and `GET /v1/app/org/report/features/{id}` send, read strictly: a field that is not
// the shape makes the whole answer "unreadable" (never a half drawn table), money is whole cents (never a float of dollars), a missing number is absent (never zero), and nothing
// here names a person. The words for the numbers (days, cents, state) and the CSV export live here too, so a test can pin each of them.
import type { Reader } from "./client.js";

export const REPORT_PATH = "/v1/app/org/report";
export const featurePath = (id: string) => `${REPORT_PATH}/features/${encodeURIComponent(id)}`;
export const NO_FEATURE_ID = "none";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value !== "" && Array.from(value).length <= max ? value : undefined);
const time = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : undefined);
const plainHttps = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 300) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined; } catch { return undefined; }
};
const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));
function must<T>(value: T | undefined): T { if (value === undefined) throw new Error("unreadable report"); return value; }

export const ORIGINS = ["linear", "jira", "slack", "web", "tool", "other"] as const;
export type Origin = (typeof ORIGINS)[number];
export const ORIGIN_WORDS: Record<Origin, string> = { linear: "Linear", jira: "Jira", slack: "Slack", web: "Web", tool: "AI tool", other: "Other" };
export const TASK_STATES = ["open", "merged", "closed", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const STATE_WORDS: Record<TaskState, string> = { open: "Open", merged: "Merged", closed: "Closed", failed: "Failed" };
export const PATHS = ["quick", "full"] as const;
export type TaskPath = (typeof PATHS)[number];
export const PATH_WORDS: Record<TaskPath, string> = { quick: "Quick", full: "Full" };
export const FEATURE_SOURCES = ["moved", "chosen", "tracker", "inherited", "confirmed_at_plan"] as const;
export type FeatureSource = (typeof FEATURE_SOURCES)[number];
export const SOURCE_WORDS: Record<FeatureSource, string> = { chosen: "chosen by a person", tracker: "from the tracker", inherited: "inherited from a related task", confirmed_at_plan: "confirmed at plan", moved: "moved by an admin" };

export interface ReportNumbers {
  tasks: number; prsOpened: number; prsMerged: number; costCents: number; unpricedCalls: number; costIsFloor: boolean;
  costPerMergedCents?: number; endToEndMs?: number; endToEndSoFar?: boolean; medianRequestToPrMs?: number;
}
export interface ReportGroup extends ReportNumbers { key: string; name: string; state?: "open" | "done" }
export interface CostReport { range: { from?: string; to?: string }; asOf: string; totals: ReportNumbers; projects: string[]; byFeature: ReportGroup[]; byProject: ReportGroup[]; unreadableTasks?: number }
export interface FeatureTask {
  taskId: string; title: string; project: string; origin: Origin; path?: TaskPath; state: TaskState; startedAt: string; costCents: number; unpricedCalls: number;
  prsOpened: number; prsMerged: number; prLinks: string[]; wallMs?: number; wallSoFar?: boolean;
}
export interface FeatureDetail {
  feature: { id: string; name: string; state?: "open" | "done"; trackerLink?: { tracker: string; id: string; url?: string }; none: boolean };
  range: { from?: string; to?: string }; asOf: string; totals: ReportNumbers;
  sources: Array<{ source: FeatureSource; count: number }>; tasks: FeatureTask[]; tasksTotal: number; unreadableTasks?: number;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : undefined);

const featureState = (value: unknown): "open" | "done" | undefined => (value === "open" ? "open" : value === "done" ? "done" : undefined);
function numbers(raw: unknown): ReportNumbers {
  if (!isRecord(raw)) throw new Error("unreadable report");
  const flag = raw["costIsFloor"];
  if (typeof flag !== "boolean") throw new Error("unreadable report");
  const soFar = raw["endToEndSoFar"];
  return {
    tasks: must(count(raw["tasks"])), prsOpened: must(count(raw["prsOpened"])), prsMerged: must(count(raw["prsMerged"])), costCents: must(count(raw["costCents"])), unpricedCalls: must(count(raw["unpricedCalls"])), costIsFloor: flag,
    ...optional("costPerMergedCents", count(raw["costPerMergedCents"])), ...optional("endToEndMs", count(raw["endToEndMs"])), ...optional("endToEndSoFar", typeof soFar === "boolean" ? soFar : undefined), ...optional("medianRequestToPrMs", count(raw["medianRequestToPrMs"])),
  };
}
function group(raw: unknown): ReportGroup {
  if (!isRecord(raw)) throw new Error("unreadable report");
  const state = featureState(raw["state"]);
  return { key: must(text(raw["key"], 200)), name: must(text(raw["name"], 200)), ...optional("state", state), ...numbers(raw) };
}
function range(raw: unknown): { from?: string; to?: string } {
  if (!isRecord(raw)) throw new Error("unreadable report");
  return { ...optional("from", time(raw["from"] ?? undefined)), ...optional("to", time(raw["to"] ?? undefined)) };
}
function list<T>(raw: unknown, max: number, read: (item: unknown) => T): T[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error("unreadable report");
  return raw.map(read);
}

export const readCostReport: Reader<CostReport> = {
  parse(body: unknown): CostReport {
    if (!isRecord(body)) throw new Error("unreadable report");
    return {
      range: range(body["range"]), asOf: must(time(body["asOf"])), totals: numbers(body["totals"]),
      projects: list(body["projects"], 2_000, (item) => must(text(item, 200))), byFeature: list(body["byFeature"], 5_000, group), byProject: list(body["byProject"], 2_000, group), ...optional("unreadableTasks", count(body["unreadableTasks"])),
    };
  },
};

export const readFeatureDetail: Reader<FeatureDetail> = {
  parse(body: unknown): FeatureDetail {
    if (!isRecord(body) || !isRecord(body["feature"])) throw new Error("unreadable report");
    const f = body["feature"];
    const link = isRecord(f["trackerLink"]) ? f["trackerLink"] : undefined;
    const tracker = link === undefined ? undefined : text(link["tracker"], 40), linkId = link === undefined ? undefined : text(link["id"], 80);
    const state = featureState(f["state"]);
    if (typeof f["none"] !== "boolean") throw new Error("unreadable report");
    return {
      feature: {
        id: must(text(f["id"], 64)), name: must(text(f["name"], 200)), none: f["none"], ...optional("state", state),
        ...(tracker !== undefined && linkId !== undefined ? { trackerLink: { tracker, id: linkId, ...optional("url", link === undefined ? undefined : plainHttps(link["url"])) } } : {}),
      },
      range: range(body["range"]), asOf: must(time(body["asOf"])), totals: numbers(body["totals"]),
      sources: list(body["sources"], 10, (item) => {
        if (!isRecord(item)) throw new Error("unreadable report");
        return { source: must(oneOf(FEATURE_SOURCES, item["source"])), count: must(count(item["count"])) };
      }),
      tasks: list(body["tasks"], 500, (item): FeatureTask => {
        if (!isRecord(item)) throw new Error("unreadable report");
        const soFar = item["wallSoFar"];
        return {
          taskId: must(text(item["taskId"], 128)), title: must(text(item["title"], 200)), project: must(text(item["project"], 200)), origin: must(oneOf(ORIGINS, item["origin"])), ...optional("path", oneOf(PATHS, item["path"])), state: must(oneOf(TASK_STATES, item["state"])),
          startedAt: must(time(item["startedAt"])), costCents: must(count(item["costCents"])), unpricedCalls: must(count(item["unpricedCalls"])), prsOpened: must(count(item["prsOpened"])), prsMerged: must(count(item["prsMerged"])),
          prLinks: Array.isArray(item["prLinks"]) ? (item["prLinks"] as unknown[]).slice(0, 20).flatMap((link) => { const good = plainHttps(link); return good === undefined ? [] : [good]; }) : [],
          ...optional("wallMs", count(item["wallMs"])), ...optional("wallSoFar", soFar === true ? true : undefined),
        };
      }),
      tasksTotal: must(count(body["tasksTotal"])), ...optional("unreadableTasks", count(body["unreadableTasks"])),
    };
  },
};

// ---- Filters ----
export type StateFilter = "open" | "merged" | "closed";
export interface ReportFilters { from?: string; to?: string; project?: string; origin?: Origin; state?: StateFilter; path?: TaskPath }
/** The query string of the filters, in a fixed order; empty for none. */
export function filterQuery(filters: ReportFilters): string {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "project", "origin", "state", "path"] as const) if (filters[key] !== undefined && filters[key] !== "") params.set(key, filters[key]);
  const out = params.toString();
  return out === "" ? "" : `?${out}`;
}
/** The first moment of the current month in UTC: the page's default range ("this month"). A task belongs to the range it started in. */
export const monthStart = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

// ---- Words for the numbers ----
/** Whole cents as dollars. Display only: the amounts stay integers everywhere else. */
export function dollars(cents: number): string {
  const whole = Math.floor(cents / 100), rest = cents % 100;
  return `$${whole.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
}
/** A cost, with the floor marked: "$12.00 or more" when calls could not be priced. */
export function costWords(cents: number, floor: boolean): string { return floor ? `${dollars(cents)} or more` : dollars(cents); }
export const unreadableWords = (tasks: number): string => `${tasks.toLocaleString("en-US")} ${tasks === 1 ? "task" : "tasks"} couldn't be read and ${tasks === 1 ? "is" : "are"} left out of these numbers.`;
export const unpricedWords = (calls: number): string => `${calls.toLocaleString("en-US")} ${calls === 1 ? "call" : "calls"} not priced`;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** A length of calendar time in the largest sensible unit: "5 days", "3 hours", "40 minutes". */
export function durationWords(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms >= DAY) { const days = ms / DAY; return plural(days >= 10 ? Math.round(days) : Math.round(days * 10) / 10, "day"); }
  if (ms >= HOUR) return plural(Math.round(ms / HOUR * 10) / 10, "hour");
  if (ms >= MIN) return plural(Math.round(ms / MIN), "minute");
  return "under a minute";
}
export const soFarWords = (ms: number, soFar: boolean | undefined): string => (soFar === true ? `${durationWords(ms)} so far` : durationWords(ms));
export function pullRequestWords(merged: number, opened: number): string { return opened === 0 && merged === 0 ? "None" : `${merged} merged of ${opened}`; }

// ---- CSV ----
/** One CSV cell: a cell that starts with = + - or @ (or a tab or carriage return) gets a leading apostrophe so a spreadsheet never runs it; quoted when it holds a comma, quote or line break. */
export function csvCell(value: string | number | undefined): string {
  let out = value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/u.test(out)) out = `'${out}`;
  return /[",\r\n]/u.test(out) ? `"${out.replace(/"/gu, '""')}"` : out;
}
export function csvOf(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | undefined>>): string {
  return [header, ...rows].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
const dollarsCsv = (cents: number | undefined): string => (cents === undefined ? "" : (cents / 100).toFixed(2));
const days = (ms: number | undefined): string => (ms === undefined ? "" : (ms / DAY).toFixed(1));
/** The export of the table on screen: what the filters show, the same columns, plain numbers (dollars with cents, days). */
export function reportCsv(groups: readonly ReportGroup[], by: "feature" | "project"): string {
  const header = [by === "feature" ? "Feature" : "Project", "Tasks", "Pull requests opened", "Pull requests merged", "Cost (USD)", "Cost is a floor", "Calls not priced", "End to end (days)", "Still open", ...(by === "feature" ? ["State"] : [])];
  return csvOf(header, groups.map((g) => [g.name, g.tasks, g.prsOpened, g.prsMerged, dollarsCsv(g.costCents), g.costIsFloor ? "yes" : "no", g.unpricedCalls, days(g.endToEndMs), g.endToEndSoFar === true ? "yes" : "no", ...(by === "feature" ? [g.state === undefined ? "" : g.state === "done" ? "Done" : "Open"] : [])]));
}
/** The export of a feature's tasks. */
export function featureCsv(tasks: readonly FeatureTask[]): string {
  return csvOf(["Task", "Project", "Started from", "State", "Pull request", "Cost (USD)", "Cost is a floor", "Calls not priced", "End to end (days)", "Still open"],
    tasks.map((t) => [t.title, t.project, ORIGIN_WORDS[t.origin], STATE_WORDS[t.state], t.prLinks[0] ?? "", dollarsCsv(t.costCents), t.unpricedCalls > 0 ? "yes" : "no", t.unpricedCalls, days(t.wallMs), t.wallSoFar === true ? "yes" : "no"]));
}

// ---- The date range ----
export const RANGES = ["this-month", "last-month", "last-90", "all"] as const;
export type RangeId = (typeof RANGES)[number];
export const RANGE_WORDS: Record<RangeId, string> = { "this-month": "This month", "last-month": "Last month", "last-90": "Last 90 days", all: "All time" };
export const isRange = (value: string | null): value is RangeId => value !== null && (RANGES as readonly string[]).includes(value);
/** A named range as the `from` and `to` the report takes (UTC, a task belongs to the range it started in). */
export function rangeBounds(range: RangeId, now: Date): { from?: string; to?: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (range === "this-month") return { from: new Date(start).toISOString() };
  if (range === "last-month") return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(), to: new Date(start - 1).toISOString() };
  if (range === "last-90") return { from: new Date(now.getTime() - 90 * DAY).toISOString() };
  return {};
}
