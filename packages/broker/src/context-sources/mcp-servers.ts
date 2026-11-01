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
  MCP_INSTALL_FAILURES, MCP_PROBE_FAILURES, McpServerEntrySchema, McpServerProposalTransportSchema, agentXError, canonicalJson, editionPolicy, featureEnabled, orgScoped, readStoredMcpServerEntry, requireFeature, stdioSpecIfComplete,
  type Edition, type McpInstallFailureCode, type McpProbeFailure, type McpServerEntry, type McpServerProbe, type McpServerTransport, type McpStdioProposal, type OrgId,
} from "@agentx/contracts";
import { parsePrivateTarget, type AllowedTarget } from "../connections/private-endpoints.js";
import type { ControllerEventStore, DrainDependencies } from "./controller-events.js";
import { inertSentence } from "./present.js";
import { annotationVerdict, toolSchemaHash, type DiscoveredTool } from "./settings.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

/** A test of a server failed for a reason an admin can be told in a fixed sentence. */
export class McpProbeError extends Error {
  /** `installCode` is the fixed code of an install that failed; `computedIntegrity` is the checksum the registry's tarball really has (shown when the admin typed another). Both are checked values, never host text. */
  constructor(readonly code: McpProbeFailure, readonly detail: { installCode?: McpInstallFailureCode; computedIntegrity?: string } = {}) {
    super(code);
    this.name = "McpProbeError";
  }
}

/** The one sentence an admin is shown for a failed test. A fixed table: nothing the host or a server said is in it. */
export function probeFailureSentence(error: McpProbeError): string {
  if (error.code === "install_failed" && error.detail.installCode !== undefined) {
    const sentence = MCP_INSTALL_FAILURES[error.detail.installCode];
    return error.detail.installCode === "integrity_mismatch" && error.detail.computedIntegrity !== undefined && /^sha512-[A-Za-z0-9+/=]{20,200}$/u.test(error.detail.computedIntegrity)
      ? `${sentence} The checksum of what your registry serves is ${error.detail.computedIntegrity}.` : sentence;
  }
  return MCP_PROBE_FAILURES[error.code];
}

export interface McpProber {
  /** Connects to the address (checked and pinned by the caller's guard) and lists its tools. `token` is the auth connection's, if the entry has one. */
  http(address: string, token: string | undefined): Promise<DiscoveredTool[]>;
  /**
   * Asks the MCP host to install the package for a moment and list its tools. `integrity` is the tarball's, computed by the host from the bytes it installed. `lockfileHash` and
   * `bundleHash` are the install's: the approval binds them. A host that returns neither cannot complete a proposal. With `pinned` (an approval) nothing is installed: the host tests the
   * bundle that was pinned, and says which bundle it tested.
   */
  stdio(spec: McpStdioProposal, pinned?: { lockfileHash: string; bundleHash: string }, serverId?: string): Promise<{
    tools: DiscoveredTool[]; integrity: string; lockfileHash?: string | undefined; bundleHash?: string | undefined; installed?: { packageCount: number; unpackedBytes: number } | undefined;
  }>;
}

export interface McpServerStore {
  get(orgId: OrgId, serverId: string): Promise<McpServerEntry | undefined>;
  list(orgId: OrgId): Promise<McpServerEntry[]>;
  /** Every entry of the org, page after page, and how many items could not be read (they are not served by `list` either). For closing an org. */
  listAll(orgId: OrgId): Promise<{ entries: McpServerEntry[]; unreadable: number }>;
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
    // An entry stored before the approval bound its install is read as `needs_reapproval` (never served, never approvable as it is).
    return readStoredMcpServerEntry(rest);
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
    async listAll(orgId) {
      const entries: McpServerEntry[] = [];
      let unreadable = 0;
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = (await deps.documentClient.send(new QueryCommand({
          TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": partition(orgId), ":prefix": "SRV#" }, Limit: 200,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of page.Items ?? []) {
          const entry = parse(item);
          if (entry === undefined) unreadable += 1; else entries.push(entry);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);
      return { entries, unreadable };
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
      // `needs_reapproval` is how a legacy row is READ; the row itself still says approved or waiting. It can only be turned off, and never moved to any other status.
      const legacy = from === "needs_reapproval";
      if (legacy && to !== "disabled") return "stale";
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
          TableName: deps.tableName, Key: key(orgId, serverId), UpdateExpression: "SET #status = :to, decidedBy = :by, decidedAt = :at",
          ConditionExpression: legacy ? "(#status = :from OR #status = :legacyApproved OR #status = :legacyWaiting)" : toolsHash === undefined ? "#status = :from" : "#status = :from AND #probe.toolsHash = :hash",
          ExpressionAttributeNames: { "#status": "status", ...(toolsHash === undefined ? {} : { "#probe": "probe" }) },
          ExpressionAttributeValues: { ":from": from, ":to": to, ":by": by, ":at": at, ...(legacy ? { ":legacyApproved": "approved", ":legacyWaiting": "awaiting_approval" } : {}), ...(toolsHash === undefined || legacy ? {} : { ":hash": toolsHash }) },
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
 * A registered server's own token. It is write-only: `put` stores it under the server's id (the org's secret store, tagged and reachable only with the org's session),
 * nothing reads it back to a person, and the only reader is the broker's call to this server's checked host and port. It is not an org connection: no other system's token
 * can be chosen for a typed address (review I1), and none needs to share the server's host.
 */
export interface McpServerSecrets {
  put(orgId: OrgId, serverId: string, value: string): Promise<string>;
  read(orgId: OrgId, serverId: string, version?: string): Promise<string | undefined>;
  remove(orgId: OrgId, serverId: string): Promise<void>;
}

/** The sentence an admin is told when a package-run server is asked for and the install has that switched off. */
export const STDIO_OFF_MESSAGE = "Servers that Rovara runs from a package are not available on this install yet. Add a server that has an address.";

export interface McpServerActor { orgId: OrgId; developerId: string; orgRole: string }

/** What the audit trail is told: ids, fixed words and flags. The label goes in the event's org details; an address and a token never do. */
export type McpServerAuditEvent =
  | { action: "mcp_server.added" | "mcp_server.disabled" | "mcp_server.removed"; actor: McpServerActor; serverId: string; label: string; transport: "http" | "stdio"; hasToken: boolean }
  /** `pin` (package-run servers): what the approval bound, as hashes and counts; `destinations` and `secretNames` are the org's details (names only, never values). */
  | { action: "mcp_server.approved"; actor: McpServerActor; serverId: string; label: string; transport: "http" | "stdio"; hasToken: boolean; pin?: { integrity: string; lockfileHash: string; bundleHash: string; toolsHash: string; destinationCount: number; secretCount: number; secretVersion?: string | undefined; destinations: string; secretNames: string } }
  | { action: "mcp_server.token_changed"; actor: McpServerActor; serverId: string; change: "stored" | "deleted" }
  | { action: "mcp_server.installed"; actor: McpServerActor; serverId: string; name: string; version: string; integrity: string; lockfileHash: string; bundleHash: string; packageCount?: number | undefined; unpackedBytes?: number | undefined }
  | { action: "mcp_server.probed"; actor: McpServerActor; serverId: string; purpose: "proposal" | "approval"; toolsHash: string; bundleHash: string; toolCount: number };

export interface McpServerDependencies {
  store: McpServerStore;
  prober: McpProber;
  edition: Edition;
  now: () => number;
  /** Each server's own write-only token. */
  secrets: McpServerSecrets;
  /**
   * Whether this install runs servers from a package (the MCP host). Off unless the operator switched it on AND the edition has the `stdioMcpServers` feature. NOT FOR
   * PRODUCTION until the host is redesigned (see the lane E follow-up): with it off, a package-run server cannot be added or approved, and the broker never calls the host.
   */
  stdioEnabled?: boolean | undefined;
  /** Called before every test of a server (add and approve); false refuses it. The test is a network call from inside the customer's network, so it is bounded (review I2). */
  probeAllowed?: ((orgId: OrgId) => boolean) | undefined;
  /** Install setting: the admin who added a server may not be the one who approves it. Off by default, because adding one must be easy. */
  secondAdminToApprove?: boolean;
  newId?: () => string;
  audit?: (event: McpServerAuditEvent) => Promise<void>;
  /** What the MCP controller wrote about package-run servers: shown as "recent starts" and recorded in the audit trail when an admin lists the servers (controller-events.ts). */
  controllerEvents?: { store: ControllerEventStore; audit?: DrainDependencies["audit"] } | undefined;
  /** The MCP host (package-run servers). Told, best effort, when a server is turned off or removed so its task, task definition and security group go at once; the host's own sweep does it within a minute otherwise. */
  host?: Pick<McpHostControl, "release"> | undefined;
}

/** What the broker asks of the MCP host besides tests and calls (T9). Every call is bounded and best effort: a host that does not answer never blocks the admin. */
export interface McpHostControl {
  /** Starts the server's task now (a stage that has this source is about to run), so no tool call waits for the cold start. */
  warm(serverId: string): Promise<void>;
  /** Stops the server's task and removes what was made for it. The host refuses while the server is still approved. */
  release(serverId: string): Promise<void>;
}

function guard(deps: McpServerDependencies, actor: McpServerActor): void {
  requireFeature(editionPolicy(deps.edition), "privateMcpServers");
  if (actor.orgRole !== "owner" && actor.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can add or approve an MCP server.");
}

/** A package-run server is refused with a clear sentence unless the install runs the MCP host (Enterprise, switched on). */
export function stdioAvailable(deps: Pick<McpServerDependencies, "edition" | "stdioEnabled">): boolean {
  return deps.stdioEnabled === true && featureEnabled(editionPolicy(deps.edition), "stdioMcpServers");
}

const told = async (deps: McpServerDependencies, event: McpServerAuditEvent): Promise<void> => {
  try { await deps.audit?.(event); } catch { /* an audit hiccup does not undo the decision */ }
};

/** What the admin is shown, and what an approval is bound to. */
export function summariseProbe(tools: readonly DiscoveredTool[], now: number): McpServerProbe {
  const shown = [...tools].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100).map((tool) => ({
    name: tool.name.slice(0, 64), description: inertSentence(tool.description ?? "", 300), annotation: annotationVerdict(tool), schemaHash: toolSchemaHash(tool),
  }));
  return { at: new Date(now).toISOString(), toolsHash: createHash("sha256").update(canonicalJson(shown.map((tool) => [tool.name, tool.schemaHash]))).digest("hex"), tools: shown };
}

/**
 * At most `max` tests per org in `windowMs`, counted in this process. An org that has been idle for a whole window is forgotten (swept at most once a window), so the map
 * holds only orgs seen recently; `size()` says how many.
 */
export function probeLimiter(options: { max: number; windowMs: number; now: () => number }): ((orgId: OrgId) => boolean) & { size(): number } {
  const seen = new Map<string, number[]>();
  let sweptAt = options.now();
  const limiter = (orgId: OrgId): boolean => {
    const at = options.now();
    if (at - sweptAt >= options.windowMs) {
      for (const [key, times] of seen) if (times.every((time) => at - time >= options.windowMs)) seen.delete(key);
      sweptAt = at;
    }
    const recent = (seen.get(orgId) ?? []).filter((time) => at - time < options.windowMs);
    if (recent.length >= options.max) { seen.set(orgId, recent); return false; }
    seen.set(orgId, [...recent, at]);
    return true;
  };
  return Object.assign(limiter, { size: () => seen.size });
}

async function probe(deps: McpServerDependencies, orgId: OrgId, transport: McpServerEntry["transport"] | { kind: "stdio"; spec: McpStdioProposal }, token: string | undefined, serverId?: string): Promise<{ probe: McpServerProbe; integrity?: string; lockfileHash?: string | undefined; bundleHash?: string | undefined; installed?: { packageCount: number; unpackedBytes: number } }> {
  if (deps.probeAllowed !== undefined && !deps.probeAllowed(orgId)) throw agentXError("TOO_MANY_REQUESTS", "Too many server tests just now. Wait a few minutes and try again.");
  let tools: DiscoveredTool[];
  let integrity: string | undefined;
  let lockfileHash: string | undefined;
  let bundleHash: string | undefined;
  let installed: { packageCount: number; unpackedBytes: number } | undefined;
  try {
    if (transport.kind === "http") {
      tools = await deps.prober.http(transport.address, token);
    } else {
      // The spec is passed on as the admin's proposal: the install computes the hashes, so a proposal carries none. An approval passes the pinned pair apart from the proposal, so the host
      // tests that bundle and does not install again; what it answers is compared with the pin below.
      const proposal: Record<string, unknown> = { ...transport.spec };
      const held = proposal as { lockfileHash?: unknown; bundleHash?: unknown };
      const pinned = typeof held.lockfileHash === "string" && typeof held.bundleHash === "string" ? { lockfileHash: held.lockfileHash, bundleHash: held.bundleHash } : undefined;
      delete proposal.lockfileHash;
      delete proposal.bundleHash;
      ({ tools, integrity, lockfileHash, bundleHash, installed } = await deps.prober.stdio(proposal as McpStdioProposal, pinned, serverId));
    }
  } catch (error) {
    // Only a fixed sentence is shown: a server's own error can hold addresses, banners and paths.
    throw agentXError("CONFIG_INVALID", error instanceof McpProbeError ? probeFailureSentence(error) : MCP_PROBE_FAILURES.unreachable);
  }
  return {
    probe: summariseProbe(tools, deps.now()), ...(integrity === undefined ? {} : { integrity }), ...(lockfileHash === undefined ? {} : { lockfileHash }), ...(bundleHash === undefined ? {} : { bundleHash }),
    ...(installed === undefined ? {} : { installed }),
  };
}

/** The values a package-run server is given as environment variables, by name. Bounded; only printable characters, so a pasted value cannot smuggle a line break into an environment. */
const SECRET_VALUE = /^[\x20-\x7e]{1,4096}$/u;

/** The JSON secret for a package-run server: exactly one value per declared name, none extra. Throws a fixed sentence naming the field, never a value. */
export function stdioSecretDocument(secretEnv: readonly string[], values: unknown): string | undefined {
  if (secretEnv.length === 0) {
    if (values !== undefined && !(typeof values === "object" && values !== null && Object.keys(values).length === 0)) throw agentXError("CONFIG_INVALID", "secrets: this server declares no secret names, so it takes no secret values");
    return undefined;
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw agentXError("CONFIG_INVALID", "secrets: give a value for each secret name");
  const given = Object.keys(values);
  if (given.length !== secretEnv.length || !secretEnv.every((name) => Object.prototype.hasOwnProperty.call(values, name))) throw agentXError("CONFIG_INVALID", "secrets: give exactly one value for each secret name, and no others");
  const document: Record<string, string> = {};
  for (const name of secretEnv) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value !== "string" || !SECRET_VALUE.test(value)) throw agentXError("CONFIG_INVALID", `secrets: the value for ${name} must be 1 to 4096 plain characters`);
    document[name] = value;
  }
  return JSON.stringify(document);
}

export async function proposeMcpServer(deps: McpServerDependencies, actor: McpServerActor, body: { label: unknown; transport: unknown; secret?: string | undefined; secrets?: unknown }): Promise<McpServerEntry> {
  guard(deps, actor);
  const label = typeof body.label === "string" ? inertSentence(body.label, 60) : "";
  if (label === "") throw agentXError("CONFIG_INVALID", "label: give the server a short name");
  const transport = McpServerProposalTransportSchema.safeParse(body.transport);
  if (!transport.success) throw agentXError("CONFIG_INVALID", transport.error.issues[0]?.message ?? "transport: is not valid");
  if (transport.data.kind === "http") {
    const target = parsePrivateTarget(transport.data.address);
    if ("problem" in target) throw agentXError("CONFIG_INVALID", `address: ${target.problem}`);
    const same = (await deps.store.list(actor.orgId)).find((entry) => entry.transport.kind === "http" && entry.status !== "disabled" && (() => {
      const other = parsePrivateTarget(entry.transport.kind === "http" ? entry.transport.address : "");
      return !("problem" in other) && other.host === target.host && other.port === target.port;
    })());
    if (same !== undefined) throw agentXError("CONFIG_INVALID", "that server is already added; open it in the list");
  } else {
    if (!stdioAvailable(deps)) throw agentXError("FORBIDDEN", STDIO_OFF_MESSAGE);
    if (body.secret !== undefined) throw agentXError("CONFIG_INVALID", "a server that Rovara runs takes secrets by name (secrets), not a token");
  }
  if (transport.data.kind === "http" && body.secrets !== undefined) throw agentXError("CONFIG_INVALID", "secrets: a server with an address takes one token, not secrets by name");
  // The values of a package-run server's secrets, as the one JSON document the task reads (checked now; stored below, before the test, because the test task reads them too).
  const secretDocument = transport.data.kind === "stdio" ? stdioSecretDocument(transport.data.spec.secretEnv, body.secrets) : undefined;
  const serverId = `mcp${(deps.newId ?? (() => randomBytes(8).toString("hex")))().replace(/[^a-z0-9]/gu, "").slice(0, 16)}`;
  // A package-run server's secrets are stored under the proposal's own id BEFORE the test (the probe task reads them like the serving task will); they are deleted again if the test fails
  // or the entry cannot be stored. If that delete fails the secret stays, unreferenced: only a test of THIS id can read it (the controller refuses it once the id has an approved or
  // other entry), nothing else is ever given the id, and the secret store's own recovery window applies when it is cleaned up.
  const dropStoredSecrets = async (): Promise<void> => { if (secretDocument !== undefined) await deps.secrets.remove(actor.orgId, serverId).catch(() => undefined); };
  let stdioSecretVersion: string | undefined;
  if (secretDocument !== undefined) stdioSecretVersion = await deps.secrets.put(actor.orgId, serverId, secretDocument);
  let shown: Awaited<ReturnType<typeof probe>>;
  try {
    shown = await probe(deps, actor.orgId, transport.data, body.secret, secretDocument === undefined ? undefined : serverId);
    // A stdio package is pinned by its tarball's integrity (the one the admin gave, which the host refused anything else than, or the one the host computed and the admin sees now)
    // AND by the install's lockfile and bundle hashes. A host that did not return the hashes cannot complete a proposal: nothing is stored.
    if (transport.data.kind === "stdio" && (shown.integrity === undefined || shown.lockfileHash === undefined || shown.bundleHash === undefined)) throw agentXError("CONFIG_INVALID", MCP_PROBE_FAILURES.host_refused);
  } catch (error) {
    await dropStoredSecrets();
    throw error;
  }
  const stored: McpServerTransport = transport.data.kind === "http" ? transport.data : { kind: "stdio", spec: { ...transport.data.spec, integrity: shown.integrity!, lockfileHash: shown.lockfileHash!, bundleHash: shown.bundleHash! } };
  // An address-server's token is stored only after the test passed with it, under this server's id, and is never returned (the entry holds only that there is one).
  const secretVersion = stdioSecretVersion ?? (body.secret === undefined ? undefined : await deps.secrets.put(actor.orgId, serverId, body.secret));
  const entry: McpServerEntry = McpServerEntrySchema.parse({
    serverId, label, status: "awaiting_approval", transport: stored, ...(secretVersion === undefined ? {} : { hasSecret: true, secretVersion }),
    probe: shown.probe, ...(shown.installed === undefined ? {} : { install: shown.installed }), requestedBy: actor.developerId, requestedAt: new Date(deps.now()).toISOString(),
  });
  if (!await deps.store.create(actor.orgId, entry)) {
    await deps.secrets.remove(actor.orgId, serverId).catch(() => undefined);
    throw agentXError("IDEMPOTENCY_CONFLICT", "that server id is taken; try again");
  }
  await told(deps, { action: "mcp_server.added", actor, serverId: entry.serverId, label: entry.label, transport: entry.transport.kind, hasToken: entry.hasSecret === true });
  if (secretVersion !== undefined) await told(deps, { action: "mcp_server.token_changed", actor, serverId: entry.serverId, change: "stored" });
  if (entry.transport.kind === "stdio") {
    // What the install produced and what the test listed: two facts in the ledger, so the approval that follows can be traced to the bytes the admin was shown.
    const spec = stdioSpecIfComplete(entry)!;
    await told(deps, { action: "mcp_server.installed", actor, serverId: entry.serverId, name: spec.name, version: spec.version, integrity: spec.integrity, lockfileHash: spec.lockfileHash, bundleHash: spec.bundleHash, packageCount: entry.install?.packageCount, unpackedBytes: entry.install?.unpackedBytes });
    await told(deps, { action: "mcp_server.probed", actor, serverId: entry.serverId, purpose: "proposal", toolsHash: entry.probe.toolsHash, bundleHash: spec.bundleHash, toolCount: entry.probe.tools.length });
  }
  return entry;
}

/**
 * Approves a server and so adds it to the allow-list. The server is tested again first: if its tools are not the ones the admin was shown, nothing is approved
 * and they are asked to look again. The decision only lands on an entry that still waits and still carries the shown tools.
 */
export async function approveMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<McpServerEntry> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry?.status === "needs_reapproval") throw agentXError("CHANGE_STALE", "This server was added before approvals pinned the install. Add the package again to look at it now.");
  if (entry?.status === "changed_needs_review") throw agentXError("CHANGE_STALE", "This server's tools changed after you allowed it, so it is paused. Add the package again to look at what it offers now, then turn the old one off.");
  if (entry === undefined || entry.status !== "awaiting_approval") throw agentXError("NOT_FOUND", "no MCP server is waiting for approval with that id");
  if (deps.secondAdminToApprove === true && entry.requestedBy === actor.developerId) throw agentXError("FORBIDDEN", "A second admin must approve this server.");
  if (entry.transport.kind === "stdio" && !stdioAvailable(deps)) throw agentXError("FORBIDDEN", STDIO_OFF_MESSAGE);
  // The server's own token is read now (review m3): an entry whose token cannot be read is not approved, and the test sends exactly what a call will send.
  let token: string | undefined;
  // A package-run server's secrets are read by its test task from the secret store, never by the broker; only an address-server's token is read here.
  if (entry.hasSecret === true && entry.transport.kind === "http") {
    token = await deps.secrets.read(actor.orgId, serverId, entry.secretVersion).catch(() => undefined);
    if (token === undefined) throw agentXError("CONFIG_INVALID", "This server's token can no longer be read. Add the server again.");
  }
  // A package-run entry is approved only with its install pinned (both hashes); the strict schema already refuses to store one without.
  const pinned = entry.transport.kind === "stdio" ? stdioSpecIfComplete(entry) : undefined;
  if (entry.transport.kind === "stdio" && pinned === undefined) throw agentXError("CHANGE_STALE", "This server was added before approvals pinned the install. Add the package again to look at it now.");
  const again = await probe(deps, actor.orgId, entry.transport, token, entry.transport.kind === "stdio" && entry.hasSecret === true ? serverId : undefined);
  // The host installed the tarball again and checked it against the pinned integrity; a different tarball or bundle never gets here, and the tools must be the ones that were shown.
  if (pinned !== undefined && (again.integrity !== pinned.integrity || again.lockfileHash !== pinned.lockfileHash || again.bundleHash !== pinned.bundleHash)) throw agentXError("CHANGE_STALE", "The package is not the one you were shown. Add it again to look at it now.");
  if (again.probe.toolsHash !== entry.probe.toolsHash) throw agentXError("CHANGE_STALE", "The server's tools are not the ones you were shown. Add it again to look at what it offers now.");
  const at = new Date(deps.now()).toISOString();
  if (await deps.store.decide({ orgId: actor.orgId, serverId, from: "awaiting_approval", to: "approved", by: actor.developerId, at, toolsHash: entry.probe.toolsHash }) === "stale") {
    throw agentXError("CHANGE_STALE", "That server was already decided. Reload the list.");
  }
  if (pinned !== undefined) await told(deps, { action: "mcp_server.probed", actor, serverId, purpose: "approval", toolsHash: again.probe.toolsHash, bundleHash: pinned.bundleHash, toolCount: again.probe.tools.length });
  await told(deps, {
    action: "mcp_server.approved", actor, serverId, label: entry.label, transport: entry.transport.kind, hasToken: entry.hasSecret === true,
    ...(pinned === undefined ? {} : { pin: {
      integrity: pinned.integrity, lockfileHash: pinned.lockfileHash, bundleHash: pinned.bundleHash, toolsHash: entry.probe.toolsHash, destinationCount: pinned.destinations.length, secretCount: pinned.secretEnv.length, secretVersion: entry.secretVersion,
      destinations: pinned.destinations.map((item) => `${item.host}:${item.port}`).join(", "), secretNames: pinned.secretEnv.join(", "),
    } }),
  });
  return { ...entry, status: "approved", decidedBy: actor.developerId, decidedAt: at };
}

/** Takes an approved server out of the allow-list (or turns down one that waits). Any admin may, at once. */
export async function disableMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<void> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry === undefined || entry.status === "disabled") throw agentXError("NOT_FOUND", "no MCP server with that id is in use");
  const result = await deps.store.decide({ orgId: actor.orgId, serverId, from: entry.status, to: "disabled", by: actor.developerId, at: new Date(deps.now()).toISOString() });
  if (result === "stale") throw agentXError("CHANGE_STALE", "That server changed while this was decided. Reload the list.");
  await told(deps, { action: "mcp_server.disabled", actor, serverId, label: entry.label, transport: entry.transport.kind, hasToken: entry.hasSecret === true });
  if (entry.transport.kind === "stdio") await deps.host?.release(serverId).catch(() => undefined);
  // ME-16: a disabled server is never turned back on, so its token has no further use: delete it now. The server is already off (the allow-list reads the entry at every call); if the delete
  // fails the admin is told and removing the server tries again.
  if (entry.hasSecret === true) {
    try { await deps.secrets.remove(actor.orgId, serverId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The server is turned off, but its token could not be deleted just now. Remove the server to try again."); }
    await told(deps, { action: "mcp_server.token_changed", actor, serverId, change: "deleted" });
  }
}

/**
 * What closing an org does to its MCP servers (ME-16): every entry and every token of the org goes, in any status, and no other org's. The token is deleted first and the entry after,
 * so a failure leaves the entry for the next run; running it again after a stop part-way finishes the rest. Every page is read, and an unreadable item stops it before anything is removed.
 */
export async function clearOrgMcpServers(deps: Pick<McpServerDependencies, "store" | "secrets">, orgId: OrgId): Promise<void> {
  const { entries, unreadable } = await deps.store.listAll(orgId);
  // An item that cannot be read may hold a token that cannot be found: stop, before anything else is removed, rather than call the org cleared.
  if (unreadable > 0) throw agentXError("RUNTIME_UNAVAILABLE", `${unreadable} MCP server record${unreadable === 1 ? " is" : "s are"} unreadable, so the organization's servers were not cleared. An operator must look at them.`);
  for (const entry of entries) {
    if (entry.hasSecret === true) await deps.secrets.remove(orgId, entry.serverId);
    await deps.store.remove(orgId, entry.serverId);
  }
}

export async function removeMcpServer(deps: McpServerDependencies, actor: McpServerActor, serverId: string): Promise<void> {
  guard(deps, actor);
  const entry = await deps.store.get(actor.orgId, serverId);
  if (entry === undefined) throw agentXError("NOT_FOUND", "no MCP server has that id");
  if (entry.status === "approved") throw agentXError("CONFIG_INVALID", "Turn the server off first, then remove it.");
  // Its token goes first. A failed delete keeps the entry (which still points at the token), so the admin can try again; the entry is never removed while its token may remain.
  if (entry.hasSecret === true) {
    try { await deps.secrets.remove(actor.orgId, serverId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The server's token could not be deleted just now, so the server was kept. Try removing it again."); }
  }
  await deps.store.remove(actor.orgId, serverId);
  if (entry.transport.kind === "stdio") await deps.host?.release(serverId).catch(() => undefined);
  if (entry.hasSecret === true) await told(deps, { action: "mcp_server.token_changed", actor, serverId, change: "deleted" });
  await told(deps, { action: "mcp_server.removed", actor, serverId, label: entry.label, transport: entry.transport.kind, hasToken: entry.hasSecret === true });
}

/** The list the settings page shows an admin: every entry, with the tools each offers. */
export async function listMcpServers(deps: McpServerDependencies, actor: McpServerActor): Promise<McpServerEntry[]> {
  guard(deps, actor);
  return (await deps.store.list(actor.orgId)).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}
