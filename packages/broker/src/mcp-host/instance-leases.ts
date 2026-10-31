// Stdio MCP host redesign (fix round 1, I2): which controller instances are alive. Each instance renews one item (`INSTANCE#<id>`) in the probe counter's partition at every reconcile; another
// instance stops a task of an instance only when that item is missing or its lease has run out. During a deploy, when the old and new instances run together, neither stops the other's
// tasks. The infrastructure still runs ONE instance (minimumHealthyPercent 0, maximumPercent 100): a runner's calls would otherwise reach the instance that does not hold its token.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped, type OrgId } from "@agentx/contracts";
import type { InstanceLeases } from "@agentx/gateway";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** Three missed reconcile passes (a pass is every minute) before an instance is called gone. */
export const INSTANCE_LEASE_MS = 3 * 60_000 + 30_000;

export function dynamoInstanceLeases(options: { documentClient: DocumentClient; tableName: string; orgId: OrgId; instanceId: string; leaseMs?: number; now?: () => number }): InstanceLeases {
  const partition = orgScoped(options.orgId, "MCPSLOT");
  const leaseMs = options.leaseMs ?? INSTANCE_LEASE_MS;
  const now = options.now ?? Date.now;
  const key = (instanceId: string) => ({ pk: partition, sk: `INSTANCE#${instanceId}` });
  return {
    async renew() {
      await options.documentClient.send(new PutCommand({ TableName: options.tableName, Item: { ...key(options.instanceId), expiresAt: now() + leaseMs } }));
    },
    async alive(instanceId) {
      if (!/^[A-Za-z0-9]{8,64}$/u.test(instanceId)) return false;
      const found = await options.documentClient.send(new GetCommand({ TableName: options.tableName, Key: key(instanceId), ConsistentRead: true })) as { Item?: { expiresAt?: unknown } };
      return typeof found.Item?.expiresAt === "number" && found.Item.expiresAt > now();
    },
  };
}
