// R4: the templated lake queries behind `recordStats` (design 4.10). There is no customer SQL, ever. Each template:
//  - is a fixed statement; the table, column and operator text never comes from a caller;
//  - binds workspace_id and project from the caller's context in code (a caller cannot name them in `params`);
//  - reads only rows whose audience is the whole project (`audience_kind = 'project'`), so an aggregate can never reveal a restricted source;
//  - takes its other values as Athena execution parameters, and its row limit as a validated integer.
// Known gap, by design: a row deleted at the source stays visible to these aggregates until the hourly lake delete has run.
import { z } from "zod";
import type { LakeClient, LakeRows } from "./lake.js";
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
    };
  }),
};

export interface StatsDeps {
  lake: LakeClient;
  tableBucket: string;
}

/** Builds (without running) the statement of a template. Exposed for tests and for the Ask tool's dry run. */
export function buildStats(bucket: string, caller: StatsCaller, templateName: string, params: unknown, nowMs: number): Built {
  assertSafeId(caller.workspaceId, "workspace id");
  assertSafeId(caller.project, "project");
  if (!(STATS_TEMPLATE_NAMES as readonly string[]).includes(templateName)) throw new Error("team-record stats: unknown template");
  return STATS_TEMPLATES[templateName as StatsTemplateName].build(bucket, caller, params, nowMs);
}

export async function runStats(deps: StatsDeps, caller: StatsCaller, templateName: string, params: unknown): Promise<LakeRows> {
  const built = buildStats(deps.tableBucket, caller, templateName, params, deps.lake.now());
  return deps.lake.query(built.sql, built.parameters);
}

