// Cloud's company data in its own DynamoDB table (infra/lib/cloud-web.ts, `Companies`), with the same key schema as the shared State
// table (dynamo-stores.ts, PrepLabsAI/Rovara-cloud#11) so several servers share it under guarded writes. A table of its own because
// this is long-lived company configuration (and invitees' email addresses), not sign-ins: the server's grant on it has no Scan and no
// batch writes, and it can be granted to a future reader alone.
//
//   pk                          sk                          what
//   COMPANY#<org_…>             SETTINGS                    the company's settings and rules; `version` guards writes
//   COMPANY#<org_…>             PENDING                     a settings change waiting for a second admin (`pendingUntil`; TTL after)
//   COMPANY#<org_…>             PROFILE                     name and plan; `version` guards writes
//   COMPANY#<org_…>             AGENT_AI                    which AI the company's agents use (DEC 240; the model gateway reads it); `version` guards writes
//   COMPANY#<org_…>             SPEND_LIMIT#PROJECT#<name>  a project's monthly limit over the company default (lead 3 B1; the gateway reads it); `version` guards writes
//   COMPANY#<org_…>             SPEND_LIMIT#PERSON#<id>     a person's monthly limit, the same
//   COMPANY#<org_…>             INVITE#<invite id>          an invite; `revision` and `inviteState` guard writes
//   COMPANY#<org_…>             INVITEREQUEST#<request id>  the invite a create request made, so a replay is refused
//   INVITETOKEN#<sha256 hex>    INVITE                      the company and invite a link's token names (never the token)
//   HOOKINSTALL#<sha256 hex>    INSTALL                     a Code install the policy hook answers, by a hash of its issuer
//   COMPANY#<org_…>             TRIAL                       the company's unlocked trial and the GitHub account that unlocked it (written once, never overwritten)
//   GITHUBTRIAL#<GitHub user id> TRIAL                      the company holding that GitHub account's one trial (first writer wins, never overwritten)
//                                                           (these two are written together, in one transaction, or not at all: L2-8)
//
// Every item carries `companyId` (an install carries its own issuer), and every read checks it against the key it asked for.
import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  COMPANY_ID, CompanyStoreConflict, INVITES_READ_MAX, SPEND_LIMIT_KINDS, SPEND_LIMIT_SORT_PREFIX, sameInvite, validAgentAiFallback, validAgentAiSource, validGithubUserId, validHookInstall, validSpendLimit, type CompanyTrial, type TrialUnlock,
  type AgentAiChoice, type AgentAiSource, type CompanyProfile, type CompanyStore, type HookInstall, type InviteRecord, type InviteState, type PendingSettingsChange, type SpendLimit, type SpendLimitBasis, type SpendLimitKind, type SpendLimitList, type StoredSettings,
} from "./company-store.js";
import type { CompanySettings } from "./company-settings.js";

/** The table's shape, which infra/lib (the table) and the tests create from. */
export const COMPANY_TABLE = { partitionKey: "pk", sortKey: "sk", ttlAttribute: "expiresAt" } as const;
/** A dropped or applied change's row could linger until TTL; reads check `pendingUntil`, and TTL removes the row a day later. */
const PENDING_TTL_GRACE_S = 24 * 60 * 60;
/** How long an invite stays readable after it closed (accepted, withdrawn) or lapsed, before TTL removes it. */
export const CLOSED_INVITE_DAYS = 90;
const CLOSED_INVITE_S = CLOSED_INVITE_DAYS * 24 * 60 * 60;
/**
 * Every invite row is removed in the end, so a company's list stays short: 90 days after it was accepted or withdrawn, else 90 days after it
 * lapses (an open, unconfirmed or stuck invite past its expiry is already never sent to Code or accepted). Its request and token rows go with it.
 */
function inviteTtl(invite: InviteRecord): number {
  const closedAt = invite.state === "accepted" ? invite.acceptedAt : invite.state === "revoked" ? invite.revokedAt : undefined;
  const from = closedAt !== undefined && Number.isFinite(Date.parse(closedAt)) ? Date.parse(closedAt) : Date.parse(invite.expiresAt);
  return seconds(from) + CLOSED_INVITE_S;
}

type Db = Pick<DynamoDBDocumentClient, "send">;
const company = (companyId: string) => `COMPANY#${companyId}`;
const issuerKey = (issuer: string) => `HOOKINSTALL#${createHash("sha256").update(issuer, "utf8").digest("hex")}`;
const seconds = (ms: number) => Math.floor(ms / 1000);

function conflicted(error: unknown): boolean {
  const named = (error as { name?: unknown }).name;
  if (error instanceof ConditionalCheckFailedException || named === "ConditionalCheckFailedException") return true;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return named === "TransactionCanceledException" && (reasons ?? []).some((reason) => reason.Code === "ConditionalCheckFailed");
}

/** A transaction cancelled only because another transaction was touching the same items right then (nothing was decided: ask again). */
function transactionBusy(error: unknown): boolean {
  const named = (error as { name?: unknown }).name;
  if (named === "TransactionConflictException") return true;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return named === "TransactionCanceledException" && (reasons ?? []).some((reason) => reason.Code === "TransactionConflict") && !conflicted(error);
}
/** How many times an unlock asks again when another transaction was in the way. */
const UNLOCK_ATTEMPTS = 4;

async function guarded<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (conflicted(error)) throw new CompanyStoreConflict(what);
    throw error;
  }
}

const versionCondition = (expectedVersion: number) => (expectedVersion === 0
  ? { ConditionExpression: "attribute_not_exists(pk)" }
  : { ConditionExpression: "version = :expected", ExpressionAttributeValues: { ":expected": expectedVersion } });

const inviteOf = (item: Record<string, unknown> | undefined, companyId: string): InviteRecord | undefined => {
  const invite = item?.invite as InviteRecord | undefined;
  return item !== undefined && item.companyId === companyId && invite?.companyId === companyId ? invite : undefined;
};

export class DynamoCompanyStore implements CompanyStore {
  constructor(private readonly db: Db, private readonly table: string) {}

  private async get(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }));
    return Item;
  }

  async settings(companyId: string): Promise<StoredSettings | undefined> {
    const item = await this.get(company(companyId), "SETTINGS");
    if (item === undefined || item.companyId !== companyId || typeof item.version !== "number") return undefined;
    return {
      companyId, settings: item.settings, version: item.version,
      ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}), ...(typeof item.updatedBy === "string" ? { updatedBy: item.updatedBy } : {}),
    };
  }

  private settingsItem(companyId: string, settings: CompanySettings, version: number, by: string, at: string) {
    return { pk: company(companyId), sk: "SETTINGS", companyId, settings, version, updatedAt: at, updatedBy: by };
  }

  async putSettings(companyId: string, settings: CompanySettings, expectedVersion: number, by: string, at: string): Promise<number> {
    await guarded("settings", () => this.db.send(new PutCommand({ TableName: this.table, Item: this.settingsItem(companyId, settings, expectedVersion + 1, by, at), ...versionCondition(expectedVersion) })));
    return expectedVersion + 1;
  }

  async pendingChange(companyId: string, nowMs: number): Promise<PendingSettingsChange | undefined> {
    const item = await this.get(company(companyId), "PENDING");
    const change = item?.change as PendingSettingsChange | undefined;
    if (item === undefined || item.companyId !== companyId || change?.companyId !== companyId) return undefined;
    return typeof item.pendingUntil === "number" && item.pendingUntil > seconds(nowMs) ? change : undefined;
  }

  async proposeChange(change: PendingSettingsChange, nowMs: number): Promise<void> {
    const until = seconds(Date.parse(change.expiresAt));
    await guarded("pending change", () => this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: company(change.companyId), sk: "PENDING", companyId: change.companyId, changeId: change.changeId, change, pendingUntil: until, expiresAt: until + PENDING_TTL_GRACE_S },
      ConditionExpression: "attribute_not_exists(pk) OR pendingUntil <= :now", ExpressionAttributeValues: { ":now": seconds(nowMs) },
    })));
  }

  async dropChange(companyId: string, changeId: string): Promise<boolean> {
    try {
      await guarded("pending change", () => this.db.send(new DeleteCommand({
        TableName: this.table, Key: { pk: company(companyId), sk: "PENDING" }, ConditionExpression: "changeId = :changeId", ExpressionAttributeValues: { ":changeId": changeId },
      })));
      return true;
    } catch (error) {
      if (error instanceof CompanyStoreConflict) return false;
      throw error;
    }
  }

  async applyChange(change: PendingSettingsChange, by: string, at: string): Promise<number> {
    await guarded("settings", () => this.db.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.table, Key: { pk: company(change.companyId), sk: "PENDING" }, ConditionExpression: "changeId = :changeId", ExpressionAttributeValues: { ":changeId": change.changeId } } },
        { Put: { TableName: this.table, Item: this.settingsItem(change.companyId, change.settings, change.baseVersion + 1, by, at), ...versionCondition(change.baseVersion) } },
      ],
    })));
    return change.baseVersion + 1;
  }

  async profile(companyId: string): Promise<CompanyProfile | undefined> {
    const item = await this.get(company(companyId), "PROFILE");
    const profile = item?.profile as CompanyProfile | undefined;
    if (item === undefined || item.companyId !== companyId || profile?.companyId !== companyId || typeof item.version !== "number") return undefined;
    return { ...profile, version: item.version };
  }

  async putProfile(profile: Omit<CompanyProfile, "version">, expectedVersion: number): Promise<number> {
    await guarded("profile", () => this.db.send(new PutCommand({
      TableName: this.table, Item: { pk: company(profile.companyId), sk: "PROFILE", companyId: profile.companyId, profile, version: expectedVersion + 1 }, ...versionCondition(expectedVersion),
    })));
    return expectedVersion + 1;
  }

  async agentAi(companyId: string): Promise<AgentAiChoice | undefined> {
    const item = await this.get(company(companyId), "AGENT_AI");
    if (item === undefined) return undefined;
    // A row that does not read as this company's choice is an outage, never "none saved" (which would hide it and block every save).
    if (item.companyId !== companyId || !validAgentAiSource(item.source) || typeof item.version !== "number" || typeof item.updatedAt !== "string" || typeof item.updatedBy !== "string") throw new Error("agent ai choice unreadable");
    // DEC 254zzz84(4): a fallback that is there but not a valid list is unreadable too (never a partial order).
    if (item.fallback !== undefined && !validAgentAiFallback(item.fallback, item.source)) throw new Error("agent ai choice unreadable");
    const fallback = item.fallback === undefined || item.fallback.length === 0 ? undefined : (item.fallback as string[]).slice() as AgentAiSource[];
    return { companyId, source: item.source, version: item.version, updatedAt: item.updatedAt, updatedBy: item.updatedBy, ...(fallback === undefined ? {} : { fallback }) };
  }

  async putAgentAi(choice: Omit<AgentAiChoice, "version">, expectedVersion: number): Promise<number> {
    if (choice.fallback !== undefined && !validAgentAiFallback(choice.fallback, choice.source)) throw new Error("invalid agent ai fallback");
    await guarded("agent ai", () => this.db.send(new PutCommand({
      // A row without a fallback is written exactly as before (no `fallback` attribute).
      TableName: this.table, Item: { pk: company(choice.companyId), sk: "AGENT_AI", companyId: choice.companyId, source: choice.source, version: expectedVersion + 1, updatedAt: choice.updatedAt, updatedBy: choice.updatedBy, ...(choice.fallback === undefined || choice.fallback.length === 0 ? {} : { fallback: choice.fallback.slice() }) }, ...versionCondition(expectedVersion),
    })));
    return expectedVersion + 1;
  }

  async spendLimit(companyId: string, kind: SpendLimitKind, id: string): Promise<SpendLimit | undefined> {
    const item = await this.get(company(companyId), `${SPEND_LIMIT_SORT_PREFIX[kind]}${id}`);
    if (item === undefined) return undefined;
    return this.readSpendLimit(item, companyId, kind, id);
  }

  // An item that does not read as exactly this company's, kind's and id's is an outage, never "none saved" (the gateway refuses spend on it too).
  private readSpendLimit(item: Record<string, unknown>, companyId: string, kind: SpendLimitKind, id: string): SpendLimit {
    const limit = { companyId: item.companyId, kind: item.kind, id: item.id, monthlyUsdMicros: item.monthlyUsdMicros, version: item.version, updatedAt: item.updatedAt, updatedBy: item.updatedBy };
    if (!validSpendLimit(limit, companyId, kind, id) || item.pk !== company(companyId) || item.sk !== `${SPEND_LIMIT_SORT_PREFIX[kind]}${id}`) throw new Error("spend limit unreadable");
    return limit;
  }

  async spendLimits(companyId: string): Promise<SpendLimitList> {
    const limits = {} as Record<SpendLimitKind, SpendLimit[]>;
    let partial = false;
    for (const def of SPEND_LIMIT_KINDS) {
      const kind: SpendLimitKind = def.kind;
      const prefix = def.sortPrefix;
      // One bounded query per kind: the most plus one, so "there were more" is known without reading them all.
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": company(companyId), ":prefix": prefix },
        ConsistentRead: true, Limit: def.max + 1,
      }));
      const items = page.Items ?? [];
      const found = items.map((item) => {
        const sk = typeof item.sk === "string" && item.sk.startsWith(prefix) ? item.sk.slice(prefix.length) : "";
        return this.readSpendLimit(item, companyId, kind, sk);
      });
      if (found.length > def.max || (page.LastEvaluatedKey !== undefined && found.length >= def.max)) partial = true;
      limits[kind] = found.slice(0, def.max);
    }
    return { limits, partial };
  }

  /** The company settings item as the default this change was judged against: still at `settingsVersion` (or still absent at 0). */
  private settingsCheck(companyId: string, settingsVersion: number) {
    return {
      ConditionCheck: {
        TableName: this.table, Key: { pk: company(companyId), sk: "SETTINGS" },
        ...(settingsVersion === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "companyId = :company AND version = :settings", ExpressionAttributeValues: { ":company": companyId, ":settings": settingsVersion } }),
      },
    };
  }

  /** The override item is still exactly as read: absent, or at the version and amount the change was judged against. */
  private spendBasis(companyId: string, basis: SpendLimitBasis) {
    return basis.override === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "companyId = :company AND version = :version AND monthlyUsdMicros = :amount", ExpressionAttributeValues: { ":company": companyId, ":version": basis.override.version, ":amount": basis.override.monthlyUsdMicros } };
  }

  async putSpendLimit(limit: Omit<SpendLimit, "version">, basis: SpendLimitBasis): Promise<number> {
    const version = (basis.override?.version ?? 0) + 1;
    await guarded("spend limit", () => this.db.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.table, Item: { pk: company(limit.companyId), sk: `${SPEND_LIMIT_SORT_PREFIX[limit.kind]}${limit.id}`, companyId: limit.companyId, kind: limit.kind, id: limit.id, monthlyUsdMicros: limit.monthlyUsdMicros, version, updatedAt: limit.updatedAt, updatedBy: limit.updatedBy }, ...this.spendBasis(limit.companyId, basis) } },
        this.settingsCheck(limit.companyId, basis.settingsVersion),
      ],
    })));
    return version;
  }

  async removeSpendLimit(companyId: string, kind: SpendLimitKind, id: string, basis: SpendLimitBasis): Promise<void> {
    if (basis.override === undefined) throw new CompanyStoreConflict("spend limit");
    await guarded("spend limit", () => this.db.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.table, Key: { pk: company(companyId), sk: `${SPEND_LIMIT_SORT_PREFIX[kind]}${id}` }, ...this.spendBasis(companyId, basis) } },
        this.settingsCheck(companyId, basis.settingsVersion),
      ],
    })));
  }

  private inviteItem(invite: InviteRecord) {
    return { pk: company(invite.companyId), sk: `INVITE#${invite.inviteId}`, companyId: invite.companyId, invite, revision: invite.revision, inviteState: invite.state, expiresAt: inviteTtl(invite) };
  }

  async createInvite(invite: InviteRecord): Promise<void> {
    const absent = { ConditionExpression: "attribute_not_exists(pk)" };
    await guarded("invite request", () => this.db.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.table, Item: this.inviteItem(invite), ...absent } },
        { Put: { TableName: this.table, Item: { pk: company(invite.companyId), sk: `INVITEREQUEST#${invite.requestId}`, companyId: invite.companyId, inviteId: invite.inviteId, expiresAt: inviteTtl(invite) }, ...absent } },
        { Put: { TableName: this.table, Item: { pk: `INVITETOKEN#${invite.tokenHash}`, sk: "INVITE", companyId: invite.companyId, inviteId: invite.inviteId, expiresAt: inviteTtl(invite) }, ...absent } },
      ],
    })));
  }

  async invite(companyId: string, inviteId: string): Promise<InviteRecord | undefined> {
    return inviteOf(await this.get(company(companyId), `INVITE#${inviteId}`), companyId);
  }

  async inviteByRequest(companyId: string, requestId: string): Promise<InviteRecord | undefined> {
    const item = await this.get(company(companyId), `INVITEREQUEST#${requestId}`);
    return item !== undefined && item.companyId === companyId && typeof item.inviteId === "string" ? this.invite(companyId, item.inviteId) : undefined;
  }

  async inviteByToken(tokenHash: string): Promise<InviteRecord | undefined> {
    const item = await this.get(`INVITETOKEN#${tokenHash}`, "INVITE");
    if (item === undefined || typeof item.companyId !== "string" || typeof item.inviteId !== "string") return undefined;
    const invite = await this.invite(item.companyId, item.inviteId);
    return invite?.tokenHash === tokenHash ? invite : undefined;
  }

  async invites(companyId: string): Promise<{ invites: InviteRecord[]; partial: boolean }> {
    const found: InviteRecord[] = [];
    let start: Record<string, unknown> | undefined;
    let partial = false;
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": company(companyId), ":prefix": "INVITE#" },
        ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      for (const item of page.Items ?? []) {
        const invite = inviteOf(item, companyId);
        if (invite !== undefined) found.push(invite);
      }
      start = page.LastEvaluatedKey;
      if (found.length > INVITES_READ_MAX) { partial = true; break; }
    } while (start !== undefined);
    found.sort((a, b) => (a.createdAt === b.createdAt ? b.inviteId.localeCompare(a.inviteId) : b.createdAt.localeCompare(a.createdAt)));
    return { invites: found.slice(0, INVITES_READ_MAX), partial: partial || found.length > INVITES_READ_MAX };
  }

  async updateInvite(next: InviteRecord, expected: { revision: number; state: InviteState }): Promise<void> {
    await guarded("invite", () => this.db.send(new PutCommand({
      TableName: this.table, Item: this.inviteItem(next),
      ConditionExpression: "companyId = :company AND revision = :revision AND inviteState = :state",
      ExpressionAttributeValues: { ":company": next.companyId, ":revision": expected.revision, ":state": expected.state },
    })));
  }

  async confirmInvite(unconfirmed: InviteRecord, confirmed: InviteRecord): Promise<void> {
    sameInvite(unconfirmed, confirmed);
    const invite = {
      Put: {
        TableName: this.table, Item: this.inviteItem(confirmed),
        ConditionExpression: "companyId = :company AND revision = :revision AND inviteState = :state",
        ExpressionAttributeValues: { ":company": unconfirmed.companyId, ":revision": unconfirmed.revision, ":state": "unconfirmed" },
      },
    };
    if (confirmed.tokenHash === unconfirmed.tokenHash) {
      await guarded("invite", () => this.db.send(new TransactWriteCommand({ TransactItems: [invite] })));
      return;
    }
    // The token row moves to the new hash in the same write: the old hash names nothing, and no other invite may hold the new one.
    await guarded("invite", () => this.db.send(new TransactWriteCommand({
      TransactItems: [
        invite,
        { Delete: { TableName: this.table, Key: { pk: `INVITETOKEN#${unconfirmed.tokenHash}`, sk: "INVITE" }, ConditionExpression: "inviteId = :invite", ExpressionAttributeValues: { ":invite": unconfirmed.inviteId } } },
        { Put: { TableName: this.table, Item: { pk: `INVITETOKEN#${confirmed.tokenHash}`, sk: "INVITE", companyId: confirmed.companyId, inviteId: confirmed.inviteId, expiresAt: inviteTtl(confirmed) }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    })));
  }

  async removeInvite(invite: InviteRecord): Promise<void> {
    try {
      await guarded("invite", () => this.db.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: { pk: company(invite.companyId), sk: `INVITE#${invite.inviteId}` }, ConditionExpression: "inviteState = :state", ExpressionAttributeValues: { ":state": "unconfirmed" } } },
          { Delete: { TableName: this.table, Key: { pk: company(invite.companyId), sk: `INVITEREQUEST#${invite.requestId}` } } },
          { Delete: { TableName: this.table, Key: { pk: `INVITETOKEN#${invite.tokenHash}`, sk: "INVITE" } } },
        ],
      })));
    } catch (error) {
      // Already confirmed (or gone): nothing to take back.
      if (!(error instanceof CompanyStoreConflict)) throw error;
    }
  }

  async hookInstall(issuer: string): Promise<HookInstall | undefined> {
    const install = (await this.get(issuerKey(issuer), "INSTALL"))?.install;
    return validHookInstall(install) && install.issuer === issuer ? install : undefined;
  }

  async putHookInstall(install: HookInstall): Promise<void> {
    if (!validHookInstall(install)) throw new Error("the install does not read");
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: issuerKey(install.issuer), sk: "INSTALL", install } }));
  }

  async removeHookInstall(issuer: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: issuerKey(issuer), sk: "INSTALL" } }));
  }

  async trial(companyId: string): Promise<CompanyTrial | undefined> {
    if (!COMPANY_ID.test(companyId)) throw new Error("the company id does not read");
    const item = await this.get(company(companyId), "TRIAL");
    return item !== undefined && item.companyId === companyId && validGithubUserId(item.githubUserId) && typeof item.unlockedAt === "string"
      ? { companyId, githubUserId: item.githubUserId, unlockedAt: item.unlockedAt } : undefined;
  }

  async unlockTrial(githubUserId: number, companyId: string, at: string): Promise<TrialUnlock> {
    if (!validGithubUserId(githubUserId) || !COMPANY_ID.test(companyId)) throw new Error("the GitHub trial unlock does not read");
    const settled = async (): Promise<TrialUnlock | undefined> => {
      const own = await this.trial(companyId);
      return own === undefined ? undefined : own.githubUserId === githubUserId ? "held" : "already";
    };
    const earlier = await settled();
    if (earlier !== undefined) return earlier;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.db.send(new TransactWriteCommand({
          TransactItems: [
            // The account's claim: free, or this company's own (the first #92 build wrote only this row, and a retry is not a second claim).
            { Put: { TableName: this.table, Item: { pk: `GITHUBTRIAL#${String(githubUserId)}`, sk: "TRIAL", companyId, githubUserId, claimedAt: at }, ConditionExpression: "attribute_not_exists(pk) OR companyId = :company", ExpressionAttributeValues: { ":company": companyId } } },
            // The company's trial: once. Together with the claim above, or not at all.
            { Put: { TableName: this.table, Item: { pk: company(companyId), sk: "TRIAL", companyId, githubUserId, unlockedAt: at }, ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        }));
        return "unlocked";
      } catch (error) {
        // Another transaction was on the same rows right then: nothing was decided, so ask again (then give up with the error: no answer, no trial).
        if (transactionBusy(error) && attempt < UNLOCK_ATTEMPTS) { const answered = await settled(); if (answered !== undefined) return answered; continue; }
        if (!conflicted(error)) throw error;
        break;
      }
    }
    // Lost: to this company's own trial (another call of its own won), or to another company holding the account. A row that does not read is never a free trial.
    return await settled() ?? "used";
  }
}
