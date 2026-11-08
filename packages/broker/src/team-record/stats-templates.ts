// R4: the templated lake queries behind `recordStats` (design 4.10). There is no customer SQL, ever. Each template:
//  - is a fixed statement; the table, column and operator text never comes from a caller;
//  - binds workspace_id and project from the caller's context in code (a caller cannot name them in `params`);
//  - reads only rows whose audience is the whole project (`audience_kind = 'project'`), so an aggregate can never reveal a restricted source;
//  - takes its other values as Athena execution parameters, and its row limit as a validated integer.
// Known gap, by design: a row deleted at the source stays visible to these aggregates until the hourly lake delete has run.
import { z } from "zod";
import { LakeError, type LakeClient, type LakeRows } from "./lake.js";
import { stringParameter, tableRef, timestampParameter, timestampText } from "./lake-sql.js";
import { assertSafeId } from "./shared-types.js";

export const STATS_TEMPLATE_NAMES = ["send_backs_by_stage", "tickets_by_component", "ci_failures_by_test", "rovara_merge_rate"] as const;
export type StatsTemplateName = (typeof STATS_TEMPLATE_NAMES)[number];

/** The most tasks one Rovara statistic looks up (SRL-4). A project with more in the window gets "history unavailable" rather than a number that includes tasks nobody checked. */
export const STATS_ROVARA_TASKS_MAX = 300;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 400;

const windowShape = {
  /** ISO-8601 UTC, e.g. 2026-08-01T00:00:00Z. Default: 90 days before `until`. */
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
};
const groupedParams = z.strictObject(windowShape);
const rateParams = z.strictObject({ since: windowShape.since, until: windowShape.until });

export interface StatsCaller {
  /** From the caller's org (the broker), never from a request body. */
  workspaceId: string;
  project: string;
}

interface Built {
  sql: string;
  parameters: string[];
  range: { since: string; until: string };
  /** Set for the grouped templates. */
  limit?: number;
}

function window(params: { since?: string | undefined; until?: string | undefined }, nowMs: number): { since: string; until: string } {
  const until = params.until ?? new Date(nowMs).toISOString().replace(/\.\d+Z$/, "Z");
  timestampText(until); // strict ISO-8601 UTC first: Date.parse alone accepts odd strings
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs)) throw new Error("team-record stats: until is not a date");
  const since = params.since ?? new Date(untilMs - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString().replace(/\.\d+Z$/, "Z");
  timestampText(since);
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs) || sinceMs >= untilMs) throw new Error("team-record stats: since must be before until");
  if (untilMs - sinceMs > MAX_WINDOW_DAYS * DAY_MS) throw new Error("team-record stats: the window is over 400 days");
  return { since, until };
}

function scopeParameters(caller: StatsCaller, range: { since: string; until: string }): string[] {
  return [stringParameter(caller.workspaceId), stringParameter(caller.project), timestampParameter(range.since), timestampParameter(range.until)];
}

const EVENT_FILTER = `"workspace_id" = ? AND "project" = ? AND "occurred_at" >= ? AND "occurred_at" < ? AND "audience_kind" = 'project'`;

/**
 * SRL-4: ` AND <column> IN (?, ...)` over the tasks a Rovara statistic may count (checked, and visible to the whole project right now). An ALLOW list, so a task that appears after the check is
 * not counted unchecked; an empty list counts nothing. `undefined` adds no clause (statistics over other sources, and direct callers). The ids are bound as parameters; the column is ours.
 */
function onlyTasks(column: string, onlyTaskIds: readonly string[] | undefined): { sql: string; parameters: string[] } {
  if (onlyTaskIds === undefined) return { sql: "", parameters: [] };
  if (onlyTaskIds.length === 0) return { sql: " AND 1 = 0", parameters: [] };
  if (onlyTaskIds.length > STATS_ROVARA_TASKS_MAX) throw new Error("team-record stats: too many tasks to count");
  return { sql: ` AND ${column} IN (${onlyTaskIds.map(() => "?").join(", ")})`, parameters: onlyTaskIds.map(stringParameter) };
}
const EVENT_TASK_ID = `coalesce(json_extract_scalar("structured_json", '$.taskId'), '')`;

function groupedEvents(bucket: string, kindClause: string, groupExpr: string, extra: string, caller: StatsCaller, params: z.infer<typeof groupedParams>, nowMs: number, extraParameters: readonly string[] = []): Built {
  const range = window(params, nowMs);
  return {
    sql:
      `SELECT ${groupExpr} AS "group", count(*) AS "count" FROM ${tableRef(bucket, "events")} ` +
      `WHERE ${EVENT_FILTER} AND ${kindClause}${extra} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${params.limit}`,
    parameters: [...scopeParameters(caller, range), ...extraParameters],
    range,
    limit: params.limit,
  };
}

interface Template {
  /** Validates `params` against the template's own strict schema, then builds the statement. */
  build(bucket: string, caller: StatsCaller, params: unknown, nowMs: number, onlyTaskIds?: readonly string[]): Built;
}

function template<S extends z.ZodType>(schema: S, build: (bucket: string, caller: StatsCaller, params: z.infer<S>, nowMs: number, onlyTaskIds: readonly string[] | undefined) => Built): Template {
  return {
    build(bucket, caller, params, nowMs, onlyTaskIds) {
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) throw new Error("team-record stats: the parameters are not valid for this template");
      return build(bucket, caller, parsed.data, nowMs, onlyTaskIds);
    },
  };
}

export const STATS_TEMPLATES: Record<StatsTemplateName, Template> = {
  send_backs_by_stage: template(groupedParams, (bucket, caller, params, nowMs, onlyTaskIds) => {
    const out = onlyTasks(EVENT_TASK_ID, onlyTaskIds);
    return groupedEvents(bucket, `"kind" = 'rovara.send_back'`, `coalesce(json_extract_scalar("structured_json", '$.stage'), 'unknown')`, out.sql, caller, params, nowMs, out.parameters);
  }),
  tickets_by_component: template(groupedParams, (bucket, caller, params, nowMs) =>
    groupedEvents(bucket, `"kind" = 'ticket.created'`, `coalesce(json_extract_scalar("structured_json", '$.component'), 'unknown')`, "", caller, params, nowMs),
  ),
  ci_failures_by_test: template(groupedParams, (bucket, caller, params, nowMs) =>
    groupedEvents(bucket, `"kind" = 'github.ci'`, `coalesce(json_extract_scalar("structured_json", '$.check'), 'unknown')`, ` AND json_extract_scalar("structured_json", '$.conclusion') = 'failure'`, caller, params, nowMs),
  ),
  rovara_merge_rate: template(rateParams, (bucket, caller, params, nowMs, onlyTaskIds) => {
    const range = window(params, nowMs);
    const out = onlyTasks(`"task_id"`, onlyTaskIds);
    return {
      sql:
        `SELECT count(*) AS "tasks", count_if("merged") AS "merged", count_if("reverted") AS "reverted", ` +
        `coalesce(sum("send_backs"), 0) AS "send_backs" FROM ${tableRef(bucket, "outcomes")} ` +
        `WHERE "workspace_id" = ? AND "project" = ? AND "occurred_at" >= ? AND "occurred_at" < ?${out.sql}`,
      parameters: [...scopeParameters(caller, range), ...out.parameters],
      range,
    };
  }),
};

/**
 * The recent side of the statistics. The lake only holds rows that were ARCHIVED (older than 90 days), so the default window (the last 90 days)
 * would be empty without this (review I-9). Contract: count project-audience rows that are NOT archived yet; archived rows are in the lake,
 * so nothing is counted twice (apart from the moment between the lake insert and `markArchived`). The record lane (R2/R9) provides it.
 */
export interface HotStatsSource {
  /** `onlyTaskIds` (SRL-4): only Rovara rows of these tasks are counted (a Rovara row that names no task is not). */
  groupedCounts(request: { workspaceId: string; project: string; template: StatsTemplateName; since: string; until: string; onlyTaskIds?: readonly string[] }): Promise<Array<{ group: string; count: number }>>;
  mergeTotals(request: { workspaceId: string; project: string; since: string; until: string; onlyTaskIds?: readonly string[] }): Promise<{ tasks: number; merged: number; reverted: number; send_backs: number }>;
  /** SRL-4: the distinct tasks the Rovara statistic `template` counts on the recent side (for the check of their live visibility). */
  rovaraTaskIds?(request: { workspaceId: string; project: string; template: StatsTemplateName; since: string; until: string }): Promise<string[]>;
}

export interface StatsDeps {
  lake: LakeClient;
  tableBucket: string;
  /** REQUIRED (review I-9): without the recent side the default window (the last 90 days) would be empty, because the lake holds archived rows only. */
  hot: HotStatsSource;
}

export interface StatsResult extends LakeRows {
  /** `unavailable`: the lake failed and only recent data is shown ("history unavailable right now", design 4.11). */
  lake: "ok" | "unavailable";
  /** Always true: the recent side was read. Kept so callers can see both sides took part. */
  hot: true;
}

/** Builds (without running) the statement of a template. Exposed for tests and for the Ask tool's dry run. */
export function buildStats(bucket: string, caller: StatsCaller, templateName: string, params: unknown, nowMs: number, limitOverride?: number, onlyTaskIds?: readonly string[]): Built {
  assertSafeId(caller.workspaceId, "workspace id");
  assertSafeId(caller.project, "project");
  if (!(STATS_TEMPLATE_NAMES as readonly string[]).includes(templateName)) throw new Error("team-record stats: unknown template");
  const withLimit = limitOverride !== undefined && templateName !== "rovara_merge_rate" ? { ...(params as object), limit: limitOverride } : params;
  return STATS_TEMPLATES[templateName as StatsTemplateName].build(bucket, caller, withLimit, nowMs, onlyTaskIds);
}

const GROUP_FETCH_LIMIT = 200;

/** The statistics that count Rovara's own rows, and so must leave out tasks that are no longer visible to the whole project (SRL-4). */
export const ROVARA_STATS: readonly StatsTemplateName[] = ["send_backs_by_stage", "rovara_merge_rate"];
export const readsRovaraRows = (templateName: string): boolean => (ROVARA_STATS as readonly string[]).includes(templateName);

/**
 * SRL-4: the distinct tasks a Rovara statistic counts in its window, lake and recent side, so the caller can read each one's live visibility. `complete` is false when the lake's list was cut
 * (more than `max` tasks): the statistic must then not be shown. A failure of the lake or the recent side throws (nothing is shown).
 */
export async function listRovaraTaskIds(deps: StatsDeps, caller: StatsCaller, templateName: string, params: unknown, options: { max?: number; nowMs?: number } = {}): Promise<{ taskIds: string[]; complete: boolean; nowMs: number }> {
  if (!readsRovaraRows(templateName)) throw new Error("team-record stats: that statistic does not count Rovara's rows");
  if (deps.hot.rovaraTaskIds === undefined) throw new Error("team-record stats: the recent side can't list tasks");
  const nowMs = options.nowMs ?? deps.lake.now();
  const built = buildStats(deps.tableBucket, caller, templateName, params, nowMs); // validates the parameters and fixes the window
  const max = options.max ?? STATS_ROVARA_TASKS_MAX;
  const bounds = { ...built.range };
  const sql = templateName === "send_backs_by_stage"
    ? `SELECT DISTINCT ${EVENT_TASK_ID} AS "task" FROM ${tableRef(deps.tableBucket, "events")} WHERE ${EVENT_FILTER} AND "kind" = 'rovara.send_back' LIMIT ${String(max + 1)}`
    : `SELECT DISTINCT "task_id" AS "task" FROM ${tableRef(deps.tableBucket, "outcomes")} WHERE "workspace_id" = ? AND "project" = ? AND "occurred_at" >= ? AND "occurred_at" < ? LIMIT ${String(max + 1)}`;
  const [recent, lake] = await Promise.all([
    deps.hot.rovaraTaskIds({ workspaceId: caller.workspaceId, project: caller.project, template: templateName as StatsTemplateName, ...bounds }),
    deps.lake.query(sql, scopeParameters(caller, bounds)),
  ]);
  const ids = new Set<string>(recent);
  for (const row of lake.rows) if (typeof row.task === "string" && row.task !== "") ids.add(row.task);
  return { taskIds: [...ids], complete: !lake.truncated && lake.rows.length <= max && ids.size <= max, nowMs };
}

export async function runStats(deps: StatsDeps, caller: StatsCaller, templateName: string, params: unknown, options: { onlyTaskIds?: readonly string[]; nowMs?: number } = {}): Promise<StatsResult> {
  const nowMs = options.nowMs ?? deps.lake.now();
  const onlyTaskIds = options.onlyTaskIds;
  const first = buildStats(deps.tableBucket, caller, templateName, params, nowMs, undefined, onlyTaskIds); // validates everything
  const base = { workspaceId: caller.workspaceId, project: caller.project, ...first.range, ...(onlyTaskIds === undefined ? {} : { onlyTaskIds }) };
  const grouped = templateName !== "rovara_merge_rate";

  // Both sides always, then merge. A lake failure leaves the recent side (flagged); a failure of the recent side is an error.
  const lakeBuilt = grouped ? buildStats(deps.tableBucket, caller, templateName, params, nowMs, GROUP_FETCH_LIMIT, onlyTaskIds) : first;
  const [hotResult, lakeResult] = await Promise.all([
    grouped ? deps.hot.groupedCounts({ ...base, template: templateName as StatsTemplateName }) : deps.hot.mergeTotals(base),
    deps.lake.query(lakeBuilt.sql, lakeBuilt.parameters).catch((error: unknown) => {
      if (error instanceof LakeError) return undefined;
      throw error;
    }),
  ]);
  const lakeStatus = lakeResult === undefined ? "unavailable" : "ok";

  if (!grouped) {
    const hot = hotResult as { tasks: number; merged: number; reverted: number; send_backs: number };
    const row = lakeResult?.rows[0];
    const num = (value: string | null | undefined): number => (value === null || value === undefined || !Number.isFinite(Number(value)) ? 0 : Number(value));
    const sum = (key: "tasks" | "merged" | "reverted" | "send_backs"): string => String(hot[key] + num(row?.[key]));
    return { rows: [{ tasks: sum("tasks"), merged: sum("merged"), reverted: sum("reverted"), send_backs: sum("send_backs") }], truncated: lakeResult?.truncated ?? false, lake: lakeStatus, hot: true };
  }

  const totals = new Map<string, number>();
  for (const row of hotResult as Array<{ group: string; count: number }>) totals.set(row.group, (totals.get(row.group) ?? 0) + row.count);
  for (const row of lakeResult?.rows ?? []) totals.set(row.group ?? "unknown", (totals.get(row.group ?? "unknown") ?? 0) + Number(row.count ?? 0));
  const rows = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, first.limit ?? 50)
    .map(([group, count]) => ({ group, count: String(count) }));
  return { rows, truncated: lakeResult?.truncated ?? false, lake: lakeStatus, hot: true };
}
