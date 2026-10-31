// Enterprise foundations I-5 (fix round 1): the first-run bootstrap of company group sign-in.
//
// A new Enterprise install has nobody who can sign in: with no mapping every sign-in is refused, break-glass needs a saved list and a person who is already an owner, and the
// routes that write the mapping need a signed-in admin. The installer runs this once, with their AWS credentials (`rovara sso bootstrap`): it makes the named people the
// install's owners, writes the first mapping and the first emergency list, and records both in the audit ledger. It refuses once a mapping or a list exists, so it can
// never be used to change a running install: after that the admin routes are the only way.
import { EditionSchema, GroupMappingConfigSchema, GroupMappingRuleSchema, GroupClaimNameSchema, agentXError, BREAK_GLASS_MAX_DAYS, requireFeature, singleOrgIdForEnv, type EditionPolicy, type OrgId } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { auditOccurrence, auditSsoBreakGlassChanged, auditSsoGroupMappingChanged } from "../audit/events.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { ownerKeyForSubject } from "../aws/lambda.js";
import { OrgStore } from "../org/store.js";
import { ssoStoresFor } from "./sso-sign-in.js";

export const SSO_BOOTSTRAP_EXISTS_MESSAGE = "Company sign-in is already set up on this install. Change it from the admin page; the bootstrap runs once.";
export const SSO_BOOTSTRAP_EDITION_MESSAGE = "Company group sign-in belongs to the Enterprise edition, and this install is not recorded as Enterprise.";

export interface SsoBootstrapInput {
  env: string;
  /** The company sign-in's issuer, as `rovara signin enable oidc` stored it. */
  oidcIssuer: string;
  /** The recorded edition of the install (`/agentx/<env>/edition`); anything but Enterprise is refused. */
  recordedEdition: string | undefined;
  claim: string;
  adminGroups: readonly string[];
  memberGroups: readonly string[];
  /** The `sub` of one or two people (as the identity provider names them) who become owners. */
  ownerSubjects: readonly string[];
  breakGlassDays: number;
  /** Who ran it: the installer's AWS caller ARN. Only a hash of it is recorded. */
  installerArn: string;
  nowMs: number;
}

export interface SsoBootstrapDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  policy: EditionPolicy;
  /** The Audit Ledger's outbox. A bootstrap that could not be recorded is not made. */
  audit: AuditRuntime | undefined;
}

export interface SsoBootstrapResult { orgId: OrgId; ownerIds: string[]; rules: number; breakGlassUntil: string }

const slug = (prefix: string, index: number) => `${prefix}-${String(index + 1)}`;

export async function bootstrapSso(deps: SsoBootstrapDeps, input: SsoBootstrapInput): Promise<SsoBootstrapResult> {
  requireFeature(deps.policy, "sso");
  if (EditionSchema.safeParse(input.recordedEdition).data !== "enterprise") throw agentXError("CONFIG_INVALID", SSO_BOOTSTRAP_EDITION_MESSAGE);
  if (deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", "Company sign-in cannot be set up without the audit ledger.");
  if (input.ownerSubjects.length < 1 || input.ownerSubjects.length > 2) throw agentXError("CONFIG_INVALID", "Name one or two owners.");
  if (new Set(input.ownerSubjects).size !== input.ownerSubjects.length) throw agentXError("CONFIG_INVALID", "Name each owner once.");
  if (input.adminGroups.length < 1) throw agentXError("CONFIG_INVALID", "Name at least one group that administers Rovara.");
  if (!Number.isInteger(input.breakGlassDays) || input.breakGlassDays < 1 || input.breakGlassDays > BREAK_GLASS_MAX_DAYS) throw agentXError("CONFIG_INVALID", `The emergency list lasts 1 to ${String(BREAK_GLASS_MAX_DAYS)} days.`);
  const claim = GroupClaimNameSchema.safeParse(input.claim);
  if (!claim.success) throw agentXError("CONFIG_INVALID", "The claim is not one that carries groups.");
  const rules = [
    ...input.adminGroups.map((group, index) => ({ id: slug("admins", index), group, orgRole: "admin" as const, projectRoles: [] })),
    ...input.memberGroups.map((group, index) => ({ id: slug("members", index), group, orgRole: "member" as const, projectRoles: [] })),
  ].map((rule) => GroupMappingRuleSchema.parse(rule));

  // The whole mapping is checked (duplicate groups, a role that cannot be granted) before anything is written.
  if (!GroupMappingConfigSchema.safeParse({ claim: claim.data, rules, version: 1, updatedAt: new Date(input.nowMs).toISOString(), updatedBy: "0".repeat(64) }).success) throw agentXError("CONFIG_INVALID", "The groups are not a valid mapping (each group once).");
  const orgId = singleOrgIdForEnv(input.env);
  const installer = `op_${createHash("sha256").update(input.installerArn).digest("hex").slice(0, 24)}`;
  const stores = ssoStoresFor({ documentClient: deps.documentClient, tableName: deps.tableName, policy: deps.policy, audit: deps.audit })!;
  // Once, and only on an install nobody has configured.
  if (await stores.mappings.get(orgId) !== undefined || await stores.breakGlass.get(orgId) !== undefined) throw agentXError("CONFIG_INVALID", SSO_BOOTSTRAP_EXISTS_MESSAGE);

  const occurredAt = new Date(input.nowMs).toISOString();
  const orgs = new OrgStore({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => input.nowMs, audit: deps.audit });
  await orgs.ensureOrg(orgId, input.env);
  const ownerIds: string[] = [];
  for (const subject of input.ownerSubjects) {
    const developerId = ownerKeyForSubject(input.oidcIssuer.replace(/\/+$/, ""), subject);
    const existing = await orgs.orgForDeveloper(developerId);
    if (existing === undefined) await orgs.addMember({ orgId, developerId, role: "owner" });
    else if (existing.orgId !== orgId || existing.role !== "owner") throw agentXError("CONFIG_INVALID", "A named owner already belongs to this install in another role.");
    ownerIds.push(developerId);
  }

  const actor = { kind: "operator" as const, id: installer };
  const mapping = await stores.mappings.put(orgId, { claim: claim.data, rules, updatedAt: occurredAt, updatedBy: createHash("sha256").update(installer).digest("hex") }, 0, [
    auditSsoGroupMappingChanged({ orgId, actor, occurredAt, occurrence: auditOccurrence("bootstrap", "1"), fromVersion: 0, toVersion: 1, rules: rules.length, added: rules.map((rule) => rule.id), removed: [] }),
  ]);
  GroupMappingConfigSchema.parse(mapping);
  const until = input.nowMs + input.breakGlassDays * 86_400_000;
  await stores.breakGlass.put(orgId, ownerIds.map((personId) => ({ personId, expiresAt: until })), createHash("sha256").update(installer).digest("hex"), 0, input.nowMs, [
    auditSsoBreakGlassChanged({ orgId, actor, occurredAt, occurrence: auditOccurrence("bootstrap", "1"), toVersion: 1, owners: ownerIds.length, ownerIds }),
  ]);
  return { orgId, ownerIds, rules: rules.length, breakGlassUntil: new Date(until).toISOString() };
}
