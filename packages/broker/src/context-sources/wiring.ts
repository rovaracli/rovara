// E-wiring: builders that turn the lane's pieces into what the broker's dependency objects hold, so that the controller's wiring is one call for each.
//
//   AwsBrokerDependencies.contextSources  = createContextSourcesRuntime({ ... })                 (the stage routes: aws/broker/context-tools.ts)
//   AgentRouteDependencies.contextSources = createContextSourceRouteDependencies({ ... })        (a project's Sources settings: agents/routes.ts)
//   AgentRouteDependencies.mcpServers     = createMcpServerDependencies({ ... })                 (the org's MCP servers, Enterprise only: agents/routes.ts)
//   once at start                         = registerContextSourceCleanup({ store: dynamoResultStore(...) })
import { isSecretLeaf, orgMcpServerSecretName, type OrgSecrets } from "../connections/org-secrets.js";
import { readConnection, readConnectionToken, type OrgConnectionDeps } from "../connections/store.js";
import type { AgentCaller } from "../agents/access.js";
import { agentXError, type Edition, type OrgId } from "@agentx/contracts";
import { dynamoCitationStore } from "./citations.js";
import { dynamoMcpServerStore, probeLimiter, stdioAvailable, type McpServerDependencies, type McpServerSecrets } from "./mcp-servers.js";
import { dynamoResultStore } from "./quotes.js";
import type { ContextSourcesRuntime } from "./runtime.js";
import { gatewayProber, gatewayServerPort, hostControlClient, hostProbeClient, prewarmStdioServers, sourceEnvironment, type ConnectionLookup, type McpHostEndpoint } from "./server-port.js";
import type { ContextSourceRouteDependencies } from "./settings-routes.js";
import { dynamoContextSourceStore } from "./store.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

interface Common {
  documentClient: DocumentClient;
  tableName: string;
  now: () => number;
  edition: Edition;
  connections: ConnectionLookup;
  /** The MCP host's private URL and token, when the install runs one. NOT FOR PRODUCTION until the host is redesigned: it is used only when `stdioEnabled`. */
  mcpHost?: McpHostEndpoint | undefined;
  /** `process.env.ROVARA_STDIO_MCP_SERVERS === "1"`, honoured only in the Enterprise edition (see `stdioAvailable`). */
  stdioEnabled?: boolean | undefined;
  /** Each registered server's own write-only token. */
  serverSecrets: McpServerSecrets;
  /** `parseInstallCidrs(process.env.ROVARA_PRIVATE_MCP_CIDRS)`: the ranges outside which no private MCP server is tested or called. */
  privateCidrs?: readonly string[] | undefined;
  /** `ROVARA_VPC_CIDRS`: the network Rovara itself runs in, never called as a private MCP server. */
  rovaraCidrs?: readonly string[] | undefined;
}

/** Registered servers' tokens, in the org's secret store (the same org-tagged role and path as connection secrets). */
export function serverSecretsFromOrgSecrets(input: { env: string; secrets: Pick<OrgSecrets, "read" | "put" | "scheduleDelete"> }): McpServerSecrets {
  const name = (orgId: OrgId, serverId: string): string => {
    if (!isSecretLeaf(serverId)) throw agentXError("FORBIDDEN", "that is not a server id");
    return orgMcpServerSecretName(input.env, orgId, serverId);
  };
  return {
    put: async (orgId, serverId, value) => input.secrets.put(orgId, name(orgId, serverId), value),
    read: async (orgId, serverId, version) => input.secrets.read(orgId, name(orgId, serverId), version),
    remove: async (orgId, serverId) => input.secrets.scheduleDelete(orgId, name(orgId, serverId)),
  };
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
    servers: gatewayServerPort({ edition: deps.edition, connections: deps.connections, servers, serverSecrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) }),
    citations: dynamoCitationStore(deps), results: dynamoResultStore(deps),
    // The host is called only where package-run servers are on; elsewhere there is nothing to warm.
    ...(deps.mcpHost === undefined || !stdioAvailable({ edition: deps.edition, stdioEnabled: deps.stdioEnabled }) ? {} : {
      prewarm: (orgId, serverIds) => prewarmStdioServers({ host: hostControlClient(deps.mcpHost!), servers, edition: deps.edition, stdioEnabled: deps.stdioEnabled }, orgId, serverIds),
    }),
    ...(deps.teamSink === undefined ? {} : { teamSink: deps.teamSink }), ...(deps.teamSearch === undefined ? {} : { teamSearch: deps.teamSearch, teamRecordAvailable: true }),
  };
}

export function createContextSourceRouteDependencies(deps: Common & { requireProjectRole: ContextSourceRouteDependencies["requireProjectRole"]; audit?: ContextSourceRouteDependencies["audit"]; discoverAllowed?: ContextSourceRouteDependencies["discoverAllowed"] }): ContextSourceRouteDependencies {
  const servers = dynamoMcpServerStore(deps);
  const port = gatewayServerPort({ edition: deps.edition, connections: deps.connections, servers, serverSecrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled, ...(deps.mcpHost === undefined ? {} : { mcpHost: deps.mcpHost }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) });
  return {
    store: dynamoContextSourceStore(deps), env: sourceEnvironment({ edition: deps.edition, connections: deps.connections, servers, port }), now: deps.now,
    requireProjectRole: deps.requireProjectRole, table: { documentClient: deps.documentClient, tableName: deps.tableName }, ...(deps.discoverAllowed === undefined ? {} : { discoverAllowed: deps.discoverAllowed }), ...(deps.audit === undefined ? {} : { audit: deps.audit }),
  };
}

export function createMcpServerDependencies(deps: Common & { audit?: McpServerDependencies["audit"]; secondAdminToApprove?: boolean }): McpServerDependencies {
  return {
    store: dynamoMcpServerStore(deps), edition: deps.edition, now: deps.now, probeAllowed: probeLimiter({ max: 10, windowMs: 600_000, now: deps.now }),
    // The host is handed to the prober only when package-run servers are switched on: with it off the broker never calls the host.
    secrets: deps.serverSecrets, stdioEnabled: deps.stdioEnabled,
    ...(deps.mcpHost === undefined || !stdioAvailable({ edition: deps.edition, stdioEnabled: deps.stdioEnabled }) ? {} : { host: hostControlClient(deps.mcpHost) }),
    prober: gatewayProber({ ...(deps.mcpHost === undefined || !stdioAvailable({ edition: deps.edition, stdioEnabled: deps.stdioEnabled }) ? {} : { host: hostProbeClient(deps.mcpHost) }), ...(deps.privateCidrs === undefined ? {} : { privateCidrs: deps.privateCidrs }), ...(deps.rovaraCidrs === undefined ? {} : { rovaraCidrs: deps.rovaraCidrs }) }),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }), ...(deps.secondAdminToApprove === undefined ? {} : { secondAdminToApprove: deps.secondAdminToApprove }),
  };
}

/** For a caller type that only the routes need. */
export type { AgentCaller };
