// E6 (Enterprise): the registry of MCP servers on the customer's network, and the easy way to add one (owner decision Q12).
//
// The admin pastes an address (a private HTTPS server) or a stdio server's package (run by the MCP host). Rovara tests it and shows what it offers; the admin
// approves; the approved entry IS the install's allow-list from then on. There is no infrastructure code to edit and no second list to keep in step:
//   - `allowedTargets()` is the approved HTTP entries' hosts and ports, read at every call;
//   - an entry that is disabled or removed leaves the allow-list at once, and the next call to it is refused;
//   - the approval is bound to what was shown: the server is tested again when the admin approves, and a list of tools that moved since is refused.
// Public never reaches any of this (the `privateMcpServers` feature is Enterprise only).
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  MCP_PROBE_FAILURES, McpServerEntrySchema, McpServerTransportSchema, agentXError, canonicalJson, editionPolicy, orgScoped, requireFeature,
  type Edition, type McpProbeFailure, type McpServerEntry, type McpServerProbe, type McpServerTransport, type OrgId,
} from "@agentx/contracts";
import { parsePrivateTarget, type AllowedTarget } from "../connections/private-endpoints.js";
import { inertSentence } from "./present.js";
import { annotationVerdict, toolSchemaHash, type DiscoveredTool } from "./settings.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** A test of a server failed for a reason an admin can be told in a fixed sentence. */
export class McpProbeError extends Error {
  constructor(readonly code: McpProbeFailure) {
    super(code);
    this.name = "McpProbeError";
  }
}

export interface McpProber {
  /** Connects to the address (checked and pinned by the caller's guard) and lists its tools. `token` is the auth connection's, if the entry has one. */
  http(address: string, token: string | undefined): Promise<DiscoveredTool[]>;
  /** Asks the MCP host to start the package for a moment and list its tools. */
  stdio(spec: Extract<McpServerTransport, { kind: "stdio" }>["spec"]): Promise<DiscoveredTool[]>;
}

export interface McpServerStore {
  get(orgId: OrgId, serverId: string): Promise<McpServerEntry | undefined>;
  list(orgId: OrgId): Promise<McpServerEntry[]>;
  /** Stores a new entry; false when the id is taken. */
  create(orgId: OrgId, entry: McpServerEntry): Promise<boolean>;
  /** Moves an entry from one status to another only if it still has `from` (and, for an approval, the tools hash that was shown). */
  decide(input: { orgId: OrgId; serverId: string; from: McpServerEntry["status"]; to: McpServerEntry["status"]; by: string; at: string; toolsHash?: string }): Promise<"ok" | "stale">;
  remove(orgId: OrgId, serverId: string): Promise<boolean>;
}

const partition = (orgId: OrgId): string => orgScoped(orgId, "MCPSRV");

export function dynamoMcpServerStore(deps: { documentClient: DocumentClient; tableName: string }): McpServerStore {
  const key = (orgId: OrgId, serverId: string) => ({ pk: partition(orgId), sk: `SRV#${serverId}` });
  const parse = (item: Record<string, unknown> | undefined): McpServerEntry | undefined => {
    if (item === undefined) return undefined;
    // An item that does not parse is not served: it can never make a host allowed.
    const rest: Record<string, unknown> = { ...item };
    delete rest.pk;
    delete rest.sk;
    const parsed = McpServerEntrySchema.safeParse(rest);
    return parsed.success ? parsed.data : undefined;
  };
  const cancelled = (error: unknown): boolean => ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(String((error as { name?: unknown } | null)?.name));
  return {
    async get(orgId, serverId) {
      return parse(((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key(orgId, serverId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item);
    },
    async list(orgId) {
      const found = (await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": partition(orgId), ":prefix": "SRV#" }, Limit: 200,
      }))) as { Items?: Array<Record<string, unknown>> };
      return (found.Items ?? []).map(parse).filter((entry): entry is McpServerEntry => entry !== undefined);
    },
    async create(orgId, entry) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: deps.tableName, Item: { ...key(orgId, entry.serverId), ...entry }, ConditionExpression: "attribute_not_exists(pk)" } }] }));
        return true;
      } catch (error) {
        if (cancelled(error)) return false;
        throw error;
      }
    },
    async decide({ orgId, serverId, from, to, by, at, toolsHash }) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
          TableName: deps.tableName, Key: key(orgId, serverId), UpdateExpression: "SET #status = :to, decidedBy = :by, decidedAt = :at",
          ConditionExpression: toolsHash === undefined ? "#status = :from" : "#status = :from AND #probe.toolsHash = :hash",
          ExpressionAttributeNames: { "#status": "status", ...(toolsHash === undefined ? {} : { "#probe": "probe" }) },
          ExpressionAttributeValues: { ":from": from, ":to": to, ":by": by, ":at": at, ...(toolsHash === undefined ? {} : { ":hash": toolsHash }) },
        } }] }));
        return "ok";
      } catch (error) {
        if (cancelled(error)) return "stale";
        throw error;
      }
    },
    async remove(orgId, serverId) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: key(orgId, serverId), ConditionExpression: "attribute_exists(pk)" } }] }));
        return true;
      } catch (error) {
        if (cancelled(error)) return false;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The allow-list is the approved entries
// ---------------------------------------------------------------------------------------------

/** The hosts and ports the broker may call for this org: the approved HTTP entries, read now. A disabled entry is not in it. */
export async function allowedTargets(store: Pick<McpServerStore, "list">, orgId: OrgId, installCidrs: readonly string[]): Promise<AllowedTarget[]> {
  // No install ranges, no allow-list: an approved name alone never makes an address callable (review I2).
  if (installCidrs.length === 0) return [];
  const targets: AllowedTarget[] = [];
  for (const entry of await store.list(orgId)) {
    if (entry.status !== "approved" || entry.transport.kind !== "http") continue;
    const target = parsePrivateTarget(entry.transport.address);
    if ("problem" in target) continue;
    targets.push({ host: target.host, port: target.port, cidrs: installCidrs });
  }
  return targets;
}

// ---------------------------------------------------------------------------------------------
// Add, test, show, approve
// ---------------------------------------------------------------------------------------------

/**
 * Review I1: a connection's token goes only to that connection's own host. A server's auth connection must be a read-only MCP connection whose own address is on the
 * same host and port as the server's, so an admin cannot send another system's token (a tracker's, say) to an address they typed. Another server needs its own token.
 */
export function authConnectionFits(connection: { type: string; access: "read" | "read_write"; endpoint?: string | undefined } | undefined, address: string): boolean {
  if (connection === undefined || connection.type !== "mcp" || connection.access !== "read" || connection.endpoint === undefined) return false;
  const own = parsePrivateTarget(connection.endpoint);
  const target = parsePrivateTarget(address);
  return !("problem" in own) && !("problem" in target) && own.host === target.host && own.port === target.port;
}

export interface McpServerActor { orgId: OrgId; developerId: string; orgRole: string }

export interface McpServerDependencies {
  store: McpServerStore;
  prober: McpProber;
  edition: Edition;
  now: () => number;
  /** The token of the org connection an http entry authenticates with; absent when the entry has none. Throws or answers undefined when it cannot be read. */
  authToken(orgId: OrgId, connectionId: string): Promise<string | undefined>;
  /** Whether the connection may authenticate the server at `address`: see `authConnectionFits`. */
  authConnectionUsable(orgId: OrgId, connectionId: string, address: string): Promise<boolean>;
  /** Called before every test of a server (add and approve); false refuses it. The test is a network call from inside the customer's network, so it is bounded (review I2). */
  probeAllowed?: ((orgId: OrgId) => boolean) | undefined;
  /** Install setting: the admin who added a server may not be the one who approves it. Off by default, because adding one must be easy. */
  secondAdminToApprove?: boolean;
  newId?: () => string;
  audit?: (event: { action: "mcp_server.added" | "mcp_server.approved" | "mcp_server.disabled" | "mcp_server.removed"; actor: McpServerActor; serverId: string; label: string }) => Promise<void>;
}

function guard(deps: McpServerDependencies, actor: McpServerActor): void {
  requireFeature(editionPolicy(deps.edition), "privateMcpServers");
  if (actor.orgRole !== "owner" && actor.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can add or approve an MCP server.");
}

const told = async (deps: McpServerDependencies, event: Parameters<NonNullable<McpServerDependencies["audit"]>>[0]): Promise<void> => {
  try { await deps.audit?.(event); } catch { /* an audit hiccup does not undo the decision */ }
};

/** What the admin is shown, and what an approval is bound to. */
export function summariseProbe(tools: readonly DiscoveredTool[], now: number): McpServerProbe {
  const shown = [...tools].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100).map((tool) => ({
    name: tool.name.slice(0, 64), description: inertSentence(tool.description ?? "", 300), annotation: annotationVerdict(tool), schemaHash: toolSchemaHash(tool),
  }));
  return { at: new Date(now).toISOString(), toolsHash: createHash("sha256").update(canonicalJson(shown.map((tool) => [tool.name, tool.schemaHash]))).digest("hex"), tools: shown };
}

/** At most `max` tests per org in `windowMs`, counted in this process. */
export function probeLimiter(options: { max: number; windowMs: number; now: () => number }): (orgId: OrgId) => boolean {
  const seen = new Map<string, number[]>();
  return (orgId) => {
    const at = options.now();
    const recent = (seen.get(orgId) ?? []).filter((time) => at - time < options.windowMs);
    if (recent.length >= options.max) { seen.set(orgId, recent); return false; }
    seen.set(orgId, [...recent, at]);
    return true;
  };
}

async function probe(deps: McpServerDependencies, orgId: OrgId, transport: McpServerTransport, authConnectionId: string | undefined): Promise<McpServerProbe> {
  if (deps.probeAllowed !== undefined && !deps.probeAllowed(orgId)) throw agentXError("TOO_MANY_REQUESTS", "Too many server tests just now. Wait a few minutes and try again.");
  let tools: DiscoveredTool[];
  try {
    if (transport.kind === "http") {
      let token: string | undefined;
      if (authConnectionId !== undefined) token = await deps.authToken(orgId, authConnectionId).catch(() => undefined);
      tools = await deps.prober.http(transport.address, token);
    } else {
      tools = await deps.prober.stdio(transport.spec);
    }
  } catch (error) {
    // Only a fixed sentence is shown: a server's own error can hold addresses, banners and paths.
    const code = error instanceof McpProbeError ? error.code : "unreachable";
    throw agentXError("CONFIG_INVALID", MCP_PROBE_FAILURES[code]);
  }
  return summariseProbe(tools, deps.now());
}

export async function proposeMcpServer(deps: McpServerDependencies, actor: McpServerActor, body: { label: unknown; transport: unknown; authConnectionId?: string | undefined }): Promise<McpServerEntry> {
  guard(deps, actor);
  const label = typeof body.label === "string" ? inertSentence(body.label, 60) : "";
  if (label === "") throw agentXError("CONFIG_INVALID", "label: give the server a short name");
  const transport = McpServerTransportSchema.safeParse(body.transport);
  if (!transport.success) throw agentXError("CONFIG_INVALID", transport.error.issues[0]?.message ?? "transport: is not valid");
  if (transport.data.kind === "http") {
    const target = parsePrivateTarget(transport.data.address);
    if ("problem" in target) throw agentXError("CONFIG_INVALID", `address: ${target.problem}`);
    const same = (await deps.store.list(actor.orgId)).find((entry) => entry.transport.kind === "http" && entry.status !== "disabled" && (() => {
      const other = parsePrivateTarget(entry.transport.kind === "http" ? entry.transport.address : "");
      return !("problem" in other) && other.host === target.host && other.port === target.port;
    })());
    if (same !== undefined) throw agentXError("CONFIG_INVALID", "that server is already added; open it in the list");
  } else if (body.authConnectionId !== undefined) {
    throw agentXError("CONFIG_INVALID", "a stdio server is reached through the MCP host and takes no connection");
  }
  if (body.authConnectionId !== undefined && !await deps.authConnectionUsable(actor.orgId, body.authConnectionId, transport.data.kind === "http" ? transport.data.address : "")) {
    throw agentXError("CONFIG_INVALID", "authConnectionId: that must be a read-only MCP connection made for this same server address");
  }
  const shown = await probe(deps, actor.orgId, transport.data, body.authConnectionId);
  const entry: McpServerEntry = McpServerEntrySchema.parse({
    serverId: `mcp${(deps.newId ?? (() => randomBytes(8).toString("hex")))().replace(/[^a-z0-9]/gu, "").slice(0, 16)}`,
    label, status: "awaiting_approval", transport: transport.data, ...(body.authConnectionId === undefined ? {} : { authConnectionId: body.authConnectionId }),
    probe: shown, requestedBy: actor.developerId, requestedAt: new Date(deps.now()).toISOString(),
  });
  if (!await deps.store.create(actor.orgId, entry)) throw agentXError("IDEMPOTENCY_CONFLICT", "that server id is taken; try again");
  await told(deps, { action: "mcp_server.added", actor, serverId: entry.serverId, label: entry.label });
  return entry;
}

/**
 * Approves a server and so adds it to the allow-list. The server is tested again first: if its tools are not the ones the admin was shown, nothing is approved
 * and they are asked to look again. The decision only lands on an entry that still waits and still carries the shown tools.
 */
export async function approveMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<McpServerEntry> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry === undefined || entry.status !== "awaiting_approval") throw agentXError("NOT_FOUND", "no MCP server is waiting for approval with that id");
  if (deps.secondAdminToApprove === true && entry.requestedBy === actor.developerId) throw agentXError("FORBIDDEN", "A second admin must approve this server.");
  const again = await probe(deps, actor.orgId, entry.transport, entry.authConnectionId);
  if (again.toolsHash !== entry.probe.toolsHash) throw agentXError("CHANGE_STALE", "The server's tools are not the ones you were shown. Add it again to look at what it offers now.");
  const at = new Date(deps.now()).toISOString();
  if (await deps.store.decide({ orgId: actor.orgId, serverId, from: "awaiting_approval", to: "approved", by: actor.developerId, at, toolsHash: entry.probe.toolsHash }) === "stale") {
    throw agentXError("CHANGE_STALE", "That server was already decided. Reload the list.");
  }
  await told(deps, { action: "mcp_server.approved", actor, serverId, label: entry.label });
  return { ...entry, status: "approved", decidedBy: actor.developerId, decidedAt: at };
}

/** Takes an approved server out of the allow-list (or turns down one that waits). Any admin may, at once. */
export async function disableMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<void> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry === undefined || entry.status === "disabled") throw agentXError("NOT_FOUND", "no MCP server with that id is in use");
  const result = await deps.store.decide({ orgId: actor.orgId, serverId, from: entry.status, to: "disabled", by: actor.developerId, at: new Date(deps.now()).toISOString() });
  if (result === "stale") throw agentXError("CHANGE_STALE", "That server changed while this was decided. Reload the list.");
  await told(deps, { action: "mcp_server.disabled", actor, serverId, label: entry.label });
}

export async function removeMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<void> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry === undefined) throw agentXError("NOT_FOUND", "no MCP server has that id");
  if (entry.status === "approved") throw agentXError("CONFIG_INVALID", "Turn the server off first, then remove it.");
  await deps.store.remove(actor.orgId, serverId);
  await told(deps, { action: "mcp_server.removed", actor, serverId, label: entry.label });
}

/** The list the settings page shows an admin: every entry, with the tools each offers. */
export async function listMcpServers(deps: McpServerDependencies, actor: McpServerActor): Promise<McpServerEntry[]> {
  guard(deps, actor);
  return (await deps.store.list(actor.orgId)).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}
