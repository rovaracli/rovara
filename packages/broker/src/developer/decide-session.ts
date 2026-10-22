// Plan 3, Task 21a-presence (R66, R67, R5-2, R7-1): a decision is made only by a person present, in a browser whose interactive sign-in is
// at most 10 minutes old. A local AI assistant holds the person's CLI token, so a token, a TTY or a typed code proves nothing.
//
// Everything here lives in the sign-in table, each kind under its own prefix (pinned by the infrastructure tests):
//   DECIDE_TICKET#<sha256 of the value>   who is deciding which approval; the only source of "who" (R7-1)
//   DECIDE_RATE#<scope>#...               counters and the "one unused ticket per (approval, member)" pointer
//   DECIDE_STATE#<sha256 of the state>    the fresh-sign-in flow's server-side state (R6-1)
//   DECIDE_SESSION#<sha256 of the cookie> the session: one approval, one decision, ten minutes
// Raw values (the ticket, the cookie, the state, the PKCE verifier) are never stored or logged: only their hashes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, type OrgId } from "@agentx/contracts";
import { mayDecide, type DecideKinds } from "./decide-kinds.js";
import { sha256Hex } from "./tokens.js";

export const DECIDE_COOKIE = "__Host-rovara_decide";
export const DECIDE_PKCE_COOKIE = "__Host-rovara_decide_pkce";
/** A ticket, a state record and a session each last ten minutes; a session's interactive sign-in may be no older than this. */
export const DECIDE_SECONDS = 600;
export const APPROVAL_ID_PATTERN = /^(?:apr|spr)_[0-9a-z]{20}$/;
/** The only places a decide flow returns to (R67): checked on the identify route's parameter, again on the ticket's, and on the stored state. */
export const APPROVE_RETURN_PATTERN = /^\/v1\/app\/approve\/((?:apr|spr)_[0-9a-z]{20})$/;
export const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const TICKET_EXPIRED_MESSAGE = "This confirmation link has expired. Open the approval again from Rovara.";
export const RATE_LIMIT_MESSAGE = "Too many confirmation attempts. Try again later.";
export const FORBIDDEN_ORIGIN_MESSAGE = "This request didn't come from Rovara's page.";
const META = "META";
const TICKETS_PER_MEMBER_PER_HOUR = 10;
const TICKETS_PER_APPROVAL_PER_DAY = 20;
const CREATE_USERS_PER_MEMBER_PER_DAY = 1;
const HOUR = 3600;
const DAY = 86_400;

export interface DecideTicket {
  orgId: OrgId; developerId: string; approvalId: string; mintedBy: "token" | "identified_session";
  createdAt: string; expiresAt: number; usedAt?: string;
}
/** The fresh-sign-in flow's state, written by `GET /v1/auth/decide/start` (purpose "decide"). The raw state is only in the URL; its hash is the key. */
export interface DecideState {
  purpose: "decide"; stateHash: string; nonce: string; codeVerifierHash: string; startedAt: number;
  return: string; approvalId: string; orgId: OrgId; developerId: string;
  /** What the start route asked Cognito for: the isFreshInteractiveSignIn fallback (no `amr`) relies on both. */
  identityProvider: "COGNITO"; prompt: "login"; expiresAt: number;
}
/** `signedInAt` and `expiresAt` are epoch seconds; `expiresAt = signedInAt + 600`, also the item's TTL. */
export interface DecideSession {
  orgId: OrgId; developerId: string; approvalId: string; signedInAt: number; method: "email_code"; csrfHash: string; usedAt?: string; expiresAt: number;
}

export const decideTicketKey = (value: string) => ({ pk: `DECIDE_TICKET#${sha256Hex(value)}`, sk: META });
export const decideSessionKey = (cookie: string) => ({ pk: `DECIDE_SESSION#${sha256Hex(cookie)}`, sk: META });
export const decideStateKey = (state: string) => ({ pk: `DECIDE_STATE#${sha256Hex(state)}`, sk: META });
const rateKey = (...parts: string[]) => ({ pk: `DECIDE_RATE#${parts.join("#")}`, sk: META });

/** The CSRF token of a session, derived from its cookie value: a page can show it only to the browser that holds the cookie, and nothing extra is stored (the session keeps its hash). */
export const csrfTokenFor = (cookie: string): string => createHash("sha256").update(`rovara-decide-csrf:${cookie}`).digest("base64url");

const conditionFailed = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
const tooMany = () => agentXError("TOO_MANY_REQUESTS", RATE_LIMIT_MESSAGE);

type DocumentClient = { send(command: unknown): Promise<unknown> };

export class DecideStore {
  constructor(private readonly input: { documentClient: DocumentClient; tableName: string; now: () => number }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); }
  private async get<T>(key: { pk: string; sk: string }): Promise<T | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
    return response.Item;
  }

  /** Counts one use of `key` in its window, or refuses with 429 when the window is full. The item expires with a margin after its window. */
  private async take(key: { pk: string; sk: string }, max: number, windowEndsAt: number): Promise<void> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: key,
        UpdateExpression: "SET expiresAt = :ttl ADD hits :one",
        ConditionExpression: "attribute_not_exists(hits) OR hits < :max",
        ExpressionAttributeValues: { ":ttl": windowEndsAt + HOUR, ":one": 1, ":max": max },
      }));
    } catch (error) {
      if (conditionFailed(error)) throw tooMany();
      throw error;
    }
  }
  private async takeInWindow(scope: string, id: string, max: number, windowSeconds: number): Promise<void> {
    const bucket = Math.floor(this.seconds() / windowSeconds);
    await this.take(rateKey(scope, id, String(bucket)), max, (bucket + 1) * windowSeconds);
  }

  /**
   * Mints a ticket (R7-1) for `developerId` to decide `approvalId`, and returns its raw value, which only the caller's response carries.
   * At most 10 per member per hour and 20 per approval per day (429, the same text whoever asks); a new mint marks the previous unused
   * ticket for the same (approval, member) used, so one is live at a time.
   */
  async mintTicket(input: { orgId: OrgId; developerId: string; approvalId: string; mintedBy: DecideTicket["mintedBy"] }): Promise<string> {
    await this.takeInWindow("MEMBER", input.developerId, TICKETS_PER_MEMBER_PER_HOUR, HOUR);
    await this.takeInWindow("APPROVAL", input.approvalId, TICKETS_PER_APPROVAL_PER_DAY, DAY);
    const value = randomBytes(32).toString("base64url");
    const expiresAt = this.seconds() + DECIDE_SECONDS;
    const ticket: DecideTicket = { orgId: input.orgId, developerId: input.developerId, approvalId: input.approvalId, mintedBy: input.mintedBy, createdAt: this.iso(), expiresAt };
    await this.input.documentClient.send(new PutCommand({
      TableName: this.input.tableName, Item: { ...decideTicketKey(value), entityType: "DECIDE_TICKET", ...ticket }, ConditionExpression: "attribute_not_exists(pk)",
    }));
    // One unused ticket per (approval, member): the pointer to the live one is swapped in one UpdateItem, which returns the previous one to
    // mark used. (The broker's grant on these keys is PutItem and UpdateItem only, so nothing here reads.)
    const swapped = await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName, Key: rateKey("PAIR", input.approvalId, input.developerId),
      UpdateExpression: "SET ticketPk = :ticket, expiresAt = :ttl", ExpressionAttributeValues: { ":ticket": decideTicketKey(value).pk, ":ttl": expiresAt + HOUR },
      ReturnValues: "ALL_OLD",
    })) as { Attributes?: { ticketPk?: string } };
    const previous = swapped.Attributes?.ticketPk;
    if (previous !== undefined) {
      try {
        await this.input.documentClient.send(new UpdateCommand({
          TableName: this.input.tableName, Key: { pk: previous, sk: META },
          UpdateExpression: "SET usedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)",
          ExpressionAttributeValues: { ":at": this.iso() },
        }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
    }
    return value;
  }

  /** Consumes a ticket: only an unused, unexpired one is returned, and it can never be redeemed again. Anything else is undefined and creates nothing. */
  async redeemTicket(value: string): Promise<DecideTicket | undefined> {
    if (!TICKET_PATTERN.test(value)) return undefined;
    const key = decideTicketKey(value);
    const stored = await this.get<DecideTicket>(key);
    const now = this.seconds();
    if (stored === undefined || stored.usedAt !== undefined || stored.expiresAt <= now) return undefined;
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: key, UpdateExpression: "SET usedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND expiresAt > :now",
        ExpressionAttributeValues: { ":at": this.iso(), ":now": now },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    return { orgId: stored.orgId, developerId: stored.developerId, approvalId: stored.approvalId, mintedBy: stored.mintedBy, createdAt: stored.createdAt, expiresAt: stored.expiresAt };
  }

  /** At most one `AdminCreateUser` per member per day (R6-2); 429 with the one text otherwise, whether or not the member exists. */
  async takeCreateUserSlot(developerId: string): Promise<void> {
    await this.takeInWindow("CREATE", developerId, CREATE_USERS_PER_MEMBER_PER_DAY, DAY);
  }

  async putState(state: string, record: DecideState): Promise<void> {
    await this.input.documentClient.send(new PutCommand({
      TableName: this.input.tableName, Item: { ...decideStateKey(state), entityType: "DECIDE_STATE", ...record }, ConditionExpression: "attribute_not_exists(pk)",
    }));
  }

  /** Reads and removes the state in one step: a callback can use it once. Unknown, used or expired: undefined. */
  async consumeState(state: string): Promise<DecideState | undefined> {
    if (!TICKET_PATTERN.test(state)) return undefined;
    const key = decideStateKey(state);
    const stored = await this.get<DecideState>(key);
    if (stored === undefined) return undefined;
    try {
      await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: key, ConditionExpression: "attribute_exists(pk)" }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    return stored.expiresAt <= this.seconds() ? undefined : stored;
  }

  async putSession(cookie: string, session: DecideSession): Promise<void> {
    await this.input.documentClient.send(new PutCommand({
      TableName: this.input.tableName, Item: { ...decideSessionKey(cookie), entityType: "DECIDE_SESSION", ...session }, ConditionExpression: "attribute_not_exists(pk)",
    }));
  }

  async getSession(cookie: string): Promise<DecideSession | undefined> {
    return this.get<DecideSession>(decideSessionKey(cookie));
  }

  /** Marks the session used, once: only an unused one for this approval that has not expired. Two requests at once get one winner. */
  async claimSession(cookie: string, approvalId: string): Promise<boolean> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: decideSessionKey(cookie), UpdateExpression: "SET usedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND approvalId = :id AND expiresAt > :now",
        ExpressionAttributeValues: { ":at": this.iso(), ":id": approvalId, ":now": this.seconds() },
      }));
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async deleteSession(cookie: string): Promise<void> {
    await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: decideSessionKey(cookie) }));
  }
}

/** REAUTH_REQUIRED for a decision: 401, with where to go (`confirmUrl` for a token, `signInUrl` for a browser without a fresh session). */
export class DecideReauthRequired extends AgentXError {
  constructor(message: string, readonly details: { confirmUrl?: string; signInUrl?: string }) {
    super("REAUTH_REQUIRED", message, 401);
    this.name = "DecideReauthRequired";
  }
}

export interface DecideRequestContext {
  store: DecideStore;
  now: () => number;
  /** The cell's origin: where the page is served, and the only Origin a state-changing request may carry. */
  cellOrigin: string;
  kinds: DecideKinds;
  /** Verifies a bearer token (CLI, MCP or any API client) and names its member and org; throws AUTH_REQUIRED for one that is not valid. */
  authenticateBearer?: (authorization: string) => Promise<{ developerId: string; orgId: OrgId }>;
}
export interface DecideRequest { method: string; path: string; headers: Record<string, string | undefined>; body?: string }
export interface DecideAuthority {
  orgId: OrgId; developerId: string; approvalId: string;
  /** Ends the session once the decision is made (R5-2: it already cannot be used again). */
  finish(): Promise<void>;
}

const DECIDE_PATHS = [
  /^\/v1\/app\/approve\/((?:apr|spr)_[0-9a-z]{20})$/,
  /^\/v1\/app\/approvals\/(apr_[0-9a-z]{20})\/decide$/,
  /^\/v1\/app\/spend-requests\/(spr_[0-9a-z]{20})\/decide$/,
];
/** The approval a decide request is about, from its path alone. */
export function approvalIdOfRequest(path: string): string | undefined {
  const pathname = new URL(path, "https://rovara.invalid").pathname;
  for (const pattern of DECIDE_PATHS) {
    const found = pattern.exec(pathname)?.[1];
    if (found !== undefined) return found;
  }
  return undefined;
}

export const signInUrlFor = (approvalId: string) => `/v1/auth/decide/identify?return=/v1/app/approve/${approvalId}`;
export const confirmUrlWithTicket = (cellOrigin: string, approvalId: string, ticket: string) => `${cellOrigin}/v1/app/approve/${approvalId}?ticket=${ticket}`;

export function cookieOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const part of (headers.cookie ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

function csrfFieldOf(request: DecideRequest): string | undefined {
  if (request.body === undefined) return undefined;
  if (/json/i.test(request.headers["content-type"] ?? "")) {
    try {
      const parsed = JSON.parse(request.body) as { csrf?: unknown } | null;
      return typeof parsed?.csrf === "string" ? parsed.csrf : undefined;
    } catch { return undefined; }
  }
  return new URLSearchParams(request.body).get("csrf") ?? undefined;
}

/** SHA-256 of the field against the stored hash, in constant time; both are hex digests of the same length, so a wrong length is false, never a throw. */
function csrfMatches(field: string | undefined, csrfHash: string): boolean {
  if (field === undefined) return false;
  const given = Buffer.from(sha256Hex(field));
  const stored = Buffer.from(csrfHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/**
 * Who is deciding, and may they now (R66, R67). Used by every decide route and by the confirmation page.
 * - A bearer token is refused with REAUTH_REQUIRED and a `confirmUrl` carrying a ticket minted for that token's member, after `mayDecide`
 *   says they may decide it now (else 403 or 404 and no ticket).
 * - A browser needs a live, unused session opened for this approval whose interactive sign-in is at most 10 minutes old; otherwise
 *   REAUTH_REQUIRED with the `signInUrl` of the identify step.
 * - A state-changing request also needs the cell's own Origin and the session's CSRF field, and claims the session: it can decide once.
 */
export async function requireDecideSession(context: DecideRequestContext, request: DecideRequest): Promise<DecideAuthority> {
  const approvalId = approvalIdOfRequest(request.path);
  if (approvalId === undefined) throw agentXError("NOT_FOUND", "route not found");
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization !== "") {
    if (context.authenticateBearer === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
    const member = await context.authenticateBearer(authorization);
    const inspection = await mayDecide(context.kinds, { orgId: member.orgId, developerId: member.developerId, approvalId });
    if (inspection.status === "not_found") throw agentXError("NOT_FOUND", "approval not found");
    if (inspection.status === "forbidden") throw agentXError("FORBIDDEN", `Only ${inspection.who} can decide this.`);
    if (inspection.status === "decided") throw agentXError("APPROVAL_CLOSED", decidedWords(inspection));
    const ticket = await context.store.mintTicket({ orgId: member.orgId, developerId: member.developerId, approvalId, mintedBy: "token" });
    const confirmUrl = confirmUrlWithTicket(context.cellOrigin, approvalId, ticket);
    throw new DecideReauthRequired(`Decisions are made in your browser. Open ${confirmUrl}.`, { confirmUrl });
  }
  const reauth = () => new DecideReauthRequired("Confirm this in your browser: sign in again to continue.", { signInUrl: signInUrlFor(approvalId) });
  const cookie = cookieOf(request.headers, DECIDE_COOKIE);
  if (cookie === undefined || cookie.length < 32 || cookie.length > 128) throw reauth();
  const session = await context.store.getSession(cookie);
  const nowSeconds = Math.floor(context.now() / 1000);
  if (session === undefined || session.usedAt !== undefined || session.approvalId !== approvalId
    || session.expiresAt <= nowSeconds || nowSeconds - session.signedInAt > DECIDE_SECONDS) throw reauth();
  const authority = (): DecideAuthority => ({
    orgId: session.orgId, developerId: session.developerId, approvalId,
    finish: () => context.store.deleteSession(cookie),
  });
  if (request.method === "GET" || request.method === "HEAD") return authority();
  if (request.headers.origin !== context.cellOrigin || !csrfMatches(csrfFieldOf(request), session.csrfHash)) throw agentXError("FORBIDDEN", FORBIDDEN_ORIGIN_MESSAGE);
  if (!await context.store.claimSession(cookie, approvalId)) throw reauth();
  return authority();
}

/** "This was already decided by <name> at <time>." */
export const decidedWords = (decided: { by: string; at: string }): string => `This was already decided by ${decided.by} at ${decided.at}.`;
