// Script tokens (UX5b): who a request with `Authorization: Bearer rvst_…` is, and whether it may do what it asks. Runs before any route is matched (`routeDeveloperRequest`), so a
// token reaches nothing but the closed list below: read the creator's own tasks on the token's projects, and start a task on one of them. Everything else, including every settings,
// member, role, billing, secret, token and decision route, is refused here with one fixed text, before any read. A token acts as its creator, with the creator's live role, and only
// while that role is the one it was made with, the creator is still in the company, their sign-in was not ended by an admin, and the sign-in method they used is still on.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE, agentXError } from "@agentx/contracts";
import { methodAllowedByEdition } from "../developer/edition-methods.js";
import { readChosenName } from "../developer/chosen-name.js";
import { safeDisplayName } from "../developer/person-name.js";
import { endedByAdmin, type DeveloperRecord } from "../developer/store.js";
import { taskKey } from "../developer/task-records.js";
import { takeRateAt } from "../developer/page-comments.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { getSignIn } from "../aws/developer-routes/authentication.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { scriptTokensEnabled } from "./switch.js";
import { noteScriptTokenUse, readScriptToken, scriptTokenStatus, type ScriptTokenRecord } from "./store.js";
import { parseScriptTokenHeader, scriptTokenMatches } from "./token-format.js";

/** Requests one token may make a minute, and task starts an hour. */
export const SCRIPT_TOKEN_REQUESTS_PER_MINUTE = 60;
export const SCRIPT_TOKEN_STARTS_PER_HOUR = 20;

const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASK_READ = new RegExp(`^/v1/dev/tasks/(${TASK_ID})(?:/events)?$`, "u");

/** What one allowed request is: the permission it needs and how its project is found. */
type AllowedRoute =
  | { permission: "start"; project: "body" }
  | { permission: "read"; project: "query" }
  | { permission: "read"; project: "task"; taskId: string };

/** The whole list of what a script token may call. Anything not here is refused. Exported for the test that pins it. */
export function scriptTokenRoute(method: string, pathname: string): AllowedRoute | undefined {
  if (pathname === "/v1/dev/tasks") {
    if (method === "POST") return { permission: "start", project: "body" };
    if (method === "GET") return { permission: "read", project: "query" };
    return undefined;
  }
  const read = method === "GET" ? TASK_READ.exec(pathname) : null;
  return read === null ? undefined : { permission: "read", project: "task", taskId: read[1]! };
}

const invalid = () => agentXError("AUTH_REQUIRED", "This script token isn't valid. Make a new one in Rovara's settings.");
const notAllowed = () => agentXError("FORBIDDEN", SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE);

/** The project a start names, read from the body without trusting it any further (the start route parses it fully). */
function bodyProject(request: AdaptedHttpRequest): string | undefined {
  if (request.body === undefined || request.body === "") return undefined;
  try {
    const value = JSON.parse(request.body) as unknown;
    return typeof value === "object" && value !== null && typeof (value as { project?: unknown }).project === "string" ? (value as { project: string }).project : undefined;
  } catch {
    return undefined;
  }
}

/** A task's company and project, and nothing else of it. A task of another company, or with no company, has none. */
async function taskScopeOf(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName">, taskId: string): Promise<{ orgId: string; project: string } | undefined> {
  const response = await deps.documentClient.send(new GetCommand({
    TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true, ProjectionExpression: "orgId, #project", ExpressionAttributeNames: { "#project": "project" },
  })) as { Item?: { orgId?: unknown; project?: unknown } };
  const item = response.Item;
  return typeof item?.orgId === "string" && typeof item.project === "string" ? { orgId: item.orgId, project: item.project } : undefined;
}

/** Whether the creator still stands where they stood when they made the token. Any change (left, moved, a new role, ended sign-in, method off) stops it for good. */
async function creatorStillHolds(deps: DeveloperRouteDependencies, record: ScriptTokenRecord): Promise<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email"> | undefined> {
  const membership = await deps.orgs?.orgForDeveloper(record.developerId);
  if (membership === undefined || membership.orgId !== record.orgId || membership.role !== record.createdRole || membership.role === "auditor") return undefined;
  if (deps.developer.methods[record.amr] !== true || !methodAllowedByEdition(deps.editionPolicy, record.amr)) return undefined;
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt">>(deps, `DEVELOPER#${record.developerId}`);
  if (developer === undefined || developer.revoked || endedByAdmin(record.createdAt, developer.sessionsEndedAt)) return undefined;
  return developer;
}

/**
 * The caller a script token stands for, once every check passed: the switch is on, the token is well formed and matches its stored hash, it is not revoked or past its end, its creator
 * still holds the role they made it with, the request is on the list, the token has the permission and names the project, and the token is within its rate. Every refusal is final and
 * fixed text: it never echoes the token, the route or the project.
 */
export async function authenticateScriptToken(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<DeveloperCaller> {
  if (!scriptTokensEnabled()) throw agentXError("AUTH_REQUIRED", "Script tokens are turned off here.");
  const parsed = parseScriptTokenHeader(request.headers.authorization);
  if (parsed === undefined) throw invalid();
  const record = await readScriptToken(deps, parsed.orgId, parsed.tokenId);
  if (record === undefined || !scriptTokenMatches(parsed.token, record.secretHash)) throw invalid();
  const status = scriptTokenStatus(record, deps.now());
  if (status === "revoked") throw agentXError("AUTH_REQUIRED", "This script token was revoked.");
  if (status === "expired") throw agentXError("AUTH_REQUIRED", "This script token has expired. Make a new one in Rovara's settings.");
  const creator = await creatorStillHolds(deps, record);
  if (creator === undefined) throw agentXError("AUTH_REQUIRED", "This script token stopped working because its creator's access changed. Make a new one in Rovara's settings.");

  const route = scriptTokenRoute(request.method, url.pathname);
  if (route === undefined || !record.permissions.includes(route.permission)) throw notAllowed();
  if (!await takeRateAt(deps, { pk: `ORG#${record.orgId}#SCRIPT_TOKEN_RATE`, sk: record.tokenId }, SCRIPT_TOKEN_REQUESTS_PER_MINUTE, 60_000)) {
    throw agentXError("TOO_MANY_REQUESTS", "This script token made too many requests. Try again in a minute.");
  }
  const project = route.project === "body" ? bodyProject(request) : route.project === "query" ? url.searchParams.get("project") ?? undefined : undefined;
  if (route.project !== "task" && (project === undefined || !record.projects.includes(project))) throw notAllowed();
  if (route.project === "task") {
    // A task outside the token's projects (or company) answers as a missing task does, so a token learns nothing about it.
    const scope = await taskScopeOf(deps, route.taskId);
    if (scope === undefined || scope.orgId !== record.orgId || !record.projects.includes(scope.project)) throw agentXError("NOT_FOUND", "task not found");
  }
  if (route.permission === "start" && !await takeRateAt(deps, { pk: `ORG#${record.orgId}#SCRIPT_TOKEN_START_RATE`, sk: record.tokenId }, SCRIPT_TOKEN_STARTS_PER_HOUR, 3_600_000)) {
    throw agentXError("TOO_MANY_REQUESTS", "This script token started too many tasks in the last hour. Try again later.");
  }
  await noteScriptTokenUse({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, record, route.permission);
  const chosenName = await readChosenName(deps.documentClient, deps.tableName, record.developerId);
  return {
    developerId: record.developerId,
    // Not a sign-in session: a token id never matches a session row, so any check that looks one up fails closed.
    sessionId: record.tokenId,
    amr: record.amr,
    orgId: record.orgId,
    orgRole: record.createdRole,
    name: chosenName ?? safeDisplayName(creator.displayName, record.developerId),
    ...(creator.slackUserId === undefined ? {} : { slackUserId: creator.slackUserId }),
    ...(creator.email === undefined ? {} : { email: creator.email }),
    scriptToken: { tokenId: record.tokenId, permissions: record.permissions, projects: record.projects },
  };
}
