// Lessons in production, lane 2: the once-claim of a reflection, in the State table: `LEARN#<task>#<outcome>` / `CLAIM`, written with a conditional put and expiring after 30 days (the table's TTL attribute).
// The item holds the org, a time and nothing else.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";
import { CLAIM_TTL_SECONDS, type ClaimStore } from "./reflect-worker.js";

export const reflectClaimKey = (taskId: string, outcome: string) => ({ pk: `LEARN#${taskId}#${outcome}`, sk: "CLAIM" as const });

export function dynamoReflectClaims(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }): ClaimStore {
  return {
    async claim(message, nowSeconds) {
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...reflectClaimKey(message.taskId, message.outcome), entityType: "LEARN_CLAIM", orgId: message.orgId, claimedAt: nowSeconds, [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + CLAIM_TTL_SECONDS },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        return "claimed";
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return "already";
        throw error;
      }
    },
  };
}
