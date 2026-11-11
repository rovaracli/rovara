// Insights (srv/insights-reads, switch INSIGHTS_ENABLED): the broker reads and the viewer grant behind the Insights screen. Design: briefs/insights-api.md; owner decisions 12, 32, 33, 91.
//   GET  /v1/app/insights                        overview: the reader's scope, which panels exist, capture status (answers `enabled: false` while the switch is off, so the navigation can hide the entry)
//   GET  /v1/app/insights/stuck?project=&minAgeHours=&limit=<1..100>&cursor=     stuck work (names on every row, content only where the reader could open the task)
//   GET  /v1/app/insights/spend?month=YYYY-MM&project=                           spend vs outcomes (`byPerson` for an owner or admin only)
//   GET  /v1/app/insights/shipped?project=&weeks=<1..26>                          needs the work-event capture (U3): answers "unavailable", no numbers
//   GET  /v1/app/insights/flow?project=&days=7|30|90                              needs the work-event capture (U3): answers "unavailable", no numbers
//   GET  /v1/app/org/insights-access             an owner or admin: who holds the viewer grant
//   POST /v1/app/org/insights-access             an owner or admin, from a live browser session only: grant or revoke
// While the switch is off every path but the overview is not found (the route answers `undefined`, as any unknown path). Reads are readable by a token or the CLI as well as the browser, by the
// same role rule. Every read is scoped from the caller's session and the member record NOW, never from the request; a project asked for must be inside the caller's scope.
import { INSIGHTS_FLOW_DAYS, INSIGHTS_FLOW_MIN_SAMPLES, INSIGHTS_RETENTION_MONTHS, INSIGHTS_SHIPPED_WEEKS_MAX, INSIGHTS_STUCK_LIMIT_DEFAULT, INSIGHTS_STUCK_LIMIT_MAX, InsightsAccessBodySchema, type InsightsFlow, type InsightsOverview, type InsightsShipped } from "@agentx/cloud-contracts";
import { AGENTX_NAME_PATTERN, agentXError, orgProjectCatalogKey } from "@rovara-code/contracts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { StatusReply } from "../aws/status-reply.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { jsonBody } from "../aws/developer-routes/organization.js";
import { INSIGHTS_ACCESS_BROWSER_MESSAGE, changeInsightsAccess, readInsightsAccess, type InsightsAccessDependencies } from "./access-grant.js";
import { insightsEnabled } from "./switch.js";
import { inScope, resolveInsightsViewer, type InsightsCaller, type InsightsViewer } from "./scope.js";
import { buildSpend, spendMonth, type InsightsSpendDependencies } from "./spend.js";
import { STUCK_COVERAGE, buildStuck, type InsightsStuckDependencies } from "./stuck.js";

export const INSIGHTS_PATH = "/v1/app/insights";
export const INSIGHTS_ACCESS_PATH = "/v1/app/org/insights-access";
export { INSIGHTS_ACCESS_BROWSER_MESSAGE };
const PANEL = /^\/v1\/app\/insights\/(stuck|shipped|spend|flow)$/u;

export type InsightsDependencies = InsightsAccessDependencies & InsightsStuckDependencies & InsightsSpendDependencies;

/** Whether the path is one of Insights' (the dispatcher's browser-only guard asks before anything is authenticated). */
export const isInsightsPath = (pathname: string): boolean => pathname === INSIGHTS_PATH || PANEL.test(pathname) || pathname === INSIGHTS_ACCESS_PATH;

function wholeNumber(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = /^\d{1,6}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) throw agentXError("CONFIG_INVALID", `${name}: must be a whole number from ${String(min)} to ${String(max)}`);
  return value;
}

/** The project a request names, checked against the viewer's scope. A maintainer is told nothing about a name outside theirs (always FORBIDDEN); a company reader is told a name the company does not have is not found. */
async function checkedProject(deps: InsightsDependencies, caller: InsightsCaller, viewer: InsightsViewer, url: URL): Promise<string | undefined> {
  const name = url.searchParams.get("project");
  if (name === null || name === "") return undefined;
  if (viewer.scope.kind === "projects") {
    if (!AGENTX_NAME_PATTERN.test(name) || !inScope(viewer, name)) throw agentXError("FORBIDDEN", "Only a maintainer of that project can see its Insights.");
    return name;
  }
  const catalog = AGENTX_NAME_PATTERN.test(name) ? ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgProjectCatalogKey(caller.orgId, name), ConsistentRead: true }))) as { Item?: unknown }).Item : undefined;
  if (catalog === undefined) throw agentXError("PROJECT_NOT_FOUND", "Project not found.");
  return name;
}

function overviewOf(deps: InsightsDependencies, viewer: InsightsViewer, enabled: boolean): InsightsOverview {
  const asOf = new Date(deps.now()).toISOString();
  return {
    enabled,
    viewer: { role: viewer.role, via: viewer.via, scope: viewer.scope, contentLevel: viewer.contentLevel, canSeePerPerson: viewer.canSeePerPerson },
    panels: {
      stuck: { status: "ready", coverage: STUCK_COVERAGE(false, false, deps.sessions !== undefined) },
      // The work-event capture (U3) is not built: these panels say so and show no number.
      shipped: { status: "unavailable", collectingSince: null },
      spend: { status: "ready", outcomesStatus: "unavailable" },
      flow: { status: "unavailable", collectingSince: null },
    },
    capture: { workEvents: "off", since: null, retentionMonths: INSIGHTS_RETENTION_MONTHS },
    asOf,
  };
}

/** The reply, or undefined when the path is not one of Insights' (or the switch is off and it is not the overview). */
export async function routeInsights(deps: InsightsDependencies, caller: InsightsCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  const path = url.pathname;
  const panel = PANEL.exec(path)?.[1];
  const enabled = insightsEnabled(env);
  if (path === INSIGHTS_PATH && request.method === "GET") {
    if (!enabled) {
      // A shell with no scope and no reads: the navigation asks only whether Insights exists here.
      const role = caller.orgRole === "owner" || caller.orgRole === "admin" ? caller.orgRole : "member";
      return new StatusReply(200, overviewOf(deps, { developerId: caller.developerId, role, via: [], scope: { kind: "projects", projects: [] }, contentLevel: "full_where_readable", canSeePerPerson: false }, false));
    }
    return new StatusReply(200, overviewOf(deps, await resolveInsightsViewer(deps, caller), true));
  }
  if (!enabled) return undefined;
  if (path === INSIGHTS_ACCESS_PATH) {
    if (request.method === "GET") return new StatusReply(200, await readInsightsAccess(deps, caller));
    if (request.method !== "POST") return undefined;
    // Defence in depth: the entry file refuses a token before this, and so does the writer.
    if (caller.browserSession !== true) throw agentXError("FORBIDDEN", INSIGHTS_ACCESS_BROWSER_MESSAGE);
    const parsed = InsightsAccessBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return new StatusReply(200, await changeInsightsAccess(deps, caller, parsed.data));
  }
  if (panel === undefined || request.method !== "GET") return undefined;
  const viewer = await resolveInsightsViewer(deps, caller);
  const project = await checkedProject(deps, caller, viewer, url);
  if (panel === "stuck") {
    const minAge = url.searchParams.get("minAgeHours");
    return new StatusReply(200, await buildStuck(deps, caller, viewer, {
      project, limit: wholeNumber(url, "limit", INSIGHTS_STUCK_LIMIT_DEFAULT, 1, INSIGHTS_STUCK_LIMIT_MAX),
      ...(minAge === null ? {} : { minAgeHours: wholeNumber(url, "minAgeHours", 0, 0, 100_000) }), ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
    }));
  }
  if (panel === "spend") return new StatusReply(200, await buildSpend(deps, caller, viewer, { month: spendMonth(url.searchParams.get("month"), deps.now()), project }));
  if (panel === "shipped") {
    wholeNumber(url, "weeks", 12, 1, INSIGHTS_SHIPPED_WEEKS_MAX);
    const answer: InsightsShipped = { status: "unavailable", collectingSince: null, weeks: [] };
    return new StatusReply(200, answer);
  }
  const days = wholeNumber(url, "days", 30, 1, 365);
  if (!(INSIGHTS_FLOW_DAYS as readonly number[]).includes(days)) throw agentXError("CONFIG_INVALID", "days: must be 7, 30 or 90");
  const answer: InsightsFlow = { days: days as 7 | 30 | 90, status: "unavailable", collectingSince: null, minSamples: INSIGHTS_FLOW_MIN_SAMPLES, byProject: [] };
  return new StatusReply(200, answer);
}
