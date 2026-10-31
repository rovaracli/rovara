// E2: what one stage has used of its sources: calls and bytes per source, failures per source, and the stage's total calls. One item per operation,
// updated with atomic adds that carry their cap as a condition, so parallel calls (up to 4) cannot jointly pass a cap.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, orgScoped, type OrgId } from "@agentx/contracts";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** A stage may make at most this many calls to all its sources together, whatever each source allows. */
export const STAGE_TOTAL_CALLS = 50;
/** After this many failed calls to a source, it is off for the rest of the stage. */
export const SOURCE_FAILURE_LIMIT = 3;
const USAGE_RETENTION_SECONDS = 3 * 24 * 60 * 60;

export type Reservation = { ok: true } | { ok: false; reason: "calls" | "total" | "failures" };

export interface UsageStore {
  /** Takes one call from the source's and the stage's allowance, or says which one is used up. */
  reserveCall(input: { orgId: OrgId; operationId: string; sourceId: string; callsPerStage: number }): Promise<Reservation>;
  /** The bytes of results already shown from this source in this stage. */
  bytesUsed(input: { orgId: OrgId; operationId: string; sourceId: string }): Promise<number>;
  addBytes(input: { orgId: OrgId; operationId: string; sourceId: string; bytes: number }): Promise<void>;
  /** Counts a failed call; returns how many have failed for this source in this stage. */
  recordFailure(input: { orgId: OrgId; operationId: string; sourceId: string }): Promise<number>;
}

const key = (orgId: OrgId, operationId: string) => ({ pk: orgScoped(orgId, `CTXUSE#${operationId}`), sk: "USE" });
const calls = (sourceId: string) => `c_${sourceId}`;
const bytes = (sourceId: string) => `b_${sourceId}`;
const failures = (sourceId: string) => `f_${sourceId}`;

export function dynamoUsageStore(deps: { documentClient: DocumentClient; tableName: string; now: () => number }): UsageStore {
  const expiry = () => Math.floor(deps.now() / 1_000) + USAGE_RETENTION_SECONDS;
  const read = async (orgId: OrgId, operationId: string): Promise<Record<string, unknown>> =>
    ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key(orgId, operationId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item ?? {};
  return {
    async reserveCall({ orgId, operationId, sourceId, callsPerStage }) {
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: key(orgId, operationId),
          UpdateExpression: "ADD #calls :one, #total :one SET #expires = :expires",
          ConditionExpression: "(attribute_not_exists(#calls) OR #calls < :callsCap) AND (attribute_not_exists(#total) OR #total < :totalCap) AND (attribute_not_exists(#failed) OR #failed < :failCap)",
          ExpressionAttributeNames: { "#calls": calls(sourceId), "#total": "total", "#failed": failures(sourceId), "#expires": INDEX_EXPIRY_ATTRIBUTE },
          ExpressionAttributeValues: { ":one": 1, ":callsCap": callsPerStage, ":totalCap": STAGE_TOTAL_CALLS, ":failCap": SOURCE_FAILURE_LIMIT, ":expires": expiry() },
        }));
        return { ok: true };
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
        const item = await read(orgId, operationId);
        if (Number(item[failures(sourceId)] ?? 0) >= SOURCE_FAILURE_LIMIT) return { ok: false, reason: "failures" };
        if (Number(item.total ?? 0) >= STAGE_TOTAL_CALLS) return { ok: false, reason: "total" };
        return { ok: false, reason: "calls" };
      }
    },
    async bytesUsed({ orgId, operationId, sourceId }) {
      return Number((await read(orgId, operationId))[bytes(sourceId)] ?? 0);
    },
    async addBytes({ orgId, operationId, sourceId, bytes: count }) {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key(orgId, operationId), UpdateExpression: "ADD #bytes :count SET #expires = :expires",
        ExpressionAttributeNames: { "#bytes": bytes(sourceId), "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":count": count, ":expires": expiry() },
      }));
    },
    async recordFailure({ orgId, operationId, sourceId }) {
      const updated = (await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key(orgId, operationId), UpdateExpression: "ADD #failed :one SET #expires = :expires",
        ExpressionAttributeNames: { "#failed": failures(sourceId), "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":one": 1, ":expires": expiry() }, ReturnValues: "ALL_NEW",
      }))) as { Attributes?: Record<string, unknown> };
      return Number(updated.Attributes?.[failures(sourceId)] ?? 1);
    },
  };
}
