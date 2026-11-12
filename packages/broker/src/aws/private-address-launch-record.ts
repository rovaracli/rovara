// Review L2: the list revision a worker was launched with, kept so the session reaper can tell a worker that read an internal address list BEFORE a removal (and so still has the removed address open) from one that read it
// AFTER, by the list's own revision rather than by clocks and a guessed margin. Written by the launch step (session-steps.ts, through private-address-launch.ts's result), read by the reaper (session-reaper.ts).
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE } from "@rovara-code/contracts";
import { PRIVATE_ADDRESS_LAUNCH_PK } from "@agentx/cloud-contracts";
import type { PrivateAddressTable } from "../org/private-addresses.js";

/** A launch record outlives every worker that could run on it (the 14 day maximum lifetime), then the table's TTL removes it. */
const LAUNCH_RECORD_TTL_SECONDS = 15 * 86_400;

/**
 * Review L2: the list revision a workspace's worker was launched with, kept beside the removal marks (PRIVATE_ADDRESS_LAUNCH_PK, sort key: the workspace id; one row per workspace, for its latest generation). The reaper
 * recycles a worker when a removal's revision is newer than this one, so "read the list before the removal" is decided by the list's own revision, never by clocks. Written before the launch returns, so a launch with a
 * list that could not be recorded fails and is retried. A launch retried within one generation keeps the OLDEST revision it read (the instance may have been launched from any attempt, and the older one is the
 * one that can still hold a removed address). Every named launch records one, so the reaper can tell "read after the removal" from "no record": a worker with no record (launched before this was kept) is recycled. A record of a newer generation is never replaced by a stale step.
 */
export async function recordPrivateAddressLaunch(table: PrivateAddressTable, input: { workspaceId: string; generation: number; revision: number }, now: () => number = Date.now): Promise<void> {
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { pk: PRIVATE_ADDRESS_LAUNCH_PK, sk: input.workspaceId, entityType: "PRIVATE_ADDRESS_LAUNCH", workspaceId: input.workspaceId, generation: input.generation, revision: input.revision, readAt: now(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now() / 1000) + LAUNCH_RECORD_TTL_SECONDS },
      ConditionExpression: "attribute_not_exists(pk) OR #g < :g OR (#g = :g AND #r > :r)",
      ExpressionAttributeNames: { "#g": "generation", "#r": "revision" },
      ExpressionAttributeValues: { ":g": input.generation, ":r": input.revision },
    }));
  } catch (error) {
    // A record of a newer generation, or of this one with an older (or equal) revision, is already there: it is at least as cautious as this one.
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
    throw error;
  }
}

/** The list revision a workspace's worker of this generation launched with, or undefined when none is recorded (a worker launched before this was kept): the reaper then recycles it. */
export async function readPrivateAddressLaunchRevision(table: PrivateAddressTable, workspaceId: string, generation: number): Promise<number | undefined> {
  const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: PRIVATE_ADDRESS_LAUNCH_PK, sk: workspaceId }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  return item !== undefined && item.workspaceId === workspaceId && item.generation === generation && typeof item.revision === "number" && Number.isSafeInteger(item.revision) ? item.revision : undefined;
}
