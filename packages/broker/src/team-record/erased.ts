// Erased people (design 4.4.3): an erase must last. Two permanent markers per person (no expiry): by developer id, and by the hash of each source identity. Ingest
// refuses a draft whose actor has one, so a Slack backfill, the 15-minute pollers, a ticket backfill or an edit cannot bring the person's words back. An unreadable
// marker THROWS (RUNTIME_UNAVAILABLE): the ingest queue redelivers a draft whose put threw, whereas a refusal is final and would lose a legitimate message for good.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, erasedPersonKey, recordActorSourceHash, type OrgId } from "@agentx/contracts";
import type { TeamRecordTable } from "./types.js";

export async function markPersonErased(table: TeamRecordTable, orgId: OrgId, who: { developerId?: string | undefined; identities?: ReadonlyArray<{ system: string; sourceId: string }> | undefined }, at: string): Promise<void> {
  const keys = [
    ...(who.developerId === undefined ? [] : [erasedPersonKey(orgId, { developerId: who.developerId })]),
    ...(who.identities ?? []).map((identity) => erasedPersonKey(orgId, { actorSourceHash: recordActorSourceHash(identity.system, identity.sourceId) })),
  ];
  for (const key of keys) await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...key, entityType: "TEAM_RECORD_ERASED", at } }));
}

export async function isErasedActor(table: TeamRecordTable, orgId: OrgId, system: string, actor: { sourceId: string; developerId?: string | undefined }): Promise<boolean> {
  const keys = [
    ...(actor.developerId === undefined ? [] : [erasedPersonKey(orgId, { developerId: actor.developerId })]),
    erasedPersonKey(orgId, { actorSourceHash: recordActorSourceHash(system, actor.sourceId) }),
  ];
  for (const key of keys) {
    const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })).catch(() => {
      throw agentXError("RUNTIME_UNAVAILABLE", "The erased-person marker can't be read right now.");
    }) as { Item?: unknown };
    if (response.Item !== undefined) return true;
  }
  return false;
}
