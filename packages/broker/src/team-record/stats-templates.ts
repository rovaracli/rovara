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

function groupedEvents(bucket: string, kindClause: string, groupExpr: string, extra: string, caller: StatsCaller, params: z.infer<typeof groupedParams>, nowMs: number): Built {
  const range = window(params, nowMs);
  return {
    sql:
      `SELECT ${groupExpr} AS "group", count(*) AS "count" FROM ${tableRef(bucket, "events")} ` +
      `WHERE ${EVENT_FILTER} AND ${kindClause}${extra} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${params.limit}`,
    parameters: scopeParameters(caller, range),
    range,
    limit: params.limit,
  };
}

interface Template {
  /** Validates `params` against the template's own strict schema, then builds the statement. */
  build(bucket: string, caller: StatsCaller, params: unknown, nowMs: number): Built;
}

function template<S extends z.ZodType>(schema: S, build: (bucket: string, caller: StatsCaller, params: z.infer<S>, nowMs: number) => Built): Template {
  return {
    build(bucket, caller, params, nowMs) {
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) throw new Error("team-record stats: the parameters are not valid for this template");
      return build(bucket, caller, parsed.data, nowMs);
    },
  };
}

export const STATS_TEMPLATES: Record<StatsTemplateName, Template> = {
  send_backs_by_stage: template(groupedParams, (bucket, caller, params, nowMs) =>
    groupedEvents(bucket, `"kind" = 'rovara.send_back'`, `coalesce(json_extract_scalar("structured_json", '$.stage'), 'unknown')`, "", caller, params, nowMs),
  ),
  tickets_by_component: template(groupedParams, (bucket, caller, params, nowMs) =>
    groupedEvents(bucket, `"kind" = 'ticket.created'`, `coalesce(json_extract_scalar("structured_json", '$.component'), 'unknown')`, "", caller, params, nowMs),
  ),
  ci_failures_by_test: template(groupedParams, (bucket, caller, params, nowMs) =>
    groupedEvents(bucket, `"kind" = 'github.ci'`, `coalesce(json_extract_scalar("structured_json", '$.check'), 'unknown')`, ` AND json_extract_scalar("structured_json", '$.conclusion') = 'failure'`, caller, params, nowMs),
  ),
  rovara_merge_rate: template(rateParams, (bucket, caller, params, nowMs) => {
    const range = window(params, nowMs);
    return {
      sql:
        `SELECT count(*) AS "tasks", count_if("merged") AS "merged", count_if("reverted") AS "reverted", ` +
        `coalesce(sum("send_backs"), 0) AS "send_backs" FROM ${tableRef(bucket, "outcomes")} ` +
        `WHERE "workspace_id" = ? AND "project" = ? AND "occurred_at" >= ? AND "occurred_at" < ?`,
      parameters: scopeParameters(caller, range),
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
  groupedCounts(request: { workspaceId: string; project: string; template: StatsTemplateName; since: string; until: string }): Promise<Array<{ group: string; count: number }>>;
  mergeTotals(request: { workspaceId: string; project: string; since: string; until: string }): Promise<{ tasks: number; merged: number; reverted: number; send_backs: number }>;
}

export interface StatsDeps {
  lake: LakeClient;
  tableBucket: string;
  hot?: HotStatsSource;
}

export interface StatsResult extends LakeRows {
  /** `unavailable`: the lake failed and only recent data is shown ("history unavailable right now", design 4.11). */
  lake: "ok" | "unavailable";
  hot: boolean;
}

/** Builds (without running) the statement of a template. Exposed for tests and for the Ask tool's dry run. */
export function buildStats(bucket: string, caller: StatsCaller, templateName: string, params: unknown, nowMs: number, limitOverride?: number): Built {
  assertSafeId(caller.workspaceId, "workspace id");
  assertSafeId(caller.project, "project");
  if (!(STATS_TEMPLATE_NAMES as readonly string[]).includes(templateName)) throw new Error("team-record stats: unknown template");
  const withLimit = limitOverride !== undefined && templateName !== "rovara_merge_rate" ? { ...(params as object), limit: limitOverride } : params;
  return STATS_TEMPLATES[templateName as StatsTemplateName].build(bucket, caller, withLimit, nowMs);
}

const GROUP_FETCH_LIMIT = 200;

export async function runStats(deps: StatsDeps, caller: StatsCaller, templateName: string, params: unknown): Promise<StatsResult> {
  const nowMs = deps.lake.now();
  const first = buildStats(deps.tableBucket, caller, templateName, params, nowMs); // validates everything
  const base = { workspaceId: caller.workspaceId, project: caller.project, ...first.range };
  const grouped = templateName !== "rovara_merge_rate";

  if (deps.hot === undefined) {
    const lake = await deps.lake.query(first.sql, first.parameters);
    return { ...lake, lake: "ok", hot: false };
  }

  // Both sides, then merge. A lake failure leaves the recent side (flagged); a failure of the recent side is an error.
  const lakeBuilt = grouped ? buildStats(deps.tableBucket, caller, templateName, params, nowMs, GROUP_FETCH_LIMIT) : first;
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
