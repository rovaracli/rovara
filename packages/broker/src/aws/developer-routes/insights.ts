// Insights (srv/insights-reads, switch INSIGHTS_ENABLED): the wiring of `/v1/app/insights*` and `/v1/app/org/insights-access` into the route dispatcher. The reads and the grant are in `insights/`;
// this file only builds their dependencies from the route dependencies. `org` and `insights` are browser route families, so the app reaches them as `/v1/web/...` (`web-auth.ts`).
// The grant's write is browser-only: `routeDeveloperRequest` refuses a token before authentication (INSIGHTS_ACCESS_BROWSER_MESSAGE), and the writer refuses it again.
import { INSIGHTS_ACCESS_BROWSER_MESSAGE, INSIGHTS_ACCESS_PATH, isInsightsPath, routeInsights, type InsightsDependencies } from "../../insights/routes.js";
import type { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { projectMembersOf } from "./project-list.js";
import { sessionReadDependencies } from "./dependencies.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { INSIGHTS_ACCESS_BROWSER_MESSAGE, INSIGHTS_ACCESS_PATH };

export function insightsDependenciesOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): InsightsDependencies {
  let sessions: InsightsDependencies["sessions"];
  try { sessions = sessionReadDependencies(deps, caller); } catch { sessions = undefined; }
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, signInTableName: deps.developer.signInTableName,
    projectMembers: deps.agents?.projectMembers ?? projectMembersOf(deps), sessions,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }), ...(deps.cloud === true ? { cloud: true } : {}),
  };
}

/** The reply, or undefined when the path is not Insights' or the switch is off. */
export async function routeInsightsFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!isInsightsPath(url.pathname)) return undefined;
  return routeInsights(insightsDependenciesOf(deps, caller), caller, request, url, env);
}
