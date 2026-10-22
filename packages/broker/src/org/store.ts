// packages/broker/src/org/store.ts
// Multi-tenancy: orgs, membership, invites and the Slack team binding. A developer belongs to at
// most one org (the developer pointer's `attribute_not_exists(pk)` condition enforces it), and an
// invite is accepted in one transaction with the membership writes, so a refused acceptance never
// burns the invite. Invite tokens are stored only as SHA-256 hashes.
import { randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MEMBER_GRANT_SK_PREFIX,
  agentXError,
  developerOrgKey,
  githubInstallationKey,
  memberGrantsPk,
  newOrgId as generateOrgId,
  normalizeEmail,
  orgBanKey,
  orgEmailKey,
  orgInviteKey,
  orgInviteRequestKey,
  orgMemberKey,
  orgMetaKey,
  orgPk,
  orgRemovedKey,
  orgSettingsKey,
  orgSlackTeamKey,
  budgetSyncedKey,
  slackTeamOrgKey,
  type AgentXErrorCode,
  type OrgId,
  type OrgInviteRecord,
  type OrgKey,
  type OrgMembershipRecord,
  type OrgRecord,
  type OrgRole,
} from "@agentx/contracts";
import { sha256Hex } from "../developer/tokens.js";
import { INVITE_HASH_PATTERN, inviteTokenHash } from "./invite-url.js";

const DEFAULT_INVITE_TTL_SECONDS = 604_800;
const NOT_EXISTS = "attribute_not_exists(pk)";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/** An invite as the join page shows it (OrgStore.describeInvite). */
export interface InviteDescription {
  orgId: OrgId; orgName: string; role: "admin" | "member"; createdBy: string; email?: string; state: "open" | "expired" | "used";
}

export interface OrgStoreInput {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  newOrgId?: () => OrgId;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/** The index of the first TransactItem whose own condition failed, or undefined when the error is not a condition cancellation. */
function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => {
    if (reason?.Code === "ConditionalCheckFailed") failed.add(index);
  });
  return failed;
}

function strip<T extends Item>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item;
  return rest;
}

const normalizeInviteEmail = (email: string) => normalizeEmail(email).email;

export class OrgStore {
  private readonly newId: () => OrgId;

  constructor(private readonly input: OrgStoreInput) {
    this.newId = input.newOrgId ?? (() => generateOrgId());
  }

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  private async get(key: OrgKey): Promise<Item | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    return response.Item;
  }

  private put(key: OrgKey, entityType: string, fields: Item): TransactItem {
    return { Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...fields }, ConditionExpression: NOT_EXISTS } };
  }

  /** The three writes every membership needs: the member record, the developer pointer and, given an email, the email pointer. Order matters to `refuse`. */
  private membershipItems(input: { orgId: OrgId; developerId: string; role: OrgRole; email?: string | undefined }): TransactItem[] {
    const joinedAt = this.iso();
    const member: OrgMembershipRecord = { orgId: input.orgId, developerId: input.developerId, role: input.role, joinedAt };
    return [
      this.put(orgMemberKey(input.orgId, input.developerId), "ORG_MEMBER", member as unknown as Item),
      this.put(developerOrgKey(input.developerId), "DEVELOPER_ORG", { orgId: input.orgId, role: input.role, joinedAt }),
      ...(input.email === undefined ? [] : [this.put(orgEmailKey(input.email), "ORG_EMAIL", { developerId: input.developerId, orgId: input.orgId, createdAt: joinedAt })]),
    ];
  }

  private async transact(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined): Promise<void> {
    try {
      await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const failed = failedIndexes(error);
      const refusal = failed === undefined ? undefined : refuse(failed);
      throw refusal ?? error;
    }
  }

  async orgForDeveloper(developerId: string): Promise<{ orgId: OrgId; role: OrgRole } | undefined> {
    const item = await this.get(developerOrgKey(developerId));
    return item === undefined ? undefined : { orgId: item.orgId as OrgId, role: item.role as OrgRole };
  }

  async developerForVerifiedEmail(email: string): Promise<string | undefined> {
    const item = await this.get(orgEmailKey(email));
    return item === undefined ? undefined : (item.developerId as string);
  }

  async getOrg(orgId: OrgId): Promise<OrgRecord | undefined> {
    const item = await this.get(orgMetaKey(orgId));
    return item === undefined ? undefined : (strip(item) as unknown as OrgRecord);
  }

  /** Idempotent creation of an org with no owner (a single-org install's org, ruling R3). An existing org is left untouched. */
  async ensureOrg(orgId: OrgId, name: string): Promise<void> {
    const org: OrgRecord = { orgId, name, createdAt: this.iso(), createdBy: "system", plan: "team" };
    try {
      await this.input.documentClient.send(new PutCommand({
        TableName: this.input.tableName,
        Item: { ...orgMetaKey(orgId), entityType: "ORG", ...org },
        ConditionExpression: NOT_EXISTS,
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }

  async createOrgWithOwner(input: { name: string; developerId: string; email?: string }): Promise<OrgId> {
    const orgId = this.newId();
    const org: OrgRecord = { orgId, name: input.name, createdAt: this.iso(), createdBy: input.developerId, plan: "trial" };
    await this.transact(
      [
        this.put(orgMetaKey(orgId), "ORG", org as unknown as Item),
        ...this.membershipItems({ orgId, developerId: input.developerId, role: "owner", email: input.email }),
      ],
      (failed) => (failed.has(2) || failed.has(3) ? alreadyInOrg() : undefined),
    );
    return orgId;
  }

  async addMember(input: { orgId: OrgId; developerId: string; role: OrgRole; email?: string }): Promise<void> {
    await this.transact(
      this.membershipItems(input),
      (failed) => (failed.has(0) || failed.has(1) || failed.has(2) ? alreadyInOrg() : undefined),
    );
  }

  /**
   * A new invite. Given a `requestId`, the invite and a marker for that request are written together, so a
   * replay of the same request is refused with IDEMPOTENCY_CONFLICT: only the token's hash is stored, so the
   * first answer cannot be given again.
   */
  async createInvite(input: { orgId: OrgId; createdBy: string; role: Exclude<OrgRole, "owner">; email?: string; requestId?: string; ttlSeconds?: number }): Promise<{ token: string }> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(token);
    const ttlMs = (input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000;
    const invite: OrgInviteRecord = {
      orgId: input.orgId,
      tokenHash,
      ...(input.email === undefined ? {} : { email: normalizeInviteEmail(input.email) }),
      role: input.role,
      createdBy: input.createdBy,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      createdAt: this.iso(),
      expiresAt: new Date(this.input.now() + ttlMs).toISOString(),
    };
    await this.transact(
      [
        this.put(orgInviteKey(tokenHash), "ORG_INVITE", invite as unknown as Item),
        ...(input.requestId === undefined ? [] : [this.put(orgInviteRequestKey(input.orgId, input.requestId), "ORG_INVITE_REQUEST", { tokenHash, createdAt: invite.createdAt })]),
      ],
      (failed) => (failed.has(1) ? coded("IDEMPOTENCY_CONFLICT", "invite already created for this request") : undefined),
    );
    return { token };
  }

  /**
   * The key of the invite whose token hashes to `tokenHash` (SHA-256, base64url: the form a sign-in request keeps). The item is keyed by the
   * same SHA-256 in hex. A string that is not a canonical hash names no invite.
   */
  private inviteKeyOf(tokenHash: string): OrgKey | undefined {
    if (!INVITE_HASH_PATTERN.test(tokenHash)) return undefined;
    const bytes = Buffer.from(tokenHash, "base64url");
    return bytes.toString("base64url") === tokenHash ? orgInviteKey(bytes.toString("hex")) : undefined;
  }

  /** What an invite grants and whom it was written for, without accepting it; undefined for an unknown invite. A sign-in reads this to check an email-targeted invite (ruling R7) before it accepts. */
  async peekInvite(tokenHash: string): Promise<{ orgId: OrgId; role: OrgRole; email?: string } | undefined> {
    const key = this.inviteKeyOf(tokenHash);
    const invite = key === undefined ? undefined : await this.get(key);
    if (invite === undefined) return undefined;
    return { orgId: invite.orgId as OrgId, role: invite.role as OrgRole, ...(typeof invite.email === "string" ? { email: invite.email } : {}) };
  }

  /**
   * What the join page tells a visitor about an invite: the org's name, the role, who made it, the address it is for and whether it can
   * still be used. Reads only. Undefined for an unknown token or an invite whose org is gone.
   */
  async describeInvite(token: string): Promise<InviteDescription | undefined> {
    return this.describeInviteByHash(inviteTokenHash(token));
  }

  /** `describeInvite` for a caller that holds only the token's hash (a sign-in request never keeps the token). */
  async describeInviteByHash(tokenHash: string): Promise<InviteDescription | undefined> {
    const key = this.inviteKeyOf(tokenHash);
    const invite = key === undefined ? undefined : await this.get(key) as (Item & OrgInviteRecord) | undefined;
    if (invite === undefined) return undefined;
    const org = await this.getOrg(invite.orgId);
    if (org === undefined) return undefined;
    const state = invite.acceptedAt !== undefined ? "used" : invite.expiresAt <= this.iso() ? "expired" : "open";
    return {
      orgId: invite.orgId, orgName: org.name, role: invite.role, createdBy: invite.createdBy,
      ...(typeof invite.email === "string" ? { email: invite.email } : {}), state,
    };
  }

  /** `tokenHash` is the invite token's SHA-256 in base64url (inviteTokenHash): the raw token never reaches a store call past the page that read it. */
  async acceptInvite(input: { tokenHash: string; developerId: string; email?: string }): Promise<{ orgId: OrgId; role: OrgRole }> {
    const inviteKey = this.inviteKeyOf(input.tokenHash);
    if (inviteKey === undefined) throw inviteInvalid();
    const invite = await this.get(inviteKey) as (Item & OrgInviteRecord) | undefined;
    const nowIso = this.iso();
    if (invite === undefined || invite.acceptedAt !== undefined || invite.expiresAt <= nowIso) throw inviteInvalid();
    const { orgId, role } = invite;
    // One transaction: the invite is marked accepted only if the developer joins, and joins only if
    // the invite is still live, so a refusal on either side leaves the other untouched.
    const items: TransactItem[] = [
      {
        Update: {
          TableName: this.input.tableName,
          Key: inviteKey,
          UpdateExpression: "SET acceptedBy = :by, acceptedAt = :at",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(acceptedAt) AND expiresAt > :now",
          ExpressionAttributeValues: { ":by": input.developerId, ":at": nowIso, ":now": nowIso },
        },
      },
      ...this.membershipItems({ orgId, developerId: input.developerId, role, email: input.email }),
      // An invite is the way back after a removal with a ban: it clears the ban in the same transaction.
      { Delete: { TableName: this.input.tableName, Key: orgBanKey(orgId, input.developerId) } },
      // A closed org (or one whose last owner is closing it) takes no new members. closeOrg writes `closingAt` before it checks that its
      // sole owner is alone, and both writes touch this item, so the two transactions are serialized.
      { ConditionCheck: { TableName: this.input.tableName, Key: orgMetaKey(orgId), ConditionExpression: "attribute_not_exists(closedAt) AND attribute_not_exists(closingAt)" } },
    ];
    await this.transact(items, (failed) => {
      if (failed.has(0)) return inviteInvalid();
      if (failed.has(items.length - 1)) return coded("INVITE_INVALID", "that organization has closed");
      return failed.has(1) || failed.has(2) || failed.has(3) ? alreadyInOrg() : undefined;
    });
    return { orgId, role };
  }

  async bindSlackTeam(input: { orgId: OrgId; teamId: string }): Promise<void> {
    const boundAt = this.iso();
    // The reverse item lets `closeOrg` find the org's teams; both are written together or not at all.
    await this.transact(
      [
        {
          Put: {
            TableName: this.input.tableName,
            Item: { ...slackTeamOrgKey(input.teamId), entityType: "SLACK_TEAM_ORG", orgId: input.orgId, boundAt },
            ConditionExpression: "attribute_not_exists(pk) OR orgId = :orgId",
            ExpressionAttributeValues: { ":orgId": input.orgId },
          },
        },
        { Put: { TableName: this.input.tableName, Item: { ...orgSlackTeamKey(input.orgId, input.teamId), entityType: "ORG_SLACK_TEAM", orgId: input.orgId, teamId: input.teamId, boundAt } } },
      ],
      (failed) => (failed.has(0) ? coded("SLACK_TEAM_TAKEN", "that Slack workspace is already connected to another organization") : undefined),
    );
  }

  /** Whether a removal banned this developer from the org (a single-org install only); sign-in refuses a banned developer. */
  async isBanned(orgId: OrgId, developerId: string): Promise<boolean> {
    return await this.get(orgBanKey(orgId, developerId)) !== undefined;
  }

  async listMembers(orgId: OrgId): Promise<OrgMembershipRecord[]> {
    const members: OrgMembershipRecord[] = [];
    for (const item of await this.queryPartition(orgPk(orgId), "MEMBER#")) members.push(strip(item) as unknown as OrgMembershipRecord);
    return members;
  }

  /** The member record and the developer pointer change role together; demoting the last owner is refused (LAST_OWNER). */
  async setRole(input: { orgId: OrgId; developerId: string; role: OrgRole }): Promise<void> {
    const { orgId, developerId, role } = input;
    const member = await this.get(orgMemberKey(orgId, developerId));
    if (member === undefined) throw coded("NOT_FOUND", "that person is not a member of the organization");
    const current = member.role as OrgRole;
    if (current === role) return;
    const guard = current === "owner" ? await this.otherOwnerGuard(orgId, developerId) : [];
    await this.transact(
      [
        {
          Update: {
            // `roleUpdatedAt` is what an E2E round's org-role proof records (Plan 2, Task 11), so a role changed and changed back reads as new.
            TableName: this.input.tableName, Key: orgMemberKey(orgId, developerId), UpdateExpression: "SET #role = :role, roleUpdatedAt = :at",
            ConditionExpression: "attribute_exists(pk) AND #role = :current", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": role, ":current": current, ":at": new Date(this.input.now()).toISOString() },
          },
        },
        {
          Update: {
            TableName: this.input.tableName, Key: developerOrgKey(developerId), UpdateExpression: "SET #role = :role",
            ConditionExpression: "attribute_exists(pk) AND orgId = :org", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":role": role, ":org": orgId },
          },
        },
        ...guard,
      ],
      (failed) => (failed.has(2) ? coded("LAST_OWNER", LAST_OWNER_MESSAGE) : coded("CHANGE_STALE", "the organization's members changed; try again")),
    );
  }

  /**
   * Removes a member. Their project grants and monthly limit go first (so a half-finished removal leaves a member with nothing), then one
   * transaction deletes the member record, the developer pointer and each email pointer that names them, and puts the ban when asked.
   * Removing the last owner is refused (LAST_OWNER) before anything is deleted.
   *
   * Everything the removal reads (the email pointers) is read first, and the member and the other owner are checked last, immediately before
   * the grants go. The transaction repeats both checks (the member's role is the one just read; another owner still holds the role), so a
   * change after that point fails it with CHANGE_STALE or LAST_OWNER. The one window left is the time `deleteMemberData` takes: a demotion
   * landing inside it fails the transaction after the grants and monthly limit are already gone (re-running the removal, or the person
   * being promoted again, does not bring them back). `expectedRole` is the role the caller's authorization saw; a different one is CHANGE_STALE.
   */
  async removeMember(input: { orgId: OrgId; developerId: string; emails: string[]; ban: boolean; expectedRole?: OrgRole }): Promise<void> {
    const { orgId, developerId } = input;
    if (await this.get(orgMemberKey(orgId, developerId)) === undefined) throw coded("NOT_FOUND", "that person is not a member of the organization");
    const pointers = await this.emailPointersOf(input.emails, developerId);
    const member = await this.get(orgMemberKey(orgId, developerId));
    if (member === undefined) throw coded("NOT_FOUND", "that person is not a member of the organization");
    const role = member.role as OrgRole;
    if (input.expectedRole !== undefined && input.expectedRole !== role) throw coded("CHANGE_STALE", "the organization's members changed; try again");
    const guard = role === "owner" ? await this.otherOwnerGuard(orgId, developerId) : [];
    await this.deleteMemberData(orgId, developerId);
    const items = this.removalItems(input, role, pointers, guard);
    await this.transact(items, (failed) => (guard.length > 0 && failed.has(items.length - 1) ? coded("LAST_OWNER", LAST_OWNER_MESSAGE) : failed.has(0) ? coded("CHANGE_STALE", "the organization's members changed; try again") : undefined));
  }

  /**
   * Closes an org whose sole owner is leaving. In order: its GitHub installations and Slack team bindings are released (both the org's
   * and the global item), its projects are archived and its egress domains cleared (injected: later tasks supply them), then `closedAt`
   * is set and the sole member removed without a ban. `emails` are the leaving person's email pointers, which must go so an invite
   * to another org can index them. The org's TRIAL_GITHUB claim stays. Safe to run again after a stop part-way.
   */
  async closeOrg(orgId: OrgId, deps: { archiveProjects: (orgId: OrgId) => Promise<void>; clearEgress: (orgId: OrgId) => Promise<void>; emails?: string[] }): Promise<void> {
    const members = await this.listMembers(orgId);
    if (members.length > 1 || members.some((member) => member.role !== "owner")) throw coded("LAST_OWNER", LAST_OWNER_MESSAGE);
    const meta = await this.get(orgMetaKey(orgId));
    if (meta === undefined) throw coded("NOT_FOUND", "your organization was not found");
    // From here no invite is accepted into the org, and only then is the member list read again: a join that slipped in before the fence
    // is seen by this second read and stops the close (bindings untouched); a join after it is refused by acceptInvite.
    if (meta.closedAt === undefined) {
      await this.setClosing(orgId);
      const again = await this.listMembers(orgId);
      if (again.length !== members.length || again.some((member, index) => member.developerId !== members[index]?.developerId || member.role !== "owner")) {
        await this.clearClosing(orgId);
        throw coded("LAST_OWNER", LAST_OWNER_MESSAGE);
      }
    }
    for (const binding of await this.queryPartition(orgPk(orgId), "GITHUB_INSTALLATION#")) {
      const installationId = Number(String(binding.sk).slice("GITHUB_INSTALLATION#".length));
      await this.deleteIfOurs(githubInstallationKey(installationId), orgId);
      await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: { pk: binding.pk, sk: binding.sk } }));
    }
    for (const binding of await this.queryPartition(orgPk(orgId), "SLACK_TEAM#")) {
      await this.deleteIfOurs(slackTeamOrgKey(String(binding.sk).slice("SLACK_TEAM#".length)), orgId);
      await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: { pk: binding.pk, sk: binding.sk } }));
    }
    await deps.archiveProjects(orgId);
    await deps.clearEgress(orgId);
    const [sole] = members;
    if (sole === undefined) return;
    await this.deleteMemberData(orgId, sole.developerId);
    await this.transact(
      [
        {
          Update: {
            TableName: this.input.tableName, Key: orgMetaKey(orgId), UpdateExpression: "SET closedAt = :at REMOVE closingAt",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":at": this.iso() },
          },
        },
        ...this.removalItems({ orgId, developerId: sole.developerId, ban: false }, sole.role, await this.emailPointersOf(deps.emails ?? [], sole.developerId), []),
      ],
      () => coded("CHANGE_STALE", "the organization changed while it was closing; try again"),
    );
  }

  /** Stops invites into the org while it closes (`closingAt`); kept if already set, so a stopped close can be run again. */
  private async setClosing(orgId: OrgId): Promise<void> {
    try {
      await this.input.documentClient.send(new UpdateCommand({
        TableName: this.input.tableName, Key: orgMetaKey(orgId), UpdateExpression: "SET closingAt = if_not_exists(closingAt, :at)",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":at": this.iso() },
      }));
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") throw coded("CHANGE_STALE", "the organization changed while it was closing; try again");
      throw error;
    }
  }

  private async clearClosing(orgId: OrgId): Promise<void> {
    await this.input.documentClient.send(new UpdateCommand({
      TableName: this.input.tableName, Key: orgMetaKey(orgId), UpdateExpression: "REMOVE closingAt", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)",
    })).catch((error: unknown) => {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    });
  }

  /** The reverse of a GitHub or Slack binding's global item, deleted only while it still names this org. */
  private async deleteIfOurs(key: OrgKey, orgId: OrgId): Promise<void> {
    try {
      await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: key, ConditionExpression: "orgId = :org", ExpressionAttributeValues: { ":org": orgId } }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
  }

  /** The `ORG_EMAIL#` pointers among `emails` that name this developer (another person's pointer, or none, is left alone). */
  private async emailPointersOf(emails: string[], developerId: string): Promise<string[]> {
    const keys = [...new Set(emails.map((email) => orgEmailKey(email).pk))];
    const found = await Promise.all(keys.map(async (pk) => ({ pk, item: await this.get({ pk, sk: "DEVELOPER" }) })));
    return found.filter(({ item }) => item?.developerId === developerId).map(({ pk }) => pk);
  }

  /** A check that another owner still holds the role at the moment of the transaction; LAST_OWNER when there is none. */
  private async otherOwnerGuard(orgId: OrgId, except: string): Promise<TransactItem[]> {
    const other = (await this.listMembers(orgId)).find((member) => member.role === "owner" && member.developerId !== except);
    if (other === undefined) throw coded("LAST_OWNER", LAST_OWNER_MESSAGE);
    return [{ ConditionCheck: { TableName: this.input.tableName, Key: orgMemberKey(orgId, other.developerId), ConditionExpression: "#role = :owner", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":owner": "owner" } } }];
  }

  /** The transaction items that end a membership: member, pointer, the person's email pointers and, given `ban`, the ban. */
  private removalItems(input: { orgId: OrgId; developerId: string; ban: boolean }, seenRole: OrgRole, emailPointers: string[], guard: TransactItem[]): TransactItem[] {
    const { orgId, developerId } = input;
    return [
      // Only while the member still holds the role that was read: a promotion in between fails the transaction.
      { Delete: { TableName: this.input.tableName, Key: orgMemberKey(orgId, developerId), ConditionExpression: "attribute_exists(pk) AND #role = :seen", ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":seen": seenRole } } },
      { Delete: { TableName: this.input.tableName, Key: developerOrgKey(developerId), ConditionExpression: "attribute_exists(pk) AND orgId = :org", ExpressionAttributeValues: { ":org": orgId } } },
      ...emailPointers.map((pk): TransactItem => ({
        Delete: { TableName: this.input.tableName, Key: { pk, sk: "DEVELOPER" }, ConditionExpression: "developerId = :dev", ExpressionAttributeValues: { ":dev": developerId } },
      })),
      // The tombstone ruling R60 reads: this person was a member and is not now. Their running tasks stop at the next dispatch.
      { Put: { TableName: this.input.tableName, Item: { ...orgRemovedKey(orgId, developerId), entityType: "ORG_REMOVED", orgId, developerId, removedAt: this.iso() } } },
      ...(input.ban ? [{ Put: { TableName: this.input.tableName, Item: { ...orgBanKey(orgId, developerId), entityType: "ORG_BAN", orgId, developerId, bannedAt: this.iso() } } }] : []),
      ...guard,
    ];
  }

  /** A member's project grants and monthly limit (and the proxy-sync marker for it), which end with their membership. */
  private async deleteMemberData(orgId: OrgId, developerId: string): Promise<void> {
    for (const grant of await this.queryPartition(memberGrantsPk(orgId, developerId), MEMBER_GRANT_SK_PREFIX)) {
      await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: { pk: grant.pk, sk: grant.sk } }));
    }
    await this.input.documentClient.send(new DeleteCommand({ TableName: this.input.tableName, Key: budgetSyncedKey(orgId, developerId) }));
    const key = orgSettingsKey(orgId, "BUDGET");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const item = await this.get(key);
      const seen = item?.memberOverrides;
      if (item === undefined || typeof seen !== "object" || seen === null || !Object.hasOwn(seen, developerId)) return;
      const others = Object.fromEntries(Object.entries(seen).filter(([id]) => id !== developerId));
      try {
        // The whole item is written back, as the budget settings are; the condition keeps a concurrent edit of the overrides from being lost.
        await this.input.documentClient.send(new PutCommand({ TableName: this.input.tableName, Item: { ...item, memberOverrides: others }, ConditionExpression: "memberOverrides = :seen", ExpressionAttributeValues: { ":seen": seen } }));
        return;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
    throw coded("CHANGE_STALE", "the organization's budget settings kept changing; try again");
  }

  private async queryPartition(pk: string, prefix: string): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return items;
  }

  async orgForSlackTeam(teamId: string): Promise<OrgId | undefined> {
    const item = await this.get(slackTeamOrgKey(teamId));
    return item === undefined ? undefined : (item.orgId as OrgId);
  }
}

const coded = (code: AgentXErrorCode, message: string) => agentXError(code, message);
const alreadyInOrg = () => coded("ALREADY_IN_ORG", "this developer already belongs to an organization");
const LAST_OWNER_MESSAGE = "An organization needs at least one owner. Make someone else an owner first.";
const inviteInvalid = () => coded("INVITE_INVALID", "the invite is unknown, expired or already used");
