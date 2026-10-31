// Enterprise foundations I1: what a company sign-in comes to, from the verified ID token's group claims and the org's saved group mapping.
//
// The server (developer/server.ts) calls `decideCompanySignIn` for every company (oidc) sign-in of an edition that has `sso`, before anything about the person is written
// or looked up. The module reads the saved mapping and the break-glass list, applies the pure rules (`decideSignIn`), checks that a break-glass sign-in is a fresh one, caps
// the session, and builds the audit event. It never echoes a claim: a refusal carries a fixed sentence and a fixed reason word.
import {
  BREAK_GLASS_NOT_FRESH_MESSAGE, BREAK_GLASS_NOT_FRESH_REASON, BREAK_GLASS_NOT_RECORDED_MESSAGE, BREAK_GLASS_NOT_RECORDED_REASON, ENTERPRISE_SESSION_MAX_SECONDS, GROUP_MAPPING_MESSAGES,
  type AuditEventInput, type EditionPolicy, type OrgId, type OrgRole, type SignInDecision,
} from "@agentx/contracts";
import type { AuditRuntime } from "../audit/outbox.js";
import { auditOccurrence, auditSsoBreakGlassUsed, auditSsoSignIn, auditSsoSignInRefused } from "../audit/events.js";
import { decideSignIn, dynamoBreakGlassStore, dynamoGroupMappingStore, readBreakGlassForSignIn, readMappingForSignIn, type BreakGlassStore, type GroupMappingStore } from "./group-mapping.js";
import type { ProviderIdentity } from "./providers.js";
import { dynamoSlackAllowanceStore, type SlackAllowanceStore } from "./slack-allowance.js";

export interface SsoStores {
  mappings: GroupMappingStore;
  breakGlass: BreakGlassStore;
  /** Which Slack users the company sign-in currently allows (the Slack ingress asks). */
  slack: SlackAllowanceStore;
}

/** The stores, built once per process where the edition has company group sign-in; none elsewhere. */
export function ssoStoresFor(input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; policy: EditionPolicy | undefined; audit?: AuditRuntime }): SsoStores | undefined {
  if (input.policy === undefined || !input.policy.features.sso) return undefined;
  const { documentClient, tableName, policy } = input;
  const audit = input.audit === undefined ? {} : { audit: input.audit };
  return { mappings: dynamoGroupMappingStore({ documentClient, tableName, policy, ...audit }), breakGlass: dynamoBreakGlassStore({ documentClient, tableName, policy, ...audit }), slack: dynamoSlackAllowanceStore({ documentClient, tableName }) };
}

export type CompanySignIn =
  | { allow: false; reason: string; message: string; event: AuditEventInput | undefined }
  | {
    allow: true; source: "mapping" | "break-glass"; orgRole: OrgRole; matchedRuleIds: string[];
    /** The session ends at this time (epoch seconds), whatever else the sign-in would have allowed. */
    sessionEndsAt: number;
    /** A break-glass sign-in must be recorded durably before it is let through, and raises an alert. */
    breakGlass: boolean;
    event: AuditEventInput;
  };

export async function decideCompanySignIn(input: {
  policy: EditionPolicy;
  /** Absent only by a wiring mistake: the sign-in is then refused as a mapping that is not configured. */
  stores: SsoStores | undefined;
  /** The sign-in method. Only the company's own (`oidc`) is ever let in by a mapping. */
  method: string;
  /** The install's single org. Absent (a wiring mistake): refused as not configured. */
  orgId: OrgId | undefined;
  identity: Pick<ProviderIdentity, "claims" | "authTime">;
  developerId: string;
  currentRole: OrgRole | undefined;
  /** What makes this sign-in one occurrence in the audit chain (the auth request's id). */
  occurrence: string;
  /** Whether there is a ledger to record an emergency sign-in in. Without one a break-glass sign-in is refused: it is never silent. */
  auditAvailable: boolean;
  nowMs: number;
}): Promise<CompanySignIn> {
  const occurredAt = new Date(input.nowMs).toISOString();
  // Anything but the company's own sign-in, or an install with no org to map into, has no mapping to read: refused, as a mapping that is not configured.
  if (input.method !== "oidc" || input.orgId === undefined) return { allow: false, reason: "not_configured", message: GROUP_MAPPING_MESSAGES.not_configured, event: undefined };
  const base = { orgId: input.orgId, actor: { kind: "member" as const, id: input.developerId }, occurredAt, occurrence: auditOccurrence(input.occurrence, input.developerId) };
  const refused = (reason: string, message: string): CompanySignIn => ({ allow: false, reason, message, event: auditSsoSignInRefused({ ...base, memberId: input.developerId, reason }) });

  const config = input.stores === undefined ? undefined : await readMappingForSignIn(input.stores.mappings, input.orgId);
  const breakGlass = input.stores === undefined ? [] : await readBreakGlassForSignIn(input.stores.breakGlass, input.orgId);
  const decision: SignInDecision = decideSignIn({
    policy: input.policy, config, claims: input.identity.claims ?? {}, currentRole: input.currentRole,
    personId: input.developerId, breakGlass, now: input.nowMs,
  });
  if (!decision.allow) return refused(decision.reason, decision.message);

  // The session never outlasts the edition's cap, so a group removal at the provider takes effect within it.
  const capSeconds = decision.sessionMaxSeconds ?? ENTERPRISE_SESSION_MAX_SECONDS;
  const sessionEndsAt = Math.floor(input.nowMs / 1000) + capSeconds;

  if (decision.source === "break-glass") {
    // A broken mapping lets a named owner in only on a sign-in the provider made a moment ago. A token that says no time at all is not a fresh one.
    const authTime = input.identity.authTime;
    const ageSeconds = authTime === undefined ? undefined : Math.floor(input.nowMs / 1000) - authTime;
    if (ageSeconds === undefined || ageSeconds < -60 || ageSeconds > decision.freshAuthWithinSeconds) return refused(BREAK_GLASS_NOT_FRESH_REASON, BREAK_GLASS_NOT_FRESH_MESSAGE);
    if (!input.auditAvailable) return refused(BREAK_GLASS_NOT_RECORDED_REASON, BREAK_GLASS_NOT_RECORDED_MESSAGE);
    return {
      allow: true, source: "break-glass", orgRole: "owner", matchedRuleIds: [], sessionEndsAt, breakGlass: true,
      event: auditSsoBreakGlassUsed({ ...base, memberId: input.developerId, sessionSeconds: capSeconds }),
    };
  }
  return {
    allow: true, source: "mapping", orgRole: decision.orgRole, matchedRuleIds: decision.matchedRuleIds, sessionEndsAt, breakGlass: false,
    event: auditSsoSignIn({ ...base, memberId: input.developerId, role: decision.orgRole, matchedRuleIds: decision.matchedRuleIds }),
  };
}
