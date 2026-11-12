// Script tokens (UX5b): who a request with `Authorization: Bearer rvst_…` is, and whether it may do what it asks. Runs before any route is matched (`routeDeveloperRequest`), so a
// token reaches nothing but the closed list below: read the creator's own tasks on the token's projects, and start a task on one of them. Everything else, including every settings,
// member, role, billing, secret, token and decision route, is refused here with one fixed text, before any read. A token acts as its creator, with the creator's live role, and only
// while that role is the one it was made with, the creator is still in the company, and nothing that ends a sign-in session ended the token (review I1): an admin's end of sign-ins,
// the method turned off (or off and on again), the method unlinked from the account, a SAML cut-off, the edition's session cap. A token refused for a change in its creator's place
// is revoked at once (review M3), so it never comes back.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SCRIPT_TOKEN_CLIENT_NAME, SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE, agentXError, singleOrgIdForEnv } from "@rovara-code/contracts";
import { isWriterOrgRole } from "@agentx/cloud-contracts";
import { methodAllowedByEdition, sessionWithinEditionCap } from "../developer/edition-methods.js";
import { readChosenName } from "../developer/chosen-name.js";
import { safeDisplayName } from "../developer/person-name.js";
import { endedByAdmin, endedByUnlink, samlSessionEnded, startedBeforeMethodOn, type DeveloperMarks, type DeveloperRecord } from "../developer/store.js";
import { startIdempotencyKey, taskKey } from "../developer/task-records.js";
import { takeRateAt } from "../developer/page-comments.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { getSignIn } from "../aws/developer-routes/authentication.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { scriptTokensEnabled } from "./switch.js";
import { auditScriptTokenStart, noteScriptTokenUse, readScriptToken, revokeForAccessChange, scriptTokenStatus, type ScriptTokenDependencies, type ScriptTokenRecord } from "./store.js";
import { parseScriptTokenHeader, scriptTokenMatches } from "./token-format.js";

/** Requests one token may make a minute, and task starts an hour. */
export const SCRIPT_TOKEN_REQUESTS_PER_MINUTE = 60;
export const SCRIPT_TOKEN_STARTS_PER_HOUR = 20;
/** Review M1: the same limits across all of one person's tokens, so ten tokens are not ten times the rate. */
export const SCRIPT_TOKEN_CREATOR_REQUESTS_PER_MINUTE = 120;
export const SCRIPT_TOKEN_CREATOR_STARTS_PER_HOUR = 20;

const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASK_READ = new RegExp(`^/v1/dev/tasks/(${TASK_ID})(?:/events)?$`, "u");
/** Decision 46b: a local coding tool reads the project-wide lessons of one project (`aws/developer-routes/lessons-local.ts`). The project is the path's. */
const LESSONS_READ = /^\/v1\/dev\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/lessons$/u;

/** What one allowed request is: the permission it needs and how its project is found. */
type AllowedRoute =
  | { permission: "start"; project: "body" }
  | { permission: "read"; project: "query" }
  | { permission: "read"; project: "task"; taskId: string }
  | { permission: "lessons"; project: "path"; name: string };

/** The whole list of what a script token may call. Anything not here is refused. Exported for the test that pins it. */
export function scriptTokenRoute(method: string, pathname: string): AllowedRoute | undefined {
  if (pathname === "/v1/dev/tasks") {
    if (method === "POST") return { permission: "start", project: "body" };
    if (method === "GET") return { permission: "read", project: "query" };
    return undefined;
  }
  const lessons = method === "POST" ? LESSONS_READ.exec(pathname) : null;
  if (lessons !== null) return { permission: "lessons", project: "path", name: lessons[1]! };
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

/** Whether this person's start with this request id was already made: its idempotency item is there (the same check `startTask` makes). */
async function startAlreadyMade(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName">, developerId: string, requestId: string): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: startIdempotencyKey(developerId, requestId), ConsistentRead: true })) as { Item?: unknown };
  return response.Item !== undefined;
}

/** The start's request id, when the body has a well-formed one (the start route checks it fully). */
function bodyRequestId(request: AdaptedHttpRequest): string | undefined {
  try {
    const value = JSON.parse(request.body ?? "") as { requestId?: unknown };
    return typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.requestId) ? value.requestId : undefined;
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

type CreatorCheck = { ok: true; creator: Pick<DeveloperRecord, "displayName" | "slackUserId" | "email"> } | { ok: false; permanent: boolean };

/**
 * Whether the creator still stands where they stood when they made the token, and whether anything that ends a sign-in session ended it. `permanent` refusals (left, moved, a new
 * role, ended or unlinked sign-in, the method cycled, a SAML cut-off) revoke the token; the others (the method off now, settings that can't be read) only refuse this request.
 */
async function creatorStillHolds(deps: DeveloperRouteDependencies, record: ScriptTokenRecord): Promise<CreatorCheck> {
  const membership = await deps.orgs?.orgForDeveloper(record.developerId);
  if (membership === undefined || membership.orgId !== record.orgId || membership.role !== record.createdRole || !isWriterOrgRole(membership.role)) return { ok: false, permanent: true };
  if (deps.developer.methods[record.amr] !== true || !methodAllowedByEdition(deps.editionPolicy, record.amr)) return { ok: false, permanent: false };
  // The method was turned off and on again after the token was made: every session from before is over, and so is the token.
  if (startedBeforeMethodOn(record.createdAt, deps.developer.since?.[record.amr])) return { ok: false, permanent: true };
  // The edition's session cap (Enterprise: 8 hours) holds for a token too, counted from when it was made.
  if (!sessionWithinEditionCap(deps.editionPolicy, record.createdAt, deps.now())) return { ok: false, permanent: false };
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt"> & DeveloperMarks>(deps, `DEVELOPER#${record.developerId}`);
  if (developer === undefined || developer.revoked || endedByAdmin(record.createdAt, developer.sessionsEndedAt)) return { ok: false, permanent: true };
  if (endedByUnlink({ startedAt: record.createdAt, amr: record.amr, ...(record.identityKey === undefined ? {} : { identityKey: record.identityKey }) }, developer)) return { ok: false, permanent: true };
  if (record.amr === "saml") {
    // As for a SAML session: settings that can't be read, or none, refuse.
    let validFrom: number;
    try {
      validFrom = (await deps.sso?.saml.config.get(singleOrgIdForEnv(deps.developer.env)))?.sessionsValidFrom ?? Number.MAX_SAFE_INTEGER;
    } catch {
      return { ok: false, permanent: false };
    }
    if (validFrom === Number.MAX_SAFE_INTEGER) return { ok: false, permanent: false };
    if (samlSessionEnded({ startedAt: record.createdAt, authTime: record.authTime }, validFrom)) return { ok: false, permanent: true };
  }
  return { ok: true, creator: developer };
}

const storeOf = (deps: DeveloperRouteDependencies): ScriptTokenDependencies => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) });

async function withinRate(deps: DeveloperRouteDependencies, name: string, sk: string, limit: number, windowMs: number, message: string, orgId: string): Promise<void> {
  if (!await takeRateAt(deps, { pk: `ORG#${orgId}#${name}`, sk }, limit, windowMs)) throw agentXError("TOO_MANY_REQUESTS", message);
}

/**
 * Review I3/N1: a token's start always has the fixed client "Script token", whatever the body says: the body is rewritten with the token's own client field before the start reads it
 * (and with the one `project` the scope check read, so a body with two `project` keys starts where it was checked).
 */
function bodyAsToken(request: AdaptedHttpRequest, record: ScriptTokenRecord, project: string): void {
  const value = JSON.parse(request.body!) as Record<string, unknown>;
  request.body = JSON.stringify({ ...value, project, client: SCRIPT_TOKEN_CLIENT_NAME });
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
  // Review M2: the token's rate is taken as soon as it is known, so a revoked or refused token can't be replayed without limit.
  await withinRate(deps, "SCRIPT_TOKEN_RATE", record.tokenId, SCRIPT_TOKEN_REQUESTS_PER_MINUTE, 60_000, "This script token made too many requests. Try again in a minute.", record.orgId);
  const status = scriptTokenStatus(record, deps.now());
  if (status === "revoked") throw agentXError("AUTH_REQUIRED", "This script token was revoked.");
  if (status === "expired") throw agentXError("AUTH_REQUIRED", "This script token has expired. Make a new one in Rovara's settings.");
  const held = await creatorStillHolds(deps, record);
  if (!held.ok) {
    if (held.permanent) await revokeForAccessChange(storeOf(deps), record);
    throw agentXError("AUTH_REQUIRED", "This script token stopped working because its creator's access changed. Make a new one in Rovara's settings.");
  }
  const creator = held.creator;
  await withinRate(deps, "SCRIPT_TOKEN_CREATOR_RATE", record.developerId, SCRIPT_TOKEN_CREATOR_REQUESTS_PER_MINUTE, 60_000, "Your script tokens made too many requests. Try again in a minute.", record.orgId);

  const route = scriptTokenRoute(request.method, url.pathname);
  if (route === undefined || !record.permissions.includes(route.permission)) throw notAllowed();
  const project = route.project === "body" ? bodyProject(request) : route.project === "query" ? url.searchParams.get("project") ?? undefined : route.project === "path" ? route.name : undefined;
  if (route.project !== "task" && (project === undefined || !record.projects.includes(project))) throw notAllowed();
  if (route.project === "task") {
    // A task outside the token's projects (or company) answers as a missing task does, so a token learns nothing about it.
    const scope = await taskScopeOf(deps, route.taskId);
    if (scope === undefined || scope.orgId !== record.orgId || !record.projects.includes(scope.project)) throw agentXError("NOT_FOUND", "task not found");
  }
  if (route.permission === "start") {
    // Review N2: a retry of a start already made (same request id, after a 503) starts nothing new, so it is not charged to the start limits again.
    const requestId = bodyRequestId(request);
    if (requestId === undefined || !await startAlreadyMade(deps, record.developerId, requestId)) {
      await withinRate(deps, "SCRIPT_TOKEN_START_RATE", record.tokenId, SCRIPT_TOKEN_STARTS_PER_HOUR, 3_600_000, "This script token started too many tasks in the last hour. Try again later.", record.orgId);
      await withinRate(deps, "SCRIPT_TOKEN_CREATOR_START_RATE", record.developerId, SCRIPT_TOKEN_CREATOR_STARTS_PER_HOUR, 3_600_000, "Your script tokens started too many tasks in the last hour. Try again later.", record.orgId);
    }
    bodyAsToken(request, record, project!);
  }
  await noteScriptTokenUse(storeOf(deps), record, route.permission);
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
    scriptToken: { tokenId: record.tokenId, name: record.name, permissions: record.permissions, projects: record.projects },
  };
}

/** After a token's start answered: the start's own audit event (review I3), when the answer names a task. Nothing for any other caller or route. */
export async function auditScriptTokenTaskStart(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, pathname: string, answer: unknown): Promise<void> {
  if (caller.scriptToken === undefined || method !== "POST" || pathname !== "/v1/dev/tasks") return;
  const taskId = (answer as { task?: { taskId?: unknown } } | undefined)?.task?.taskId;
  if (typeof taskId !== "string") return;
  await auditScriptTokenStart(storeOf(deps), { orgId: caller.orgId, tokenId: caller.scriptToken.tokenId, developerId: caller.developerId }, taskId);
}
