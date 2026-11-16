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
//   COMPANY#<org_…>             INVITE#<invite id>          an invite; `revision` and `inviteState` guard writes
//   COMPANY#<org_…>             INVITEREQUEST#<request id>  the invite a create request made, so a replay is refused
//   INVITETOKEN#<sha256 hex>    INVITE                      the company and invite a link's token names (never the token)
//   HOOKINSTALL#<sha256 hex>    INSTALL                     a Code install the policy hook answers, by a hash of its issuer
//
// Every item carries `companyId` (an install carries its own issuer), and every read checks it against the key it asked for.
import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CompanyStoreConflict, INVITES_READ_MAX, validAgentAiSource, validHookInstall,
  type AgentAiChoice, type CompanyProfile, type CompanyStore, type HookInstall, type InviteRecord, type InviteState, type PendingSettingsChange, type StoredSettings,
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
    return { companyId, source: item.source, version: item.version, updatedAt: item.updatedAt, updatedBy: item.updatedBy };
  }

  async putAgentAi(choice: Omit<AgentAiChoice, "version">, expectedVersion: number): Promise<number> {
    await guarded("agent ai", () => this.db.send(new PutCommand({
      TableName: this.table, Item: { pk: company(choice.companyId), sk: "AGENT_AI", companyId: choice.companyId, source: choice.source, version: expectedVersion + 1, updatedAt: choice.updatedAt, updatedBy: choice.updatedBy }, ...versionCondition(expectedVersion),
    })));
    return expectedVersion + 1;
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
}
