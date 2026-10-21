// Multi-tenancy: org identity, roles, record shapes and the DynamoDB key helpers every org-scoped
// store builds on. `orgScoped` is the prefix for every collision-prone key.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { normalizeEmail } from "./email.js";

export const OrgIdSchema = z.string().regex(/^org_[0-9a-z]{20}$/);
export type OrgId = z.infer<typeof OrgIdSchema>;

export const OrgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

export interface OrgRecord {
  orgId: OrgId;
  name: string;
  createdAt: string;
  /** developerId of the creator. */
  createdBy: string;
  plan: "trial" | "team";
  /** When connecting GitHub unlocked this trial org (epoch milliseconds); absent while it is locked. Only a `trial` org is ever locked. */
  trialUnlockedAt?: number;
  /** The GitHub account whose connection unlocked the trial; it can unlock no other org. */
  trialGithubUserId?: string;
  /**
   * Ruling R55: the one GitHub account or organization login (lower case) whose repositories an owner or admin of this cloud org may
   * register as projects. Only an operator sets it; absent, the org cannot create projects.
   */
  githubOwner?: string;
  /** When the org was closed (its sole owner left, or the race org of a duplicate sign-in was retired); a closed org takes no new members. */
  closedAt?: string;
  /** Set while the sole owner's leave closes the org: from then on no invite is accepted into it. A stopped close is run again by the owner. */
  closingAt?: string;
}

/** A GitHub account or organization login, stored lower case: 1 to 39 letters, digits and single hyphens, never starting or ending with one. */
export const GithubOwnerSchema = z.string().trim().min(1).max(39)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, "must be a GitHub account or organization login")
  .transform((login) => login.toLowerCase());

export interface OrgMembershipRecord {
  orgId: OrgId;
  developerId: string;
  role: OrgRole;
  joinedAt: string;
}

export interface OrgInviteRecord {
  orgId: OrgId;
  tokenHash: string;
  email?: string;
  role: Exclude<OrgRole, "owner">;
  createdBy: string;
  /** The request that created it (POST /v1/dev/org/invites); a replay of that request is refused. */
  requestId?: string;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
}

const ORG_ID_BODY_LENGTH = 20;
const MIN_RANDOM_BYTES = 16;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * 20 base36 characters from at least 16 random bytes. The value is reduced modulo 36^20, so the
 * mapping is uniform up to a bias below 2^-24 for 16 bytes and smaller for more.
 */
export function newOrgId(random: () => Uint8Array = () => randomBytes(32)): OrgId {
  const bytes = random();
  if (bytes.length < MIN_RANDOM_BYTES) throw new Error(`org id needs at least ${MIN_RANDOM_BYTES} random bytes`);
  const body = (bytesToBigInt(bytes) % 36n ** BigInt(ORG_ID_BODY_LENGTH)).toString(36).padStart(ORG_ID_BODY_LENGTH, "0");
  return OrgIdSchema.parse(`org_${body}`);
}

/** The deterministic org id for a single-org environment (ruling R3): base36 of SHA-256(env). */
export function singleOrgIdForEnv(env: string): OrgId {
  const digest = createHash("sha256").update(env, "utf8").digest();
  const body = bytesToBigInt(digest).toString(36).padStart(ORG_ID_BODY_LENGTH, "0").slice(0, ORG_ID_BODY_LENGTH);
  return OrgIdSchema.parse(`org_${body}`);
}

export interface OrgKey {
  pk: string;
  sk: string;
}

export function orgPk(orgId: OrgId): string {
  return `ORG#${orgId}`;
}

export function orgScoped(orgId: OrgId, key: string): string {
  return `ORG#${orgId}#${key}`;
}

export function orgMetaKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "META" };
}

export function orgMemberKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `MEMBER#${developerId}` };
}

/** Pointer from a developer to their org. */
export function developerOrgKey(developerId: string): OrgKey {
  return { pk: `DEVELOPER_ORG#${developerId}`, sk: "ORG" };
}

export function orgInviteKey(tokenHash: string): OrgKey {
  return { pk: `ORG_INVITE#${tokenHash}`, sk: "META" };
}

/** Marks that an org's invite request was served, so a replay of the same requestId is refused rather than minting a second invite. */
export function orgInviteRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `INVITE_REQUEST#${requestId}` };
}

export function slackTeamOrgKey(teamId: string): OrgKey {
  return { pk: `SLACK_TEAM#${teamId}`, sk: "ORG" };
}

/** The claim a GitHub account holds on the one trial it unlocked. Global, not org-scoped: a second org must find it. */
export function trialGithubKey(githubUserId: string): OrgKey {
  return { pk: `TRIAL_GITHUB#${githubUserId}`, sk: "ORG" };
}

export function orgEmailKey(email: string): OrgKey {
  return { pk: `ORG_EMAIL#${normalizeEmail(email).email}`, sk: "DEVELOPER" };
}

/** A developer removed from a single-org install, who may not rejoin it by signing in again until an invite clears this item. */
export function orgBanKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "BAN"), sk: developerId };
}

/**
 * Written when a person is removed from an org or leaves it, and never deleted. A task's creator who is not a member is refused (ruling
 * R60) only when this says they once were: a Slack user who has not signed in yet has no member record and is not removed.
 */
export function orgRemovedKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "REMOVED"), sk: developerId };
}

/** The reverse of `slackTeamOrgKey`, in the org's own partition, so closing the org finds the Slack teams it bound. */
export function orgSlackTeamKey(orgId: OrgId, teamId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `SLACK_TEAM#${teamId}` };
}

/** A GitHub App installation bound to an org. Global, so a second org finds it. */
export function githubInstallationKey(installationId: number): OrgKey {
  return { pk: `GITHUB_INSTALLATION#${String(installationId)}`, sk: "ORG" };
}

/** The same binding in the org's own partition, so closing the org finds its installations. */
export function orgGithubInstallationKey(orgId: OrgId, installationId: number): OrgKey {
  return { pk: orgPk(orgId), sk: `GITHUB_INSTALLATION#${String(installationId)}` };
}

/**
 * One connect attempt (Plan 2, Task 13), keyed by the SHA-256 of its state (base64url). It holds who started it and for which org, and
 * later what the callback found and the hash of the confirmation token; it is single use (`consumedAt`) and short lived (`expiresAt`).
 */
export function githubConnectStateKey(stateHash: string): OrgKey {
  return { pk: `GITHUB_CONNECT#${stateHash}`, sk: "META" };
}

/**
 * Written once when an installation is first bound to an org, and never deleted (not by a disconnect, not by closing the org): it says the
 * installation was bound before. `firstBoundAt` and `firstOrgId` are set only the first time. Task 14's request flow never binds an
 * installation that has one.
 */
export function githubInstallationEverBoundKey(installationId: number): OrgKey {
  return { pk: `GITHUB_INSTALLATION#${String(installationId)}`, sk: "EVER_BOUND" };
}

export interface GithubInstallationRecord {
  installationId: number;
  orgId: OrgId;
  accountLogin: string;
  accountId: number;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  installedByGithubUserId: string;
  boundByDeveloperId: string;
  status: "active" | "suspended" | "removed";
  boundAt: string;
  updatedAt: string;
}
