// Company memberships (srv/company-memberships; briefs/company-memberships-api.md sections 3 to 6, owner decision 91): `/v1/app/companies`, while the switch `cw` is on (off: not found, as any unknown path).
//
//   GET  /v1/app/companies   the caller's OWN live memberships: name, role, when they joined, which one is active. A browser session lists them all; a token lists the one company it is bound to.
//   POST /v1/app/companies   { action: "switch", companyId, requestId }   from a live browser session only: this session's active company becomes `companyId`.
//
// Nothing about another person is read or answered, and nothing is read inside a company the session is not in but its name and the caller's own role there.
// THE SWITCH. Allowed only to a company the caller is a live member of now (org/companies/memberships.ts: a pointer that names it, the company's member record, no ban, the company not closed). A company they were
// removed or banned from is 403 REMOVED_FROM_ORG (they know that already); any other id, a company that does not exist included, is 404 with the same words, so a guessed id learns nothing. The session's item, the
// request item and checks on everything the decision read (the member record and its role, no ban, the pointer, the company open) are ONE transaction, fenced on the session item's revision: a removal or a second
// tab's switch that lands in between gives a clear refusal, never a switch into a company the person just lost. A repeat of the same `requestId` and body writes nothing and answers the session as it is now; the same
// `requestId` with another body is 409 IDEMPOTENCY_CONFLICT. 20 switches an hour per person. No fresh sign-in is asked for (the brief asks none), the CSRF token stays the session's (it is bound to the session, not
// the company), and other tabs are kept honest by `x-rovara-company` (org/companies/header.ts). Owner decision 91: a switch is recorded in the session's own record (its switch count, time and request), never in a
// company's audit ledger.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANIES_MAX, COMPANY_SWITCH_MACHINE_MESSAGE, CompanySwitchBodySchema, developerOrgKey, orgBanKey, orgMemberKey, orgMetaKey, orgRemovedKey, type CompaniesAnswer, type CompanySwitchAnswer } from "@agentx/cloud-contracts";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, type OrgId } from "@rovara-code/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { takeRateAt } from "../../developer/page-comments.js";
import type { SessionRecord } from "../../developer/store.js";
import { activeCompanyKey, companySwitchRateKey, companySwitchRequestKey, developerMembershipKey, liveMembershipOf, liveMembershipsOf, readActiveCompany, type CompanyReadDeps, type LiveMembership } from "../../org/companies/memberships.js";
import { companySwitcherEnabled } from "../../org/companies/switch.js";
import { REMOVED_FROM_ORG_MESSAGE } from "../../org/sign-in.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { getAppMe, jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const COMPANIES_PATH = "/v1/app/companies";
/** Switches an hour, per person (brief section 6). */
export const COMPANY_SWITCHES_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const REQUEST_SECONDS = 86_400;
const NOT_FOUND_MESSAGE = "That company was not found.";
const BODY_MESSAGE = "The request names an action this route does not take, or has a field it does not have.";
const STALE_MESSAGE = "Your company was changed at the same time in another tab. Reload and try again.";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
const readDeps = (deps: DeveloperRouteDependencies): CompanyReadDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, editionPolicy: deps.editionPolicy });
const send = <T>(deps: DeveloperRouteDependencies, command: unknown): Promise<T> => deps.documentClient.send(command) as Promise<T>;
const hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The list as the answer carries it: the active company first, then by name. */
function listed(memberships: LiveMembership[], active: OrgId): CompaniesAnswer["companies"] {
  const rows = memberships.map((membership) => ({ companyId: membership.orgId, name: membership.name, role: membership.role, joinedAt: membership.joinedAt, active: membership.orgId === active, status: membership.status }));
  return rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "en") || a.companyId.localeCompare(b.companyId)).slice(0, COMPANIES_MAX);
}

/** The caller's companies. The request's company is always among them (it was re-checked on this request); if a removal raced the request, the caller signs in again rather than being shown a list without it. */
async function companiesOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<CompaniesAnswer["companies"]> {
  const memberships = caller.browserSession === true
    ? await liveMembershipsOf(readDeps(deps), caller.developerId)
    : [await liveMembershipOf(readDeps(deps), caller.developerId, caller.orgId)].filter((membership): membership is LiveMembership => membership !== undefined);
  if (!memberships.some((membership) => membership.orgId === caller.orgId)) throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
  return listed(memberships, caller.orgId);
}

async function listAnswer(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<CompaniesAnswer> {
  return { activeCompanyId: caller.orgId, companies: await companiesOf(deps, caller), limits: { maxCompanies: COMPANIES_MAX }, canCreate: false, canJoinByInvite: false };
}

/** The answer of a switch, for the session as it is now (`orgId` and `orgRole` are the active company's). */
async function switchAnswer(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<CompanySwitchAnswer> {
  return { status: "done", activeCompanyId: caller.orgId, companies: await companiesOf(deps, caller), me: await getAppMe(deps, caller) };
}

/** Why `companyId` cannot be switched to: REMOVED_FROM_ORG for a company that removed (or banned) this person, NOT_FOUND for anything else. */
async function refusal(deps: DeveloperRouteDependencies, developerId: string, orgId: OrgId): Promise<Error> {
  const removed = (await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: orgRemovedKey(orgId, developerId), ConsistentRead: true }))).Item;
  return removed === undefined ? agentXError("NOT_FOUND", NOT_FOUND_MESSAGE) : agentXError("REMOVED_FROM_ORG", REMOVED_FROM_ORG_MESSAGE);
}

/** The session as it is now, read again after a switch or a replay: the active company and its role, re-checked as a live membership. */
async function sessionNow(deps: DeveloperRouteDependencies, caller: DeveloperCaller, fallback: LiveMembership | undefined): Promise<DeveloperCaller> {
  const chosen = await readActiveCompany(readDeps(deps), caller.sessionId);
  if (chosen === undefined) return caller;
  const membership = chosen.orgId === fallback?.orgId ? fallback : await liveMembershipOf(readDeps(deps), caller.developerId, chosen.orgId);
  return membership === undefined ? caller : { ...caller, orgId: membership.orgId, orgRole: membership.role };
}

async function switchCompany(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<CompanySwitchAnswer> {
  const parsed = CompanySwitchBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", BODY_MESSAGE);
  const { companyId, requestId } = parsed.data;
  const target = companyId;
  const requestKey = companySwitchRequestKey(caller.developerId, requestId);
  const digest = hex(JSON.stringify({ session: activeCompanyKey(caller.sessionId).pk, action: "switch", companyId }));
  const replay = async (): Promise<boolean> => {
    const previous = (await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: requestKey, ConsistentRead: true }))).Item;
    if (previous === undefined) return false;
    if (previous.digest !== digest) throw agentXError("IDEMPOTENCY_CONFLICT", "That request was already used for a different change.");
    return true;
  };
  // A repeat writes nothing and answers the session as it is now (a later switch elsewhere is not undone by a late repeat).
  if (await replay()) return switchAnswer(deps, await sessionNow(deps, caller, undefined));
  const membership = await liveMembershipOf(readDeps(deps), caller.developerId, target);
  if (membership === undefined) throw await refusal(deps, caller.developerId, target);
  let accepted: boolean;
  try { accepted = await takeRateAt({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, companySwitchRateKey(caller.developerId), COMPANY_SWITCHES_PER_HOUR, HOUR_MS); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The switch could not be saved. Try again."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many company switches. Try again later.");
  const session = await getSignIn<Pick<SessionRecord, "endsAt" | "developerId">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || session.developerId !== caller.developerId || typeof session.endsAt !== "number") throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
  const current = await readActiveCompany(readDeps(deps), caller.sessionId);
  if (current !== undefined && current.developerId !== caller.developerId) throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
  const at = new Date(deps.now()).toISOString(), nowSeconds = Math.floor(deps.now() / 1000);
  const sessionKey = activeCompanyKey(caller.sessionId);
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...sessionKey, entityType: "WEB_ACTIVE_COMPANY", orgId: target, developerId: caller.developerId, revision: (current?.revision ?? 0) + 1, switches: (current?.switches ?? 0) + 1, switchedAt: at, requestId, [INDEX_EXPIRY_ATTRIBUTE]: session.endsAt + REQUEST_SECONDS },
      ...(current === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": current.revision } }) } },
    { Put: { TableName: deps.tableName, Item: { ...requestKey, entityType: "COMPANY_SWITCH_REQUEST", digest, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + REQUEST_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" } },
    // What the decision read, held for the write: the member record with the same role, no ban, the pointer that names the company, the company not closed.
    { ConditionCheck: { TableName: deps.tableName, Key: orgMemberKey(target, caller.developerId), ConditionExpression: "attribute_exists(pk) AND #role = :role", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": membership.role } } },
    { ConditionCheck: { TableName: deps.tableName, Key: orgBanKey(target, caller.developerId), ConditionExpression: "attribute_not_exists(pk)" } },
    { ConditionCheck: { TableName: deps.tableName, Key: membership.primary ? developerOrgKey(caller.developerId) : developerMembershipKey(caller.developerId, target), ConditionExpression: "orgId = :org", ExpressionAttributeValues: { ":org": target } } },
    { ConditionCheck: { TableName: deps.tableName, Key: orgMetaKey(target), ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)" } },
  ];
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw agentXError("RUNTIME_UNAVAILABLE", "The switch could not be saved. Try again.");
    // A cancellation can hide a write that went through: read again before deciding.
    if (await replay()) return switchAnswer(deps, await sessionNow(deps, caller, undefined));
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons ?? [];
    if (reasons.slice(2).some((reason) => reason?.Code === "ConditionalCheckFailed")) throw await refusal(deps, caller.developerId, target);
    if (reasons[0]?.Code === "ConditionalCheckFailed") throw agentXError("CHANGE_STALE", STALE_MESSAGE);
    throw agentXError("RUNTIME_UNAVAILABLE", "The switch could not be saved. Try again.");
  }
  logDeveloperEvent({ event: "developer.company_switched", same: String(target === caller.orgId) });
  return switchAnswer(deps, await sessionNow(deps, caller, membership));
}

/** The reply, or undefined when the path is not this one. */
export async function routeCompanies(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, pathname: string, environment: Record<string, string | undefined> = process.env): Promise<unknown> {
  if (pathname !== COMPANIES_PATH) return undefined;
  if (!companySwitcherEnabled(environment) || (request.method !== "GET" && request.method !== "POST")) throw agentXError("NOT_FOUND", "route not found");
  if (request.method === "GET") return listAnswer(deps, caller);
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", COMPANY_SWITCH_MACHINE_MESSAGE);
  return switchCompany(deps, caller, request);
}
