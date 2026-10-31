// E-wiring: builders that turn the lane's pieces into what the broker's dependency objects hold, so that the controller's wiring is one call for each.
//
//   AwsBrokerDependencies.contextSources  = createContextSourcesRuntime({ ... })                 (the stage routes: aws/broker/context-tools.ts)
//   AgentRouteDependencies.contextSources = createContextSourceRouteDependencies({ ... })        (a project's Sources settings: agents/routes.ts)
//   AgentRouteDependencies.mcpServers     = createMcpServerDependencies({ ... })                 (the org's MCP servers, Enterprise only: agents/routes.ts)
//   once at start                         = registerContextSourceCleanup({ store: dynamoResultStore(...) })
import { readConnection, readConnectionToken, type OrgConnectionDeps } from "../connections/store.js";
import type { AgentCaller } from "../agents/access.js";
import type { Edition, OrgId } from "@agentx/contracts";
import { dynamoCitationStore } from "./citations.js";
import { authConnectionFits, dynamoMcpServerStore, probeLimiter, type McpServerDependencies } from "./mcp-servers.js";
import { dynamoResultStore } from "./quotes.js";
import type { ContextSourcesRuntime } from "./runtime.js";
import { gatewayProber, gatewayServerPort, hostProbeClient, sourceEnvironment, type ConnectionLookup, type McpHostEndpoint } from "./server-port.js";
import type { ContextSourceRouteDependencies } from "./settings-routes.js";
import { dynamoContextSourceStore } from "./store.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

interface Common {
  documentClient: DocumentClient;
  tableName: string;
  now: () => number;
  edition: Edition;
  connections: ConnectionLookup;
  /** The MCP host's private URL and token, when the install runs one (stdio servers). */
  mcpHost?: McpHostEndpoint | undefined;
  /** `parseInstallCidrs(process.env.ROVARA_PRIVATE_MCP_CIDRS)`: the ranges outside which no private MCP server is tested or called. */
  privateCidrs?: readonly string[] | undefined;
}

/** The connection lookup the port needs, from the broker's connection store. A connection that is not an MCP connection carries no endpoint. */
export function connectionLookupFromStore(deps: OrgConnectionDeps): ConnectionLookup {
  return {
    async read(orgId, connectionId) {
      const record = await readConnection(deps, orgId, connectionId);
      if (record === undefined) return undefined;
      return { type: record.type, access: record.access, ...(record.type === "mcp" ? { endpoint: record.endpoint, ...(record.auth === undefined ? {} : { auth: record.auth }) } : {}) };
    },
    async token(orgId, connectionId) {
      const record = await readConnection(deps, orgId, connectionId);
      return record === undefined || record.type !== "mcp" || !record.hasSecret ? undefined : readConnectionToken(deps, orgId, record);
    },
  };
}

export function createContextSourcesRuntime(deps: Common & { teamSink?: ContextSourcesRuntime["teamSink"]; teamSearch?: ContextSourcesRuntime["teamSearch"] }): ContextSourcesRuntime {
  const servers = dynamoMcpServerStore(deps);
  return {
    servers: gatewayServerPort({ edition: deps.edition, connections: deps.connections, servers, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }) }),
    citations: dynamoCitationStore(deps), results: dynamoResultStore(deps),
    ...(deps.teamSink === undefined ? {} : { teamSink: deps.teamSink }), ...(deps.teamSearch === undefined ? {} : { teamSearch: deps.teamSearch, teamRecordAvailable: true }),
  };
}

export function createContextSourceRouteDependencies(deps: Common & { requireProjectRole: ContextSourceRouteDependencies["requireProjectRole"]; audit?: ContextSourceRouteDependencies["audit"] }): ContextSourceRouteDependencies {
  const servers = dynamoMcpServerStore(deps);
  const port = gatewayServerPort({ edition: deps.edition, connections: deps.connections, servers, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }) });
  return {
    store: dynamoContextSourceStore(deps), env: sourceEnvironment({ edition: deps.edition, connections: deps.connections, servers, port }), now: deps.now,
    requireProjectRole: deps.requireProjectRole, table: { documentClient: deps.documentClient, tableName: deps.tableName }, ...(deps.audit === undefined ? {} : { audit: deps.audit }),
  };
}

export function createMcpServerDependencies(deps: Common & { audit?: McpServerDependencies["audit"]; secondAdminToApprove?: boolean }): McpServerDependencies {
  return {
    store: dynamoMcpServerStore(deps), edition: deps.edition, now: deps.now, probeAllowed: probeLimiter({ max: 10, windowMs: 600_000, now: deps.now }),
    prober: gatewayProber({ ...(deps.mcpHost === undefined ? {} : { host: hostProbeClient(deps.mcpHost) }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }) }),
    authToken: (orgId: OrgId, connectionId: string) => deps.connections.token(orgId, connectionId),
    authConnectionUsable: async (orgId: OrgId, connectionId: string, address: string) => authConnectionFits(await deps.connections.read(orgId, connectionId), address),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }), ...(deps.secondAdminToApprove === undefined ? {} : { secondAdminToApprove: deps.secondAdminToApprove }),
  };
}

/** For a caller type that only the routes need. */
export type { AgentCaller };
