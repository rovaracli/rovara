// What the source write route (`source-write.ts`) keeps in the TeamRecord table besides the source rows themselves. All three kinds hold no text of anyone's:
//   SRCSCOPE#<system>#<hash>   in the WORKSPACE partition: the claim that one project holds a place. A source row and its claim are written in one transaction, so two projects can never
//                              both hold one place (the claim's condition is "absent, or this project's");
//   SRCCHG#<id>                in the PROJECT partition: a less-safe change waiting for a second person (seven days; the table's TTL removes it after that);
//   SRCREQ#<hash>              in the PROJECT partition: the outcome of one write request, so a repeat of it answers the same and writes nothing (a day).
// A proposal holds person ids (`proposedBy`, `row.addedBy`, source ids in `row.exclude`): `scrubSourceChanges` is the erase step for them. Project archive and company close remove all three
// kinds (`erase.ts`): the claim of a source row is dropped with the row (`dropScopeClaim`), the others are in the project's partition.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, SourceChangeProposalSchema, recordSourceKey, teamRecordPk, teamRecordSourceHash,
  type OrgId, type SourceChangeProposal, type SourceConfig,
} from "@agentx/contracts";
import { Aliases, EXISTS, NOT_EXISTS, type Item } from "../agents/table-writes.js";
import { ERASED_DEVELOPER_ID, queryPrefix, sourceConfigFromItem } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const SOURCE_CHANGE_SK_PREFIX = "SRCCHG#";
export const SOURCE_SCOPE_SK_PREFIX = "SRCSCOPE#";
export const SOURCE_REQUEST_SK_PREFIX = "SRCREQ#";
/** How long a request item answers a repeat. */
export const SOURCE_REQUEST_TTL_SECONDS = 86_400;
/** Waiting changes one project may hold at once (the view lists at most this many). */
export const SOURCE_CHANGES_MAX = 100;

export const sourceChangeKey = (orgId: OrgId, project: string, id: string) => ({ pk: teamRecordPk(orgId, project), sk: `${SOURCE_CHANGE_SK_PREFIX}${id}` });
export const scopeClaimKey = (orgId: OrgId, system: string, scope: string) => ({ pk: teamRecordPk(orgId), sk: `${SOURCE_SCOPE_SK_PREFIX}${system}#${teamRecordSourceHash(system, scope)}` });
/** The request item is keyed by the person AND their request id, so one person's id never reads or blocks another's. */
export const sourceRequestKey = (orgId: OrgId, project: string, developerId: string, requestId: string) => ({
  pk: teamRecordPk(orgId, project), sk: `${SOURCE_REQUEST_SK_PREFIX}${createHash("sha256").update(`${developerId}\0${requestId}`).digest("hex")}`,
});

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

/** A stored proposal, or undefined when absent. One that does not parse throws (never read as absent). The table's own attributes are not part of it. */
export async function readSourceChange(table: TeamRecordTable, orgId: OrgId, project: string, id: string): Promise<SourceChangeProposal | undefined> {
  const item = await getItem(table, sourceChangeKey(orgId, project, id));
  return item === undefined ? undefined : proposalFromItem(item);
}

export function proposalFromItem(item: Item): SourceChangeProposal {
  const { pk: _pk, sk: _sk, entityType: _entityType, [INDEX_EXPIRY_ATTRIBUTE]: _ttl, ...fields } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- the table's own attributes
  const parsed = SourceChangeProposalSchema.safeParse(fields);
  if (!parsed.success) throw new Error("the waiting change is not readable");
  return parsed.data;
}

/** The project's waiting changes, oldest first by id order; those that do not parse are left out. Bounded. */
export async function listSourceChanges(table: TeamRecordTable, orgId: OrgId, project: string, maxItems = SOURCE_CHANGES_MAX + 1): Promise<SourceChangeProposal[]> {
  const { items } = await queryPrefix(table, orgId, project, SOURCE_CHANGE_SK_PREFIX, maxItems);
  const found: SourceChangeProposal[] = [];
  for (const item of items) {
    try { found.push(proposalFromItem(item)); } catch { /* a change that does not parse is never shown or approved */ }
  }
  return found;
}

export function proposalPut(table: TeamRecordTable, proposal: SourceChangeProposal) {
  return {
    Put: {
      TableName: table.tableName,
      Item: { ...sourceChangeKey(proposal.workspaceId, proposal.project, proposal.id), entityType: "TEAM_RECORD_SOURCE_CHANGE", ...proposal, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(proposal.expiresAt) / 1000) },
      ConditionExpression: NOT_EXISTS,
    },
  };
}

export const proposalDelete = (table: TeamRecordTable, orgId: OrgId, project: string, id: string) => ({ Delete: { TableName: table.tableName, Key: sourceChangeKey(orgId, project, id), ConditionExpression: EXISTS } });

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

/**
 * The person-erase step for waiting changes: a change the person proposed is deleted; in any other, their id as the adder becomes the 64-zero stand-in and the source ids of the person leave
 * the exclusion list. Works on the raw items, so a change that no longer parses is still scrubbed. Returns how many changes it touched.
 */
export async function scrubSourceChanges(table: TeamRecordTable, orgId: OrgId, project: string, who: { developerId?: string; ids: readonly string[] }): Promise<number> {
  const { items } = await queryPrefix(table, orgId, project, SOURCE_CHANGE_SK_PREFIX, SOURCE_CHANGES_MAX * 5);
  let touched = 0;
  for (const item of items) {
    if (typeof item.pk !== "string" || typeof item.sk !== "string") continue;
    const key = { pk: item.pk, sk: item.sk };
    if (who.developerId !== undefined && item.proposedBy === who.developerId) {
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: key }));
      touched += 1;
      continue;
    }
    const row = (item.row ?? {}) as { addedBy?: unknown; exclude?: unknown };
    const aliases = new Aliases();
    const sets: string[] = [];
    if (who.developerId !== undefined && row.addedBy === who.developerId) sets.push(`${aliases.name("row")}.${aliases.name("addedBy")} = ${aliases.value(ERASED_DEVELOPER_ID)}`);
    if (Array.isArray(row.exclude) && row.exclude.some((id) => typeof id === "string" && who.ids.includes(id))) sets.push(`${aliases.name("row")}.${aliases.name("exclude")} = ${aliases.value(row.exclude.filter((id) => !(typeof id === "string" && who.ids.includes(id))))}`);
    if (sets.length === 0) continue;
    try {
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: key, UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: `attribute_exists(${aliases.name("pk")})`,
        ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      }));
      touched += 1;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; // the change was decided meanwhile: nothing left to scrub
    }
  }
  return touched;
}
