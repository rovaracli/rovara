// packages/broker/src/org/store.ts
// Multi-tenancy: orgs, membership, invites and the Slack team binding. A developer belongs to at
// most one org (the developer pointer's `attribute_not_exists(pk)` condition enforces it), and an
// invite is accepted in one transaction with the membership writes, so a refused acceptance never
// burns the invite. Invite tokens are stored only as SHA-256 hashes.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError,
  developerOrgKey,
  newOrgId as generateOrgId,
  orgEmailKey,
  orgInviteKey,
  orgMemberKey,
  orgMetaKey,
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

const DEFAULT_INVITE_TTL_SECONDS = 604_800;
const NOT_EXISTS = "attribute_not_exists(pk)";

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

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

const normalizeEmail = (email: string) => email.trim().toLowerCase();

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

  async createInvite(input: { orgId: OrgId; createdBy: string; role: Exclude<OrgRole, "owner">; email?: string; ttlSeconds?: number }): Promise<{ token: string }> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(token);
    const ttlMs = (input.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000;
    const invite: OrgInviteRecord = {
      orgId: input.orgId,
      tokenHash,
      ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
      role: input.role,
      createdBy: input.createdBy,
      createdAt: this.iso(),
      expiresAt: new Date(this.input.now() + ttlMs).toISOString(),
    };
    await this.input.documentClient.send(new PutCommand({
      TableName: this.input.tableName,
      Item: { ...orgInviteKey(tokenHash), entityType: "ORG_INVITE", ...invite },
      ConditionExpression: NOT_EXISTS,
    }));
    return { token };
  }

  async acceptInvite(input: { token: string; developerId: string; email?: string }): Promise<{ orgId: OrgId; role: OrgRole }> {
    const tokenHash = sha256Hex(input.token);
    const invite = await this.get(orgInviteKey(tokenHash)) as (Item & OrgInviteRecord) | undefined;
    const nowIso = this.iso();
    if (invite === undefined || invite.acceptedAt !== undefined || invite.expiresAt <= nowIso) throw inviteInvalid();
    const { orgId, role } = invite;
    // One transaction: the invite is marked accepted only if the developer joins, and joins only if
    // the invite is still live, so a refusal on either side leaves the other untouched.
    await this.transact(
      [
        {
          Update: {
            TableName: this.input.tableName,
            Key: orgInviteKey(tokenHash),
            UpdateExpression: "SET acceptedBy = :by, acceptedAt = :at",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(acceptedAt) AND expiresAt > :now",
            ExpressionAttributeValues: { ":by": input.developerId, ":at": nowIso, ":now": nowIso },
          },
        },
        ...this.membershipItems({ orgId, developerId: input.developerId, role, email: input.email }),
      ],
      (failed) => {
        if (failed.has(0)) return inviteInvalid();
        return failed.has(1) || failed.has(2) || failed.has(3) ? alreadyInOrg() : undefined;
      },
    );
    return { orgId, role };
  }

  async bindSlackTeam(input: { orgId: OrgId; teamId: string }): Promise<void> {
    try {
      await this.input.documentClient.send(new PutCommand({
        TableName: this.input.tableName,
        Item: { ...slackTeamOrgKey(input.teamId), entityType: "SLACK_TEAM_ORG", orgId: input.orgId, boundAt: this.iso() },
        ConditionExpression: "attribute_not_exists(pk) OR orgId = :orgId",
        ExpressionAttributeValues: { ":orgId": input.orgId },
      }));
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") throw coded("SLACK_TEAM_TAKEN", "that Slack workspace is already connected to another organization");
      throw error;
    }
  }

  async orgForSlackTeam(teamId: string): Promise<OrgId | undefined> {
    const item = await this.get(slackTeamOrgKey(teamId));
    return item === undefined ? undefined : (item.orgId as OrgId);
  }
}

const coded = (code: AgentXErrorCode, message: string) => agentXError(code, message);
const alreadyInOrg = () => coded("ALREADY_IN_ORG", "this developer already belongs to an organization");
const inviteInvalid = () => coded("INVITE_INVALID", "the invite is unknown, expired or already used");
