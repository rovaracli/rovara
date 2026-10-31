// ME-13 (wire lane C): what the install hands to the lane E builders (`wiring.ts`), in one place that reads the operator's settings and fails closed.
//
//   ROVARA_EDITION              enterprise | public (unset is Public; anything else stops the install)
//   ROVARA_PRIVATE_MCP_CIDRS    Enterprise: the private ranges outside which no private MCP server is tested or called (unset: none, so every private server is refused)
//   ROVARA_VPC_CIDRS            Enterprise: the network Rovara itself runs in (set by the install). A private range that overlaps it stops the install; an address inside it is never tested or called
//   ROVARA_STDIO_MCP_SERVERS    Enterprise: exactly "1" runs servers from a package through the MCP host. OFF by default; NOT FOR PRODUCTION until the host is redesigned (register ME-14)
//   MCP_HOST_URL, MCP_HOST_TOKEN  the host's address (https; http only on this machine's loopback) and the bearer the broker presents
//
// Public ignores every private-network setting. A host address that is not https stops the install even while package-run servers are off, so a later switch-on cannot send the token in clear.
import { EditionSchema, agentXError, type Edition } from "@agentx/contracts";
import type { AuditDeps } from "../audit/outbox.js";
import { cidrBlockListOf, parseInstallCidrs } from "../connections/private-endpoints.js";
import { contextSourceAudit, mcpServerAudit } from "./audit.js";
import { connectionLookupFromStore, createContextSourceRouteDependencies, createContextSourcesRuntime, createMcpServerDependencies, serverSecretsFromOrgSecrets } from "./wiring.js";
import type { OrgConnectionDeps } from "../connections/store.js";
import { probeLimiter, type McpServerDependencies } from "./mcp-servers.js";
import { registerContextSourceCleanup, dynamoResultStore } from "./quotes.js";
import type { ContextSourcesRuntime } from "./runtime.js";
import { assertSecureHostUrl, type McpHostEndpoint } from "./server-port.js";
import type { ContextSourceRouteDependencies } from "./settings-routes.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PrivateMcpInstallConfig {
  edition: Edition;
  /** `parseInstallCidrs(ROVARA_PRIVATE_MCP_CIDRS)`; empty means every private server is refused. */
  privateCidrs: string[];
  /** `ROVARA_VPC_CIDRS`: the network Rovara runs in. */
  rovaraCidrs: string[];
  /** True only for Enterprise with `ROVARA_STDIO_MCP_SERVERS=1` and a host. */
  stdioEnabled: boolean;
  mcpHost?: McpHostEndpoint;
}

/** Reads the settings above. Throws a CONFIG_INVALID that names the setting (never its value, which may be a token) when one is wrong. */
export function privateMcpInstallConfig(env: Environment): PrivateMcpInstallConfig {
  const configured = env.ROVARA_EDITION;
  let edition: Edition = "public";
  if (configured !== undefined && configured !== "") {
    const parsed = EditionSchema.safeParse(configured);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "ROVARA_EDITION must be exactly enterprise or public");
    edition = parsed.data;
  }
  if (edition !== "enterprise") return { edition, privateCidrs: [], rovaraCidrs: [], stdioEnabled: false };

  const rovaraCidrs = (env.ROVARA_VPC_CIDRS ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (cidrBlockListOf(rovaraCidrs) === undefined) throw agentXError("CONFIG_INVALID", "ROVARA_VPC_CIDRS is not a list of ranges such as 10.42.0.0/16");
  const privateCidrs = parseInstallCidrs(env.ROVARA_PRIVATE_MCP_CIDRS, rovaraCidrs);
  const stdioEnabled = env.ROVARA_STDIO_MCP_SERVERS === "1";
  const url = env.MCP_HOST_URL;
  const token = env.MCP_HOST_TOKEN;
  const hostGiven = url !== undefined && url !== "";
  if (stdioEnabled && !hostGiven) throw agentXError("CONFIG_INVALID", "ROVARA_STDIO_MCP_SERVERS=1 needs MCP_HOST_URL, the address of the MCP host");
  if (!hostGiven) return { edition, privateCidrs, rovaraCidrs, stdioEnabled: false };
  // https only, checked now: the token never goes to an http:// address, whether or not package-run servers are on yet.
  assertSecureHostUrl(url);
  if (token === undefined || token === "") throw agentXError("CONFIG_INVALID", "MCP_HOST_URL needs MCP_HOST_TOKEN, the host's bearer token");
  return { edition, privateCidrs, rovaraCidrs, stdioEnabled, mcpHost: { url, token } };
}

export interface ContextSourcesInstall {
  config: PrivateMcpInstallConfig;
  /** For `AwsBrokerDependencies.contextSources`. */
  runtime: ContextSourcesRuntime;
  /** For `AgentRouteDependencies.contextSources` and, in Enterprise only, `.mcpServers`. The MCP servers flow is built once, so its test limiter lasts. */
  routes(input: { requireProjectRole: ContextSourceRouteDependencies["requireProjectRole"] }): { contextSources: ContextSourceRouteDependencies; mcpServers?: McpServerDependencies };
  /** Takes the live-only cleanup off the task-end hook again (tests). */
  stopCleanup?: () => void;
}

export interface ContextSourcesInstallInput {
  env: Environment;
  /** The org connection dependencies of the broker. Absent where no connection secrets role exists: then there is nowhere safe to keep a server's token and the lane stays inert. */
  orgConnections: OrgConnectionDeps | undefined;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now?: () => number;
  /** Default true: delete a task's live-only source text when it ends. */
  registerCleanup?: boolean;
  /** The Audit Ledger (`dependencies.audit`). Absent on a legacy install: nothing is recorded. */
  audit?: AuditDeps;
}

/** Builds the lane for this install, or undefined (inert: no sources, no capability) where there is no connection secrets role. A wrong setting throws. */
export function installContextSources(input: ContextSourcesInstallInput): ContextSourcesInstall | undefined {
  const connectionDeps = input.orgConnections;
  if (connectionDeps === undefined) return undefined;
  const config = privateMcpInstallConfig(input.env);
  const common = {
    documentClient: input.documentClient, tableName: input.tableName, now: input.now ?? Date.now, edition: config.edition,
    connections: connectionLookupFromStore(connectionDeps),
    serverSecrets: serverSecretsFromOrgSecrets({ env: connectionDeps.env, secrets: connectionDeps.secrets }),
    stdioEnabled: config.stdioEnabled,
    privateCidrs: config.privateCidrs,
    rovaraCidrs: config.rovaraCidrs,
    ...(config.mcpHost === undefined ? {} : { mcpHost: config.mcpHost }),
  };
  const runtime = createContextSourcesRuntime(common);
  // Admin changes to servers and Sources are recorded in the Audit Ledger (audit.ts), where the install has one.
  const ledger: AuditDeps = input.audit ?? {};
  const serverAudit = mcpServerAudit(ledger, common.now);
  const sourceAudit = contextSourceAudit(ledger, common.now);
  // One limiter for the install: listing a server's tools is a call out to the server, so each org may do it only so often (like the test of a pasted server).
  const discoverAllowed = probeLimiter({ max: 30, windowMs: 600_000, now: common.now });
  // Built once for the install: the limiter on tests of a pasted server counts in this process.
  const mcpServers = config.edition === "enterprise" ? createMcpServerDependencies({ ...common, ...(serverAudit === undefined ? {} : { audit: serverAudit }) }) : undefined;
  const stopCleanup = input.registerCleanup === false ? undefined : registerContextSourceCleanup({ store: dynamoResultStore(common), log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })) });
  return {
    config, runtime,
    routes: ({ requireProjectRole }) => ({
      contextSources: createContextSourceRouteDependencies({ ...common, requireProjectRole, discoverAllowed, ...(sourceAudit === undefined ? {} : { audit: sourceAudit }) }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    }),
    ...(stopCleanup === undefined ? {} : { stopCleanup }),
  };
}

const installs = new WeakMap<object, ContextSourcesInstall | null>();

/**
 * The install, built once per set of connection dependencies (the broker builds those once per container). The broker's dependency builders run for every request; the limiter on
 * server tests and the cleanup hook must not be rebuilt with them.
 */
export function sharedContextSourcesInstall(input: ContextSourcesInstallInput): ContextSourcesInstall | undefined {
  if (input.orgConnections === undefined) return undefined;
  const known = installs.get(input.orgConnections);
  if (known !== undefined) return known ?? undefined;
  const built = installContextSources(input) ?? null;
  installs.set(input.orgConnections, built);
  return built ?? undefined;
}
