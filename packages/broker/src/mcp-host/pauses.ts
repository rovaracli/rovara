// Stdio MCP host redesign (fix round 1, S2): where the controller keeps a server's pause after a tools change. One small item per server in the probe-slot partition (`ORG#<org>#MCPSLOT`,
// `PAUSE#<server id>`), which the controller's role may already read, write and delete and which holds nothing the registry of approvals does. A pause names the approval it was made for (the
// tools hash and the bundle hash); the controller ignores and removes a pause whose approval is no longer the registry's.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { McpServerIdSchema, orgScoped, type OrgId } from "@agentx/contracts";
import type { PauseStore } from "@agentx/gateway";

type DocumentClient = { send(command: unknown): Promise<unknown> };
const HASH = /^[0-9a-f]{64}$/u;

export function dynamoPauses(options: { documentClient: DocumentClient; tableName: string; orgId: OrgId }): PauseStore {
  const key = (serverId: string) => ({ pk: orgScoped(options.orgId, "MCPSLOT"), sk: `PAUSE#${McpServerIdSchema.parse(serverId)}` });
  return {
    async get(serverId) {
      const found = await options.documentClient.send(new GetCommand({ TableName: options.tableName, Key: key(serverId), ConsistentRead: true })) as { Item?: { toolsHash?: unknown; bundleHash?: unknown } };
      const item = found.Item;
      if (item === undefined) return undefined;
      // A pause that does not read as one is not a pause the controller can match: it is treated as paused for an approval nobody has (it never matches, and the next start removes it).
      return typeof item.toolsHash === "string" && HASH.test(item.toolsHash) && typeof item.bundleHash === "string" && HASH.test(item.bundleHash) ? { toolsHash: item.toolsHash, bundleHash: item.bundleHash } : { toolsHash: "", bundleHash: "" };
    },
    async set(serverId, pause) {
      if (!HASH.test(pause.toolsHash) || !HASH.test(pause.bundleHash)) throw new Error("a pause names two hashes");
      await options.documentClient.send(new PutCommand({ TableName: options.tableName, Item: { ...key(serverId), toolsHash: pause.toolsHash, bundleHash: pause.bundleHash } }));
    },
    async clear(serverId) {
      await options.documentClient.send(new DeleteCommand({ TableName: options.tableName, Key: key(serverId) }));
    },
  };
}
