// What the source write route (`source-write.ts`) keeps in the TeamRecord table besides the source rows themselves. All three kinds hold no text of anyone's:
//   SRCSCOPE#<system>#<hash>   in the WORKSPACE partition: the claim that one project holds a place. A source row and its claim are written in one transaction, so two projects can never
//                              both hold one place (the claim's condition is "absent, or this project's");
//   SRCREQ#<hash>              in the PROJECT partition: the outcome of one write request, so a repeat of it answers the same and writes nothing (a day).
//   SRCREV#<system>#<hash>     in the PROJECT partition: the highest revision a removed source row reached and when it was removed, so a row added for the place again counts on from there
//                              and a write made against the old row can never fit the new one (hash and number only; no expiry).
// Owner decision 2026-11-04 (no second person for any source change) removed the waiting-change item (`SRCCHG#`): no such row was ever written outside this lane's branch (the Team record switch is off
// everywhere), so there is nothing to migrate, scrub or sweep. Project archive and company close remove the three kinds above (`erase.ts`): the claim of a source row is dropped with the row
// (`dropScopeClaim`), the others are in the project's partition.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, recordSourceKey, teamRecordPk, teamRecordSourceHash, type OrgId, type SourceConfig } from "@agentx/contracts";
import { Aliases, NOT_EXISTS, type Item } from "../agents/table-writes.js";
import { sourceConfigFromItem } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const SOURCE_SCOPE_SK_PREFIX = "SRCSCOPE#";
export const SOURCE_REQUEST_SK_PREFIX = "SRCREQ#";
export const SOURCE_REVISION_SK_PREFIX = "SRCREV#";
/** How long a request item answers a repeat. */
export const SOURCE_REQUEST_TTL_SECONDS = 86_400;

export const scopeClaimKey = (orgId: OrgId, system: string, scope: string) => ({ pk: teamRecordPk(orgId), sk: `${SOURCE_SCOPE_SK_PREFIX}${system}#${teamRecordSourceHash(system, scope)}` });
/** The request item is keyed by the person AND their request id, so one person's id never reads or blocks another's. */
export const sourceRequestKey = (orgId: OrgId, project: string, developerId: string, requestId: string) => ({
  pk: teamRecordPk(orgId, project), sk: `${SOURCE_REQUEST_SK_PREFIX}${createHash("sha256").update(`${developerId}\0${requestId}`).digest("hex")}`,
});

export const sourceRevisionKey = (orgId: OrgId, project: string, system: string, scope: string) => ({ pk: teamRecordPk(orgId, project), sk: `${SOURCE_REVISION_SK_PREFIX}${system}#${teamRecordSourceHash(system, scope)}` });

async function getItem(table: TeamRecordTable, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
}

/** The source row of one place in one project. A row that is there but does not parse throws: it is never read as absent. */
export async function readSourceRow(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string): Promise<SourceConfig | undefined> {
  const item = await getItem(table, recordSourceKey(orgId, project, system, scope));
  if (item === undefined) return undefined;
  const config = sourceConfigFromItem(item);
  if (config === undefined) throw new Error("the source row is not readable");
  return config;
}

/** What a removed row of this place left: its last revision and when it went. Undefined when no row of the place was ever removed. */
export async function readRevisionFloor(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string): Promise<{ revision: number; removedAt: string } | undefined> {
  const item = await getItem(table, sourceRevisionKey(orgId, project, system, scope));
  if (item === undefined) return undefined;
  if (typeof item.revision !== "number" || typeof item.removedAt !== "string") throw new Error("the revision marker is not readable");
  return { revision: item.revision, removedAt: item.removedAt };
}

/** Written with the removal of a row (the row was at `revision`, which is never lower than the marker it replaces: an add counts on from the marker). */
export function revisionFloorPut(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string, revision: number, removedAt: string) {
  return { Put: { TableName: table.tableName, Item: { ...sourceRevisionKey(orgId, project, system, scope), entityType: "TEAM_RECORD_SOURCE_REVISION", revision, removedAt } } };
}

/** The condition that the marker is still what an add read (absent, or at this revision). */
export function revisionFloorCheck(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string, floor: { revision: number } | undefined) {
  const aliases = new Aliases();
  return {
    ConditionCheck: {
      TableName: table.tableName, Key: sourceRevisionKey(orgId, project, system, scope),
      ...(floor === undefined ? { ConditionExpression: NOT_EXISTS }
        : { ConditionExpression: `attribute_exists(pk) AND ${aliases.name("revision")} = ${aliases.value(floor.revision)}`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values }),
    },
  };
}

/** The project that holds a place, or undefined when none does. */
export async function readScopeClaim(table: TeamRecordTable, orgId: OrgId, system: string, scope: string): Promise<string | undefined> {
  const item = await getItem(table, scopeClaimKey(orgId, system, scope));
  if (item === undefined) return undefined;
  if (typeof item.project !== "string") throw new Error("the claim is not readable");
  return item.project;
}

export function claimPut(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string, at: string) {
  const aliases = new Aliases();
  return {
    Put: {
      TableName: table.tableName,
      Item: { ...scopeClaimKey(orgId, system, scope), entityType: "TEAM_RECORD_SOURCE_SCOPE", project, claimedAt: at },
      ConditionExpression: `attribute_not_exists(pk) OR ${aliases.name("project")} = ${aliases.value(project)}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
}

/** Frees a place held by `project` (its source row is going). A claim of another project is left alone. */
export async function dropScopeClaim(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string): Promise<void> {
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new DeleteCommand({
      TableName: table.tableName, Key: scopeClaimKey(orgId, system, scope),
      ConditionExpression: `${aliases.name("project")} = ${aliases.value(project)}`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
  }
}

/** The claim of a place as a transaction item: it goes with the source row, and only when it is this project's (a legacy row has none; another project's claim is left alone). */
export function claimDrop(table: TeamRecordTable, orgId: OrgId, project: string, system: string, scope: string) {
  const aliases = new Aliases();
  return {
    Delete: {
      TableName: table.tableName, Key: scopeClaimKey(orgId, system, scope),
      ConditionExpression: `attribute_not_exists(pk) OR ${aliases.name("project")} = ${aliases.value(project)}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
}

/** The stored outcome of a request that was already answered, while it is still good. */
export async function readSourceRequest(table: TeamRecordTable, orgId: OrgId, project: string, developerId: string, requestId: string, nowMs: number): Promise<{ bodyHash: string; status: number; reply: unknown } | undefined> {
  const item = await getItem(table, sourceRequestKey(orgId, project, developerId, requestId));
  if (item === undefined || typeof item.bodyHash !== "string" || typeof item.status !== "number") return undefined;
  const expiry = item[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expiry !== "number" || expiry * 1000 <= nowMs) return undefined;
  return { bodyHash: item.bodyHash, status: item.status, reply: item.reply };
}

export function requestPut(table: TeamRecordTable, orgId: OrgId, project: string, developerId: string, requestId: string, outcome: { bodyHash: string; status: number; reply: unknown }, nowMs: number) {
  const aliases = new Aliases();
  const expires = aliases.name(INDEX_EXPIRY_ATTRIBUTE);
  return {
    Put: {
      TableName: table.tableName,
      Item: { ...sourceRequestKey(orgId, project, developerId, requestId), entityType: "TEAM_RECORD_SOURCE_REQUEST", ...outcome, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SOURCE_REQUEST_TTL_SECONDS },
      // A request item that has expired but not yet been removed by the table does not block a new one.
      ConditionExpression: `attribute_not_exists(pk) OR ${expires} <= ${aliases.value(Math.floor(nowMs / 1000))}`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    },
  };
}
