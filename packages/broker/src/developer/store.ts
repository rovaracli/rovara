// packages/broker/src/developer/store.ts
// The DeveloperSignIn table (spec 025 FR-005, FR-008). Codes and refresh tokens are stored only as
// SHA-256 hashes. Every expiry is checked here; the table's TTL only cleans up afterwards.
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError,
  normalizeEmail,
  DEVELOPER_AUTH_REQUEST_SECONDS,
  DEVELOPER_CODE_SECONDS,
  DEVELOPER_SESSION_SECONDS,
  type DeveloperSignInMethod,
  type LinkedIdentity,
} from "@agentx/contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { pkceChallengeMatches, randomToken, sha256Hex } from "./tokens.js";

export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number; browserReturnTo?: string;
  /** SHA-256 of the invite token in base64url. The raw token is never stored. */
  inviteTokenHash?: string;
  /** "join": the browser join page's sign-in (Plan 2, Task 5); its completion stores a JOIN_RESULT instead of issuing a session or code. */
  purpose?: "join" }
/** How a join ended (Plan 2, Task 5). Only "joined" used the invite. */
export type JoinOutcome = "joined" | "ALREADY_IN_ORG" | "INVITE_WRONG_EMAIL" | "INVITE_INVALID";
/**
 * The facts the join "done" page shows, kept ten minutes under `JOIN_RESULT#<authRequestId>`. `orgName` is the org joined (or the invited
 * one); `codeChallenge` is the join request's PKCE challenge, which the browser's cookie must satisfy to read the page. No token, no email.
 */
export interface JoinResultRecord {
  outcome: JoinOutcome; orgName: string; role: "admin" | "member"; currentOrgName?: string; invitedOrgName: string; maskedEmail?: string;
  inviterName: string; codeChallenge: string; expiresAt: number;
}
export const JOIN_RESULT_SECONDS = 600;
export interface DeveloperRecord { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string; firstSignInAt: string; lastSignInAt: string; revoked: boolean; sessionsEndedAt?: string;
  /** Plan 2, Task 3: the developer this one was merged into (a duplicate member of the same person); its sign-in identity is linked there. */
  mergedInto?: string; mergedAt?: string }
/** One item of a TransactWriteItems request, for a transaction that also writes another table. */
export type SignInTransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
/**
 * One sign-in identity's link to a developer (Plan 2, Task 2). `identityKey` is `ownerKeyForSubject(issuer, subject)`. The forward item
 * (`SIGNIN_IDENTITY#<identityKey>`) answers "which developer is this sign-in"; the reverse item (`DEVELOPER#<developerId>` /
 * `IDENTITY#<identityKey>`) lists a developer's identities. Both carry these fields and are written in one transaction.
 * `unlinkedFrom` and `unlinkedAt` are set when the person unlinked the identity from that developer.
 */
export interface IdentityLinkRecord {
  developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; email?: string; login?: string;
  linkedAt: string; lastSignInAt: string; unlinkedFrom?: string; unlinkedAt?: string;
}
export interface SessionRecord { sessionId: string; developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; identityKey?: string; startedAt: string; endsAt: number; reviewExpiresAt?: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string }

/** A method's enabled-since cutoff from its environment variable, epoch seconds; "0", empty or unreadable means none. */
export function methodSince(text: string | undefined): number | undefined {
  if (text === undefined || !/^[0-9]{1,12}$/.test(text)) return undefined;
  const since = Number(text);
  return since > 0 ? since : undefined;
}

/** Whether a session started before its method was last turned on (FR-045): its disable ended it. */
export function startedBeforeMethodOn(startedAt: string, since: number | undefined): boolean {
  if (since === undefined || since <= 0) return false;
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || started < since * 1000;
}
/** E9: whether an admin ended this session: it started before the developer's `sessionsEndedAt`. Fails closed on an unreadable time. */
export function endedByAdmin(startedAt: string, sessionsEndedAt: string | undefined): boolean {
  if (sessionsEndedAt === undefined) return false;
  const started = Date.parse(startedAt);
  const ended = Date.parse(sessionsEndedAt);
  return !Number.isFinite(started) || !Number.isFinite(ended) || started < ended;
}
export type RefreshLookup =
  | { kind: "active"; session: SessionRecord; tokenHash: string }
  | { kind: "unknown" }
  | { kind: "reused"; sessionId: string }
  | { kind: "recently_rotated"; session: SessionRecord; tokenHash: string }
  | { kind: "ended"; session: SessionRecord };

/** Auth0-style reuse interval (rulings.md, Task 4 fix round 1, F2): a refresh token presented again
 * within this many seconds of its own rotation is not treated as theft, so a lost response or a
 * stale-lock race between two local processes does not sign the person out. */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

interface CodeRecord { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; identityKey?: string; codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string; graceUsedAt?: string }
interface CancellationReason { Code?: string }

export const META = "META";

/** E8: the email index's key, the SHA-256 of the normalized email (normalizeEmail, the same as the org email pointer), so no email is stored as a key. */
export function emailIndexKey(email: string): { pk: string; sk: "META" } {
  return { pk: `EMAIL#${sha256Hex(normalizeEmail(email).email)}`, sk: META };
}
export function signInIdentityKey(identityKey: string): { pk: string; sk: "META" } {
  return { pk: `SIGNIN_IDENTITY#${identityKey}`, sk: META };
}
/** The reverse item: one row per identity linked to a developer, in the developer's own partition. */
export function developerIdentityKey(developerId: string, identityKey: string): { pk: string; sk: string } {
  return { pk: `DEVELOPER#${developerId}`, sk: `IDENTITY#${identityKey}` };
}
/** A link reads as no link once it was unlinked, unless the identity then re-linked to its own developer (its own key). */
const isActiveLink = (link: Pick<IdentityLinkRecord, "developerId" | "unlinkedFrom">, identityKey: string): boolean =>
  link.unlinkedFrom === undefined || link.developerId === identityKey;
/**
 * Plan 2, Task 8: unlinking a sign-in method ends that method's sessions without touching the person's others. The sessions are not
 * listed (the table has no index of them); the unlink marks the developer's record instead, and every session check compares its start
 * with the mark: a session of the unlinked identity (`sessionsEndedByIdentity#<identityKey>`), or a session from before sessions
 * recorded their identity, by method (`sessionsEndedByMethod#<provider>`). The marks are separate attributes, so one unlink is one
 * atomic update beside the unlink itself, and no new kind of access to the table.
 */
export const identitySessionsEndedAttribute = (identityKey: string): string => `sessionsEndedByIdentity#${identityKey}`;
export const methodSessionsEndedAttribute = (provider: DeveloperSignInMethod): string => `sessionsEndedByMethod#${provider}`;
/** Whether the person unlinked this session's sign-in method after the session started. `developer` is the developer record as stored. */
export function endedByUnlink(session: Pick<SessionRecord, "startedAt" | "amr" | "identityKey">, developer: Record<string, unknown>): boolean {
  const mark = developer[session.identityKey === undefined ? methodSessionsEndedAttribute(session.amr) : identitySessionsEndedAttribute(session.identityKey)];
  return typeof mark === "string" && endedByAdmin(session.startedAt, mark);
}
/** Refusals of an unlink, in the person's words. */
export const UNLINK_ONLY_IDENTITY = "this is your only way to sign in, so it can't be removed";
export const UNLINK_FIRST_IDENTITY = "this is the sign-in your account was created with, so it can't be removed";
const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Real DynamoDB always populates this on a cancelled TransactWriteItems, one entry per
 * TransactItem, ordered the same way, "None" for items not implicated (fix round 2, F4: FakeDynamoDb
 * now models this too, so there is no other case to fall back to). */
function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  const reasons = (error as { CancellationReasons?: unknown } | null)?.CancellationReasons;
  return Array.isArray(reasons) ? (reasons as CancellationReason[]) : undefined;
}

export class DeveloperSignInStore {
  constructor(private readonly input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); }

  private async get<T>(pk: string): Promise<(T & { pk: string; sk: string }) | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T & { pk: string; sk: string } };
    return response.Item;
  }

  private async put(item: Record<string, unknown>, condition?: string): Promise<void> {
    await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) }));
  }

  async createAuthRequest(input: Omit<AuthRequestRecord, "id" | "expiresAt" | "method" | "consumedAt">): Promise<AuthRequestRecord> {
    const record: AuthRequestRecord = { ...input, id: randomToken(""), expiresAt: this.seconds() + DEVELOPER_AUTH_REQUEST_SECONDS };
    await this.put({ pk: `AUTHREQ#${record.id}`, sk: META, entityType: "AUTH_REQUEST", ...record }, "attribute_not_exists(pk)");
    return record;
  }

  async putJoinResult(id: string, result: Omit<JoinResultRecord, "expiresAt">): Promise<void> {
    await this.put({ pk: `JOIN_RESULT#${id}`, sk: META, entityType: "JOIN_RESULT", ...result, expiresAt: this.seconds() + JOIN_RESULT_SECONDS }, "attribute_not_exists(pk)");
  }

  async getJoinResult(id: string): Promise<JoinResultRecord | undefined> {
    const item = await this.get<JoinResultRecord>(`JOIN_RESULT#${id}`);
    return item === undefined || item.expiresAt <= this.seconds() ? undefined : strip(item);
  }

  async getAuthRequest(id: string): Promise<AuthRequestRecord | undefined> {
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined || item.expiresAt <= this.seconds() ? undefined : strip(item);
  }

  async chooseMethod(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET #method = :method",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt)",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":method": method, ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    return this.getAuthRequest(id);
  }

  async consumeAuthRequest(id: string, method: DeveloperSignInMethod): Promise<AuthRequestRecord | undefined> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `AUTHREQ#${id}`, sk: META },
        UpdateExpression: "SET consumedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attribute_not_exists(consumedAt) AND #method = :method",
        ExpressionAttributeNames: { "#method": "method" },
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds(), ":method": method },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const item = await this.get<AuthRequestRecord>(`AUTHREQ#${id}`);
    return item === undefined ? undefined : strip(item);
  }

  async upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked">): Promise<DeveloperRecord> {
    // One atomic update, not a read-then-overwrite: a concurrent revocation (or another sign-in)
    // must never be clobbered by this call. firstSignInAt and revoked are set only if absent;
    // revoked in particular must never flip true back to false (fix round 1, F3).
    const at = this.iso();
    const setClauses = [
      "entityType = :entityType",
      "provider = :provider",
      "issuer = :issuer",
      "subject = :subject",
      "displayName = :displayName",
      "lastSignInAt = :at",
      "firstSignInAt = if_not_exists(firstSignInAt, :at)",
      "revoked = if_not_exists(revoked, :false)",
    ];
    const removeClauses: string[] = [];
    const values: Record<string, unknown> = {
      ":entityType": "DEVELOPER",
      ":provider": profile.provider,
      ":issuer": profile.issuer,
      ":subject": profile.subject,
      ":displayName": profile.displayName,
      ":at": at,
      ":false": false,
    };
    if (profile.email === undefined) removeClauses.push("email");
    else { setClauses.push("email = :email"); values[":email"] = profile.email; }
    if (profile.slackUserId === undefined) removeClauses.push("slackUserId");
    else { setClauses.push("slackUserId = :slackUserId"); values[":slackUserId"] = profile.slackUserId; }

    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `DEVELOPER#${profile.developerId}`, sk: META },
      UpdateExpression: `SET ${setClauses.join(", ")}${removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(", ")}` : ""}`,
      ExpressionAttributeValues: values,
    }));
    if (profile.email !== undefined) {
      // E8 (Q4): the latest sign-in with this verified email wins; the email itself is not stored here.
      await this.put({ ...emailIndexKey(profile.email), entityType: "DEVELOPER_EMAIL", developerId: profile.developerId, updatedAt: at });
    }
    const stored = await this.getDeveloper(profile.developerId);
    if (stored === undefined) throw new Error("developer upsert did not persist");
    return stored;
  }

  async getDeveloper(developerId: string): Promise<DeveloperRecord | undefined> {
    const item = await this.get<DeveloperRecord>(`DEVELOPER#${developerId}`);
    return item === undefined ? undefined : strip(item);
  }

  /** The identity's link item as stored, whether or not it still counts as a link (see `isActiveLink`). */
  async getIdentityLink(identityKey: string): Promise<IdentityLinkRecord | undefined> {
    const item = await this.get<IdentityLinkRecord>(signInIdentityKey(identityKey).pk);
    return item === undefined ? undefined : strip(item);
  }

  /**
   * The developer this sign-in identity belongs to. An unlinked identity has none. With no link item at all it is its own developer
   * when a `DEVELOPER#<identityKey>` record exists for the same issuer and subject, so a developer from before identity links is
   * recognised before their next sign-in writes the link. Sign-in itself reads `getIdentityLink`, not this fallback.
   */
  async developerForIdentity(identityKey: string): Promise<string | undefined> {
    const link = await this.getIdentityLink(identityKey);
    if (link !== undefined) return isActiveLink(link, identityKey) ? link.developerId : undefined;
    const record = await this.getDeveloper(identityKey);
    return record !== undefined && ownerKeyForSubject(record.issuer, record.subject) === identityKey ? identityKey : undefined;
  }

  /**
   * Links a sign-in identity to a developer, both items in one transaction. Whoever writes first wins: when another sign-in linked the
   * identity to a different developer in the meantime, that developer is returned and nothing is written. `created` is true only when this
   * call wrote a new link item (an identity unlinked earlier and now linked to its own developer again counts). Linking an unlinked
   * identity to anyone but its own developer is refused: only the identity's own sign-in may start a new developer for it.
   */
  async linkIdentity(input: { identityKey: string; developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; email?: string; login?: string }): Promise<{ developerId: string; created: boolean }> {
    const { identityKey, developerId } = input;
    const own = developerId === identityKey;
    const current = await this.getIdentityLink(identityKey);
    const settled = this.settledLink(current, identityKey, developerId, own);
    if (settled !== undefined) return settled;
    const at = this.iso();
    const link: IdentityLinkRecord = {
      developerId, provider: input.provider, issuer: input.issuer, subject: input.subject,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.login === undefined ? {} : { login: input.login }),
      linkedAt: at, lastSignInAt: at,
      // An unlinked item that the identity re-links to itself keeps its unlinkedFrom and unlinkedAt (they record why it left).
      ...(current?.unlinkedFrom === undefined ? {} : { unlinkedFrom: current.unlinkedFrom }),
      ...(current?.unlinkedAt === undefined ? {} : { unlinkedAt: current.unlinkedAt }),
    };
    const body = { entityType: "IDENTITY_LINK", ...link };
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: {
            TableName: this.input.tableName, Item: { ...signInIdentityKey(identityKey), ...body },
            // Writes when nothing is linked, or (for the identity's own developer) over an item that was unlinked.
            ConditionExpression: `attribute_not_exists(pk) OR (developerId = :d AND attribute_not_exists(unlinkedFrom))${own ? " OR attribute_exists(unlinkedFrom)" : ""}`,
            ExpressionAttributeValues: { ":d": developerId },
          } },
          { Put: { TableName: this.input.tableName, Item: { ...developerIdentityKey(developerId, identityKey), ...body } } },
        ],
      }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // Another sign-in linked this identity first: read what it wrote.
      const winner = this.settledLink(await this.getIdentityLink(identityKey), identityKey, developerId, own);
      if (winner === undefined) throw error;
      return winner;
    }
    return { developerId, created: true };
  }

  /** What an existing link item settles for a `linkIdentity(developerId)` call: an answer, or undefined when the item can be (over)written. */
  private settledLink(current: IdentityLinkRecord | undefined, identityKey: string, developerId: string, own: boolean): { developerId: string; created: false } | undefined {
    if (current === undefined) return undefined;
    if (isActiveLink(current, identityKey)) return { developerId: current.developerId, created: false };
    if (own) return undefined;
    throw agentXError("AUTH_REQUIRED", "this sign-in was unlinked from that account and can only start its own; run agentx login again");
  }

  /**
   * The sign-in table's items for merging a duplicate developer into `survivorId` (Plan 2, Task 3), for a caller whose one transaction also
   * writes the State table: the duplicate's identity is linked to the survivor, and the duplicate's record says where it went and when
   * and ends its sessions as of that moment, so no session outlives the merge.
   * `link` is the identity's link item when it has one. A duplicate that signed in after identity links has a link to itself, which is
   * moved to the survivor (both items, conditional on still being its own and never unlinked); with no link item one is written.
   */
  mergeItems(input: { duplicate: DeveloperRecord; duplicateIdentityKey: string; survivorId: string; at: string; link?: IdentityLinkRecord; email?: string; login?: string }): SignInTransactItem[] {
    const { duplicate, duplicateIdentityKey: identityKey, survivorId, at, link } = input;
    const TableName = this.input.tableName;
    const email = input.email ?? link?.email ?? duplicate.email;
    const login = input.login ?? link?.login;
    const body = {
      entityType: "IDENTITY_LINK", developerId: survivorId, provider: duplicate.provider, issuer: duplicate.issuer, subject: duplicate.subject,
      ...(email === undefined ? {} : { email }),
      ...(login === undefined ? {} : { login }),
      linkedAt: link?.linkedAt ?? at, lastSignInAt: at,
    };
    const items: SignInTransactItem[] = link === undefined
      ? [{ Put: { TableName, Item: { ...signInIdentityKey(identityKey), ...body }, ConditionExpression: "attribute_not_exists(pk)" } }]
      : [
        { Update: {
          TableName, Key: signInIdentityKey(identityKey), UpdateExpression: "SET developerId = :survivor, lastSignInAt = :at",
          ConditionExpression: "developerId = :duplicate AND attribute_not_exists(unlinkedFrom)", ExpressionAttributeValues: { ":survivor": survivorId, ":at": at, ":duplicate": duplicate.developerId },
        } },
        // The old reverse item stays but no longer lists under the duplicate.
        { Update: {
          TableName, Key: developerIdentityKey(duplicate.developerId, identityKey), UpdateExpression: "SET developerId = :survivor",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":survivor": survivorId },
        } },
      ];
    return [
      ...items,
      { Put: { TableName, Item: { ...developerIdentityKey(survivorId, identityKey), ...body } } },
      { Update: {
        TableName, Key: { pk: `DEVELOPER#${duplicate.developerId}`, sk: META }, UpdateExpression: "SET mergedInto = :survivor, mergedAt = :at, sessionsEndedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(mergedInto) AND (attribute_not_exists(sessionsEndedAt) OR sessionsEndedAt <= :at)",
        ExpressionAttributeValues: { ":survivor": survivorId, ":at": at },
      } },
    ];
  }

  /**
   * Whether the identity is still linked to this developer. A link that was unlinked, or moved to another developer, is not. An identity
   * with no link item (a developer from before identity links) is its own developer's.
   */
  async identityBelongsTo(identityKey: string, developerId: string): Promise<boolean> {
    const link = await this.getIdentityLink(identityKey);
    return link === undefined || (isActiveLink(link, identityKey) && link.developerId === developerId);
  }

  /** Every reverse item in the developer's partition, as stored (some may be unlinked or moved), following LastEvaluatedKey through each page. */
  private async identityItems(developerId: string): Promise<Array<IdentityLinkRecord & { sk: string }>> {
    const links: Array<IdentityLinkRecord & { sk: string }> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const response = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "IDENTITY#" },
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<IdentityLinkRecord & { sk: string }>; LastEvaluatedKey?: Record<string, unknown> };
      links.push(...(response.Items ?? []));
      start = response.LastEvaluatedKey;
    } while (start !== undefined);
    return links;
  }

  /** The identities linked to a developer, oldest link first, as stored. */
  private async activeIdentityItems(developerId: string): Promise<Array<IdentityLinkRecord & { sk: string }>> {
    return (await this.identityItems(developerId))
      .filter((link) => link.developerId === developerId && isActiveLink(link, link.sk.slice("IDENTITY#".length)))
      .sort((left, right) => left.linkedAt.localeCompare(right.linkedAt) || left.sk.localeCompare(right.sk));
  }

  /** The identities linked to a developer, oldest link first. Issuer and subject never leave the store. */
  async identitiesOf(developerId: string): Promise<LinkedIdentity[]> {
    return (await this.activeIdentityItems(developerId)).map((link) => ({
      provider: link.provider,
      ...(link.email === undefined ? {} : { email: link.email }),
      ...(link.login === undefined ? {} : { login: link.login }),
      linkedAt: link.linkedAt, lastSignInAt: link.lastSignInAt,
    }));
  }

  /**
   * Removes a sign-in method from a developer (Plan 2, Task 8). It must leave the developer another active identity, and never the one the
   * account was created with (the identity whose key is the developer's). Per identity of that method, one transaction: the reverse item is
   * deleted, the forward item keeps its fields and gains `unlinkedFrom` and `unlinkedAt` (rule 2 never relinks it: its next sign-in starts
   * its own developer), and the developer's record is marked so that identity's sessions end (see `endedByUnlink`), the others' not.
   * Only the caller's own developer is ever touched. Returns the (first) identity key removed.
   */
  async unlinkIdentity(input: { developerId: string; provider: DeveloperSignInMethod; now?: number }): Promise<{ identityKey: string }> {
    const { developerId, provider } = input;
    const active = await this.activeIdentityItems(developerId);
    const targets = active.filter((link) => link.provider === provider);
    if (targets.length === 0) throw agentXError("NOT_FOUND", "that sign-in method is not linked to your account");
    if (active.length - targets.length < 1) throw agentXError("CONFIG_INVALID", UNLINK_ONLY_IDENTITY);
    const keys = targets.map((link) => link.sk.slice("IDENTITY#".length));
    if (keys.includes(developerId)) throw agentXError("CONFIG_INVALID", UNLINK_FIRST_IDENTITY);
    const at = new Date(input.now ?? this.input.now()).toISOString();
    const TableName = this.input.tableName;
    for (const [index, link] of targets.entries()) {
      const identityKey = keys[index]!;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the reverse item's keys
      const { pk: _pk, sk: _sk, entityType: _type, ...fields } = link as typeof link & { pk: string; entityType?: string };
      try {
        await this.input.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: {
              TableName, Key: developerIdentityKey(developerId, identityKey),
              ConditionExpression: "attribute_exists(pk) AND developerId = :d AND attribute_not_exists(unlinkedFrom)", ExpressionAttributeValues: { ":d": developerId },
            } },
            { Put: {
              TableName, Item: { ...fields, ...signInIdentityKey(identityKey), entityType: "IDENTITY_LINK", unlinkedFrom: developerId, unlinkedAt: at },
              ConditionExpression: "attribute_exists(pk) AND developerId = :d AND attribute_not_exists(unlinkedFrom)", ExpressionAttributeValues: { ":d": developerId },
            } },
            { Update: {
              TableName, Key: { pk: `DEVELOPER#${developerId}`, sk: META }, UpdateExpression: "SET #identity = :at, #method = :at",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#identity": identitySessionsEndedAttribute(identityKey), "#method": methodSessionsEndedAttribute(link.provider) },
              ExpressionAttributeValues: { ":at": at },
            } },
          ],
        }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
        throw agentXError("CONFIG_INVALID", "your sign-in methods changed while this ran; check them with agentx whoami and try again");
      }
    }
    return { identityKey: keys[0]! };
  }

  /** Records a sign-in on the identity's link, on both items. Nothing happens for an identity with no active link. */
  async touchIdentity(identityKey: string): Promise<void> {
    const link = await this.getIdentityLink(identityKey);
    if (link === undefined || !isActiveLink(link, identityKey)) return;
    const at = this.iso();
    const update = (key: { pk: string; sk: string }) => ({ Update: {
      TableName: this.input.tableName, Key: key, UpdateExpression: "SET lastSignInAt = :at",
      ConditionExpression: "attribute_exists(pk) AND developerId = :d", ExpressionAttributeValues: { ":at": at, ":d": link.developerId },
    } });
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [update(signInIdentityKey(identityKey)), update(developerIdentityKey(link.developerId, identityKey))],
      }));
    } catch (error) {
      // Unlinked, or relinked elsewhere, between the read and the write: the time of that sign-in is not worth a failed sign-in.
      if (!conditionFailed(error)) throw error;
    }
  }

  async issueCode(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; identityKey?: string; codeChallenge: string; redirectUri: string }): Promise<string> {
    const code = randomToken("agxc_");
    const record: CodeRecord = { ...input, expiresAt: this.seconds() + DEVELOPER_CODE_SECONDS };
    await this.put({ pk: `CODE#${sha256Hex(code)}`, sk: META, entityType: "AUTH_CODE", ...record }, "attribute_not_exists(pk)");
    return code;
  }

  async redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<{ developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; identityKey?: string } | undefined> {
    const pk = `CODE#${sha256Hex(input.code)}`;
    try {
      // Burned first, whatever the verifier: a code is tried once.
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk, sk: META },
        UpdateExpression: "SET usedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND expiresAt > :now",
        ExpressionAttributeValues: { ":at": this.iso(), ":now": this.seconds() },
      }));
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
    const record = await this.get<CodeRecord>(pk);
    if (record === undefined || record.redirectUri !== input.redirectUri || !pkceChallengeMatches(input.verifier, record.codeChallenge)) return undefined;
    return { developerId: record.developerId, amr: record.amr, ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }), ...(record.identityKey === undefined ? {} : { identityKey: record.identityKey }) };
  }

  /** `endsAt` (epoch seconds) is for a browser review sign-in, which has its own fixed length; every other session lasts DEVELOPER_SESSION_SECONDS. The stored record's clean-up time follows `endsAt`. */
  async createSession(input: { developerId: string; amr: DeveloperSignInMethod; slackUserId?: string; identityKey?: string; reviewExpiresAt?: number; endsAt?: number }): Promise<{ session: SessionRecord; refreshToken: string }> {
    const session: SessionRecord = { endsAt: this.seconds() + DEVELOPER_SESSION_SECONDS, ...input, sessionId: randomUUID(), startedAt: this.iso() };
    const refreshToken = randomToken("agxr_");
    await this.input.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.input.tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: META, entityType: "SESSION", ...session, expiresAt: session.endsAt + 86_400 }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }));
    return { session, refreshToken };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const item = await this.get<SessionRecord & { expiresAt?: number }>(`SESSION#${sessionId}`);
    if (item === undefined) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { expiresAt: _ttl, ...session } = strip(item);
    return session;
  }

  async lookupRefresh(refreshToken: string): Promise<RefreshLookup> {
    const tokenHash = sha256Hex(refreshToken);
    const record = await this.get<RefreshRecord>(`REFRESH#${tokenHash}`);
    if (record === undefined) return { kind: "unknown" };
    if (record.usedAt !== undefined) {
      // Fix round 1, F2 (owner ruling): inside the grace window, and only for a session that is
      // still healthy, a repeat presentation gets a fresh successor instead of being treated as
      // theft. Past the window, or against a dead session, it's reused exactly as before. Strict
      // comparison (fix round 2, F5), matching the mint condition's strict `usedAt > :cutoff`: the
      // boundary itself (exactly REFRESH_REUSE_GRACE_SECONDS elapsed) is outside the window.
      const withinGrace = this.input.now() - Date.parse(record.usedAt) < REFRESH_REUSE_GRACE_SECONDS * 1000;
      if (withinGrace) {
        const session = await this.getSession(record.sessionId);
        if (session !== undefined && session.revokedAt === undefined && session.endsAt > this.seconds()) {
          return { kind: "recently_rotated", session, tokenHash };
        }
      }
      return { kind: "reused", sessionId: record.sessionId };
    }
    const session = await this.getSession(record.sessionId);
    if (session === undefined) return { kind: "unknown" };
    if (session.revokedAt !== undefined || session.endsAt <= this.seconds()) return { kind: "ended", session };
    return { kind: "active", session, tokenHash };
  }

  async rotateRefresh(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true } | { ended: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${input.tokenHash}`, sk: META }, UpdateExpression: "SET usedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)", ExpressionAttributeValues: { ":at": at } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: input.session.sessionId, expiresAt: input.session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${input.session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND endsAt > :now", ExpressionAttributeValues: { ":at": at, ":now": this.seconds() } } },
        ],
      }));
    } catch (error) {
      const classification = this.classifyRotationFailure(error);
      // Fix round 2, F2: the real two-process race. Both processes see `active` and both call
      // rotateRefresh with the same old token; the loser's old-token condition fails here. Rather
      // than reporting that as reuse (which would make Task 6 revoke a perfectly healthy session),
      // attempt the same grace mint rotateRecentlyUsed uses. Its own atomic condition (window, one
      // mint per old token, session health) decides the real answer, so a genuine replay outside
      // the window or past the cap still ends up `reused`.
      if (!("reused" in classification)) return classification; // { ended: true }
      return this.mintGraceSuccessor(input.tokenHash, input.session);
    }
    return { refreshToken };
  }

  /** Fix round 1, F2 (owner ruling); fix round 2, F1 and F3: mints a fresh successor for a token
   * already used within REFRESH_REUSE_GRACE_SECONDS, atomically re-checking that window, the
   * one-grace-mint-per-old-token cap, and the session's health, so a caller can't be tricked by a
   * stale lookup. Covers a lost response and a stale-lock race between two local processes
   * refreshing at once, without weakening reuse detection past the window or the cap. */
  async rotateRecentlyUsed(input: { session: SessionRecord; tokenHash: string }): Promise<{ refreshToken: string } | { reused: true }> {
    const result = await this.mintGraceSuccessor(input.tokenHash, input.session);
    // This method's signature predates the reused/ended split classifyRotationFailure makes for
    // rotateRefresh; a dead session here still means "no grace, fall through to reused handling".
    return "ended" in result ? { reused: true } : result;
  }

  /** Fix round 2, F2 and F3: one atomic transaction shared by rotateRefresh's internal fallback and
   * rotateRecentlyUsed. Stamps the old token with `graceUsedAt` (condition: not already stamped, its
   * `usedAt` within the window) so at most one grace successor can ever come from a given old token
   * (the security ruling's "two lineages" cap) -- a second grace presentation, or one past the
   * window, is `reused` just like an ordinary replay. The first successor (from the original
   * rotation) is never touched or invalidated by this. */
  private async mintGraceSuccessor(oldTokenHash: string, session: SessionRecord): Promise<{ refreshToken: string } | { reused: true } | { ended: true }> {
    const refreshToken = randomToken("agxr_");
    const at = this.iso();
    const cutoff = new Date(this.input.now() - REFRESH_REUSE_GRACE_SECONDS * 1000).toISOString();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: this.input.tableName, Key: { pk: `REFRESH#${oldTokenHash}`, sk: META }, UpdateExpression: "SET graceUsedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_exists(usedAt) AND usedAt > :cutoff AND attribute_not_exists(graceUsedAt)", ExpressionAttributeValues: { ":at": at, ":cutoff": cutoff } } },
          { Put: { TableName: this.input.tableName, Item: { pk: `REFRESH#${sha256Hex(refreshToken)}`, sk: META, entityType: "REFRESH_TOKEN", sessionId: session.sessionId, expiresAt: session.endsAt }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: { TableName: this.input.tableName, Key: { pk: `SESSION#${session.sessionId}`, sk: META }, UpdateExpression: "SET lastRefreshAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revokedAt) AND endsAt > :now", ExpressionAttributeValues: { ":at": at, ":now": this.seconds() } } },
        ],
      }));
    } catch (error) {
      return this.classifyRotationFailure(error);
    }
    return { refreshToken };
  }

  /** Fix round 2, F4: a cancelled transaction must be read for which item's condition actually
   * failed. ConditionalCheckFailed on index 0 (the old token's check, in both rotateRefresh's own
   * transaction and mintGraceSuccessor's) means reused; on index 2 (the session's check), ended.
   * Anything else (TransactionConflict, throttling, ...) is transient and gets rethrown so the
   * caller can retry, instead of being folded into "reused" and signing the person out. Real
   * DynamoDB always includes CancellationReasons on a cancelled transaction, and FakeDynamoDb now
   * models that too, so a missing array only means a genuinely unmodeled failure -- treated as
   * transient, not reused. */
  private classifyRotationFailure(error: unknown): { reused: true } | { ended: true } {
    if (!conditionFailed(error)) throw error;
    const reasons = cancellationReasons(error);
    if (reasons === undefined) throw error;
    if (reasons[0]?.Code === "ConditionalCheckFailed") return { reused: true };
    if (reasons[2]?.Code === "ConditionalCheckFailed") return { ended: true };
    throw error;
  }

  /**
   * E9 (Q3): sessions that started before `at` end; `revoked` is untouched, so they may sign in again.
   * The end never moves backwards: an older `at` leaves a later end in place and still answers
   * "ended". `at` is stored in toISOString's one format, so the condition's text order is time order.
   */
  async endSessions(developerId: string, at: string): Promise<"ended" | "not_found"> {
    const when = Date.parse(at);
    if (!Number.isFinite(when)) throw new RangeError("endSessions needs a readable time");
    const normalized = new Date(when).toISOString();
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: META },
        UpdateExpression: "SET sessionsEndedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(sessionsEndedAt) OR sessionsEndedAt < :at)",
        ExpressionAttributeValues: { ":at": normalized },
      }));
      return "ended";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // The record exists with a later or equal end, or it does not exist at all.
      return (await this.getDeveloper(developerId)) === undefined ? "not_found" : "ended";
    }
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `SESSION#${sessionId}`, sk: META },
      UpdateExpression: "SET revokedAt = if_not_exists(revokedAt, :at), revokedReason = if_not_exists(revokedReason, :reason)",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":at": this.iso(), ":reason": reason },
    })).catch((error: unknown) => {
      if (!conditionFailed(error)) throw error;
    });
  }
}

function strip<T extends { pk: string; sk: string }>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item as T & { entityType?: string };
  return rest;
}
