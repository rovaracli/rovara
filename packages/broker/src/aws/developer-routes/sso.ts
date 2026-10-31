// Enterprise foundations I1: the admin routes for company group sign-in. They exist in the Enterprise edition only.
//
//   GET /v1/app/org/sso/group-mapping    the saved mapping (an owner or admin)
//   PUT /v1/app/org/sso/group-mapping    saves it (an owner or admin, a live browser session, compare-and-set on the version, audited in the same transaction)
//   GET /v1/app/org/sso/break-glass      the break-glass owners (an owner)
//   PUT /v1/app/org/sso/break-glass      saves them (an owner, a live browser session; at most two current owners, each with an expiry within 90 days)
//
// A mapping never grants owner (the schema refuses it), so saving one cannot make anyone an owner. Nothing here echoes the provider's words: refusals are fixed sentences.
import { z } from "zod";
import {
  AUDIT_ERROR_MESSAGES, BREAK_GLASS_MAX_DAYS, BreakGlassOwnersSchema, GroupMappingConfigSchema, GroupMappingRuleSchema, GroupClaimNameSchema, agentXError, requireFeature, type GroupMappingConfig,
} from "@agentx/contracts";
import { auditOccurrence, auditSsoBreakGlassChanged, auditSsoGroupMappingChanged } from "../../audit/events.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { evaluateGroupMapping } from "../../developer/group-mapping.js";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import { getSignIn } from "./authentication.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const GROUP_MAPPING_PATH = "/v1/app/org/sso/group-mapping";
export const BREAK_GLASS_PATH = "/v1/app/org/sso/break-glass";
export const isSsoRoute = (pathname: string): boolean => pathname === GROUP_MAPPING_PATH || pathname === BREAK_GLASS_PATH;

const MappingBodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  claim: GroupClaimNameSchema,
  rules: z.array(GroupMappingRuleSchema).min(1),
}).strict();

const BreakGlassBodySchema = z.object({ expectedVersion: z.number().int().min(0), owners: BreakGlassOwnersSchema }).strict();

const systemSaved = (caller: DeveloperCaller): { updatedAt: string; updatedBy: string } => ({ updatedAt: new Date().toISOString(), updatedBy: caller.developerId });

export const SSO_FRESH_SIGN_IN_MESSAGE = "Sign in again to change company sign-in.";

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
