// TRW-4 (owner, 2026-11-02): the Team record keeps only what it can erase. A tracker author (Linear, Jira) counts only when the company has linked that author id to a Rovara person.
// The link is made at connect or sign-in time (`linkTrackerIdentity`, called from the connect and sign-in flows), or by an email the tracker reports as VERIFIED (`linkTrackerByVerifiedEmail`,
// never an unverified one). Links live in the org's own record partition (so a company erase takes them) as two items: the forward one (author id -> person) and a reverse one under a hash of
// the person (person -> author ids), which is how a person erase finds them and removes them.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { recordDeveloperHash, teamRecordPk, type OrgId } from "@agentx/contracts";
import { isErasedActor } from "./erased.js";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export type TrackerLinkVia = "connect" | "signin" | "verified_email";
export interface TrackerLink { system: string; sourceId: string }

const SYSTEM = /^(linear|jira:[a-z0-9][a-z0-9.-]{0,252})$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
export const LINK_PREFIX = "TRLINK#";
export const LINK_BY_PERSON_PREFIX = "TRLINKDEV#";

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
export async function linkTrackerIdentity(table: TeamRecordTable, orgId: OrgId, input: TrackerLink & { developerId: string; via: TrackerLinkVia; at: string }, members: OrgMembershipPort): Promise<boolean> {
  if (!SYSTEM.test(input.system) || !SOURCE_ID.test(input.sourceId) || input.developerId === "") return false;
  if ((await members.orgOfDeveloper(input.developerId)) !== orgId) return false;
  if (await isErasedActor(table, orgId, input.system, { sourceId: input.sourceId, developerId: input.developerId })) return false;
  const existing = await developerOfTrackerAuthor(table, orgId, input);
  if (existing !== undefined && existing !== input.developerId) await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: reverseKey(orgId, existing, input) }));
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...forwardKey(orgId, input), entityType: "TEAM_RECORD_TRACKER_LINK", orgId, developerId: input.developerId, via: input.via, at: input.at } }));
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
export async function linkTrackerByVerifiedEmail(table: TeamRecordTable, deps: VerifiedEmailDependencies, orgId: OrgId, input: TrackerLink & { email: string; emailVerified: boolean | undefined; at: string }): Promise<boolean> {
  if (input.emailVerified !== true || input.email === "") return false;
  const developerId = await deps.developerForVerifiedEmail(input.email);
  if (developerId === undefined || (await deps.orgOfDeveloper(developerId)) !== orgId) return false;
  return linkTrackerIdentity(table, orgId, { system: input.system, sourceId: input.sourceId, developerId, via: "verified_email", at: input.at }, deps);
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
  return !found.truncated;
}
