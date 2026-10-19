// Multi-tenancy: org identity, roles, record shapes and the DynamoDB key helpers every org-scoped
// store builds on. `orgScoped` is the prefix for every collision-prone key.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

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
}

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
  return { pk: `DEVELOPER#${developerId}`, sk: "ORG" };
}

export function orgInviteKey(tokenHash: string): OrgKey {
  return { pk: `ORG_INVITE#${tokenHash}`, sk: "META" };
}

export function slackTeamOrgKey(teamId: string): OrgKey {
  return { pk: `SLACK_TEAM#${teamId}`, sk: "ORG" };
}

export function orgEmailKey(email: string): OrgKey {
  return { pk: `ORG_EMAIL#${email.trim().toLowerCase()}`, sk: "DEVELOPER" };
}
