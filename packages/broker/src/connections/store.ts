// Org connections (Plan 3, ruling R62): the record of each Linear, Jira or MCP connection an org has given Rovara, and
// the hook secrets of Plan 4's event hooks. A record holds the connection's settings, whether a secret has been saved,
// and what the last check found. It never holds the key or token, or even the secret's name: that name is derived from
// the org id and the connection id each time, and the value lives only in the org-tagged secret (org-secrets.ts).
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { listMcpTools } from "@agentx/gateway";
import {
  ConnectionIdSchema,
  ConnectionSecretSchemas,
  OrgConnectionSchema,
  OrgIdSchema,
  agentXError,
  connectionKey,
  connectionSecretToken,
  connectionsKey,
  type ConnectionSecret,
  type ConnectionType,
  type OrgConnection,
  type OrgId,
} from "@agentx/contracts";
import { isSecretLeaf, orgConnectorSecretName, orgHookSecretName, type OrgSecrets } from "./org-secrets.js";

type Item = Record<string, unknown>;

/** What the stores and the per-org credential registry need. */
export interface OrgConnectionDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The install's environment name, which prefixes every secret name. */
  env: string;
  secrets: Pick<OrgSecrets, "read" | "put" | "scheduleDelete">;
  now: () => number;
}

export interface ConnectionCheckRecord {
  ok: boolean;
  at: string;
}

/** A connection as members and administrators see it: no secret, no secret name and no vendor account id (`actorId`). */
export type OrgConnectionRecord = OrgConnection & {
  orgId: OrgId;
  hasSecret: boolean;
  lastCheck?: ConnectionCheckRecord;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

export interface CheckResult {
  ok: boolean;
  message?: string;
}

export interface OrgConnectionStoreInput extends OrgConnectionDeps {
  fetch?: typeof fetch;
  /**
   * Refuses an MCP endpoint that must not be called (Task 12b supplies checkEndpointUrl, which also resolves the host).
   * It throws, with a message safe to show, to refuse. Without it an MCP connection cannot be checked.
   */
  checkEndpoint?: (url: string) => Promise<void>;
  listMcpTools?: typeof listMcpTools;
}

const CHECK_TIMEOUT_MS = 10_000;
const MAX_CHECK_RESPONSE_BYTES = 1_000_000;
const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const coded = (code: Parameters<typeof agentXError>[0], message: string) => agentXError(code, message);
const parseOrg = (orgId: string): OrgId => {
  const parsed = OrgIdSchema.safeParse(orgId);
  if (!parsed.success) throw coded("FORBIDDEN", "that is not an organization id");
  return parsed.data;
};

/** The host a saved secret is sent to, or undefined for Linear (a fixed vendor endpoint). */
function secretHost(connection: OrgConnection): string | undefined {
  if (connection.type === "jira") return new URL(connection.siteUrl).hostname;
  if (connection.type === "mcp") return new URL(connection.endpoint).hostname;
  return undefined;
}

function strip(item: Item): Item {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, actorId: _actor, ...rest } = item;
  return rest;
}

async function readItem(deps: OrgConnectionDeps, orgId: OrgId, connectionId: string): Promise<Item | undefined> {
  if (!ConnectionIdSchema.safeParse(connectionId).success) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: connectionKey(orgId, connectionId), ConsistentRead: true })) as { Item?: Item };
  return response.Item;
}

async function listItems(deps: OrgConnectionDeps, orgId: OrgId): Promise<Item[]> {
  const directory: Item[] = [];
  let start: Record<string, unknown> | undefined;
  const pk = connectionsKey(orgId, "x").pk;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    directory.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const items = await Promise.all(directory.map((entry) => readItem(deps, orgId, String(entry.sk))));
  return items.filter((item): item is Item => item !== undefined);
}

/** The vendor account ids this org's connections of one type have checked as, to tell their own writes from a person's. */
export async function connectionActorIds(deps: OrgConnectionDeps, orgId: string, type: ConnectionType): Promise<Set<string>> {
  const org = parseOrg(orgId);
  const ids = new Set<string>();
  for (const item of await listItems(deps, org)) {
    if (item.type === type && typeof item.actorId === "string" && item.actorId !== "") ids.add(item.actorId);
  }
  return ids;
}

export class OrgConnectionStore {
  constructor(private readonly input: OrgConnectionStoreInput) {}

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  async get(orgId: string, connectionId: string): Promise<OrgConnectionRecord | undefined> {
    const item = await readItem(this.input, parseOrg(orgId), connectionId);
    return item === undefined ? undefined : (strip(item) as unknown as OrgConnectionRecord);
  }

  async list(orgId: string): Promise<OrgConnectionRecord[]> {
    return (await listItems(this.input, parseOrg(orgId))).map((item) => strip(item) as unknown as OrgConnectionRecord);
  }

  /**
   * Creates the connection, or changes an existing one. The secret is write-only: given, it replaces the saved one; absent,
   * the saved one stays. A saved secret is never sent to another host: pointing a connection at a different site or
   * endpoint host needs a new secret with it.
   */
  async put(input: { orgId: string; connection: unknown; secret?: unknown; by: string }): Promise<OrgConnectionRecord> {
    const orgId = parseOrg(input.orgId);
    const parsed = OrgConnectionSchema.safeParse(input.connection);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw coded("CONFIG_INVALID", `connection${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "is not valid"}`);
    }
    const connection = parsed.data;
    let secretJson: string | undefined;
    if (input.secret !== undefined) {
      const secret = ConnectionSecretSchemas[connection.type].safeParse(input.secret);
      if (!secret.success) throw coded("CONFIG_INVALID", `secret: a ${connection.type} connection takes ${Object.keys(ConnectionSecretSchemas[connection.type].shape).join(", ")} and nothing else`);
      secretJson = JSON.stringify(secret.data);
    }
    const existing = await readItem(this.input, orgId, connection.connectionId);
    if (existing !== undefined && existing.type !== connection.type) throw coded("CONFIG_INVALID", "connection.type: a connection's type cannot change; remove it and add a new one");
    const movedHost = existing !== undefined && secretHost(OrgConnectionSchema.parse(pick(existing))) !== secretHost(connection);
    if (movedHost && secretJson === undefined && existing.hasSecret === true) {
      throw coded("CONFIG_INVALID", "connection: the saved secret would be sent to a different host; give the new secret with it");
    }
    // The secret first: a failed write leaves the record as it was.
    if (secretJson !== undefined) await this.input.secrets.put(orgId, orgConnectorSecretName(this.input.env, orgId, connection.connectionId), secretJson);
    const at = this.iso();
    // A new secret may belong to another vendor account, so what the last check learned is dropped with the old one.
    const keepsAccount = existing !== undefined && !movedHost && secretJson === undefined;
    const item: Item = {
      ...connectionKey(orgId, connection.connectionId),
      entityType: "ORG_CONNECTION",
      orgId,
      ...connection,
      hasSecret: secretJson !== undefined || existing?.hasSecret === true,
      ...(keepsAccount && existing.lastCheck !== undefined ? { lastCheck: existing.lastCheck } : {}),
      ...(keepsAccount && typeof existing.actorId === "string" ? { actorId: existing.actorId } : {}),
      createdBy: typeof existing?.createdBy === "string" ? existing.createdBy : input.by,
      createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : at,
      updatedBy: input.by,
      updatedAt: at,
    };
    if (existing === undefined) {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.input.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: this.input.tableName, Item: { ...connectionsKey(orgId, connection.connectionId), entityType: "ORG_CONNECTION_DIRECTORY", orgId, connectionId: connection.connectionId }, ConditionExpression: "attribute_not_exists(pk)" } },
        ],
      }));
    } else {
      await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: item, ConditionExpression: "attribute_exists(pk)" }));
    }
    return strip(item) as unknown as OrgConnectionRecord;
  }

  /** Removes the connection and schedules its secret for deletion (7 days to recover it). */
  async remove(input: { orgId: string; connectionId: string }): Promise<void> {
    const orgId = parseOrg(input.orgId);
    const existing = await readItem(this.input, orgId, input.connectionId);
    if (existing === undefined) throw coded("NOT_FOUND", "no connection has that ID");
    if (existing.hasSecret === true) await this.input.secrets.scheduleDelete(orgId, orgConnectorSecretName(this.input.env, orgId, input.connectionId));
    await this.input.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.input.tableName, Key: connectionKey(orgId, input.connectionId) } },
        { Delete: { TableName: this.input.tableName, Key: connectionsKey(orgId, input.connectionId) } },
      ],
    }));
  }

  /**
   * Asks the vendor who the saved secret belongs to (Linear `viewer { id }`, Jira `GET <siteUrl>/rest/api/3/myself`) or, for
   * MCP, lists the server's tools. Linear and Jira keep the account id as `actorId`. A message never holds the secret.
   */
  async check(orgId: string, connectionId: string): Promise<CheckResult> {
    const org = parseOrg(orgId);
    const item = await readItem(this.input, org, connectionId);
    if (item === undefined) throw coded("NOT_FOUND", "no connection has that ID");
    const connection = OrgConnectionSchema.parse(pick(item));
    if (connection.type === "mcp" && this.input.checkEndpoint === undefined) {
      throw coded("CONFIG_INVALID", "this deployment cannot check an MCP endpoint, so it cannot check an MCP connection");
    }
    let result: CheckResult & { actorId?: string };
    if (item.hasSecret !== true) {
      result = { ok: false, message: "no secret has been saved for this connection yet" };
    } else {
      const raw = await this.input.secrets.read(org, orgConnectorSecretName(this.input.env, org, connectionId));
      const secret = raw === undefined ? undefined : parseSecret(connection.type, raw);
      result = secret === undefined
        ? { ok: false, message: "the saved secret could not be read; save it again" }
        : await this.ask(connection, secret);
    }
    await this.record(org, connectionId, result);
    return result.message === undefined ? { ok: result.ok } : { ok: result.ok, message: result.message };
  }

  private async record(orgId: OrgId, connectionId: string, result: CheckResult & { actorId?: string }): Promise<void> {
    const sets = ["lastCheck = :check"];
    const values: Record<string, unknown> = { ":check": { ok: result.ok, at: this.iso() } };
    if (result.ok && result.actorId !== undefined) {
      sets.push("actorId = :actor");
      values[":actor"] = result.actorId;
    }
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: connectionKey(orgId, connectionId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: values,
    })).catch((error: unknown) => {
      // The connection was removed while it was being checked: there is nothing to record on.
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    });
  }

  private async ask(connection: OrgConnection, secret: ConnectionSecret): Promise<CheckResult & { actorId?: string }> {
    const fetchImplementation = this.input.fetch ?? fetch;
    const token = connectionSecretToken(connection.type, secret);
    if (connection.type === "mcp") return this.askMcp(connection, token);
    const vendor = connection.type === "linear" ? "Linear" : "Jira";
    try {
      const response = connection.type === "linear"
        ? await fetchImplementation(LINEAR_GRAPHQL, {
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query: "query { viewer { id } }" }),
          redirect: "error",
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        })
        : await fetchImplementation(`${connection.siteUrl}/rest/api/3/myself`, {
          method: "GET",
          headers: { authorization: `Basic ${Buffer.from(`${(secret as { email: string }).email}:${token}`).toString("base64")}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
      if (!response.ok) return { ok: false, message: `${vendor} refused the saved secret (HTTP ${String(response.status)})` };
      const text = await readCapped(response, MAX_CHECK_RESPONSE_BYTES);
      if (text === undefined) return { ok: false, message: `${vendor} answered with more than a check should return` };
      const body: unknown = JSON.parse(text);
      const actorId = connection.type === "linear"
        ? ((body as { data?: { viewer?: { id?: unknown } } })?.data?.viewer?.id)
        : (body as { accountId?: unknown })?.accountId;
      if (typeof actorId !== "string" || actorId === "") return { ok: false, message: `${vendor} did not say whose secret this is` };
      return { ok: true, actorId };
    } catch {
      // The message of a network error can quote the request; only the vendor is named.
      return { ok: false, message: `could not reach ${vendor} to check the saved secret` };
    }
  }

  private async askMcp(connection: Extract<OrgConnection, { type: "mcp" }>, token: string): Promise<CheckResult> {
    try {
      await this.input.checkEndpoint!(connection.endpoint);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "the endpoint is not allowed" };
    }
    try {
      const tools = await (this.input.listMcpTools ?? listMcpTools)({
        endpoint: new URL(connection.endpoint),
        token,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        ...(connection.auth === undefined ? {} : { auth: connection.auth }),
        ...(this.input.fetch === undefined ? {} : { fetchImplementation: this.input.fetch }),
      });
      return { ok: true, message: `${String(tools.length)} tool${tools.length === 1 ? "" : "s"}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error && error.name === "McpUnauthorized" ? "the server rejected the saved token" : "could not list the server's tools" };
    }
  }
}

/**
 * The response body as text, or undefined when it is longer than `limit` bytes. It counts the bytes actually read and stops
 * reading at the cap, so a chunked or understated response cannot be pulled into memory in full.
 */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The connection's settings out of a stored item. */
function pick(item: Item): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the bookkeeping fields
  const { pk: _pk, sk: _sk, entityType: _type, orgId: _org, hasSecret: _has, actorId: _actor, lastCheck: _check, createdBy: _by, createdAt: _at, updatedBy: _ub, updatedAt: _ua, ...settings } = item;
  return settings;
}

/** A stored secret, or undefined when it is not the shape its type takes. */
function parseSecret(type: ConnectionType, raw: string): ConnectionSecret | undefined {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return undefined; }
  const parsed = ConnectionSecretSchemas[type].safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Reads a connection's stored secret as its one value, for the credential registry. */
export async function readConnectionToken(deps: OrgConnectionDeps, orgId: OrgId, connection: { connectionId: string; type: ConnectionType }): Promise<string | undefined> {
  const raw = await deps.secrets.read(orgId, orgConnectorSecretName(deps.env, orgId, connection.connectionId));
  const secret = raw === undefined ? undefined : parseSecret(connection.type, raw);
  return secret === undefined ? undefined : connectionSecretToken(connection.type, secret);
}

/** Reads one connection for the credential registry, with the fields the store keeps back from members. */
export async function readConnection(deps: OrgConnectionDeps, orgId: OrgId, connectionId: string): Promise<(OrgConnectionRecord & { actorId?: string }) | undefined> {
  const item = await readItem(deps, orgId, connectionId);
  return item === undefined ? undefined : (item as unknown as OrgConnectionRecord);
}

/** Hook secrets (for Plan 4's event hooks), each through OrgSecrets under `agentx/<env>/org-hooks/<orgId>/<hookId>`. */
export class HookSecretStore {
  constructor(private readonly input: { env: string; secrets: Pick<OrgSecrets, "read" | "put" | "scheduleDelete"> }) {}

  private name(orgId: string, hookId: string): string {
    // A hook id names one path segment. Anything else, such as another org's path, is refused before any AWS call.
    if (!isSecretLeaf(hookId)) throw coded("FORBIDDEN", "that is not a hook id");
    return orgHookSecretName(this.input.env, orgId, hookId);
  }

  async put(orgId: string, hookId: string, value: string): Promise<void> {
    await this.input.secrets.put(orgId, this.name(orgId, hookId), value);
  }

  async read(orgId: string, hookId: string): Promise<string> {
    const value = await this.input.secrets.read(orgId, this.name(orgId, hookId));
    if (value === undefined) throw coded("NOT_FOUND", "no secret is saved for that hook");
    return value;
  }

  async scheduleDelete(orgId: string, hookId: string): Promise<void> {
    await this.input.secrets.scheduleDelete(orgId, this.name(orgId, hookId));
  }
}
