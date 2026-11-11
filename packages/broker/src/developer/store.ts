// packages/broker/src/developer/store.ts
// The DeveloperSignIn table (spec 025 FR-005, FR-008). Codes and refresh tokens are stored only as
// SHA-256 hashes. Every expiry is checked here; the table's TTL only cleans up afterwards.
import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError,
  developerOrgKey,
  normalizeEmail,
  DEVELOPER_AUTH_REQUEST_SECONDS,
  DEVELOPER_CODE_SECONDS,
  DEVELOPER_SESSION_SECONDS,
  FRESH_SIGN_IN_SECONDS,
  SetMyNameBodySchema,
  type AuditEventInput,
  type DeveloperSignInMethod,
  type LinkedIdentity,
  SLACK_OIDC_ISSUER,
} from "@agentx/contracts";
import { auditIdentityLinked, auditIdentityUnlinked, auditMemberRenamed, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { chosenNameStatesOf, chosenNameWrite, readChosenName, readNameItems, withChosenName, type ChosenNameItem } from "./chosen-name.js";
import { placeholderDisplayName, readableDeveloper, safeDisplayName } from "./person-name.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { pkceChallengeMatches, randomToken, sha256Hex } from "./tokens.js";

export interface AuthRequestRecord { id: string; clientRedirectUri: string; clientState: string; codeChallenge: string; nonce: string; method?: DeveloperSignInMethod; consumedAt?: string; expiresAt: number; browserReturnTo?: string;
  /** SHA-256 of the invite token in base64url. The raw token is never stored. */
  inviteTokenHash?: string;
  /** "join": the browser join page's sign-in (Plan 2, Task 5); its completion stores a JOIN_RESULT instead of issuing a session or code. */
  purpose?: "join" | "decide_identify";
  /** "decide_identify" (Plan 3, Task 21a-presence): the approval whose confirmation link started this sign-in, which only names the member; it is never fresh. */
  decideApprovalId?: string;
  /**
   * Plan 2, Task 8b: set on the request that adds a removed sign-in method back. `linkDeveloperId` is the only developer it may link to,
   * `linkSessionId` the fresh session of theirs that started it (checked again when the person finishes) and `linkMethod` the one method
   * it is for. Its completion links the identity back and stores nothing else: no session, no code.
   */
  linkDeveloperId?: string; linkSessionId?: string; linkMethod?: DeveloperSignInMethod;
  /** The Slack link, started from the web app: its callback must come from a browser that holds the session `linkSessionId` (its session cookie), or nothing is linked. */
  linkBrowser?: true;
  /** Plan 2, Task 8b: the CLI's fresh sign-in (for changing sign-in methods); the provider is asked to have the person sign in again where it can. */
  fresh?: boolean;
  /** UX1 (OWNER DECISION 5): the browser sign-in came from "Create a company"; only then may a new person's sign-in create one. */
  createCompany?: true;
  /** UX1: where a browser GitHub link returns the person (a fixed choice). */
  linkReturnTo?: "/app" | "/app/onboard" | "/app/admin/connections" }
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
/**
 * Plan 2, Task 8: the marks an unlink (and a later relink) leaves on a developer's record, one attribute per identity or method
 * (see `endedByUnlink`). They are written by the store, never by a profile, and read from the item as stored.
 */
export type DeveloperMarks = {
  [attribute: `sessionsEndedByIdentity#${string}`]: string | undefined;
  [attribute: `identityUnlinked#${string}`]: string | undefined;
  [attribute: `sessionsEndedByMethod#${string}`]: string | undefined;
};
export interface DeveloperRecord extends DeveloperMarks { developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string;
  /** The name others see. Never an email address: a sign-in stores the provider's real name or a placeholder, and a record from before release 0.4.16 reads back safe (`getDeveloper`). */
  displayName: string;
  /** ERASE-NAME-1: when the person's erase cleared the name this record held; a sign-in then leaves the placeholder name alone. */
  nameErasedAt?: string;
  /** True once the person chose their own name (`PUT /v1/app/me/name`); a sign-in then leaves the name alone. False (or absent on an older record): the provider's name or a placeholder. */
  displayNameChosen?: boolean;
  email?: string; slackUserId?: string; firstSignInAt: string; lastSignInAt: string; revoked: boolean; sessionsEndedAt?: string;
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
  linkedAt: string; lastSignInAt: string;
  /** When the provider says the person last authenticated THERE (its `auth_time` claim, as an ISO time never later than the sign-in), when it sends one. `lastSignInAt` is touched at every completed sign-in, a silent single sign-on renewal included; this is not, so it is what a company sign-in counts as a recent sign-in (approval place). Absent: the provider sent none. */
  lastAuthTime?: string;
  unlinkedFrom?: string; unlinkedAt?: string;
  /** Plan 2, Task 8b: set when the person added the identity back: who (the developer, under their fresh session), when, and the method that session signed in with. */
  relinkedBy?: string; relinkedAt?: string; relinkedWith?: DeveloperSignInMethod;
}
/**
 * `authTime` (Plan 2, Task 8b) is when the person signed in interactively (at the provider), as an ISO time. A refresh renews the session
 * and never changes it. A session from before it was recorded has none, and is never fresh.
 */
export interface SessionRecord { sessionId: string; developerId: string; amr: DeveloperSignInMethod; /** The group claims of the company sign-in that started the session (Enterprise foundations N-2): what a mapping change is checked against so it cannot lock its author out. */ groupClaims?: Record<string, unknown>; /** The session came in through the emergency list. */ ssoBreakGlass?: true; slackUserId?: string; identityKey?: string; authTime?: string; startedAt: string; endsAt: number; reviewExpiresAt?: number; lastRefreshAt?: string; revokedAt?: string; revokedReason?: string }

/**
 * Plan 2, Task 8b: whether the person signed in interactively within the last `FRESH_SIGN_IN_SECONDS` (inclusive). A session with no
 * readable `authTime` is not fresh.
 */
export function isFreshSignIn(session: Pick<SessionRecord, "authTime">, nowMs: number): boolean {
  if (session.authTime === undefined) return false;
  const signedIn = Date.parse(session.authTime);
  return Number.isFinite(signedIn) && nowMs - signedIn <= FRESH_SIGN_IN_SECONDS * 1000;
}

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
/**
 * Whether a SAML session is over because of the settings' cutoff (`sessionsValidFrom`, epoch seconds): it started before it, or the person authenticated at the provider before it.
 * The second is what keeps an assertion made before a certificate rotation from starting a session after it: `authTime` is never later than the session's start. An unreadable time
 * is over (fail closed), as in `startedBeforeMethodOn`; a session with no `authTime` is judged by its start.
 */
export function samlSessionEnded(session: { startedAt: string; authTime?: string | undefined }, validFrom: number): boolean {
  return startedBeforeMethodOn(session.startedAt, validFrom) || (session.authTime !== undefined && startedBeforeMethodOn(session.authTime, validFrom));
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

interface CodeRecord { developerId: string; amr: DeveloperSignInMethod; groupClaims?: Record<string, unknown>; ssoBreakGlass?: true; slackUserId?: string; identityKey?: string; authTime?: string; /** The session this code starts ends at this time (epoch seconds): the edition's sign-in cap (Enterprise foundations I1). */ sessionEndsAt?: number; codeChallenge: string; redirectUri: string; expiresAt: number; usedAt?: string }
interface RefreshRecord { sessionId: string; expiresAt: number; usedAt?: string; graceUsedAt?: string }
interface CancellationReason { Code?: string }

export const META = "META";
/** A relink refused by its own rules (CONFIG_INVALID) or by a race on its transaction. */
const conditionFailedOrRefused = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "CONFIG_INVALID" || conditionFailed(error);
/** How many sign-in records a list reads at once (`getDevelopers`). */
const RECORD_READS_AT_ONCE = 16;

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
 * listed (the table has no index of them); the unlink marks the developer's record instead, and every session check reads the marks.
 * A session that recorded its identity is ended for as long as `identityUnlinked#<identityKey>` is present, whenever it started: an
 * unlinked identity can never be active for this developer again, and a session created from a link read just before the unlink
 * (a sign-in that was already running) starts after the mark yet must not live. Linking the identity again removes that mark and
 * leaves `sessionsEndedByIdentity#<identityKey>` as the link time, so sessions from before the link stay ended and later ones live.
 * A session from before sessions recorded their identity is ended by method (`sessionsEndedByMethod#<provider>`), by start time. The
 * marks are separate attributes, so one unlink is one atomic update beside the unlink itself, and no new kind of access to the table.
 */
export const identitySessionsEndedAttribute = (identityKey: string): `sessionsEndedByIdentity#${string}` => `sessionsEndedByIdentity#${identityKey}`;
export const identityUnlinkedAttribute = (identityKey: string): `identityUnlinked#${string}` => `identityUnlinked#${identityKey}`;
export const methodSessionsEndedAttribute = (provider: DeveloperSignInMethod): `sessionsEndedByMethod#${string}` => `sessionsEndedByMethod#${provider}`;
/** Whether the person unlinked this session's sign-in method after the session started (or, for its identity, at all since). `developer` is the developer record as stored. */
export function endedByUnlink(session: Pick<SessionRecord, "startedAt" | "amr" | "identityKey">, developer: DeveloperMarks): boolean {
  if (session.identityKey !== undefined) {
    if (typeof developer[identityUnlinkedAttribute(session.identityKey)] === "string") return true;
    const relinked = developer[identitySessionsEndedAttribute(session.identityKey)];
    return typeof relinked === "string" && endedByAdmin(session.startedAt, relinked);
  }
  const mark = developer[methodSessionsEndedAttribute(session.amr)];
  return typeof mark === "string" && endedByAdmin(session.startedAt, mark);
}
/** Refusals of an unlink, in the person's words. */
export const UNLINK_ONLY_IDENTITY = "this is your only way to sign in, so it can't be removed";
export const UNLINK_FIRST_IDENTITY = "this is the sign-in your account was created with, so it can't be removed";
/** Plan 2, Task 8b: changing the sign-in methods needs a fresh sign-in (REAUTH_REQUIRED), with a method that is not the one being removed. */
export const REAUTH_TO_CHANGE_METHODS = "to change your sign-in methods, sign in again first with a method you are keeping, then try again";
export const REAUTH_SAME_METHOD = "you are signed in with the method you are removing; sign in again with a different method first, then try again";
/** Refusals of adding a removed sign-in method back, in the person's words. */
export const RELINK_NOT_REMOVED = "that sign-in was not removed from your account, so it cannot be added back here";
export const RELINK_OWN_ACCOUNT = "that sign-in has since started its own account, so it cannot be added back to this one";
export const RELINK_ALREADY = "that sign-in is already part of your account";
/** The account record's marker of its one Slack link (the identity key), written in the link's own transaction and removed by the unlink. */
export const SLACK_LINKED_ATTRIBUTE = "slackLinkedIdentity";
/** UX1: the same one-per-account marker for a GitHub account linked from the web app, so two simultaneous links end with one. */
export const GITHUB_LINKED_ATTRIBUTE = "githubLinkedIdentity";
export const GITHUB_LINK_HAS_ONE = "a GitHub account is already linked to your account";
/** UX1: why a Slack account cannot be linked yet: the company has no Slack workspace connected (the next step is the operator's). */
export const SLACK_NO_WORKSPACE_MESSAGE = "Your company hasn't connected a Slack workspace to Rovara yet, so there is no workspace to link your Slack account to. Ask a company owner to contact Rovara support to connect your Slack workspace, then link your account here.";
/** Refusals of linking a Slack account to a web account, in the person's words. */
export const SLACK_LINK_TAKEN = "that Slack account already belongs to another Rovara account, so it can't be linked to this one";
export const SLACK_LINK_HAS_ONE = "a Slack account is already linked to your account; remove it first to link another";
export const SLACK_LINK_CHANGED = "your sign-in methods changed while this ran; check them and try again";
/** The name a person chose, as `SetMyNameBodySchema` allows it, or undefined. */
const safeChosenName = (name: string): string | undefined => {
  const parsed = SetMyNameBodySchema.safeParse({ name });
  return parsed.success ? parsed.data.name : undefined;
};

/** A name chosen while an erase was being written: the person's details were just erased, and the name was not saved. */
export const NAME_ERASED_MESSAGE = "your details were just erased, so this name was not saved; choose a name again";
/** ERASED-REJOIN-NAME: the name a person tries to choose is the one they were erased under. Their old history stays anonymous, so it can't be linked to them again by that name. */
export const NAME_WAS_ERASED_MESSAGE = "that is the name you had before your details were erased; choose a different name (your earlier work stays under \"A former member\")";

const conditionFailed = (error: unknown) =>
  error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/** Real DynamoDB always populates this on a cancelled TransactWriteItems, one entry per
 * TransactItem, ordered the same way, "None" for items not implicated (fix round 2, F4: FakeDynamoDb
 * now models this too, so there is no other case to fall back to). */
function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  const reasons = (error as { CancellationReasons?: unknown } | null)?.CancellationReasons;
  return Array.isArray(reasons) ? (reasons as CancellationReason[]) : undefined;
}

/**
 * Why `link` cannot be added back to `developerId` (Plan 2, Task 8b), or undefined when it is that developer's tombstone: unlinked from
 * them and still pointing at them, so nobody has linked it anywhere since.
 */
function relinkRefusal(link: IdentityLinkRecord | undefined, identityKey: string, developerId: string, provider: DeveloperSignInMethod): string | undefined {
  if (link === undefined || link.provider !== provider) return RELINK_NOT_REMOVED;
  if (isActiveLink(link, identityKey)) {
    if (link.developerId === developerId && link.unlinkedFrom === undefined) return RELINK_ALREADY;
    // Signed in on its own after it was removed: it is its own developer now, and a developer is never merged into another here.
    return link.developerId === identityKey && link.unlinkedFrom === developerId ? RELINK_OWN_ACCOUNT : RELINK_NOT_REMOVED;
  }
  return link.unlinkedFrom === developerId && link.developerId === developerId ? undefined : RELINK_NOT_REMOVED;
}

export class DeveloperSignInStore {
  constructor(private readonly input: {
    documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number;
    /** The Audit Ledger's outbox (Task 18): a sign-in method linked or unlinked is recorded in the transaction that does it. Absent on a legacy install. */
    audit?: AuditRuntime;
    /**
     * Release 0.4.18: the State table, where the name a person chose is kept (`chosen-name.ts`). The broker passes it: `getDeveloper` and `getDevelopers` then show the chosen
     * name, and `setChosenDisplayName` writes it. The sign-in function leaves it out (it has no grant on that item) and reads the sign-in record's name.
     */
    nameTableName?: string;
    /**
     * SLACK-LINK-1: the State table, named only so that linking a Slack or GitHub account can include a ConditionCheck on the State table's developer-to-company pointer
     * (`DEVELOPER_ORG#<identity key>` must not exist) in the link's own transaction, which makes "the account holds no company" and the link one atomic write. The
     * company side of the same fence is `OrgStore`'s `signInTableName`. Unlike `nameTableName` it reads no name: the sign-in function passes it and needs the ConditionCheckItem
     * grant on `DEVELOPER_ORG#*`, plus the GetItem it already has there (a lost link reads the pointer once to say why it was refused). Absent: the link keeps only its
     * read-then-write check (a test with two unrelated tables).
     */
    stateTableName?: string;
    /**
     * ERASED-REJOIN-NAME: whether `name` is the name an erased person was known by (compared as keyed hashes, so nothing readable is kept; ask-erased-aliases.ts `erasedNameIsChosenAgain`). Asked only
     * when the person has an erase tombstone. Absent (or it answers false): the new name is accepted. A throw refuses the choice: when it cannot be settled, the old name is not let back in.
     */
    erasedNameCheck?: (developerId: string, name: string) => Promise<boolean>;
  }) {}

  private seconds(): number { return Math.floor(this.input.now() / 1000); }
  private iso(): string { return new Date(this.input.now()).toISOString(); }

  private auditDeps(): { audit?: AuditRuntime } {
    return this.input.audit === undefined ? {} : { audit: this.input.audit };
  }

  /**
   * The audit event for a sign-in method linked to or unlinked from a developer, or undefined when this install has no ledger or the
   * developer belongs to no org (a person's first sign-in: the chain is an org's, and there is none yet). The org is read from the
   * developer's `DEVELOPER_ORG#` pointer in the State table. A failed read or a bad event is logged and never stops the sign-in.
   */
  private async identityEvent(kind: "linked" | "unlinked", input: { identityKey: string; developerId: string; provider: DeveloperSignInMethod; at: string }): Promise<AuditEventInput | undefined> {
    const audit = this.input.audit;
    if (audit === undefined) return undefined;
    const [event] = await tryAuditEvents(this.auditDeps(), async () => {
      const pointer = await this.input.documentClient.send(new GetCommand({ TableName: audit.tableName, Key: developerOrgKey(input.developerId), ConsistentRead: true })) as { Item?: { orgId?: unknown } };
      const orgId = pointer.Item?.orgId;
      if (typeof orgId !== "string") return [];
      const facts = {
        orgId, actor: { kind: "member" as const, id: input.developerId }, occurredAt: input.at, occurrence: auditOccurrence(input.identityKey, input.at),
        memberId: input.developerId, provider: input.provider,
      };
      return [kind === "linked" ? auditIdentityLinked(facts) : auditIdentityUnlinked(facts)];
    });
    return event;
  }

  private pendingFor(event: AuditEventInput | undefined): TransactItem[] {
    return event === undefined ? [] : auditPending(this.auditDeps(), event);
  }

  private async flush(event: AuditEventInput | undefined): Promise<void> {
    if (event !== undefined) await flushAuditEvents(this.auditDeps(), [event]);
  }

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

  async upsertDeveloper(profile: Omit<DeveloperRecord, "firstSignInAt" | "lastSignInAt" | "revoked" | "displayNameChosen">): Promise<DeveloperRecord> {
    // One atomic update, not a read-then-overwrite: a concurrent revocation (or another sign-in)
    // must never be clobbered by this call. firstSignInAt and revoked are set only if absent;
    // revoked in particular must never flip true back to false (fix round 1, F3).
    const at = this.iso();
    // Release 0.4.16: whatever the provider calls the person (the email-code sign-in calls them by their address), no email is stored as a name.
    const displayName = safeDisplayName(profile.displayName, profile.developerId);
    const setClauses = [
      "entityType = :entityType",
      "provider = :provider",
      "issuer = :issuer",
      "subject = :subject",
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
      ":at": at,
      ":false": false,
    };
    if (profile.email === undefined) removeClauses.push("email");
    else { setClauses.push("email = :email"); values[":email"] = profile.email; }
    if (profile.slackUserId === undefined) removeClauses.push("slackUserId");
    else { setClauses.push("slackUserId = :slackUserId"); values[":slackUserId"] = profile.slackUserId; }

    const update = async (withName: boolean) => this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName,
      Key: { pk: `DEVELOPER#${profile.developerId}`, sk: META },
      UpdateExpression: `SET ${[...setClauses, ...(withName ? ["displayName = :displayName", "displayNameChosen = :notChosen"] : [])].join(", ")}${removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(", ")}` : ""}`,
      // A name the person chose is theirs: the sign-in writes the provider's name only while they have not chosen one. The check is part of the write, so a
      // choice made while this sign-in is in flight is never overwritten either.
      // ERASE-NAME-1: a record whose name was erased (`nameErasedAt`) keeps the placeholder: a sign-in never writes the provider's name back.
      ...(withName ? { ConditionExpression: "(attribute_not_exists(displayNameChosen) OR displayNameChosen = :notChosen) AND attribute_not_exists(nameErasedAt)" } : {}),
      ExpressionAttributeValues: { ...values, ...(withName ? { ":displayName": displayName, ":notChosen": false } : {}) },
    }));
    try {
      await update(true);
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      await update(false);
    }
    if (profile.email !== undefined) {
      // E8 (Q4): the latest sign-in with this verified email wins; the email itself is not stored here.
      await this.put({ ...emailIndexKey(profile.email), entityType: "DEVELOPER_EMAIL", developerId: profile.developerId, updatedAt: at });
    }
    const stored = await this.getDeveloper(profile.developerId);
    if (stored === undefined) throw new Error("developer upsert did not persist");
    return stored;
  }

  /**
   * Release 0.4.16: the person chooses their own name. `developerId` is the verified session's, never anything a request carries. The name was validated at the
   * route (`SetMyNameBodySchema`) and is checked again here, so no other caller can store an email as a name. Marks the name chosen, so a sign-in leaves it alone,
   * and records `member.renamed` (no name in the record) in the same transaction as the change.
   *
   * Release 0.4.18: the name is an item of its own in the State table (`DEVELOPER_NAME#<id>`), written in one transaction with a ConditionCheck on the person's sign-in
   * record (not revoked, not merged) and the audit's pending item. The broker has no write on the sign-in table, only the read and the ConditionCheckItem it already had.
   */
  async setChosenDisplayName(input: { developerId: string; orgId: string; name: string }): Promise<DeveloperRecord> {
    const name = safeChosenName(input.name);
    if (name === undefined) throw agentXError("CONFIG_INVALID", "name: give a name of 1 to 80 characters, with no email address");
    const nameTable = this.input.nameTableName;
    if (nameTable === undefined) throw new Error("the chosen-name table is not configured");
    const at = this.iso();
    // The name already chosen again changes nothing, so it writes and audits nothing.
    const current = await this.getDeveloper(input.developerId);
    if (current === undefined) throw agentXError("NOT_FOUND", "your sign-in record was not found; sign in again");
    if (current.displayNameChosen === true && current.displayName === name) return current;
    const [event] = await tryAuditEvents(this.auditDeps(), () => [auditMemberRenamed({
      orgId: input.orgId, actor: { kind: "member", id: input.developerId }, occurredAt: at, occurrence: auditOccurrence(input.developerId, at), memberId: input.developerId,
    })]);
    const signInCheck = 1;
    const nameCheck = 0;
    // ERASED-REJOIN-NAME: a person who was erased may choose a name for the new membership. The tombstone stays in the item (the write keeps it); the name they were erased under is refused.
    const existing = (await readNameItems(this.input.documentClient, nameTable, [input.developerId])).get(input.developerId);
    if (existing?.erased === true && this.input.erasedNameCheck !== undefined && await this.input.erasedNameCheck(input.developerId, name)) throw agentXError("FORBIDDEN", NAME_WAS_ERASED_MESSAGE);
    const write = chosenNameWrite(existing, input.developerId, name, at);
    try {
      await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: [
        // ERASE-NAME-1: the condition keeps an erase that lands in between (a new tombstone) from being overwritten by this name.
        { Put: { TableName: nameTable, Item: write.item, ConditionExpression: write.condition, ...(write.values === undefined ? {} : { ExpressionAttributeValues: write.values }) } },
        // A person whose sign-in was turned off, or who was merged into another developer, cannot rename (a revocation landing after the session check is caught here).
        // The check is on the sign-in record, which this transaction only reads.
        { ConditionCheck: {
          TableName: this.input.tableName, Key: { pk: `DEVELOPER#${input.developerId}`, sk: META },
          ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(revoked) OR revoked = :false) AND attribute_not_exists(mergedInto)",
          ExpressionAttributeValues: { ":false": false },
        } },
        ...this.pendingFor(event),
      ] }));
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
        if (reasons?.[nameCheck]?.Code === "ConditionalCheckFailed") throw agentXError("FORBIDDEN", NAME_ERASED_MESSAGE);
        if (reasons?.[signInCheck]?.Code === "ConditionalCheckFailed") throw agentXError("FORBIDDEN", "your sign-in can't change its name now; sign in again");
        throw error;
      }
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw agentXError("FORBIDDEN", "your sign-in can't change its name now; sign in again");
      throw error;
    }
    await this.flush(event);
    const stored = await this.getDeveloper(input.developerId);
    if (stored === undefined) throw agentXError("NOT_FOUND", "your sign-in record was not found; sign in again");
    return stored;
  }

  /** The developer's record. Its name reads back safe to show: a name stored as an email (a record from before release 0.4.16) is the placeholder. */
  async getDeveloper(developerId: string): Promise<DeveloperRecord | undefined> {
    const nameTable = this.input.nameTableName;
    // The name a person chose (release 0.4.18) is read beside the record, and shows instead of the record's name.
    const [item, chosen] = await Promise.all([
      this.get<DeveloperRecord>(`DEVELOPER#${developerId}`),
      nameTable === undefined ? Promise.resolve(undefined) : readChosenName(this.input.documentClient, nameTable, developerId),
    ]);
    // The id is the item's key: a sign-in writes no `developerId` attribute, so the record's own field is absent on every real item.
    return item === undefined ? undefined : readableDeveloper(withChosenName({ ...strip(item), developerId }, chosen));
  }

  /**
   * Many developers' records for a list (members, cards): the records one read each, in parallel (the broker has no batch read on this table), and the chosen names
   * of all of them in one BatchGetItem per 100. A person with no record is missing from the map.
   */
  async getDevelopers(developerIds: readonly string[]): Promise<Map<string, DeveloperRecord>> {
    return (await this.getDevelopersWithNameItems(developerIds)).records;
  }

  /**
   * `getDevelopers`, also handing back the name items it read (developerId to the raw item, for those who have one), so a list that must also settle who is erased or removed
   * (`replacementNamesFrom`, name-resolver.ts) does it from the same BatchGetItem.
   */
  async getDevelopersWithNameItems(developerIds: readonly string[]): Promise<{ records: Map<string, DeveloperRecord>; nameItems: Map<string, ChosenNameItem> }> {
    const unique = [...new Set(developerIds)];
    const nameTable = this.input.nameTableName;
    // At most a few reads at a time, as the routes' lists did when they read the records one by one.
    const read = async (): Promise<Array<(DeveloperRecord & { pk: string; sk: string }) | undefined>> => {
      const found: Array<(DeveloperRecord & { pk: string; sk: string }) | undefined> = [];
      for (let start = 0; start < unique.length; start += RECORD_READS_AT_ONCE) {
        found.push(...await Promise.all(unique.slice(start, start + RECORD_READS_AT_ONCE).map((developerId) => this.get<DeveloperRecord>(`DEVELOPER#${developerId}`))));
      }
      return found;
    };
    const [items, nameItems] = await Promise.all([
      read(),
      nameTable === undefined ? Promise.resolve(new Map<string, ChosenNameItem>()) : readNameItems(this.input.documentClient, nameTable, unique),
    ]);
    const chosen = new Map([...chosenNameStatesOf(nameItems)].map(([developerId, state]) => [developerId, state.name] as const));
    const records = new Map<string, DeveloperRecord>();
    unique.forEach((developerId, index) => {
      const item = items[index];
      if (item !== undefined) records.set(developerId, readableDeveloper(withChosenName({ ...strip(item), developerId }, chosen.get(developerId))));
    });
    return { records, nameItems };
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
    // An identity that was unlinked from this developer and now links to it again stops being ended by that unlink: the mark that ended
    // every session of the identity goes in the same transaction, and sessions from before the link stay ended by its time.
    const marked = current === undefined ? undefined : await this.getDeveloper(developerId);
    const clearsUnlink = marked !== undefined && marked[identityUnlinkedAttribute(identityKey)] !== undefined;
    // R1-5: a transaction cannot say whether it created the link, so the audited attempt is create-only: it writes only where nothing is
    // linked, or over the identity's own tombstone. When that fails the link was made by someone else meanwhile (or is the same developer's
    // already): the read below answers `created: false` and nothing is recorded.
    const event = await this.identityEvent("linked", { identityKey, developerId, provider: input.provider, at });
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...(clearsUnlink ? [{ Update: {
            TableName: this.input.tableName, Key: { pk: `DEVELOPER#${developerId}`, sk: META }, UpdateExpression: "SET #ended = :at REMOVE #unlinked",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: { "#ended": identitySessionsEndedAttribute(identityKey), "#unlinked": identityUnlinkedAttribute(identityKey) },
            ExpressionAttributeValues: { ":at": at },
          } }] : []),
          { Put: {
            TableName: this.input.tableName, Item: { ...signInIdentityKey(identityKey), ...body },
            // Writes when nothing is linked, or (for the identity's own developer) over an item that was unlinked. Audited: only those two.
            ...(event === undefined
              ? {
                ConditionExpression: `attribute_not_exists(pk) OR (developerId = :d AND attribute_not_exists(unlinkedFrom))${own ? " OR attribute_exists(unlinkedFrom)" : ""}`,
                ExpressionAttributeValues: { ":d": developerId },
              }
              // Over a tombstone, only the tombstone that was read: the item keeps `unlinkedFrom` when the identity links to its own developer, so a
              // second link racing the first would pass `attribute_exists(unlinkedFrom)` and record the link again. Its `developerId` has moved.
              : current === undefined
                ? { ConditionExpression: "attribute_not_exists(pk)" }
                : { ConditionExpression: "attribute_exists(unlinkedFrom) AND developerId = :prev", ExpressionAttributeValues: { ":prev": current.developerId } }),
          } },
          { Put: { TableName: this.input.tableName, Item: { ...developerIdentityKey(developerId, identityKey), ...body } } },
          ...this.pendingFor(event),
        ],
      }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // Another sign-in linked this identity first: read what it wrote.
      const winner = this.settledLink(await this.getIdentityLink(identityKey), identityKey, developerId, own);
      if (winner === undefined) throw error;
      return winner;
    }
    await this.flush(event);
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

  /**
   * Plan 3, Task 21a-presence (R7-2): the addresses a decision's email code may go to, most recently used first. Only a linked identity's
   * own address counts, and a provider hands the sign-in an address only when it vouches for it (ProviderIdentity.email is the verified
   * email), so every stored `email` is a verified one; an address that is not plain ASCII (normalizeEmail's `ascii`) never qualifies.
   * Whether the member has an email-code user is Cognito's answer (the pool user for that address), never a link's provider: a Google
   * sign-in through the pool is also a `cloud` link.
   */
  async decideEmailsOf(developerId: string): Promise<{ emails: string[] }> {
    const identities = await this.activeIdentityItems(developerId);
    const seen = new Set<string>();
    const emails = identities
      .filter((link) => link.email !== undefined && normalizeEmail(link.email).ascii)
      .sort((left, right) => right.lastSignInAt.localeCompare(left.lastSignInAt) || right.linkedAt.localeCompare(left.linkedAt))
      .map((link) => normalizeEmail(link.email!).email)
      .filter((email) => !seen.has(email) && seen.add(email));
    return { emails };
  }

  /** Plan 6 Task 14: the GitHub account (its numeric id) the developer signs in with, or undefined. For the org's member link; the subject goes no further than that. */
  async githubUserIdOf(developerId: string): Promise<string | undefined> {
    const link = (await this.activeIdentityItems(developerId)).find((entry) => entry.provider === "github");
    return link !== undefined && /^[1-9][0-9]{0,19}$/.test(link.subject) ? link.subject : undefined;
  }

  /** The Slack user ids (`U...`) of the developer's linked Slack sign-ins. For the Team record's person erase, which must reach the Slack rows the person wrote; the ids go no further than that. */
  async slackUserIdsOf(developerId: string): Promise<string[]> {
    return [...new Set((await this.activeIdentityItems(developerId)).filter((link) => link.provider === "slack" && /^[UW][A-Z0-9]{2,31}$/.test(link.subject)).map((link) => link.subject))];
  }

  /** The developer a Slack user id signed in as (the forward link of the Slack sign-in identity), or undefined. For the Team record: a Slack message is stored only for an author linked to a person. */
  async developerOfSlackUser(slackUserId: string): Promise<string | undefined> {
    if (!/^[UW][A-Z0-9]{2,31}$/.test(slackUserId)) return undefined;
    const link = await this.getIdentityLink(ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId));
    return link === undefined || (link.unlinkedFrom !== undefined && link.developerId !== ownerKeyForSubject(SLACK_OIDC_ISSUER, slackUserId)) ? undefined : link.developerId;
  }

  /**
   * Approval place (U4, A-09): when the person last signed in INTERACTIVELY to Rovara by one of `methods`, as an ISO time, or undefined. Per active identity link of those methods the time is:
   *   - an email-code sign-in (`cloud`): `lastSignInAt`, written at a completed sign-in and never by a refresh (the person typed a fresh code);
   *   - a company sign-in (`oidc`, `saml`): `lastAuthTime`, the provider's own `auth_time`, because `lastSignInAt` is touched by a silent single sign-on renewal too. A provider that sent no `auth_time` leaves none, and then the sign-in
   *     does not count: the person is asked to sign in again (fail closed).
   * Any other method counts `lastSignInAt` (the caller's list decides what counts at all; Slack and GitHub are not in it: decision Q3). An unlinked identity does not count (`activeIdentityItems`); an unreadable time is skipped.
   */
  async lastInteractiveSignInAt(developerId: string, methods: readonly DeveloperSignInMethod[]): Promise<string | undefined> {
    let newest: { at: number; iso: string } | undefined;
    for (const link of await this.activeIdentityItems(developerId)) {
      if (!methods.includes(link.provider)) continue;
      const stamp = link.provider === "oidc" || link.provider === "saml" ? link.lastAuthTime : link.lastSignInAt;
      if (stamp === undefined) continue;
      const at = Date.parse(stamp);
      if (!Number.isFinite(at)) continue;
      if (newest === undefined || at > newest.at) newest = { at, iso: new Date(at).toISOString() };
    }
    return newest?.iso;
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
   * Only the caller's own developer is ever touched. It needs a fresh sign-in (`freshSessionFor`), with a method that is not the one removed.
   * Returns the (first) identity key removed.
   */
  async unlinkIdentity(input: { developerId: string; sessionId: string; provider: DeveloperSignInMethod; now?: number }): Promise<{ identityKey: string }> {
    const { developerId, provider } = input;
    const active = await this.activeIdentityItems(developerId);
    const targets = active.filter((link) => link.provider === provider);
    if (targets.length === 0) throw agentXError("NOT_FOUND", "that sign-in method is not linked to your account");
    if (active.length - targets.length < 1) throw agentXError("CONFIG_INVALID", UNLINK_ONLY_IDENTITY);
    const keys = targets.map((link) => link.sk.slice("IDENTITY#".length));
    if (keys.includes(developerId)) throw agentXError("CONFIG_INVALID", UNLINK_FIRST_IDENTITY);
    // Only a removal that could go through asks for a fresh sign-in: the session must have signed in within ten minutes, with a method that stays.
    await this.freshSessionFor({ developerId, sessionId: input.sessionId, removing: provider });
    const at = new Date(input.now ?? this.input.now()).toISOString();
    const TableName = this.input.tableName;
    const merged = new Map<string, string | undefined>();
    for (const key of keys) merged.set(key, key === developerId ? undefined : (await this.getDeveloper(key))?.mergedInto);
    for (const [index, link] of targets.entries()) {
      const identityKey = keys[index]!;
      const mergedAway = (key: string): boolean => merged.get(key) === developerId;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the reverse item's keys
      const { pk: _pk, sk: _sk, entityType: _type, ...fields } = link as typeof link & { pk: string; entityType?: string };
      const event = await this.identityEvent("unlinked", { identityKey, developerId, provider: link.provider, at });
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
              // Project AI commits pin method marks, not each identity mark. Every unlink must set #method atomically; review that fence if this changes.
              TableName, Key: { pk: `DEVELOPER#${developerId}`, sk: META },
              // The Slack link's one-per-account marker goes with the link.
              UpdateExpression: `SET #identity = :at, #unlinked = :at, #method = :at${link.provider === "slack" || link.provider === "github" ? " REMOVE #linkedMarker" : ""}`,
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#identity": identitySessionsEndedAttribute(identityKey), "#unlinked": identityUnlinkedAttribute(identityKey), "#method": methodSessionsEndedAttribute(link.provider), ...(link.provider === "slack" ? { "#linkedMarker": SLACK_LINKED_ATTRIBUTE } : link.provider === "github" ? { "#linkedMarker": GITHUB_LINKED_ATTRIBUTE } : {}) },
              ExpressionAttributeValues: { ":at": at },
            } },
            // An identity merged in by rule 1b is keyed to the developer that was merged away. Unlinked, it starts that developer again
            // (rule 3), so the record stops saying the developer went into the survivor.
            ...(mergedAway(identityKey) ? [{ Update: {
              TableName, Key: { pk: `DEVELOPER#${identityKey}`, sk: META }, UpdateExpression: "REMOVE mergedInto, mergedAt",
              ConditionExpression: "mergedInto = :d", ExpressionAttributeValues: { ":d": developerId },
            } }] : []),
            ...this.pendingFor(event),
          ],
        }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
        throw agentXError("CONFIG_INVALID", "your sign-in methods changed while this ran; check them with agentx whoami and try again");
      }
      await this.flush(event);
    }
    return { identityKey: keys[0]! };
  }

  /**
   * Plan 2, Task 8b: the session `sessionId` of `developerId`, when it proves a fresh sign-in for changing that developer's sign-in
   * methods; otherwise REAUTH_REQUIRED with what to do. Fresh means: the session is the developer's and still live (not revoked, expired,
   * ended by an admin or by an unlink, the developer not revoked), the person signed in interactively within `FRESH_SIGN_IN_SECONDS`
   * (a refresh renewal does not count: `authTime` never changes), and, when a method is being removed, the session was not made with it.
   */
  async freshSessionFor(input: { developerId: string; sessionId: string; removing?: DeveloperSignInMethod }): Promise<SessionRecord> {
    const session = await this.getSession(input.sessionId);
    const developer = session === undefined || session.developerId !== input.developerId ? undefined : await this.getDeveloper(input.developerId);
    if (session === undefined || developer === undefined || session.revokedAt !== undefined || session.endsAt <= this.seconds() || developer.revoked
      || endedByAdmin(session.startedAt, developer.sessionsEndedAt) || endedByUnlink(session, developer)) {
      throw agentXError("REAUTH_REQUIRED", REAUTH_TO_CHANGE_METHODS);
    }
    if (input.removing !== undefined && session.amr === input.removing) throw agentXError("REAUTH_REQUIRED", REAUTH_SAME_METHOD);
    if (!isFreshSignIn(session, this.input.now())) throw agentXError("REAUTH_REQUIRED", REAUTH_TO_CHANGE_METHODS);
    return session;
  }

  /**
   * Plan 2, Task 8b: adds a sign-in identity back to the developer it was unlinked from, in one transaction: the link item replaces its
   * tombstone (no `unlinkedFrom`; `relinkedBy`, `relinkedAt` and `relinkedWith` say who and when), the reverse item is written, and the
   * developer's record loses the unlink mark and keeps `sessionsEndedByIdentity#<identityKey>` as the link time, so the identity's sessions
   * from before stay ended. The caller has checked that `developerId` has a fresh session (`freshSessionFor`). Only a tombstone that
   * names this developer is relinked: an identity that was never removed, was removed from another developer, or has since started its own
   * account is refused, and nothing is written. Never goes through `linkIdentity`, whose rule for an unlinked identity stays as it was.
   */
  async relinkIdentity(input: { identityKey: string; developerId: string; provider: DeveloperSignInMethod; issuer: string; subject: string; email?: string; login?: string; by: { method: DeveloperSignInMethod } }): Promise<{ developerId: string }> {
    const { identityKey, developerId } = input;
    const refusal = relinkRefusal(await this.getIdentityLink(identityKey), identityKey, developerId, input.provider);
    if (refusal !== undefined) throw agentXError("CONFIG_INVALID", refusal);
    const at = this.iso();
    const body = {
      entityType: "IDENTITY_LINK", developerId, provider: input.provider, issuer: input.issuer, subject: input.subject,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.login === undefined ? {} : { login: input.login }),
      linkedAt: at, lastSignInAt: at, relinkedBy: developerId, relinkedAt: at, relinkedWith: input.by.method,
    };
    const marker = input.provider === "slack" ? SLACK_LINKED_ATTRIBUTE : input.provider === "github" ? GITHUB_LINKED_ATTRIBUTE : undefined;
    const TableName = this.input.tableName;
    const event = await this.identityEvent("linked", { identityKey, developerId, provider: input.provider, at });
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Update: {
            TableName, Key: { pk: `DEVELOPER#${developerId}`, sk: META },
            // A Slack link comes back with its one-per-account marker, and only while the account has no other Slack link.
            // A Slack or GitHub link comes back with its one-per-account marker (UX1 review M2), and only while the account has no other link of it.
            UpdateExpression: `SET #ended = :at${marker === undefined ? "" : ", #linkedMarker = :identityKey"} REMOVE #unlinked`,
            ConditionExpression: marker === undefined ? "attribute_exists(pk)" : "attribute_exists(pk) AND attribute_not_exists(#linkedMarker)",
            ExpressionAttributeNames: { "#ended": identitySessionsEndedAttribute(identityKey), "#unlinked": identityUnlinkedAttribute(identityKey), ...(marker === undefined ? {} : { "#linkedMarker": marker }) },
            ExpressionAttributeValues: { ":at": at, ...(marker === undefined ? {} : { ":identityKey": identityKey }) },
          } },
          { Put: {
            TableName, Item: { ...signInIdentityKey(identityKey), ...body },
            ConditionExpression: "developerId = :d AND unlinkedFrom = :d", ExpressionAttributeValues: { ":d": developerId },
          } },
          { Put: { TableName, Item: { ...developerIdentityKey(developerId, identityKey), ...body } } },
          ...this.pendingFor(event),
        ],
      }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // Something moved between the read and the write: say what, when the identity's link now shows it.
      const now = relinkRefusal(await this.getIdentityLink(identityKey), identityKey, developerId, input.provider);
      throw agentXError("CONFIG_INVALID", now ?? "your sign-in methods changed while this ran; check them with agentx whoami and try again");
    }
    await this.flush(event);
    return { developerId };
  }


  /**
   * Links a Slack account (verified by Sign in with Slack, by the caller) to the web account `developerId`: a verified identity link of this
   * table, the same items sign-in and the duplicate merge write, in one transaction with the audit item. The Slack account's own
   * developer, if it ever signed in, is merged into the account (so no session of it outlives the link). Never merges two accounts that
   * each hold a company: `belongsToCompany` says whether the Slack account's own developer already does. Refuses (as an outcome, nothing written):
   * `taken` (the identity is linked to another account, was unlinked from another, or its own developer holds a company or was merged
   * elsewhere), `has_one` (the account already has an active Slack link), `changed` (it moved while this ran). The same account may link
   * the identity again after unlinking it (the tombstone is relinked, as for any removed method).
   */
  async linkSlackIdentity(input: { developerId: string; identityKey: string; subject: string; issuer: string; email?: string; by: { method: DeveloperSignInMethod }; belongsToCompany: boolean }): Promise<{ ok: true; created: boolean } | { ok: false; reason: "taken" | "has_one" | "changed" }> {
    return this.linkVerifiedIdentity("slack", input);
  }

  /**
   * UX1: links a GitHub account (verified at GitHub just now, by the caller) to the web account `developerId`, by the same rules as `linkSlackIdentity`: never an
   * account that is someone else's (linked to another account, unlinked from another, or its own developer holds a company or was merged elsewhere), one GitHub
   * account per account, and the GitHub account's own developer (if it signed in once and holds no company) is merged in.
   */
  async linkGithubIdentity(input: { developerId: string; identityKey: string; subject: string; issuer: string; email?: string; login?: string; by: { method: DeveloperSignInMethod }; belongsToCompany: boolean }): Promise<{ ok: true; created: boolean } | { ok: false; reason: "taken" | "has_one" | "changed" }> {
    return this.linkVerifiedIdentity("github", input);
  }

  private async linkVerifiedIdentity(provider: "slack" | "github", input: { developerId: string; identityKey: string; subject: string; issuer: string; email?: string; login?: string; by: { method: DeveloperSignInMethod }; belongsToCompany: boolean }): Promise<{ ok: true; created: boolean } | { ok: false; reason: "taken" | "has_one" | "changed" }> {
    const { developerId, identityKey } = input;
    const marker = provider === "slack" ? SLACK_LINKED_ATTRIBUTE : GITHUB_LINKED_ATTRIBUTE;
    const login = provider === "github" && input.login !== undefined ? { login: input.login } : {};
    if (identityKey === developerId) return { ok: false, reason: "taken" };
    const [current, duplicate, account, held] = await Promise.all([this.getIdentityLink(identityKey), this.getDeveloper(identityKey), this.getDeveloper(developerId), this.activeIdentityItems(developerId)]);
    if (account === undefined || account.revoked || account.mergedInto !== undefined) return { ok: false, reason: "changed" };
    if (current !== undefined && isActiveLink(current, identityKey) && current.developerId === developerId) return { ok: true, created: false };
    if (held.some((link) => link.provider === provider)) return { ok: false, reason: "has_one" };
    if (current !== undefined && !isActiveLink(current, identityKey)) {
      // Removed from an account earlier: only that account takes it back (relink); it never moves to another.
      try {
        await this.relinkIdentity({ identityKey, developerId, provider, issuer: input.issuer, subject: input.subject, ...(input.email === undefined ? {} : { email: input.email }), ...login, by: input.by });
      } catch (error) {
        if (!conditionFailedOrRefused(error)) throw error;
        return { ok: false, reason: "taken" };
      }
      return { ok: true, created: true };
    }
    // Linked to another account, or its own developer holds a company or was merged elsewhere: not this account's to take.
    if (current !== undefined && current.developerId !== identityKey) return { ok: false, reason: "taken" };
    if (input.belongsToCompany || duplicate?.revoked === true || (duplicate?.mergedInto !== undefined && duplicate.mergedInto !== developerId)) return { ok: false, reason: "taken" };
    const at = this.iso();
    const TableName = this.input.tableName;
    const event = await this.identityEvent("linked", { identityKey, developerId, provider, at });
    const stateTable = this.input.stateTableName;
    const items: SignInTransactItem[] = duplicate !== undefined
      ? this.mergeItems({ duplicate, duplicateIdentityKey: identityKey, survivorId: developerId, at, ...(current === undefined ? {} : { link: current }), ...(input.email === undefined ? {} : { email: input.email }) })
      : (() => {
        const body = { entityType: "IDENTITY_LINK", developerId, provider, issuer: input.issuer, subject: input.subject, ...(input.email === undefined ? {} : { email: input.email }), ...login, linkedAt: at, lastSignInAt: at };
        return [
          { Put: { TableName, Item: { ...signInIdentityKey(identityKey), ...body }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName, Item: { ...developerIdentityKey(developerId, identityKey), ...body } } },
        ];
      })();
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          // The account is still there, not revoked and not merged away, and holds no link of this provider yet: the marker is what makes two simultaneous links end with one.
          { Update: { TableName, Key: { pk: `DEVELOPER#${developerId}`, sk: META }, UpdateExpression: "SET #linkedMarker = :identityKey",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(mergedInto) AND (attribute_not_exists(revoked) OR revoked = :no) AND attribute_not_exists(#linkedMarker)",
            ExpressionAttributeNames: { "#linkedMarker": marker }, ExpressionAttributeValues: { ":no": false, ":identityKey": identityKey } } },
          ...items,
          ...this.pendingFor(event),
          // SLACK-LINK-1: the identity's own developer still holds no company, checked in this same transaction. A company created or joined after the caller read
          // `belongsToCompany` fails this check; the company side fails the other way (OrgStore refuses a membership for a developer merged away), so the two never both land.
          ...(stateTable === undefined ? [] : [{ ConditionCheck: { TableName: stateTable, Key: developerOrgKey(identityKey), ConditionExpression: "attribute_not_exists(pk)" } }]),
        ],
      }));
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      // A company appeared for the identity's developer between the caller's read and this write: the same answer as when the caller saw it.
      if (stateTable !== undefined) {
        const reasons = cancellationReasons(error);
        if (reasons?.[reasons.length - 1]?.Code === "ConditionalCheckFailed" && await this.companyExists(stateTable, identityKey)) return { ok: false, reason: "taken" };
      }
      // Someone linked or moved it between the read and the write: say what the link now shows.
      const now = await this.getIdentityLink(identityKey);
      if (now !== undefined && isActiveLink(now, identityKey) && now.developerId === developerId) return { ok: true, created: false };
      if (now !== undefined && now.developerId !== identityKey) return { ok: false, reason: "taken" };
      // The account's marker is there: another Slack link won the race.
      if (typeof (await this.get<Record<string, unknown>>(`DEVELOPER#${developerId}`))?.[marker] === "string") return { ok: false, reason: "has_one" };
      return { ok: false, reason: "changed" };
    }
    await this.flush(event);
    return { ok: true, created: true };
  }

  /** Whether the State table holds a company pointer for the developer (a consistent read, used only to name why a link's transaction was cancelled). */
  private async companyExists(stateTable: string, developerId: string): Promise<boolean> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: stateTable, Key: developerOrgKey(developerId), ConsistentRead: true })) as { Item?: unknown };
    return response.Item !== undefined;
  }

  /** Records a sign-in on the identity's link, on both items. Nothing happens for an identity with no active link. */
  async touchIdentity(identityKey: string, providerAuthTime?: number): Promise<void> {
    const link = await this.getIdentityLink(identityKey);
    if (link === undefined || !isActiveLink(link, identityKey)) return;
    const at = this.iso();
    // The provider's own `auth_time` (epoch seconds), never later than now; one that is not a plain number is none (a link keeps the last good one).
    const authAt = typeof providerAuthTime === "number" && Number.isFinite(providerAuthTime) && providerAuthTime > 0 ? new Date(Math.min(Date.parse(at), Math.round(providerAuthTime * 1000))).toISOString() : undefined;
    const update = (key: { pk: string; sk: string }) => ({ Update: {
      TableName: this.input.tableName, Key: key, UpdateExpression: authAt === undefined ? "SET lastSignInAt = :at" : "SET lastSignInAt = :at, lastAuthTime = :auth",
      ConditionExpression: "attribute_exists(pk) AND developerId = :d", ExpressionAttributeValues: { ":at": at, ":d": link.developerId, ...(authAt === undefined ? {} : { ":auth": authAt }) },
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

  /** `authTime`: when the person signed in at the provider, if the provider says it was before this answer (its `auth_time`); else now. */
  async issueCode(input: { developerId: string; amr: DeveloperSignInMethod; groupClaims?: Record<string, unknown>; ssoBreakGlass?: true; slackUserId?: string; identityKey?: string; authTime?: string; sessionEndsAt?: number; codeChallenge: string; redirectUri: string }): Promise<string> {
    const code = randomToken("agxc_");
    // The code is issued the moment the provider has answered, so this is when the person signed in interactively (unless the provider says earlier).
    const record: CodeRecord = { ...input, authTime: input.authTime ?? this.iso(), expiresAt: this.seconds() + DEVELOPER_CODE_SECONDS };
    await this.put({ pk: `CODE#${sha256Hex(code)}`, sk: META, entityType: "AUTH_CODE", ...record }, "attribute_not_exists(pk)");
    return code;
  }

  async redeemCode(input: { code: string; verifier: string; redirectUri: string }): Promise<{ developerId: string; amr: DeveloperSignInMethod; groupClaims?: Record<string, unknown>; ssoBreakGlass?: true; slackUserId?: string; identityKey?: string; authTime?: string; sessionEndsAt?: number } | undefined> {
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
    return { developerId: record.developerId, amr: record.amr, ...(record.slackUserId === undefined ? {} : { slackUserId: record.slackUserId }), ...(record.identityKey === undefined ? {} : { identityKey: record.identityKey }), ...(record.authTime === undefined ? {} : { authTime: record.authTime }), ...(record.sessionEndsAt === undefined ? {} : { sessionEndsAt: record.sessionEndsAt }), ...(record.groupClaims === undefined ? {} : { groupClaims: record.groupClaims }), ...(record.ssoBreakGlass === true ? { ssoBreakGlass: true as const } : {}) };
  }

  /** `authTime` is when the person signed in interactively (the code's, for the CLI); a refresh keeps it. `endsAt` (epoch seconds) is for a browser review sign-in, which has its own fixed length; every other session lasts DEVELOPER_SESSION_SECONDS. The stored record's clean-up time follows `endsAt`. */
  async createSession(input: { developerId: string; amr: DeveloperSignInMethod; groupClaims?: Record<string, unknown>; ssoBreakGlass?: true; slackUserId?: string; identityKey?: string; authTime?: string; reviewExpiresAt?: number; endsAt?: number }): Promise<{ session: SessionRecord; refreshToken: string }> {
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

  /**
   * ERASE-NAME-1: the person's erase clears the name this record holds (the provider's real name, or the one a sign-in made): it becomes the placeholder, marked `nameErasedAt`, which a sign-in
   * leaves alone. Repeatable (the first time stands). Only the sign-in function calls this; the broker has no write on this table. "not_found" when the person never signed in.
   */
  async eraseDisplayName(developerId: string, at: string): Promise<"erased" | "not_found"> {
    const when = Date.parse(at);
    if (!Number.isFinite(when)) throw new RangeError("eraseDisplayName needs a readable time");
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName,
        Key: { pk: `DEVELOPER#${developerId}`, sk: META },
        UpdateExpression: "SET displayName = :placeholder, displayNameChosen = :notChosen, nameErasedAt = if_not_exists(nameErasedAt, :at)",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":placeholder": placeholderDisplayName(developerId), ":notChosen": false, ":at": new Date(when).toISOString() },
      }));
      return "erased";
    } catch (error) {
      if (!conditionFailed(error)) throw error;
      return "not_found";
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
