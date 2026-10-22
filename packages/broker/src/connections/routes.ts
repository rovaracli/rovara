// The org connection routes (Plan 3 Task 12, ruling R62): `GET /v1/app/connections`, `GET|PUT|DELETE /v1/app/connections/{id}`,
// `POST /v1/app/connections` (creates and returns the server-made id) and `POST /v1/app/connections/{id}/check`. Members may read;
// an owner or admin changes. Every key is built from the caller's org, so another org's connection answers the 404 a missing one does.
// A secret is write-only: it goes to the store and nowhere else, and no answer, error, log line, request item or event holds it.
// Every change carries a `requestId` (R18) whose item is written in the same transaction as the change.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  ConnectionIdSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  agentRequestKey,
  agentXError,
  canonicalJson,
  newPrefixedId,
} from "@agentx/contracts";
import type { AgentCaller } from "../agents/access.js";
import type { RequestMark } from "../agents/table-writes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import type { OrgConnectionRecord, OrgConnectionStore } from "./store.js";

/** What the connection routes need: the store, and the State table the request items are read from. */
export interface ConnectionRouteDependencies {
  store: OrgConnectionStore;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

export const isConnectionRoute = (pathname: string): boolean => /^\/v1\/app\/connections(\/|$)/.test(pathname);

const PATH = /^\/v1\/app\/connections(?:\/([^/]+)(?:\/(check))?)?$/;

// ---- bodies

const RequestIdSchema = z.string().uuid();
const SettingsSchema = z.record(z.string(), z.unknown());
const SaveBodySchema = z.object({ requestId: RequestIdSchema, connection: SettingsSchema, secret: SettingsSchema.optional() }).strict();
const RequestOnlySchema = z.object({ requestId: RequestIdSchema }).strict();

/** A body that is not valid. The refusal names the field, never the value or an unknown field's name: a body can carry a secret. */
function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

// ---- what people see

/** A connection as people see it: whether a credential is saved, never the credential, its name or the vendor account it belongs to. */
function view(record: OrgConnectionRecord) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { hasSecret, orgId: _org, ...rest } = record;
  return { ...rest, hasCredential: hasSecret };
}

const notFound = () => agentXError("NOT_FOUND", "no connection has that ID");

/** An id in a path: one that is not shaped like a connection id is as unknown as one nobody has. */
function connectionIdOf(raw: string): string {
  if (!ConnectionIdSchema.safeParse(raw).success) throw notFound();
  return raw;
}

function requireAdmin(caller: AgentCaller): void {
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only an org owner or admin can change the company's connections.");
}

// ---- repeated requests (R18)

/**
 * What a request is, apart from its id: the route, the connection and the rest of the body. A secret enters only as a one-way hash that is
 * specific to this org and connection, so the same id for another secret is caught and the item holds nothing that gives the secret back.
 */
function fingerprintOf(orgId: string, route: string, connectionId: string, body: { requestId: string; secret?: Record<string, unknown> | undefined }): string {
  const { requestId: _requestId, secret, ...rest } = body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the id is the key, not part of what was asked
  const secretDigest = secret === undefined ? null : createHash("sha256").update(`connection-secret\0${orgId}\0${connectionId}\0${canonicalJson(secret)}`, "utf8").digest("hex");
  return createHash("sha256").update(canonicalJson({ route, connectionId, body: rest, secret: secretDigest }), "utf8").digest("hex");
}

/**
 * The mark a change carries, and what it did the last time this developer sent this request (`replay`), if it did anything. It is read after
 * the role check, so a repeat tells nobody who lost their role anything. It reads the same request item `AgentStore` writes (Task 7).
 */
async function markRequest(deps: ConnectionRouteDependencies, caller: AgentCaller, route: string, connectionId: string, body: { requestId: string; secret?: Record<string, unknown> | undefined }): Promise<{ mark: RequestMark; replay?: { result: unknown } }> {
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint: fingerprintOf(caller.orgId, route, connectionId, body) };
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: agentRequestKey(caller.orgId, caller.developerId, body.requestId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const earlier = response.Item;
  const expires = earlier?.[INDEX_EXPIRY_ATTRIBUTE];
  if (earlier === undefined || (typeof expires === "number" && expires <= Math.floor(deps.now() / 1000))) return { mark };
  if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  return { mark, replay: { result: earlier.result } };
}

// ---- handlers

/**
 * The id a created connection gets: made here, from the org, the developer and the request id, so a client never chooses one (a removed
 * connection's id stays unusable while its secret waits for deletion) and a retry of a request that stopped half-way finds its own secret.
 */
function mintConnectionId(caller: AgentCaller, requestId: string): string {
  return newPrefixedId("con", () => createHash("sha256").update(`connection-id\0${caller.orgId}\0${caller.developerId}\0${requestId}`, "utf8").digest());
}

/** The settings of a save, with the id the route decided on. A client's own id is refused unless it is the path's. */
function withId(connection: Record<string, unknown>, connectionId: string, allowSame: boolean): Record<string, unknown> {
  if ("connectionId" in connection && !(allowSame && connection.connectionId === connectionId)) {
    throw agentXError("CONFIG_INVALID", allowSame ? "connection.connectionId: must be the ID in the path, or left out" : "connection.connectionId: the server makes the ID; leave it out");
  }
  return { ...connection, connectionId };
}

async function createConnection(deps: ConnectionRouteDependencies, caller: AgentCaller, body: unknown): Promise<StatusReply> {
  requireAdmin(caller);
  const input = parseBody(SaveBodySchema, body);
  const connectionId = mintConnectionId(caller, input.requestId);
  const { mark, replay } = await markRequest(deps, caller, "create", "", input);
  if (replay !== undefined) return new StatusReply(201, { connection: view(replay.result as OrgConnectionRecord) });
  const connection = withId(input.connection, connectionId, false);
  // The id comes from the request id, so a connection already there means a request id used again after its memory expired.
  if (await deps.store.get(caller.orgId, connectionId) !== undefined) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used; send a new one");
  const saved = await deps.store.put({
    orgId: caller.orgId, connection, ...(input.secret === undefined ? {} : { secret: input.secret }),
    by: caller.developerId, requestId: input.requestId, request: mark,
  });
  return new StatusReply(201, { connection: view(saved) });
}

async function saveConnection(deps: ConnectionRouteDependencies, caller: AgentCaller, connectionId: string, body: unknown): Promise<unknown> {
  requireAdmin(caller);
  const input = parseBody(SaveBodySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "save", connectionId, input);
  if (replay !== undefined) return { connection: view(replay.result as OrgConnectionRecord) };
  const saved = await deps.store.put({
    orgId: caller.orgId, connection: withId(input.connection, connectionId, true), ...(input.secret === undefined ? {} : { secret: input.secret }),
    by: caller.developerId, requestId: input.requestId, request: mark, requireExisting: true,
  });
  return { connection: view(saved) };
}

async function removeConnection(deps: ConnectionRouteDependencies, caller: AgentCaller, connectionId: string, body: unknown): Promise<unknown> {
  requireAdmin(caller);
  const input = parseBody(RequestOnlySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "remove", connectionId, input);
  if (replay !== undefined) return { removed: { connectionId } };
  await deps.store.remove({ orgId: caller.orgId, connectionId, by: caller.developerId, requestId: input.requestId, request: mark });
  return { removed: { connectionId } };
}

async function checkConnection(deps: ConnectionRouteDependencies, caller: AgentCaller, connectionId: string, body: unknown): Promise<unknown> {
  requireAdmin(caller);
  const input = parseBody(RequestOnlySchema, body);
  const { mark, replay } = await markRequest(deps, caller, "check", connectionId, input);
  if (replay !== undefined) return replay.result;
  return deps.store.check(caller.orgId, connectionId, mark);
}

/** The connection routes. Called for a path `isConnectionRoute` matched. */
export async function routeConnectionRequest(deps: ConnectionRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "route not found");
  const [, rawId, sub] = matched;
  const method = request.method;
  if (rawId === undefined) {
    if (method === "GET") return { connections: (await deps.store.list(caller.orgId)).map(view) };
    if (method === "POST") return createConnection(deps, caller, jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  if (sub === "check") {
    if (method === "POST") return checkConnection(deps, caller, connectionIdOf(rawId), jsonBody(request));
    throw agentXError("NOT_FOUND", "route not found");
  }
  if (method === "GET") {
    const found = await deps.store.get(caller.orgId, connectionIdOf(rawId));
    if (found === undefined) throw notFound();
    return { connection: view(found) };
  }
  if (method === "PUT") return saveConnection(deps, caller, connectionIdOf(rawId), jsonBody(request));
  if (method === "DELETE") return removeConnection(deps, caller, connectionIdOf(rawId), jsonBody(request));
  throw agentXError("NOT_FOUND", "route not found");
}
