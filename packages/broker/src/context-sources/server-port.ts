// E6: the real `ContextServerPort` (reaching a source's server) and `SourceEnvironment` (what the settings rules ask of the world), built on the gateway's MCP client.
//
// Three ways to reach a source, all read through the same client and all pinned to the addresses that were checked:
//   - an org connection of type `mcp` (a public https server, Public and Enterprise): the existing public guard (checkEndpointUrl);
//   - an approved registered server over HTTP (Enterprise): the install's allow-list, which is the approved entries (mcp-servers.ts), and the never-called list;
//   - an approved registered server over stdio (Enterprise): the MCP host, an operator-configured private URL with its own token. No server code runs here.
// No other connection type is reached by this port yet: Linear and Jira are native connectors and are added behind this same port later (not in this lane).
import { connectMcp, listMcpTools, type McpConnection, type McpToolResult } from "@agentx/gateway";
import { agentXError, editionPolicy, featureEnabled, type ContextSourceServer, type Edition, type McpAuth, type OrgId } from "@agentx/contracts";
import { mcpEndpointGuard, type McpEndpointGuard } from "../connections/pinned-endpoint.js";
import { privateMcpEndpointGuard, probeMcpEndpointGuard } from "../connections/private-endpoints.js";
import { McpProbeError, allowedTargets, authConnectionFits, type McpProber, type McpServerStore } from "./mcp-servers.js";
import type { ContextServerPort, ContextServerSession } from "./routes.js";
import type { DiscoveredTool, SourceEnvironment } from "./settings.js";

/** The org connection as the port needs it. The broker builds this from its connection store (connections/store.ts `readConnection`, `readConnectionToken`). */
export interface ConnectionLookup {
  read(orgId: OrgId, connectionId: string): Promise<{ type: string; access: "read" | "read_write"; endpoint?: string | undefined; auth?: McpAuth | undefined } | undefined>;
  token(orgId: OrgId, connectionId: string): Promise<string | undefined>;
}

/**
 * Review I6: the host's bearer token travels only over TLS. An http:// host address is refused, except on this machine's own loopback (a test host never leaves it).
 */
export function assertSecureHostUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw agentXError("CONFIG_INVALID", "the MCP host address is not a web address"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw agentXError("CONFIG_INVALID", "the MCP host must be reached over https");
  return url;
}

export interface McpHostEndpoint {
  /** The private URL of the MCP host service (https when the install gave it a certificate). */
  url: string;
  /** The bearer token the host expects from the broker. */
  token: string;
}

export interface ServerPortDependencies {
  edition: Edition;
  connections: ConnectionLookup;
  servers: Pick<McpServerStore, "get" | "list">;
  mcpHost?: McpHostEndpoint | undefined;
  /** The install's private address ranges (`parseInstallCidrs(process.env.ROVARA_PRIVATE_MCP_CIDRS)`). None: no private server is called. */
  privateCidrs?: readonly string[] | undefined;
  /** For a public connection. Default: the existing guard. */
  publicGuard?: McpEndpointGuard | undefined;
  /** For an approved private server. Default: the allow-list guard over `servers`. */
  privateGuard?: ((orgId: OrgId) => McpEndpointGuard) | undefined;
  connect?: typeof connectMcp | undefined;
  list?: typeof listMcpTools | undefined;
}

const NO_TOKEN_AUTH: McpAuth = { header: "x-rovara-client", prefix: "rovara" };

interface Target { endpoint: URL; token: string; auth: McpAuth | undefined; fetchImplementation: typeof fetch; hosts: string[] }

async function targetOf(deps: ServerPortDependencies, orgId: OrgId, server: ContextSourceServer): Promise<Target> {
  if (server.kind === "connection") {
    const connection = await deps.connections.read(orgId, server.connectionId);
    // Context sources are read-only: a connection that can also write is not used, whatever the project's settings once said.
    if (connection === undefined || connection.type !== "mcp" || connection.access !== "read" || connection.endpoint === undefined) throw agentXError("CONFIG_INVALID", "this source's connection cannot be used");
    const endpoint = new URL(connection.endpoint);
    const token = await deps.connections.token(orgId, server.connectionId);
    if (token === undefined) throw agentXError("CONFIG_INVALID", "this source's connection has no key");
    return { endpoint, token, auth: connection.auth, fetchImplementation: await (deps.publicGuard ?? mcpEndpointGuard())(endpoint), hosts: [endpoint.hostname] };
  }
  if (!featureEnabled(editionPolicy(deps.edition), "privateMcpServers")) throw agentXError("FORBIDDEN", "this edition does not use registered MCP servers");
  const entry = await deps.servers.get(orgId, server.serverId);
  // Read now, every time: an entry that was disabled a moment ago is not called.
  if (entry === undefined || entry.status !== "approved") throw agentXError("FORBIDDEN", "that MCP server is not approved");
  if (entry.transport.kind === "http") {
    const endpoint = new URL(entry.transport.address);
    const guard = (deps.privateGuard ?? ((org: OrgId) => privateMcpEndpointGuard({ allowed: () => allowedTargets(deps.servers, org, deps.privateCidrs ?? []) })))(orgId);
    let token: string | undefined;
    if (entry.authConnectionId !== undefined) {
      // Read now: the connection must still be read-only and still made for this same server (authConnectionFits), or its token is not sent.
      if (!authConnectionFits(await deps.connections.read(orgId, entry.authConnectionId), entry.transport.address)) throw agentXError("FORBIDDEN", "this server's connection cannot be used");
      token = await deps.connections.token(orgId, entry.authConnectionId);
      if (token === undefined) throw agentXError("CONFIG_INVALID", "this server's connection has no key");
    }
    return { endpoint, token: token ?? "", auth: token === undefined ? NO_TOKEN_AUTH : undefined, fetchImplementation: await guard(endpoint), hosts: [endpoint.hostname] };
  }
  if (deps.mcpHost === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the MCP host is not set up in this install");
  // The host address is the operator's, not a person's: it is not an SSRF input and is called with the host's own token. A stdio server has no site of its own, so
  // no address argument is ever on its host.
  return { endpoint: new URL(`${assertSecureHostUrl(deps.mcpHost.url).href.replace(/\/$/u, "")}/servers/${server.serverId}/mcp`), token: deps.mcpHost.token, auth: undefined, fetchImplementation: fetch, hosts: [] };
}

const toDiscovered = (tools: McpConnection["tools"]): DiscoveredTool[] => tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error("failed")); });
  });
}

export function gatewayServerPort(deps: ServerPortDependencies): ContextServerPort {
  const connect = deps.connect ?? connectMcp;
  const list = deps.list ?? listMcpTools;
  return {
    async open(orgId, server, signal, tools): Promise<ContextServerSession> {
      const target = await targetOf(deps, orgId, server);
      const connection = await connect({ endpoint: target.endpoint, token: target.token, tools, signal, ...(target.auth === undefined ? {} : { auth: target.auth }), fetchImplementation: target.fetchImplementation });
      return {
        hosts: target.hosts, tools: toDiscovered(connection.tools),
        call: async (name, args, callSignal): Promise<McpToolResult> => abortable(connection.call(name, args), callSignal),
        close: () => connection.close(),
      };
    },
    async listAll(orgId, server, signal): Promise<DiscoveredTool[]> {
      const target = await targetOf(deps, orgId, server);
      return toDiscovered(await list({ endpoint: target.endpoint, token: target.token, signal, ...(target.auth === undefined ? {} : { auth: target.auth }), fetchImplementation: target.fetchImplementation }));
    },
  };
}

/** The settings rules' view of the world, from the real port. */
export function sourceEnvironment(deps: ServerPortDependencies & { port: ContextServerPort }): SourceEnvironment {
  return {
    edition: deps.edition,
    connection: async (orgId, connectionId) => {
      const connection = await deps.connections.read(orgId, connectionId);
      return connection === undefined ? undefined : { type: connection.type, access: connection.access };
    },
    registeredServer: async (orgId, serverId) => {
      const entry = await deps.servers.get(orgId, serverId);
      return entry === undefined ? undefined : { status: entry.status };
    },
    discoverTools: async (orgId, server) => {
      if (deps.port.listAll === undefined) throw new Error("no tool listing");
      return deps.port.listAll(orgId, server, AbortSignal.timeout(15_000));
    },
    // Nothing checks a viewer's own identity at a source yet, so "people allowed at the source" cannot be chosen.
    perUserCheckAvailable: () => false,
  };
}

// ---------------------------------------------------------------------------------------------
// Testing a pasted address
// ---------------------------------------------------------------------------------------------

export interface HostProbeClient {
  /** Asks the MCP host to start a package for a moment and list its tools. Throws McpProbeError. */
  probe(spec: Parameters<McpProber["stdio"]>[0]): Promise<{ tools: DiscoveredTool[]; integrity: string }>;
}

/** Maps what went wrong while testing an address to one of the fixed codes. The error's own text is never kept. */
function classify(error: unknown): McpProbeError {
  if (error instanceof McpProbeError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : "";
  if (name === "McpUnauthorized") return new McpProbeError("unauthorized");
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/iu.test(message)) return new McpProbeError("timed_out");
  if (/never calls/u.test(message)) return new McpProbeError("not_allowed_address");
  if (/could not be looked up|did not resolve/u.test(message)) return new McpProbeError("dns_failed");
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|fetch failed|certificate|self[- ]signed/iu.test(message)) return new McpProbeError("unreachable");
  return new McpProbeError("not_mcp");
}

/**
 * Tests a pasted address: the form and the never-called list apply, the allow-list does not (nothing is approved yet), and the connection is pinned to the checked
 * addresses. `host` serves stdio specs. Every failure is one of the fixed codes.
 */
export function gatewayProber(deps: { host?: HostProbeClient | undefined; privateCidrs?: readonly string[] | undefined; guard?: McpEndpointGuard | undefined; list?: typeof listMcpTools | undefined; timeoutMs?: number | undefined }): McpProber {
  const list = deps.list ?? listMcpTools;
  return {
    async http(address, token) {
      try {
        const endpoint = new URL(address);
        const fetchImplementation = await (deps.guard ?? probeMcpEndpointGuard({ installCidrs: deps.privateCidrs ?? [] }))(endpoint);
        return toDiscovered(await list({ endpoint, token: token ?? "", signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000), ...(token === undefined ? { auth: NO_TOKEN_AUTH } : {}), fetchImplementation }));
      } catch (error) {
        throw classify(error);
      }
    },
    async stdio(spec) {
      if (deps.host === undefined) throw new McpProbeError("host_unavailable");
      try { return await deps.host.probe(spec); } catch (error) { throw error instanceof McpProbeError ? error : new McpProbeError("host_refused"); }
    },
  };
}

/** The MCP host's probe route, called by the broker with the host's token. */
export function hostProbeClient(host: McpHostEndpoint, fetchImplementation: typeof fetch = fetch): HostProbeClient {
  return {
    async probe(spec) {
      assertSecureHostUrl(host.url);
      let response: Response;
      try {
        response = await fetchImplementation(`${host.url.replace(/\/$/u, "")}/probe`, {
          method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ spec }), signal: AbortSignal.timeout(100_000),
        });
      } catch {
        throw new McpProbeError("host_unavailable");
      }
      if (!response.ok) throw new McpProbeError(response.status === 401 ? "host_unavailable" : "host_refused");
      const body = await response.json().catch(() => undefined) as { tools?: unknown; error?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.tools) || typeof (body as { integrity?: unknown }).integrity !== "string") throw new McpProbeError("host_refused");
      const tools = (body.tools as Array<{ name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }>)
        .filter((tool): tool is { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: DiscoveredTool["annotations"] } => typeof tool.name === "string" && typeof tool.inputSchema === "object" && tool.inputSchema !== null)
        .slice(0, 200).map((tool) => ({ name: tool.name, description: typeof tool.description === "string" ? tool.description : undefined, inputSchema: tool.inputSchema, annotations: tool.annotations }));
      return { tools, integrity: (body as { integrity: string }).integrity };
    },
  };
}
