// Script tokens (UX5b): the stored tokens. A token is a `META` item in its own partition (`scriptTokenKey`) holding the hash of the token, never the token, and a row in the company's
// list (`orgScriptTokensKey`). Both are written in one transaction with the request's own item and the audit event. Revoking marks both `revokedAt` in one transaction with its audit
// event. Every item expires by the State table's TTL a month after the token's own end, so dead tokens leave nothing behind. The list row only says where to look: the record decides.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  CreateScriptTokenBodySchema,
  INDEX_EXPIRY_ATTRIBUTE,
  OrgIdSchema,
  OrgRoleSchema,
  SCRIPT_TOKEN_DEFAULT_DAYS,
  SCRIPT_TOKEN_MAX_DAYS,
  SCRIPT_TOKENS_LIMIT_MESSAGE,
  SCRIPT_TOKENS_PER_PERSON_MAX,
  SCRIPT_TOKEN_PROJECTS_MAX,
  ScriptTokenIdSchema,
  ScriptTokenNameSchema,
  ScriptTokenPermissionSchema,
  agentXError,
  canonicalJson,
  newPrefixedId,
  orgScriptTokensKey,
  scriptTokenKey,
  type AuditEventInput,
  type CreatedScriptToken,
  type DeveloperSignInMethod,
  type OrgId,
  type OrgRole,
  type ScriptTokenPermission,
  type ScriptTokenView,
} from "@agentx/contracts";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditDeps } from "../audit/outbox.js";
import { auditOccurrence, auditScriptTokenCreated, auditScriptTokenRevoked, auditScriptTokenUsed } from "../audit/events.js";
import { commit, errorName, failedIndexes, readRequest, type Item, type RequestMark, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { mintScriptToken, scriptTokenHint } from "./token-format.js";

export interface ScriptTokenDependencies extends TableInput, AuditDeps {
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** Who makes, lists or revokes tokens: a signed-in person, with their live role, and the sign-in method of the session they used. */
export interface ScriptTokenCaller {
  developerId: string; orgId: OrgId; orgRole: OrgRole; amr: DeveloperSignInMethod;
  /** The creating session's sign-in identity and the time the person signed in: the token is ended by what ends that session (an unlink, a SAML cut-off). */
  identityKey?: string; authTime?: string;
}

const DAY_MS = 86_400_000;
/** How long a dead token's items stay before the TTL deletes them: a month after the token's end (or its revocation). */
const KEEP_AFTER_END_DAYS = 30;
/** A person makes at most this many tokens an hour. */
export const SCRIPT_TOKEN_CREATES_PER_HOUR = 10;
/** List rows read per page, and pages at most: a company's list holds at most a few hundred rows that have not expired. */
const ROWS_PER_PAGE = 100;
const ROW_PAGES_MAX = 20;
/** How often a token's "last used" time is written at most (the day's first use is always written, with its audit event). */
export const LAST_USED_EVERY_MS = 5 * 60_000;
const REVOKE_TRIES = 3;

const METHODS = ["slack", "oidc", "cloud", "github", "saml"] as const satisfies readonly DeveloperSignInMethod[];
const Instant = z.string().datetime();

/** A token as stored. `secretHash` is the SHA-256 hex of the token. `createdRole` is the creator's company role when they made it: the token works only while it is still theirs. */
export const ScriptTokenRecordSchema = z.object({
  orgId: OrgIdSchema,
  tokenId: ScriptTokenIdSchema,
  developerId: z.string().regex(/^[a-f0-9]{64}$/),
  name: ScriptTokenNameSchema,
  projects: z.array(z.string()).min(1).max(SCRIPT_TOKEN_PROJECTS_MAX),
  permissions: z.array(ScriptTokenPermissionSchema).min(1),
  createdAt: Instant,
  expiresAt: Instant,
  createdRole: OrgRoleSchema,
  amr: z.enum(METHODS),
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  lastUsedAt: Instant.optional(),
  lastUsedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  revokedAt: Instant.optional(),
  /** A person's id, or `rovara` when Rovara revoked it because its creator's access changed. */
  revokedBy: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal("rovara")]).optional(),
  /** Review I1: the creating session's identity and sign-in time, so an unlink or a SAML cut-off ends the token as it ends the session. Absent on a token made before. */
  identityKey: z.string().min(1).max(200).optional(),
  authTime: Instant.optional(),
}).strip();
export type ScriptTokenRecord = z.infer<typeof ScriptTokenRecordSchema>;

const isAdmin = (role: OrgRole) => role === "owner" || role === "admin";
const isoOf = (ms: number) => new Date(ms).toISOString();
const keepUntil = (endMs: number) => Math.floor(endMs / 1000) + KEEP_AFTER_END_DAYS * 86_400;
const log = (deps: ScriptTokenDependencies, entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
const notFound = () => agentXError("NOT_FOUND", "script token not found");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Script tokens need the audit ledger.");
const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** Whether the token's own record lets it work now: not revoked, not past its end, and never made for longer than the cap. */
export function scriptTokenStatus(record: ScriptTokenRecord, nowMs: number): "active" | "expired" | "revoked" {
  if (record.revokedAt !== undefined) return "revoked";
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  if (!(expires > nowMs) || !(expires - created <= SCRIPT_TOKEN_MAX_DAYS * DAY_MS)) return "expired";
  return "active";
}

function viewOf(record: ScriptTokenRecord, nowMs: number, viewer: string, createdBy?: string): ScriptTokenView {
  const mine = record.developerId === viewer;
  return {
    tokenId: record.tokenId, name: record.name, hint: scriptTokenHint(record.tokenId), projects: record.projects, permissions: record.permissions,
    createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }), status: scriptTokenStatus(record, nowMs), mine,
    ...(mine || createdBy === undefined ? {} : { createdBy }),
  };
}

/** The error text for a body that doesn't fit: the first field that is wrong, never the value. */
function invalidBody(issue: { path: PropertyKey[]; code: string; message: string } | undefined): Error {
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.map(String).join(".");
  return agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

// ---- reading

/** The record under a token id in a company, if it is that company's and well formed (revoked or expired records are returned; the caller decides). */
export async function readScriptToken(deps: Pick<ScriptTokenDependencies, "documentClient" | "tableName" | "log">, orgId: OrgId, tokenId: string): Promise<ScriptTokenRecord | undefined> {
  const id = ScriptTokenIdSchema.safeParse(tokenId);
  if (!id.success) return undefined;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: scriptTokenKey(orgId, id.data), ConsistentRead: true })) as { Item?: Item };
  if (response.Item === undefined) return undefined;
  const parsed = ScriptTokenRecordSchema.safeParse(response.Item);
  if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.tokenId !== id.data) {
    log(deps as ScriptTokenDependencies, { event: "script_tokens.record_unreadable", orgId });
    return undefined;
  }
  return parsed.data;
}

/** Every token record of the company (or one person's), read through the list rows. `complete` is false when the pages ran out first. */
async function readTokens(deps: ScriptTokenDependencies, orgId: OrgId, developerId: string | undefined): Promise<{ records: ScriptTokenRecord[]; complete: boolean }> {
  const records: ScriptTokenRecord[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < ROW_PAGES_MAX; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": orgScriptTokensKey(orgId, "stk_00000000000000000000").pk },
      Limit: ROWS_PER_PAGE, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const ids = (response.Items ?? []).filter((row) => developerId === undefined || row["developerId"] === developerId).map((row) => String(row["sk"]));
    const found = await Promise.all(ids.map((id) => readScriptToken(deps, orgId, id)));
    for (const record of found) if (record !== undefined && (developerId === undefined || record.developerId === developerId)) records.push(record);
    start = response.LastEvaluatedKey;
    if (start === undefined) return { records, complete: true };
  }
  return { records, complete: false };
}

/**
 * `GET /v1/app/script-tokens`: the caller's own tokens; an owner or admin also sees every other token in the company (to revoke it), with its creator's name. Newest first.
 * `nameOf` gives a person's display name (never an email address).
 */
export async function listScriptTokens(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, nameOf: (developerId: string) => Promise<string | undefined>): Promise<ScriptTokenView[]> {
  const { records, complete } = await readTokens(deps, caller.orgId, isAdmin(caller.orgRole) ? undefined : caller.developerId);
  if (!complete) log(deps, { event: "script_tokens.list_truncated", orgId: caller.orgId });
  const names = new Map<string, string | undefined>();
  for (const record of records) if (record.developerId !== caller.developerId && !names.has(record.developerId)) names.set(record.developerId, await nameOf(record.developerId));
  const now = deps.now();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.tokenId.localeCompare(b.tokenId))
    .map((record) => viewOf(record, now, caller.developerId, names.get(record.developerId)));
}

const liveCount = (records: ScriptTokenRecord[], nowMs: number) => records.filter((record) => scriptTokenStatus(record, nowMs) === "active").length;

// ---- making

/**
 * `POST /v1/app/script-tokens`: makes a token for the caller, on projects they can reach today (`checkProject` refuses one they can't), and returns it this once. The request's own item
 * remembers only the token's id: a repeat of the request is refused, never answered with the token. A person keeps at most `SCRIPT_TOKENS_PER_PERSON_MAX` live tokens, counted from what
 * is stored; two requests can pass the count together, so the list is read again after the write and a request that finds more takes its own token back and is refused.
 */
export async function createScriptToken(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, body: unknown, checkProject: (project: string) => Promise<void>, options: { lifetimeCapSeconds?: number } = {}): Promise<CreatedScriptToken> {
  if (caller.orgRole === "auditor") throw agentXError("FORBIDDEN", "An Auditor can't make script tokens.");
  const parsed = CreateScriptTokenBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues[0]);
  const input = parsed.data;
  if (deps.audit === undefined) throw auditUnavailable();
  const days = input.days ?? SCRIPT_TOKEN_DEFAULT_DAYS;
  const projects = [...input.projects].sort();
  const permissions = (["read", "start", "lessons"] as const).filter((permission) => input.permissions.includes(permission));
  const { orgId, developerId } = caller;
  const mark: RequestMark = { orgId, developerId, requestId: input.requestId, fingerprint: sha256({ route: "script_token_create", name: input.name, projects, permissions, days }) };
  const earlier = await readRequest(deps, orgId, developerId, input.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    throw agentXError("CONFIG_INVALID", "That token was already made and shown once. Make a new one, and revoke the first if you didn't keep it.");
  }
  if (!await takeRateAt(deps, { pk: `ORG#${orgId}#SCRIPT_TOKEN_CREATE_RATE`, sk: developerId }, SCRIPT_TOKEN_CREATES_PER_HOUR, 3_600_000)) {
    throw agentXError("TOO_MANY_REQUESTS", "Too many script tokens made in the last hour. Try again later.");
  }
  for (const project of projects) await checkProject(project);
  const before = await readTokens(deps, orgId, developerId);
  if (!before.complete || liveCount(before.records, deps.now()) >= SCRIPT_TOKENS_PER_PERSON_MAX) throw agentXError("CONFIG_INVALID", SCRIPT_TOKENS_LIMIT_MESSAGE);

  const nowMs = deps.now();
  const tokenId = newPrefixedId("stk");
  const { token, hash } = mintScriptToken(orgId, tokenId);
  // Review I1: where the edition caps every session (Enterprise), a token lives no longer than a session would.
  const expiresMs = Math.min(nowMs + days * DAY_MS, options.lifetimeCapSeconds === undefined ? Number.MAX_SAFE_INTEGER : nowMs + options.lifetimeCapSeconds * 1000);
  const record: ScriptTokenRecord = {
    orgId, tokenId, developerId, name: input.name, projects, permissions, createdAt: isoOf(nowMs), expiresAt: isoOf(expiresMs), createdRole: caller.orgRole, amr: caller.amr, secretHash: hash,
    ...(caller.identityKey === undefined ? {} : { identityKey: caller.identityKey }), ...(caller.authTime === undefined ? {} : { authTime: caller.authTime }),
  };
  const event = auditScriptTokenCreated({
    orgId, actor: { kind: "member", id: developerId }, occurredAt: record.createdAt, occurrence: auditOccurrence(tokenId, "created"), tokenId, days: Math.max(0, Math.round((expiresMs - nowMs) / DAY_MS)), projects: projects.length, permissions: permissions.join(","),
  });
  const items: TransactItem[] = [
    { Put: { TableName: deps.tableName, Item: { ...scriptTokenKey(orgId, tokenId), entityType: "SCRIPT_TOKEN", ...record, [INDEX_EXPIRY_ATTRIBUTE]: keepUntil(expiresMs) }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...orgScriptTokensKey(orgId, tokenId), entityType: "SCRIPT_TOKEN_ROW", orgId, tokenId, developerId, createdAt: record.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: keepUntil(expiresMs) }, ConditionExpression: "attribute_not_exists(pk)" } },
    ...auditItems(deps, event),
  ];
  await commit(deps, items, () => undefined, { ...mark, result: { tokenId } });
  await flushAuditEvents(deps, [event]);

  const after = await readTokens(deps, orgId, developerId);
  if (!after.complete || liveCount(after.records, deps.now()) > SCRIPT_TOKENS_PER_PERSON_MAX) {
    await takeBack(deps, record);
    throw agentXError("CONFIG_INVALID", SCRIPT_TOKENS_LIMIT_MESSAGE);
  }
  return { token: viewOf(record, nowMs, developerId), secret: token };
}

function auditItems(deps: ScriptTokenDependencies, event: AuditEventInput): TransactItem[] {
  const items = auditPending(deps, event);
  if (items.length === 0) throw auditUnavailable();
  return items;
}

/** Revokes a token made a moment ago that broke the per-person limit (it was never handed out). Tries a few times; if it can't, fails closed with a retryable error. */
async function takeBack(deps: ScriptTokenDependencies, record: ScriptTokenRecord): Promise<void> {
  for (let attempt = 0; attempt < REVOKE_TRIES; attempt += 1) {
    try {
      const at = isoOf(deps.now());
      // Review M5: the take-back is audited like any revoke, so the ledger never shows a token made and never ended.
      const event = auditScriptTokenRevoked({ orgId: record.orgId, actor: { kind: "member", id: record.developerId }, occurredAt: at, occurrence: auditOccurrence(record.tokenId, "revoked"), tokenId: record.tokenId, by: "limit" });
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...revokeItems(deps, record, at, record.developerId), ...auditPending(deps, event)] }));
      await flushAuditEvents(deps, [event]);
      return;
    } catch (error) {
      log(deps, { event: "script_tokens.take_back_failed", orgId: record.orgId, error: errorName(error) ?? "unknown" });
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't finish making that token. Try again.");
}

function revokeItems(deps: ScriptTokenDependencies, record: ScriptTokenRecord, at: string, by: string): TransactItem[] {
  const expires = keepUntil(Date.parse(at));
  return [
    {
      Update: {
        TableName: deps.tableName, Key: scriptTokenKey(record.orgId, record.tokenId), UpdateExpression: "SET revokedAt = :at, revokedBy = :by, #expires = :expires",
        ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :developer AND attribute_not_exists(revokedAt)",
        ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: { ":at": at, ":by": by, ":expires": expires, ":org": record.orgId, ":developer": record.developerId },
      },
    },
    {
      Update: {
        TableName: deps.tableName, Key: orgScriptTokensKey(record.orgId, record.tokenId), UpdateExpression: "SET revokedAt = :at, #expires = :expires",
        ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":at": at, ":expires": expires },
      },
    },
  ];
}

// ---- revoking

/**
 * `DELETE /v1/app/script-tokens/{id}`: revokes the caller's own token, or any token in the company when the caller is an owner or admin. Any other token (missing, another company's,
 * another person's for a member) is `NOT_FOUND`. It takes effect at once: every request reads the record. Revoking a revoked token answers it as it is.
 */
export async function revokeScriptToken(deps: ScriptTokenDependencies, caller: ScriptTokenCaller, tokenId: string): Promise<ScriptTokenView> {
  if (!ScriptTokenIdSchema.safeParse(tokenId).success) throw notFound();
  for (let attempt = 0; attempt < REVOKE_TRIES; attempt += 1) {
    const record = await readScriptToken(deps, caller.orgId, tokenId);
    const mine = record?.developerId === caller.developerId;
    if (record === undefined || (!mine && !isAdmin(caller.orgRole))) throw notFound();
    if (record.revokedAt !== undefined) return viewOf(record, deps.now(), caller.developerId);
    if (deps.audit === undefined) throw auditUnavailable();
    const at = isoOf(deps.now());
    const event = auditScriptTokenRevoked({
      orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: at, occurrence: auditOccurrence(tokenId, "revoked"), related: [record.developerId], tokenId, by: mine ? "creator" : "admin",
    });
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...revokeItems(deps, record, at, caller.developerId), ...auditItems(deps, event)] }));
      await flushAuditEvents(deps, [event]);
      return viewOf({ ...record, revokedAt: at, revokedBy: caller.developerId }, deps.now(), caller.developerId);
    } catch (error) {
      // Revoked by someone else at the same moment: read it again and answer what is there.
      const failed = failedIndexes(error);
      if (failed === undefined) throw error;
      log(deps, { event: "script_tokens.revoke_cancelled", orgId: caller.orgId, reasons: [...failed].join(",") || "none" });
    }
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "That token changed while it was revoked. Try again.");
}

/**
 * Review M3: a token refused because its creator's place changed (role, removal, ended or unlinked sign-in) is revoked by Rovara at once, so it never works again if the creator
 * goes back to where they stood. Best effort: the request is refused either way; a failed write is logged and the next request tries again.
 */
export async function revokeForAccessChange(deps: ScriptTokenDependencies, record: ScriptTokenRecord): Promise<void> {
  const at = isoOf(deps.now());
  const event = auditScriptTokenRevoked({ orgId: record.orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: auditOccurrence(record.tokenId, "revoked"), related: [record.developerId], tokenId: record.tokenId, by: "access_changed" });
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...revokeItems(deps, record, at, "rovara"), ...auditPending(deps, event)] }));
    await flushAuditEvents(deps, [event]);
  } catch (error) {
    log(deps, { event: "script_tokens.access_revoke_failed", orgId: record.orgId, error: errorName(error) ?? "unknown", reasons: [...(failedIndexes(error) ?? [])].join(",") || "none" });
  }
}

// ---- use

/**
 * Notes a request a token made: with the day's first request, the day's `script_token.used` audit event, in the same write as the token's "last used" day. That write fails closed
 * (review I4): if it fails for any reason but its own condition (another request noted the day first), the request is refused with a retryable 503, so every day of use is in the
 * ledger. A use with no audit ledger is refused. Later "last used" updates (at most every `LAST_USED_EVERY_MS`) are bookkeeping only: a failure is logged and the request goes on.
 */
export async function noteScriptTokenUse(deps: ScriptTokenDependencies, record: ScriptTokenRecord, permission: ScriptTokenPermission): Promise<void> {
  if (deps.audit === undefined) throw auditUnavailable();
  const nowMs = deps.now();
  const at = isoOf(nowMs);
  const day = at.slice(0, 10);
  const key = scriptTokenKey(record.orgId, record.tokenId);
  if (record.lastUsedDay !== day) {
    const event = auditScriptTokenUsed({ orgId: record.orgId, actor: { kind: "member", id: record.developerId }, occurredAt: at, occurrence: auditOccurrence(record.tokenId, day), tokenId: record.tokenId, day, permission });
    try {
      await deps.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.tableName, Key: key, UpdateExpression: "SET lastUsedAt = :at, lastUsedDay = :day",
              ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND (attribute_not_exists(lastUsedDay) OR lastUsedDay <> :day)",
              ExpressionAttributeValues: { ":at": at, ":day": day },
            },
          },
          ...auditPending(deps, event),
        ],
      }));
    } catch (error) {
      const failed = failedIndexes(error);
      log(deps, { event: "script_tokens.use_note_cancelled", orgId: record.orgId, error: errorName(error) ?? "unknown", reasons: [...(failed ?? [])].join(",") || "none" });
      // Only the token's own condition: today is noted already (or the token was revoked a moment ago, which the next request refuses).
      if (failed !== undefined && failed.size === 1 && failed.has(0)) return;
      throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't record this script token's use. Try again.");
    }
    await flushAuditEvents(deps, [event]);
    return;
  }
  if (record.lastUsedAt !== undefined && Date.parse(record.lastUsedAt) > nowMs - LAST_USED_EVERY_MS) return;
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET lastUsedAt = :at",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND (attribute_not_exists(lastUsedAt) OR lastUsedAt < :cutoff)",
      ExpressionAttributeValues: { ":at": at, ":cutoff": isoOf(nowMs - LAST_USED_EVERY_MS) },
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") log(deps, { event: "script_tokens.last_used_failed", orgId: record.orgId, error: errorName(error) ?? "unknown" });
  }
}

/**
 * Review I3: every task a token starts is audited by itself, naming the token and the task (`related`), so the ledger lists what a token did. Written after the start answered;
 * the occurrence is the token and the task, so a retry of the same start (same request id, same task) writes the same event once. Fails closed with a retryable 503: the script
 * retries with its request id, gets the same task back, and the event is written then.
 */
export async function auditScriptTokenStart(deps: ScriptTokenDependencies, token: { orgId: OrgId; tokenId: string; developerId: string }, taskId: string): Promise<void> {
  if (deps.audit === undefined) throw auditUnavailable();
  const at = isoOf(deps.now());
  const event = auditScriptTokenUsed({
    orgId: token.orgId, actor: { kind: "member", id: token.developerId }, occurredAt: at, occurrence: auditOccurrence(token.tokenId, taskId), related: [taskId], tokenId: token.tokenId, day: at.slice(0, 10), permission: "start",
  });
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: auditPending(deps, event) }));
  } catch (error) {
    log(deps, { event: "script_tokens.start_audit_failed", orgId: token.orgId, error: errorName(error) ?? "unknown", reasons: [...(failedIndexes(error) ?? [])].join(",") || "none" });
    throw agentXError("RUNTIME_UNAVAILABLE", "The task started, but Rovara couldn't record it. Send the same request again.");
  }
  await flushAuditEvents(deps, [event]);
}
