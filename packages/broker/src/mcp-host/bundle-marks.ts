// Review N4: where the controller keeps the day it first saw a bundle that no entry references. One small item per bundle in the probe-slot partition (`ORG#<org>#MCPSLOT`, `ORPHAN#<sha256>`),
// which the controller's role may already read, write and delete. The registry's partition is never written.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped, type OrgId } from "@agentx/contracts";
import type { BundleMarks } from "@agentx/gateway";

type DocumentClient = { send(command: unknown): Promise<unknown> };
const HASH = /^[0-9a-f]{64}$/u;

export function dynamoBundleMarks(options: { documentClient: DocumentClient; tableName: string; orgId: OrgId }): BundleMarks {
  const key = (hash: string) => {
    if (!HASH.test(hash)) throw new Error("a bundle is named by its sha256");
    return { pk: orgScoped(options.orgId, "MCPSLOT"), sk: `ORPHAN#${hash}` };
  };
  return {
    async get(hash) {
      const found = await options.documentClient.send(new GetCommand({ TableName: options.tableName, Key: key(hash), ConsistentRead: true })) as { Item?: { firstSeenAt?: unknown } };
      if (found.Item === undefined) return undefined;
      // An item that is there but is not a time is damaged: the sweep leaves that bundle alone (it is never read as "not seen yet", which would restart the clock, nor as old).
      if (typeof found.Item.firstSeenAt !== "number" || !Number.isSafeInteger(found.Item.firstSeenAt) || found.Item.firstSeenAt < 0) throw new Error("the bundle mark is damaged");
      return found.Item.firstSeenAt;
    },
    async set(hash, at) {
      if (!Number.isSafeInteger(at) || at < 0) throw new Error("a mark is a time in milliseconds");
      try {
        await options.documentClient.send(new PutCommand({ TableName: options.tableName, Item: { ...key(hash), firstSeenAt: at }, ConditionExpression: "attribute_not_exists(pk)" }));
      } catch (error) {
        // Already marked: the first sighting stays.
        if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
      }
    },
    async clear(hash) {
      await options.documentClient.send(new DeleteCommand({ TableName: options.tableName, Key: key(hash) }));
    },
  };
}
