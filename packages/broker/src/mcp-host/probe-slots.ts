// Stdio MCP host redesign (T7), design section 6: "2 probe or install tasks per org at once, counted in DynamoDB with a conditional counter" (this also fixes ME-15 for stdio: the
// broker's per-process limiter cannot count across instances; this does).
//
// Each slot is one item, `SLOT#<n>` in a partition of its own (so the controller's write permission is on the counter and nowhere near the registry of approvals). A slot is taken by a
// conditional write that succeeds only if the item is absent or its lease has run out, so two controller instances can never both hold a slot, and a controller that died with a slot
// loses it when the lease ends. A slot is given back by a delete that only succeeds for the lease that took it.
import { randomBytes } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped, type OrgId } from "@agentx/contracts";
import type { ProbeSlots } from "@agentx/gateway";

type DocumentClient = { send(command: unknown): Promise<unknown> };

const isConditionFailure = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

export function dynamoProbeSlots(options: { documentClient: DocumentClient; tableName: string; orgId: OrgId; max?: number; leaseMs?: number; now?: () => number }): ProbeSlots {
  const max = options.max ?? 2;
  const leaseMs = options.leaseMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(max) || max < 1 || max > 16) throw new Error("the number of probe slots is not valid");
  const partition = orgScoped(options.orgId, "MCPSLOT");
  return {
    async acquire() {
      const leaseId = randomBytes(16).toString("hex");
      for (let slot = 0; slot < max; slot += 1) {
        const at = now();
        try {
          await options.documentClient.send(new PutCommand({
            TableName: options.tableName,
            Item: { pk: partition, sk: `SLOT#${slot}`, leaseId, expiresAt: at + leaseMs },
            // Free: never taken, or its lease has run out.
            ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
            ExpressionAttributeValues: { ":now": at },
          }));
        } catch (error) {
          if (isConditionFailure(error)) continue;
          // A table that cannot be written is no slot: nothing starts.
          throw error;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await options.documentClient.send(new DeleteCommand({ TableName: options.tableName, Key: { pk: partition, sk: `SLOT#${slot}` }, ConditionExpression: "leaseId = :lease", ExpressionAttributeValues: { ":lease": leaseId } }));
          } catch (error) {
            // The lease ran out and another job took the slot: it is theirs now.
            if (!isConditionFailure(error)) throw error;
          }
        };
      }
      return undefined;
    },
  };
}
