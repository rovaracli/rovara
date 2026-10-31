// E6: the process the MCP host service runs (infra/lib/mcp-host.ts). It reads the registry of approved stdio servers from the install's own table, with a
// read-only role, and serves them (gateway/src/mcp-host.ts). It needs no secret but its own bearer token, which the task's secret store gives it.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createServer } from "node:http";
import { OrgIdSchema } from "@agentx/contracts";
import { createMcpHost, npmLauncher, type HostRegistry } from "@agentx/gateway";
import { dynamoMcpServerStore } from "../context-sources/mcp-servers.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** An Enterprise install has one org; the host serves that org's approved stdio entries and nothing else. */
export function registryFor(store: ReturnType<typeof dynamoMcpServerStore>, orgId: string): HostRegistry {
  const org = OrgIdSchema.parse(orgId);
  return {
    async approvedStdio(serverId) {
      const entry = await store.get(org, serverId);
      return entry?.status === "approved" && entry.transport.kind === "stdio" ? entry.transport.spec : undefined;
    },
  };
}

export function start(): void {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const token = required("MCP_HOST_TOKEN");
  // The token is held in this process only. Hosted servers run under other uids (review I4) and so cannot read this process's memory or /proc entries, and the variable is
  // removed from the environment this process hands on. (A same-uid process could still read the initial environment from /proc, which is why they never share the uid.)
  delete process.env.MCP_HOST_TOKEN;
  // Without the ability to change uid the host would run servers beside its own secrets; it refuses to start rather than do that.
  if (process.getuid?.() !== 0 && process.env.MCP_HOST_ALLOW_SAME_UID !== "1") throw new Error("the MCP host must start as root so that it can run each server under its own uid");
  const host = createMcpHost({
    token,
    isolation: process.env.MCP_HOST_ALLOW_SAME_UID === "1" ? "none" : { firstUid: 20_000, count: 32, gid: 20_000 },
    registry: registryFor(dynamoMcpServerStore({ documentClient, tableName: required("STATE_TABLE_NAME") }), required("ROVARA_ORG_ID")),
    launcher: npmLauncher(),
    log: (event, fields) => console.log(JSON.stringify({ component: "mcp-host", event, ...fields })),
  });
  const server = createServer((req, res) => { void host.handle(req, res); });
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  const stop = () => { server.close(); void host.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) start();
