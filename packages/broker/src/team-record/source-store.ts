// What the source write route (`source-write.ts`) keeps in the TeamRecord table besides the source rows themselves, and the Slack add prompts. None of these kinds holds text of anyone's:
//   SRCSCOPE#<system>#<hash>   in the WORKSPACE partition: the claim that one project holds a place. A source row and its claim are written in one transaction, so two projects can never
//                              both hold one place (the claim's condition is "absent, or this project's");
//   SRCREQ#<hash>              in the PROJECT partition: the outcome of one write request, so a repeat of it answers the same and writes nothing (a day).
//   SRCREV#<system>#<hash>     in the PROJECT partition: the highest revision a removed source row reached and when it was removed, so a row added for the place again counts on from there
//                              and a write made against the old row can never fit the new one (hash and number only; no expiry).
//   SLKADD#<uuid>              in the WORKSPACE partition: one "learn from this channel" prompt (`slack-add.ts`): the Slack team, the channel, a hash of the person and a 15-minute expiry. No Slack user id, no text.
// Owner decision 2026-11-04 (no second person for any source change) removed the waiting-change item (`SRCCHG#`): no such row was ever written outside this lane's branch (the Team record switch is off
// everywhere), so there is nothing to migrate, scrub or sweep. Project archive and company close remove the three kinds above (`erase.ts`): the claim of a source row is dropped with the row
// (`dropScopeClaim`), the others are in the project's partition.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { recordSourceKey, teamRecordSourceHash, type SourceConfig } from "@agentx/cloud-contracts";
import { Aliases, NOT_EXISTS, type Item } from "../agents/table-writes.js";
import { sourceConfigFromItem } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export const SOURCE_SCOPE_SK_PREFIX = "SRCSCOPE#";
export const SOURCE_REQUEST_SK_PREFIX = "SRCREQ#";
export const SOURCE_REVISION_SK_PREFIX = "SRCREV#";
/** The pickers' listing sessions (`source-options.ts`): in the WORKSPACE partition, a page count with a short expiry; no person and no text. Company close removes them, and a project archive removes that project's (`erase.ts`, found by the `project` field). */
export const SOURCE_OPTIONS_SK_PREFIX = "SRCOPT#";
/** The prompts of "learn from this channel" (`slack-add.ts`): in the WORKSPACE partition, the team, the channel, a hash of the person and a 15-minute expiry; no Slack user id and no text. Company close removes them. */
export const SLACK_ADD_SK_PREFIX = "SLKADD#";
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

// ---- the "learn from this channel" prompts (`slack-add.ts`)

const slackAddKey = (orgId: OrgId, token: string) => ({ pk: teamRecordPk(orgId), sk: `${SLACK_ADD_SK_PREFIX}${token}` });

/** Writes a prompt (never over another). `expiresAtSeconds` is the table's expiry attribute; the reader checks it too, because a table's own expiry runs late. */
export async function putSlackAddPrompt(table: TeamRecordTable, orgId: OrgId, token: string, prompt: { team: string; channel: string; person: string; createdAt: string; expiresAtSeconds: number }): Promise<void> {
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: { ...slackAddKey(orgId, token), entityType: "TEAM_RECORD_SLACK_ADD", team: prompt.team, channel: prompt.channel, person: prompt.person, createdAt: prompt.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: prompt.expiresAtSeconds },
    ConditionExpression: NOT_EXISTS,
  }));
}

/** The prompt, or undefined when there is none under this company. */
export async function readSlackAddPrompt(table: TeamRecordTable, orgId: OrgId, token: string): Promise<{ team?: unknown; channel?: unknown; person?: unknown; startedBy?: unknown; startedProject?: unknown; doneOutcome?: unknown; expiresAtSeconds: number } | undefined> {
  const item = await getItem(table, slackAddKey(orgId, token));
  return item === undefined ? undefined : { team: item.team, channel: item.channel, person: item.person, startedBy: item.startedBy, startedProject: item.startedProject, doneOutcome: item.doneOutcome, expiresAtSeconds: Number(item[INDEX_EXPIRY_ATTRIBUTE]) };
}

/** Remembers that a press began on the prompt, and for which project (the first one wins). A later press FOR THE SAME PROJECT that finds the place already saved knows the first one was this prompt's own. Best effort. */
export async function markSlackAddStarted(table: TeamRecordTable, orgId: OrgId, token: string, interactionId: string, project: string): Promise<void> {
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: slackAddKey(orgId, token), UpdateExpression: "SET startedBy = :interaction, startedProject = :project",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(startedBy)", ExpressionAttributeValues: { ":interaction": interactionId, ":project": project },
    }));
  } catch { /* a press that began earlier already left its mark, or the item is gone */ }
}

/** Stores the outcome on the prompt (`added`, the one outcome that is kept: a refusal leaves the prompt open to try again). A failure is swallowed: the route's request item and its place claim still make a later press the same save. */
export async function markSlackAddUsed(table: TeamRecordTable, orgId: OrgId, token: string): Promise<void> {
  try {
    await table.documentClient.send(new UpdateCommand({
      TableName: table.tableName, Key: slackAddKey(orgId, token), UpdateExpression: "SET doneOutcome = :added",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(doneOutcome)", ExpressionAttributeValues: { ":added": "added" },
    }));
  } catch { /* see above */ }
}
