// Company memberships (srv/company-memberships; briefs/company-memberships-api.md sections 2, 5 and 7): the caller's LIVE memberships, and the company a browser session is in.
//
// WHAT A MEMBERSHIP IS, read fresh on every call (never cached):
//   - a developer pointer in the person's own partition `DEVELOPER_ORG#<developer>`: the legacy `ORG` item (the PRIMARY: the company every sign-in token, Slack and the CLI use, and the one each of the
//     broker's other `orgForDeveloper` callers still assumes), or a per-membership `ORG#<org>` item (brief section 7 step 1: readers before writers; NOTHING writes one yet, so today every person has
//     exactly the primary);
//   - AND the company's member record (`ORG#<org>` / `MEMBER#<developer>`) with a role this release knows: the role always comes from here, never from the pointer;
//   - AND no ban (`ORG#<org>#BAN` / <developer>), and the company exists and is not closed;
//   - AND, for the Auditor, an edition that has the role.
// A person who is removed or banned loses the member record (the ban is checked too), so they lose that company on their very next request.
//
// THE SESSION'S ACTIVE COMPANY. The broker may only READ the sign-in table (R13), so a browser session's chosen company is an item in the State table, keyed by a SHA-256 of the session id (the cookie value is never a key):
// `WEB_ACTIVE_COMPANY#<sha256(session)>` / `META`, holding the company, the developer it was chosen by, a revision that fences every switch, and an expiry with the session. It is the session's switch history too
// (owner decision 91: a switch is recorded in the sign-in history only, never in a company's audit ledger): when, which request, how many switches.
// No item, or an item naming the primary: the session is in the primary, exactly as before this lane. An item naming another company that is a live membership: the session is in that company, with that company's role.
// An item naming a company that is no longer a live membership (removed, banned, closed): the session falls back to the primary at once and the item is rewritten to name the primary with its reload marker set, so
// a later re-invite never moves an open tab silently back into it, a page that names the lost company in `x-rovara-company` is refused CSRF_STALE and reloads into the primary, and a page that names none may not
// write until it reloads (header.ts). A switch sets the same marker.
// With the switch `cw` off none of this is read: everyone is in the primary.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, type OrgId } from "@rovara-code/contracts";
import { COMPANIES_MAX, OrgRoleSchema, developerOrgKey, orgBanKey, orgMemberKey, orgMetaKey, type EditionPolicy, type OrgRole } from "@agentx/cloud-contracts";
import { auditorAllowedByEdition } from "../auditor.js";
import { safeOrgName } from "../../developer/person-name.js";
import { logDeveloperEvent } from "../../developer/log.js";

type Item = Record<string, unknown>;
export interface CompanyReadDeps { documentClient: { send(command: never): Promise<unknown> }; tableName: string; editionPolicy?: EditionPolicy | undefined }

/** One live membership, as the companies list and the session check read it. */
export interface LiveMembership { orgId: OrgId; role: OrgRole; joinedAt: string; name: string; status: "open" | "closing"; primary: boolean }

const POINTER_PREFIX = "ORG";
/** The per-membership pointer (brief section 7). Read here; written by nothing yet. */
export function developerMembershipKey(developerId: string, orgId: OrgId): { pk: string; sk: string } {
  return { pk: developerOrgKey(developerId).pk, sk: `ORG#${orgId}` };
}
const sessionHash = (sessionId: string): string => createHash("sha256").update(sessionId, "utf8").digest("hex");
/** The session's chosen company. */
export function activeCompanyKey(sessionId: string): { pk: string; sk: string } {
  return { pk: `WEB_ACTIVE_COMPANY#${sessionHash(sessionId)}`, sk: "META" };
}
/** A switch request already served (a day), keyed by the person and their request id. */
export function companySwitchRequestKey(developerId: string, requestId: string): { pk: string; sk: string } {
  return { pk: `COMPANY_SWITCH_REQUEST#${developerId}`, sk: requestId };
}
/** The person's switch rate window. */
export function companySwitchRateKey(developerId: string): { pk: string; sk: string } {
  return { pk: `COMPANY_SWITCHES#${developerId}`, sk: "ALL" };
}

const send = <T>(deps: CompanyReadDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;
async function getItem(deps: CompanyReadDeps, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return (await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))).Item;
}

/** The companies the person's pointers name: the primary (legacy `ORG` item) and any per-membership items. A pointer whose company id does not read, or whose item disagrees with its key, names nothing. */
export async function pointerCompanies(deps: CompanyReadDeps, developerId: string): Promise<{ primary: OrgId | undefined; others: OrgId[] }> {
  const items: Item[] = [];
  let start: Item | undefined;
  // Bounded: a few pages at most (COMPANIES_MAX memberships plus the legacy item).
  for (let page = 0; page < 4; page += 1) {
    const answer = await send<{ Items?: Item[]; LastEvaluatedKey?: Item }>(deps, new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": developerOrgKey(developerId).pk, ":prefix": POINTER_PREFIX },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    items.push(...(answer.Items ?? []));
    start = answer.LastEvaluatedKey;
    if (start === undefined) break;
  }
  let primary: OrgId | undefined;
  const others: OrgId[] = [];
  for (const item of items) {
    const orgId = OrgIdSchema.safeParse(item.orgId);
    if (!orgId.success) continue;
    if (item.sk === POINTER_PREFIX) primary = orgId.data;
    else if (item.sk === `ORG#${orgId.data}`) others.push(orgId.data);
  }
  return { primary, others: [...new Set(others)].filter((orgId) => orgId !== primary) };
}

/**
 * The person's standing in one company NOW, from the company's own records: the member record with a known role, no ban, the company open or closing (not closed or gone), and the Auditor only where the edition
 * has it. `undefined` when any of that fails. Does not look at the pointer: callers that need it (`liveMembershipOf`) check it themselves.
 */
async function standingIn(deps: CompanyReadDeps, developerId: string, orgId: OrgId): Promise<Omit<LiveMembership, "primary"> | undefined> {
  const [member, ban, org] = await Promise.all([getItem(deps, orgMemberKey(orgId, developerId)), getItem(deps, orgBanKey(orgId, developerId)), getItem(deps, orgMetaKey(orgId))]);
  if (member === undefined || ban !== undefined || org === undefined || org.closedAt !== undefined) return undefined;
  const role = OrgRoleSchema.safeParse(member.role);
  if (!role.success) return undefined;
  if (role.data === "auditor" && !auditorAllowedByEdition(deps.editionPolicy)) return undefined;
  const name = typeof org.name === "string" ? safeOrgName(org.name) : "";
  return { orgId, role: role.data, joinedAt: typeof member.joinedAt === "string" ? member.joinedAt : "", name: name === "" ? "Your company" : name, status: org.closingAt === undefined ? "open" : "closing" };
}

/** Every live membership of the person, the primary first, at most COMPANIES_MAX. */
export async function liveMembershipsOf(deps: CompanyReadDeps, developerId: string): Promise<LiveMembership[]> {
  const pointers = await pointerCompanies(deps, developerId);
  const ids = [...(pointers.primary === undefined ? [] : [pointers.primary]), ...pointers.others].slice(0, COMPANIES_MAX);
  const found = await Promise.all(ids.map(async (orgId) => {
    const standing = await standingIn(deps, developerId, orgId);
    return standing === undefined ? undefined : { ...standing, primary: orgId === pointers.primary };
  }));
  return found.filter((membership): membership is LiveMembership => membership !== undefined);
}

/** The person's live membership of ONE company: a pointer that names it (the primary, or its own per-membership item) and a live standing. */
export async function liveMembershipOf(deps: CompanyReadDeps, developerId: string, orgId: OrgId): Promise<LiveMembership | undefined> {
  const [primary, own] = await Promise.all([getItem(deps, developerOrgKey(developerId)), getItem(deps, developerMembershipKey(developerId, orgId))]);
  const isPrimary = primary?.orgId === orgId;
  if (!isPrimary && own?.orgId !== orgId) return undefined;
  const standing = await standingIn(deps, developerId, orgId);
  return standing === undefined ? undefined : { ...standing, primary: isPrimary };
}

/** What the session's item says, read consistently. A store fault refuses the request (503): the broker does not guess which company a request is in. */
export interface ActiveCompanyItem { orgId: OrgId; developerId: string; revision: number; switches: number; reloadNeeded: boolean }
export async function readActiveCompany(deps: CompanyReadDeps, sessionId: string): Promise<ActiveCompanyItem | undefined> {
  let item: Item | undefined;
  try { item = await getItem(deps, activeCompanyKey(sessionId)); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "Your company could not be read. Try again shortly."); }
  if (item === undefined) return undefined;
  const orgId = OrgIdSchema.safeParse(item.orgId);
  if (!orgId.success || typeof item.developerId !== "string" || typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 1) {
    // An item that does not read is never a company: the session is signed out (fail closed) rather than put somewhere by a guess.
    throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
  }
  return { orgId: orgId.data, developerId: item.developerId, revision: item.revision, switches: typeof item.switches === "number" ? item.switches : 0, reloadNeeded: item.reloadNeeded === true };
}

/**
 * The session's RELOAD MARKER (Opus review M1). Set when the session's company changes under its open pages: a switch, or the chosen company lost (removed, banned, closed). While it is set, a browser WRITE
 * without `x-rovara-company` is refused CSRF_STALE (header.ts), whatever the company's `companies` flag says, so an old tab that does not name its company never acts in the company the session moved to.
 * One of the reads a page makes when it loads (navigation, `/me`, the companies list) clears it. `revision` is the item's, so a clear never removes a newer marker.
 */
export interface CompanyReloadMarker { revision: number }

/**
 * The company a browser session is in, given the caller its sign-in pointer gave (the primary). Called for cookie sessions only (`authenticateDeveloperSessionId`), and only while `cw` is on.
 * Returns the caller unchanged, or moved to the session's chosen company with THAT company's role, with `companyReload` while the reload marker is set. A chosen company that is no longer a live membership gives the
 * primary: the item is rewritten to name the primary with the marker set (best effort), so a later re-invite never moves an open tab back and an old tab's headerless write is refused until it reloads.
 */
export async function sessionCompany<Caller extends { developerId: string; sessionId: string; orgId: OrgId; orgRole: OrgRole }>(deps: CompanyReadDeps, caller: Caller): Promise<Caller & { companyReload?: CompanyReloadMarker }> {
  const chosen = await readActiveCompany(deps, caller.sessionId);
  if (chosen === undefined) return caller;
  if (chosen.developerId !== caller.developerId) throw agentXError("AUTH_REQUIRED", "Sign in to continue.");
  const marked = <T extends Caller>(who: T) => (chosen.reloadNeeded ? { ...who, companyReload: { revision: chosen.revision } } : who);
  if (chosen.orgId === caller.orgId) return marked(caller);
  let membership: LiveMembership | undefined;
  try { membership = await liveMembershipOf(deps, caller.developerId, chosen.orgId); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "Your company could not be read. Try again shortly."); }
  if (membership !== undefined) return marked({ ...caller, orgId: membership.orgId, orgRole: membership.role });
  logDeveloperEvent({ event: "developer.active_company_lost" });
  let revision = chosen.revision;
  try {
    await send(deps, new UpdateCommand({
      TableName: deps.tableName, Key: activeCompanyKey(caller.sessionId), UpdateExpression: "SET orgId = :primary, reloadNeeded = :yes, revision = :next",
      ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":primary": caller.orgId, ":yes": true, ":next": chosen.revision + 1, ":revision": chosen.revision },
    }));
    revision = chosen.revision + 1;
  } catch { /* Best effort: the next request finds the same lost company and tries again; this request is refused a headerless write all the same. */ }
  return { ...caller, companyReload: { revision } };
}

/** Clears the reload marker the request saw (a page loaded). Best effort and fenced on the revision read: a newer switch's marker stays. */
export async function clearCompanyReload(deps: CompanyReadDeps, sessionId: string, marker: CompanyReloadMarker): Promise<void> {
  try {
    await send(deps, new UpdateCommand({ TableName: deps.tableName, Key: activeCompanyKey(sessionId), UpdateExpression: "REMOVE reloadNeeded", ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": marker.revision } }));
  } catch { /* The marker stays: the next page read clears it. */ }
}
