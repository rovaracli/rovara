// Enterprise foundations I1: the admin routes for company group sign-in. They exist in the Enterprise edition only.
//
//   GET /v1/app/org/sso/group-mapping    the saved mapping (an owner or admin)
//   PUT /v1/app/org/sso/group-mapping    saves it (an owner or admin, a live browser session, compare-and-set on the version, audited in the same transaction)
//   GET /v1/app/org/sso/break-glass      the break-glass owners (an owner)
//   PUT /v1/app/org/sso/break-glass      saves them (an owner, a live browser session; at most two current owners, each with an expiry within 90 days)
//   GET /v1/app/org/sso/saml             the SAML identity provider settings (an owner or admin) and the addresses to give the provider (I4)
//   PUT /v1/app/org/sso/saml             saves them (an owner or admin, a live browser session AND a fresh sign-in, compare-and-set on the version, audited in the same transaction)
//
// A mapping never grants owner (the schema refuses it), so saving one cannot make anyone an owner. Nothing here echoes the provider's words: refusals are fixed sentences.
import { X509Certificate } from "node:crypto";
import { z } from "zod";
import {
  AUDIT_ERROR_MESSAGES, BREAK_GLASS_MAX_DAYS, BreakGlassOwnersSchema, GroupMappingConfigSchema, GroupMappingRuleSchema, GroupClaimNameSchema, SamlIdpSettingsSchema, agentXError, requireFeature, singleOrgIdForEnv, type GroupMappingConfig, type OrgId,
} from "@agentx/contracts";
import { auditOccurrence, auditSsoBreakGlassChanged, auditSsoGroupMappingChanged, auditSsoSamlChanged } from "../../audit/events.js";
import { samlServiceProviderAddresses } from "../../developer/saml.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { evaluateGroupMapping } from "../../developer/group-mapping.js";
import { isFreshSignIn, type DeveloperRecord, type SessionRecord } from "../../developer/store.js";
import { sendSamlSettingsChangedNotice } from "../../developer/identity-notice.js";
import { getSignIn } from "./authentication.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const GROUP_MAPPING_PATH = "/v1/app/org/sso/group-mapping";
export const BREAK_GLASS_PATH = "/v1/app/org/sso/break-glass";
export const SAML_PATH = "/v1/app/org/sso/saml";
export const isSsoRoute = (pathname: string): boolean => pathname === GROUP_MAPPING_PATH || pathname === BREAK_GLASS_PATH || pathname === SAML_PATH;

const MappingBodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  claim: GroupClaimNameSchema,
  rules: z.array(GroupMappingRuleSchema).min(1),
}).strict();

const SamlBodySchema = SamlIdpSettingsSchema.extend({ expectedVersion: z.number().int().min(0) }).strict();

const BreakGlassBodySchema = z.object({ expectedVersion: z.number().int().min(0), owners: BreakGlassOwnersSchema }).strict();

const systemSaved = (caller: DeveloperCaller): { updatedAt: string; updatedBy: string } => ({ updatedAt: new Date().toISOString(), updatedBy: caller.developerId });

export const SSO_FRESH_SIGN_IN_MESSAGE = "Sign in again to change company sign-in.";
export const SAML_ENTITY_ID_RESERVED_MESSAGE = "That entity id is already used by another sign-in method of this installation. Use the identity provider's own SAML entity id.";
export const SAML_ENTITY_ID_LOCKED_MESSAGE = "The identity provider's entity id cannot be changed once saved: people's accounts are tied to it. To move to a different identity provider, ask Rovara support.";

/**
 * A change to company sign-in needs a live browser session AND a sign-in made within the last few minutes (the same rule as the other high-risk actions): saving a
 * mapping can make any provider group an admin, and saving the emergency list decides who can bypass the mapping. And it needs the audit ledger: a change that could not
 * be recorded is not made.
 */
async function requireFreshBrowserWrite(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<Pick<SessionRecord, "groupClaims" | "ssoBreakGlass">> {
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", "Use a live browser session to change company sign-in.");
  const session = await getSignIn<Pick<SessionRecord, "authTime" | "groupClaims" | "ssoBreakGlass">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", SSO_FRESH_SIGN_IN_MESSAGE);
  if (deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE);
  return session;
}

export const lockoutMessage = (claim: string): string =>
  `This mapping would lock you out: the groups in your last sign-in (claim "${claim}") match none of its rules. Add a rule for one of your groups, or check the claim name, then save again.`;

/**
 * Emails every owner of the org that the SAML settings changed, by whom and what kind of change (not the values). After the change has committed: a mail that cannot be sent is logged and never
 * undoes or fails the save (the audit record is the durable one).
 */
async function tellOwnersOfSamlChange(deps: DeveloperRouteDependencies, orgId: OrgId, caller: DeveloperCaller, changed: readonly string[]): Promise<void> {
  const notice = deps.ownerNotice;
  const log = notice?.log ?? (() => undefined);
  try {
    if (notice === undefined || deps.orgs === undefined) {
      log({ event: "saml.settings_notice_skipped", reason: "no_sender" });
      return;
    }
    const owners = (await deps.orgs.listMembers(orgId)).filter((member) => member.role === "owner").slice(0, 20);
    const cellUrl = deps.developer.webOrigin ?? new URL(deps.developer.issuer).origin;
    for (const owner of owners) {
      try {
        const email = (await getSignIn<Pick<DeveloperRecord, "email">>(deps, `DEVELOPER#${owner.developerId}`))?.email;
        if (email === undefined) {
          log({ event: "saml.settings_notice_skipped", reason: "no_address" });
          continue;
        }
        await sendSamlSettingsChangedNotice(notice, { to: email, actorName: caller.name, changed, cellUrl });
      } catch (error) {
        log({ event: "saml.settings_notice_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    }
  } catch (error) {
    log({ event: "saml.settings_notice_failed", error: error instanceof Error ? error.name : "unknown" });
  }
}

export async function routeSsoRequest(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, pathname: string): Promise<unknown> {
  // Not in this edition: an install with no edition has no company sign-in to configure, and Public is told so in the edition's own words.
  if (deps.editionPolicy === undefined) throw agentXError("NOT_FOUND", "company sign-in is not set up in this deployment");
  requireFeature(deps.editionPolicy, "sso");
  if (deps.sso === undefined) throw agentXError("NOT_FOUND", "company sign-in is not set up in this deployment");
  const stores = deps.sso;
  const orgId = caller.orgId;
  const isOwner = caller.orgRole === "owner";
  const isAdmin = isOwner || caller.orgRole === "admin";

  if (pathname === GROUP_MAPPING_PATH) {
    if (!isAdmin) throw agentXError("FORBIDDEN", "Only an owner or admin can see or change company sign-in.");
    if (request.method === "GET") {
      const mapping = await stores.mappings.get(orgId);
      return { mapping: mapping ?? null, version: mapping?.version ?? 0 };
    }
    if (request.method === "PUT") {
      const own = await requireFreshBrowserWrite(deps, caller);
      const parsed = MappingBodySchema.safeParse(jsonBody(request));
      if (!parsed.success) throw agentXError("CONFIG_INVALID", "The group mapping is not valid.");
      const { expectedVersion, claim, rules } = parsed.data;
      const current = await stores.mappings.get(orgId);
      if ((current?.version ?? 0) !== expectedVersion) throw agentXError("IDEMPOTENCY_CONFLICT", "Someone else changed the group mapping. Reload it and make your change again.");
      // Fix round 2 (N-2): the saving admin's own groups, as their last company sign-in carried them, must still get in under the NEW mapping; a claim name the provider does
      // not send, or rules that name no group of theirs, would refuse every sign-in. A session that came in through the emergency list is the recovery actor and is not held to it.
      if (own.ssoBreakGlass !== true) {
        const mine = evaluateGroupMapping({ policy: deps.editionPolicy, config: { claim, rules, version: expectedVersion + 1, updatedAt: new Date().toISOString(), updatedBy: caller.developerId }, claims: own.groupClaims ?? {} });
        if (!mine.ok) throw agentXError("CONFIG_INVALID", lockoutMessage(claim));
      }
      const before = new Set((current?.rules ?? []).map((rule) => rule.id));
      const after = new Set(rules.map((rule) => rule.id));
      const saved = systemSaved(caller);
      const config: Omit<GroupMappingConfig, "version"> = { claim, rules, ...saved };
      const event = auditSsoGroupMappingChanged({
        orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: saved.updatedAt, occurrence: auditOccurrence(String(expectedVersion + 1)),
        fromVersion: expectedVersion, toVersion: expectedVersion + 1, rules: rules.length,
        added: [...after].filter((id) => !before.has(id)).sort(), removed: [...before].filter((id) => !after.has(id)).sort(),
      });
      // The schema is checked again by the store (`owner` is refused there too); the audit record commits with the save.
      GroupMappingConfigSchema.parse({ ...config, version: expectedVersion + 1 });
      const next = await stores.mappings.put(orgId, config, expectedVersion, [event]);
      return { mapping: next, version: next.version };
    }
    throw agentXError("NOT_FOUND", "route not found");
  }

  if (pathname === SAML_PATH) {
    if (!isAdmin) throw agentXError("FORBIDDEN", "Only an owner or admin can see or change company sign-in.");
    // The settings are for the install's own organization, the one sign-in reads them from (review N4); a caller of any other would save settings no sign-in would ever read.
    if (orgId !== singleOrgIdForEnv(deps.developer.env)) throw agentXError("FORBIDDEN", "SAML sign-in is set up for this installation's own organization only.");
    const addresses = samlServiceProviderAddresses(deps.developer.issuer);
    if (request.method === "GET") {
      const saved = await stores.saml.config.get(orgId);
      return { settings: saved ?? null, version: saved?.version ?? 0, serviceProvider: addresses };
    }
    if (request.method === "PUT") {
      // High risk, owners only (as the emergency sign-in list is): the identity provider named here decides who can sign in as whom, the owner included. A live browser session, a
      // sign-in within the last few minutes, and a ledger to record it in. Every owner is told of every change.
      if (!isOwner) throw agentXError("FORBIDDEN", "Only an owner can change SAML sign-in.");
      await requireFreshBrowserWrite(deps, caller);
      const parsed = SamlBodySchema.safeParse(jsonBody(request));
      if (!parsed.success) throw agentXError("CONFIG_INVALID", "The SAML settings are not valid.");
      const { expectedVersion, ...settings } = parsed.data;
      const current = await stores.saml.config.get(orgId);
      if ((current?.version ?? 0) !== expectedVersion) throw agentXError("IDEMPOTENCY_CONFLICT", "Someone else changed the SAML settings. Reload them and make your change again.");
      // People's accounts are keyed on the provider's entity id: changing it would give every person a new, empty account.
      if (current !== undefined && current.idpEntityId !== settings.idpEntityId) throw agentXError("CONFIG_INVALID", SAML_ENTITY_ID_LOCKED_MESSAGE);
      // The entity id is never one of the install's other issuers (review B1): the account key carries a method prefix already, and this keeps a saved value from reading as another method's.
      const plain = (issuer: string) => issuer.replace(/\/+$/, "").toLowerCase();
      if ((deps.developer.reservedIssuers ?? []).some((issuer) => plain(issuer) === plain(settings.idpEntityId))) throw agentXError("CONFIG_INVALID", SAML_ENTITY_ID_RESERVED_MESSAGE);
      const now = deps.now();
      const changed = [
        ...(current === undefined || current.idpEntityId !== settings.idpEntityId ? ["entity_id"] : []),
        ...(current === undefined || current.ssoUrl !== settings.ssoUrl ? ["sign_in_address"] : []),
        ...(current === undefined || current.certificate !== settings.certificate ? ["certificate"] : []),
        ...(current === undefined || current.enabled !== settings.enabled ? ["enabled"] : []),
        ...((current?.trustEmail ?? false) !== settings.trustEmail ? ["trust_email"] : []),
      ];
      // SAML sessions that started before now are over when SAML is turned off, the certificate changes or the entity id changes (review S3): a leaked signing key must not leave
      // already-issued sessions standing. Rounded up, so a session of the same second ends too.
      const endSessions = current !== undefined && (!settings.enabled || current.certificate !== settings.certificate || current.idpEntityId !== settings.idpEntityId);
      const sessionsValidFrom = endSessions ? Math.ceil(now / 1000) : current?.sessionsValidFrom ?? 0;
      // The store checks the certificate (a real, unexpired certificate with an RSA key of 2048 bits or more) before it saves; the fingerprint is read here only for the record.
      let certificateSha256: string | undefined;
      try {
        certificateSha256 = new X509Certificate(settings.certificate).fingerprint256.replace(/:/g, "").toLowerCase();
      } catch {
        certificateSha256 = undefined;
      }
      const event = auditSsoSamlChanged({
        orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(now).toISOString(), occurrence: auditOccurrence(String(expectedVersion + 1)),
        fromVersion: expectedVersion, toVersion: expectedVersion + 1, changed, ...(certificateSha256 === undefined ? {} : { certificateSha256 }),
      });
      const next = await stores.saml.config.put(orgId, { ...settings, sessionsValidFrom }, caller.developerId, expectedVersion, now, [event]);
      await tellOwnersOfSamlChange(deps, orgId, caller, changed);
      return { settings: next, version: next.version, serviceProvider: addresses };
    }
    throw agentXError("NOT_FOUND", "route not found");
  }

  // break-glass
  if (!isOwner) throw agentXError("FORBIDDEN", "Only an owner can see or change the emergency sign-in list.");
  if (request.method === "GET") {
    const record = await stores.breakGlass.get(orgId);
    return { owners: record?.owners ?? [], version: record?.version ?? 0, maxDays: BREAK_GLASS_MAX_DAYS };
  }
  if (request.method === "PUT") {
    await requireFreshBrowserWrite(deps, caller);
    const parsed = BreakGlassBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "The emergency sign-in list is not valid.");
    const { expectedVersion, owners } = parsed.data;
    if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
    // Only a current owner of this org can be on the list: the list lets someone in as an owner.
    const members = await deps.orgs.listMembers(orgId);
    const ownerIds = new Set(members.filter((member) => member.role === "owner").map((member) => member.developerId));
    if (owners.some((owner) => !ownerIds.has(owner.personId))) throw agentXError("CONFIG_INVALID", "Everyone on the emergency sign-in list must be an owner of this organization.");
    const now = Date.now();
    const event = auditSsoBreakGlassChanged({
      orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: new Date(now).toISOString(), occurrence: auditOccurrence(String(expectedVersion + 1)),
      toVersion: expectedVersion + 1, owners: owners.length, ownerIds: owners.map((owner) => owner.personId),
    });
    const next = await stores.breakGlass.put(orgId, owners, caller.developerId, expectedVersion, now, [event]);
    return { owners: next.owners, version: next.version, maxDays: BREAK_GLASS_MAX_DAYS };
  }
  throw agentXError("NOT_FOUND", "route not found");
}
