// TRW-4 (owner, 2026-11-02): the Team record keeps only what it can erase. A tracker author (Linear, Jira) counts only when the company has linked that author id to a Rovara person.
// The link is made at connect or sign-in time (`linkTrackerIdentity`, called from the connect and sign-in flows), or by an email the tracker reports as VERIFIED (`linkTrackerByVerifiedEmail`,
// never an unverified one). Links live in the org's own record partition (so a company erase takes them) as two items: the forward one (author id -> person) and a reverse one under a hash of
// the person (person -> author ids), which is how a person erase finds them and removes them.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { recordDeveloperHash } from "@agentx/cloud-contracts";
import { replaceEmailAddresses, teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { isErasedActor } from "./erased.js";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export type TrackerLinkVia = "connect" | "signin" | "verified_email" | "admin" | "auto";
export interface TrackerLink { system: string; sourceId: string }

const SYSTEM = /^(linear|jira:[a-z0-9][a-z0-9.-]{0,252})$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
export const LINK_PREFIX = "TRLINK#";
export const LINK_BY_PERSON_PREFIX = "TRLINKDEV#";
/** Tool users nobody is linked to (display name and tool id only: never an email), for the admin mapping page. */
export const UNMATCHED_PREFIX = "TRUNMATCHED#";
/** A tool user an admin unmapped: the automatic linker leaves them alone until an admin maps them again. Ids only. */
export const UNMAPPED_PREFIX = "TRUNMAP#";

/** Whether a source system is one the company links authors for here (the trackers). */
export const isTrackerSystem = (system: string): boolean => SYSTEM.test(system);

const forwardKey = (orgId: OrgId, link: TrackerLink): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${LINK_PREFIX}${link.system}#${link.sourceId}` });
const personPrefix = (developerId: string): string => `${LINK_BY_PERSON_PREFIX}${recordDeveloperHash(developerId)}#`;
const reverseKey = (orgId: OrgId, developerId: string, link: TrackerLink): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${personPrefix(developerId)}${link.system}#${link.sourceId}` });

export interface OrgMembershipPort {
  /** The org the developer belongs to (`OrgStore.orgForDeveloper`). */
  orgOfDeveloper(developerId: string): Promise<OrgId | undefined>;
}

/**
 * Links a tracker author id to a person of the org. Refused (false) for an id that is not well formed, a person who is not a member of THIS org (a link in this org's partition to another org's person
 * would put that person's id on rows that their own org's erase never reaches), or a person who has been erased. A second link for the same author id replaces the first.
 */
export async function linkTrackerIdentity(table: TeamRecordTable, orgId: OrgId, input: TrackerLink & { developerId: string; via: TrackerLinkVia; at: string; displayName?: string | undefined; why?: string | undefined }, members: OrgMembershipPort): Promise<boolean> {
  if (!SYSTEM.test(input.system) || !SOURCE_ID.test(input.sourceId) || input.developerId === "") return false;
  if ((await members.orgOfDeveloper(input.developerId)) !== orgId) return false;
  if (await isErasedActor(table, orgId, input.system, { sourceId: input.sourceId, developerId: input.developerId })) return false;
  const existing = await developerOfTrackerAuthor(table, orgId, input);
  if (existing !== undefined && existing !== input.developerId) await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: reverseKey(orgId, existing, input) }));
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...forwardKey(orgId, input), entityType: "TEAM_RECORD_TRACKER_LINK", orgId, developerId: input.developerId, via: input.via, at: input.at, ...(input.displayName === undefined ? {} : { displayName: shownName(input.displayName, input.sourceId) }), ...(input.why === undefined ? {} : { why: input.why.slice(0, 60) }) } }));
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...reverseKey(orgId, input.developerId, input), entityType: "TEAM_RECORD_TRACKER_LINK_BY_PERSON", orgId, system: input.system, sourceId: input.sourceId, at: input.at } }));
  return true;
}

export interface VerifiedEmailDependencies extends OrgMembershipPort {
  /** The org member whose VERIFIED email this is (`OrgStore.developerForVerifiedEmail`). */
  developerForVerifiedEmail(email: string): Promise<string | undefined>;
}

/**
 * Links a tracker author by an email the TRACKER reported as verified. `emailVerified` must be exactly `true`: a tracker that does not say, or says no, links nothing. The person must be a member of THIS org.
 * Returns whether a link was made.
 */
export async function linkTrackerByVerifiedEmail(table: TeamRecordTable, deps: VerifiedEmailDependencies, orgId: OrgId, input: TrackerLink & { email: string; emailVerified: boolean | undefined; at: string; displayName?: string | undefined; via?: "verified_email" | "auto"; why?: string | undefined }): Promise<boolean> {
  if (input.emailVerified !== true || input.email === "") return false;
  const developerId = await deps.developerForVerifiedEmail(input.email);
  if (developerId === undefined || (await deps.orgOfDeveloper(developerId)) !== orgId) return false;
  return linkTrackerIdentity(table, orgId, { system: input.system, sourceId: input.sourceId, developerId, via: input.via ?? "verified_email", at: input.at, ...(input.displayName === undefined ? {} : { displayName: input.displayName }), ...(input.why === undefined ? {} : { why: input.why }) }, deps);
}

/** The person an author id is linked to, or undefined. */
export async function developerOfTrackerAuthor(table: TeamRecordTable, orgId: OrgId, link: TrackerLink): Promise<string | undefined> {
  if (!SYSTEM.test(link.system) || !SOURCE_ID.test(link.sourceId)) return undefined;
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: forwardKey(orgId, link), ConsistentRead: true }))) as { Item?: { developerId?: unknown } }).Item;
  return typeof item?.developerId === "string" ? item.developerId : undefined;
}

/** Every tracker author id a person is linked to (bounded). */
export async function trackerLinksOf(table: TeamRecordTable, orgId: OrgId, developerId: string): Promise<TrackerLink[]> {
  const found = await queryPrefix(table, orgId, undefined, personPrefix(developerId), 200);
  return found.items.flatMap((item) => (typeof item.system === "string" && typeof item.sourceId === "string" ? [{ system: item.system, sourceId: item.sourceId }] : []));
}

/** Removes every link of a person (both items of each). Returns whether none is left. */
export async function removeTrackerLinks(table: TeamRecordTable, orgId: OrgId, developerId: string): Promise<boolean> {
  const found = await queryPrefix(table, orgId, undefined, personPrefix(developerId), 200);
  for (const item of found.items) {
    if (typeof item.system !== "string" || typeof item.sourceId !== "string" || typeof item.sk !== "string") continue;
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: forwardKey(orgId, { system: item.system, sourceId: item.sourceId }) }));
    await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(orgId), sk: item.sk } }));
  }
  const forgotten = await forgetUnmappedTrackerUsersOf(table, orgId, developerId);
  return !found.truncated && forgotten;
}

/** A person's erase also takes what an unmap of their tool users left: the "unmapped" marks and the unmatched entries that name the hash of the person they were unmapped from. Returns whether none is left. */
async function forgetUnmappedTrackerUsersOf(table: TeamRecordTable, orgId: OrgId, developerId: string): Promise<boolean> {
  const hash = recordDeveloperHash(developerId);
  let complete = true;
  for (const prefix of [UNMAPPED_PREFIX, UNMATCHED_PREFIX]) {
    const found = await queryPrefix(table, orgId, undefined, prefix, 2_000);
    complete &&= !found.truncated;
    for (const item of found.items) if (item.formerDeveloperHash === hash && typeof item.sk === "string") await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(orgId), sk: item.sk } }));
  }
  return complete;
}

// ---- Tracker people nobody is linked to, and the admin's mapping of them (lane team-record-links)

/** A tool user's name as the admin page may show it: control characters out, an email address in it hidden, cut to 100 characters. The tool id stands in when nothing is left. */
export function shownName(name: string | undefined, fallback: string): string {
  const clean = replaceEmailAddresses(name ?? "", "[email]").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return [...(clean === "" ? fallback : clean)].slice(0, 100).join("");
}

const unmatchedKey = (orgId: OrgId, link: TrackerLink): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${UNMATCHED_PREFIX}${link.system}#${link.sourceId}` });
const unmappedKey = (orgId: OrgId, link: TrackerLink): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${UNMAPPED_PREFIX}${link.system}#${link.sourceId}` });
const validLink = (link: TrackerLink): boolean => SYSTEM.test(link.system) && SOURCE_ID.test(link.sourceId);

export interface UnmatchedTrackerUser { system: string; sourceId: string; displayName: string; seenAt: string; /** Why automatic linking did not link them (a fixed code; see `tracker-autolink.ts`). */ reason?: string }

/**
 * Records a tool user nobody is linked to. Only the name the tool showed and the tool's own id are kept: never an email. An update, not a replacement, so what an unmap left on the entry (the hash of the
 * person it was unmapped from, which their erase looks for) stays.
 */
export async function noteUnmatchedTrackerUser(table: TeamRecordTable, orgId: OrgId, input: TrackerLink & { displayName: string; at: string; formerDeveloperHash?: string; reason?: string }): Promise<void> {
  if (!validLink(input)) return;
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: unmatchedKey(orgId, input),
    UpdateExpression: `SET entityType = :type, orgId = :org, #system = :system, sourceId = :id, displayName = :name, seenAt = :at${input.formerDeveloperHash === undefined ? "" : ", formerDeveloperHash = :former"}${input.reason === undefined ? "" : ", reason = :reason"}`,
    ExpressionAttributeNames: { "#system": "system" },
    ExpressionAttributeValues: { ":type": "TEAM_RECORD_TRACKER_UNMATCHED", ":org": orgId, ":system": input.system, ":id": input.sourceId, ":name": shownName(input.displayName, input.sourceId), ":at": input.at, ...(input.formerDeveloperHash === undefined ? {} : { ":former": input.formerDeveloperHash }), ...(input.reason === undefined ? {} : { ":reason": input.reason.slice(0, 40) }) },
  }));
}

export async function clearUnmatchedTrackerUser(table: TeamRecordTable, orgId: OrgId, link: TrackerLink): Promise<void> {
  if (!validLink(link)) return;
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: unmatchedKey(orgId, link) }));
}

/** The tool users nobody is linked to, oldest id first, up to `limit`. `truncated` says there are more. */
export async function listUnmatchedTrackerUsers(table: TeamRecordTable, orgId: OrgId, limit = 500): Promise<{ users: UnmatchedTrackerUser[]; truncated: boolean }> {
  const found = await queryPrefix(table, orgId, undefined, UNMATCHED_PREFIX, limit);
  const users = found.items.flatMap((item) => (typeof item.system === "string" && typeof item.sourceId === "string" && typeof item.displayName === "string" && typeof item.seenAt === "string" ? [{ system: item.system, sourceId: item.sourceId, displayName: item.displayName, seenAt: item.seenAt, ...(typeof item.reason === "string" ? { reason: item.reason } : {}) }] : []));
  return { users, truncated: found.truncated };
}

/** After a complete read of one tool's users: the ones it no longer lists (a deactivated account) leave the list. */
export async function pruneUnmatchedTrackerUsers(table: TeamRecordTable, orgId: OrgId, system: string, seenBefore: string): Promise<number> {
  const found = await queryPrefix(table, orgId, undefined, `${UNMATCHED_PREFIX}${system}#`, 2_000);
  let pruned = 0;
  for (const item of found.items) {
    if (typeof item.sk === "string" && typeof item.seenAt === "string" && item.seenAt < seenBefore) {
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(orgId), sk: item.sk } }));
      pruned += 1;
    }
  }
  return pruned;
}

/** Whether an admin unmapped this tool user (the automatic linker then leaves them alone). */
export async function isAutoLinkSuppressed(table: TeamRecordTable, orgId: OrgId, link: TrackerLink): Promise<boolean> {
  if (!validLink(link)) return true;
  return ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: unmappedKey(orgId, link), ConsistentRead: true }))) as { Item?: unknown }).Item !== undefined;
}

export interface LinkedTrackerUser { system: string; sourceId: string; developerId: string; displayName: string; via: string; at: string; /** Why the automatic linker linked them (a fixed code), when it did. */ why?: string }

/** The tool users linked to a person of the org, with how: for the admin page (so it can unmap one). Bounded. */
export async function listLinkedTrackerUsers(table: TeamRecordTable, orgId: OrgId, limit = 500): Promise<{ users: LinkedTrackerUser[]; truncated: boolean }> {
  const found = await queryPrefix(table, orgId, undefined, LINK_PREFIX, limit);
  const users = found.items.flatMap((item) => (item.entityType === "TEAM_RECORD_TRACKER_LINK" && typeof item.sk === "string" && typeof item.developerId === "string"
    ? [{ ...splitLinkKey(item.sk), developerId: item.developerId, displayName: typeof item.displayName === "string" ? item.displayName : "", via: typeof item.via === "string" ? item.via : "", at: typeof item.at === "string" ? item.at : "", ...(typeof item.why === "string" ? { why: item.why } : {}) }] : []));
  return { users: users.flatMap((user) => (user.system === "" ? [] : [user])), truncated: found.truncated };
}

function splitLinkKey(sk: string): { system: string; sourceId: string } {
  const rest = sk.slice(LINK_PREFIX.length);
  // The system never holds a `#` (`linear`, `jira:<host>`); the id follows the first one.
  const at = rest.indexOf("#");
  return at <= 0 ? { system: "", sourceId: "" } : { system: rest.slice(0, at), sourceId: rest.slice(at + 1) };
}

/**
 * An admin maps a tool user to a person of the SAME org (the org check is `linkTrackerIdentity`'s). Replaces any link the tool user had, takes them off the unmatched list and lifts the "unmapped" mark.
 * Returns whether the link was made.
 */
export async function mapTrackerUser(table: TeamRecordTable, orgId: OrgId, input: TrackerLink & { developerId: string; at: string; displayName?: string | undefined }, members: OrgMembershipPort): Promise<boolean> {
  const unmatched = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: unmatchedKey(orgId, input), ConsistentRead: true }))) as { Item?: { displayName?: unknown } };
  const name = input.displayName ?? (typeof unmatched.Item?.displayName === "string" ? unmatched.Item.displayName : undefined);
  if (!await linkTrackerIdentity(table, orgId, { ...input, via: "admin", ...(name === undefined ? {} : { displayName: name }) }, members)) return false;
  await clearUnmatchedTrackerUser(table, orgId, input);
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: unmappedKey(orgId, input) }));
  return true;
}

/**
 * Takes a link away: both items go, the tool user is marked "unmapped" (the automatic linker will not link them again) and goes back on the unmatched list. Rows already stored under the person stay
 * theirs (found by their developer id, so their erase still takes them); from now on a change by this tool user is not stored. Returns who they were linked to, or undefined when there was no link.
 */
export async function unmapTrackerUser(table: TeamRecordTable, orgId: OrgId, link: TrackerLink, at: string): Promise<{ developerId: string } | undefined> {
  if (!validLink(link)) return undefined;
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: forwardKey(orgId, link), ConsistentRead: true }))) as { Item?: { developerId?: unknown; displayName?: unknown } }).Item;
  if (typeof item?.developerId !== "string") return undefined;
  const former = recordDeveloperHash(item.developerId);
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...unmappedKey(orgId, link), entityType: "TEAM_RECORD_TRACKER_UNMAPPED", orgId, system: link.system, sourceId: link.sourceId, at, formerDeveloperHash: former } }));
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: forwardKey(orgId, link) }));
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: reverseKey(orgId, item.developerId, link) }));
  await noteUnmatchedTrackerUser(table, orgId, { ...link, displayName: typeof item.displayName === "string" && item.displayName !== "" ? item.displayName : link.sourceId, at, formerDeveloperHash: former });
  return { developerId: item.developerId };
}
