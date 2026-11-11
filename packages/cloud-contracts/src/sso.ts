// Enterprise foundations, task I1: company sign-in group mapping. An admin maps the groups the company's identity provider puts in a sign-in (an OIDC claim, or a
// SAML attribute later) to a Rovara org role and to project roles. The mapping is read at every sign-in and fails closed: a person with no mapped group has no
// access. An owner is never granted by mapping. Enterprise edition only (the `sso` feature).
import { z } from "zod";
import { AGENTX_NAME_PATTERN, type OrgId, type OrgKey, orgPk, ProjectRoleSchema } from "@rovara-code/contracts";
import { OrgRoleSchema, type OrgRole } from "./org.js";

/** Roles a mapping may grant: every org role but `owner`. A mapping that names `owner` does not parse, so no stored record can grant it. */
export const MappableOrgRoleSchema = OrgRoleSchema.exclude(["owner"]);
export type MappableOrgRole = z.infer<typeof MappableOrgRoleSchema>;

/**
 * Which mapped org role wins when a person is in several mapped groups, strongest first. Every mappable role must be listed (a test pins it), so adding a role
 * to the org roles without deciding where it ranks fails a test instead of silently ranking last.
 */
export const MAPPED_ORG_ROLE_PRECEDENCE: readonly MappableOrgRole[] = ["admin", "member", "auditor"];
// Auditor ranks last, but it never loses to a writer's role quietly: a person who matches an Auditor rule and an admin or member rule is refused (`auditor_and_writer`), not made the writer.
export const PROJECT_ROLE_PRECEDENCE = ["maintainer", "contributor", "viewer"] as const;

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;

export const GROUP_MAPPING_MAX_RULES = 200;
/** The most groups one sign-in may carry. A person in more is refused: a claim this long is cut by the provider, and a cut list could hide the group that denies. */
export const GROUP_CLAIM_MAX_GROUPS = 500;
export const GROUP_NAME_MAX_CHARS = 256;

/** The claims that carry group membership, as the common identity providers name them. */
export const GROUP_CLAIM_NAMES = ["groups", "roles", "memberOf", "member_of", "cognito:groups", "custom:groups", "entitlements"] as const;
/** A namespaced claim such as `https://example.com/groups` (how some providers name a custom claim). */
const NAMESPACED_GROUP_CLAIM = /^https:\/\/[A-Za-z0-9._~:/-]{1,200}\/(?:groups|roles)$/;
export const GroupClaimNameSchema = z.string().refine((value) => (GROUP_CLAIM_NAMES as readonly string[]).includes(value) || NAMESPACED_GROUP_CLAIM.test(value), "a claim that carries groups");

/**
 * The people who may sign in as owner when the mapping itself is broken (not configured, unreadable, or the provider stops sending the claim), so that a broken
 * mapping cannot lock every owner out. At most two. An entry may expire; the admin renews it. A broken mapping is the only case it applies to.
 */
export const BREAK_GLASS_OWNERS_MAX = 2;
export const BreakGlassOwnerSchema = z.object({ personId: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive().optional() }).strict();
export const BreakGlassOwnersSchema = z.array(BreakGlassOwnerSchema).max(BREAK_GLASS_OWNERS_MAX);
export type BreakGlassOwner = z.infer<typeof BreakGlassOwnerSchema>;
/** A break-glass session is short and needs a recent authentication at the provider. */
export const BREAK_GLASS_SESSION_MAX_SECONDS = 60 * 60;
export const BREAK_GLASS_FRESH_AUTH_SECONDS = 5 * 60;
/**
 * The refusals a broken mapping gives, which are the only ones break-glass may answer: the mapping itself is missing or cannot be read (a system failure). Never a
 * refusal about one person's token: an identity provider that leaves the groups claim out for a person in no group (Entra ID, Okta) would otherwise let a removed owner back in.
 */
export const BROKEN_MAPPING_REFUSALS = ["not_configured", "config_invalid"] as const;

export const GroupMappingRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** The group exactly as the identity provider names it. Compared exactly and case-sensitively. */
  group: z.string().min(1).max(GROUP_NAME_MAX_CHARS).regex(NO_CONTROL),
  orgRole: MappableOrgRoleSchema,
  projectRoles: z.array(z.object({ project: z.string().regex(AGENTX_NAME_PATTERN), role: ProjectRoleSchema }).strict()).max(50),
}).strict();
export type GroupMappingRule = z.infer<typeof GroupMappingRuleSchema>;

export const GroupMappingConfigSchema = z.object({
  /** The claim (or attribute) that carries the person's groups. Only a claim that is a group list: never one a person can edit about themselves (email, name). */
  claim: GroupClaimNameSchema,
  rules: z.array(GroupMappingRuleSchema).min(1).max(GROUP_MAPPING_MAX_RULES),
  /** Starts at 1; a save names the version it read (compare and set), so two admins cannot overwrite each other. */
  version: z.number().int().min(1),
  updatedAt: z.string().min(1).max(64),
  updatedBy: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  const groups = new Set<string>();
  config.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) ctx.addIssue({ code: "custom", message: "rule ids are unique", path: ["rules", index, "id"] });
    if (groups.has(rule.group)) ctx.addIssue({ code: "custom", message: "a group is mapped by one rule only", path: ["rules", index, "group"] });
    ids.add(rule.id);
    groups.add(rule.group);
  });
});
export type GroupMappingConfig = z.infer<typeof GroupMappingConfigSchema>;

/** The partition and sort key of an org's mapping (one item per org). */
export function groupMappingKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "SSO_GROUP_MAPPING" };
}

/**
 * The break-glass list, stored apart from the mapping on purpose: the list is for the day the mapping cannot be read, so it must not live inside it. A save names the
 * version it read (compare and set). Every entry must expire, within BREAK_GLASS_MAX_DAYS of the save, so the list cannot be left standing.
 */
export const BREAK_GLASS_MAX_DAYS = 90;
export const BreakGlassRecordSchema = z.object({
  owners: BreakGlassOwnersSchema,
  version: z.number().int().min(1),
  updatedAt: z.string().min(1).max(64),
  updatedBy: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type BreakGlassRecord = z.infer<typeof BreakGlassRecordSchema>;
export function breakGlassKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "SSO_BREAK_GLASS" };
}

/** Why a sign-in was refused by the mapping: a fixed list, never the provider's words. */
export const GROUP_MAPPING_REFUSALS = ["edition_off", "not_configured", "config_invalid", "claim_missing", "claim_invalid", "no_group", "auditor_and_writer"] as const;
export type GroupMappingRefusal = (typeof GROUP_MAPPING_REFUSALS)[number];

/** The sentence for a break-glass owner whose sign-in at the provider is too old (or says no time): fixed, and not a mapping refusal. */
export const BREAK_GLASS_NOT_FRESH_MESSAGE = "A recent sign-in at your identity provider is needed. Sign out of it, then sign in again.";
export const BREAK_GLASS_NOT_FRESH_REASON = "break_glass_not_fresh";
/** An emergency sign-in is let in only once it is on record; with no ledger to record it in, or the ledger down, it is refused. */
export const BREAK_GLASS_NOT_RECORDED_MESSAGE = "Rovara could not record this emergency sign-in, so it did not let you in. Try again in a minute.";
export const BREAK_GLASS_NOT_RECORDED_REASON = "break_glass_not_recorded";

/** What the person sees. Fixed sentences: nothing from the sign-in is echoed. */
export const GROUP_MAPPING_MESSAGES: Readonly<Record<GroupMappingRefusal, string>> = {
  edition_off: "Company group sign-in is part of the Enterprise edition.",
  not_configured: "Your administrator has not finished setting up company sign-in. Ask them to map your groups to Rovara roles.",
  config_invalid: "Company sign-in is set up in a way Rovara cannot read. Ask your administrator to check the group mapping.",
  claim_missing: "Your company sign-in did not say which groups you belong to. Ask your administrator to check the sign-in settings.",
  claim_invalid: "Your company sign-in gave group information Rovara cannot read. Ask your administrator to check the sign-in settings.",
  no_group: "Your company sign-in did not put you in a group that is allowed to use Rovara. Ask your administrator.",
  // Owner default, pending: one person is never both an Auditor and someone who works in Rovara (separation of duties); the sign-in is refused rather than choosing one of the two.
  auditor_and_writer: "Your company groups make you both an auditor and a member or admin of Rovara, and one person cannot be both. Ask your administrator to put you in only one of them.",
};

export interface MappedAccess {
  orgRole: MappableOrgRole;
  projectRoles: Array<{ project: string; role: z.infer<typeof ProjectRoleSchema> }>;
  /** The rules that matched, for the audit event. */
  matchedRuleIds: string[];
}

export type GroupMappingEvaluation = { ok: true; access: MappedAccess } | { ok: false; reason: GroupMappingRefusal };

export type SignInDecision =
  | {
    allow: true; orgRole: OrgRole; source: "mapping"; projectRoles: MappedAccess["projectRoles"]; matchedRuleIds: string[];
    /** The session ends by then: the edition's cap, so a group removal takes effect within it. */
    sessionMaxSeconds: number | undefined;
  }
  | {
    allow: true; orgRole: "owner"; source: "break-glass"; projectRoles: []; matchedRuleIds: [];
    /** The route must write an `sso.break_glass_used` audit event, alert, and require a sign-in no older than `freshAuthWithinSeconds`. */
    auditEvent: "sso.break_glass_used"; alert: true; sessionMaxSeconds: number; freshAuthWithinSeconds: number;
  }
  | { allow: false; reason: GroupMappingRefusal; message: string };

// ---- SAML 2.0 sign-in (Enterprise foundations I4)
//
// A second way to sign in with the company's own identity provider, beside OpenID Connect. The admin saves the provider's metadata (its entity id, its sign-in address and the
// certificate it signs with). The certificate is public, not a secret. The same group mapping, ban checks, invites and audit apply as for the OpenID Connect sign-in; only the
// group attribute's name has the same limits as a group claim's. Enterprise edition only (the `sso` feature). Nothing is on until an admin saves a configuration with `enabled: true`.

/** The most bytes of a SAML response the sign-in will read (the decoded XML). A response is a few KB; anything this large is refused before it is parsed. */
export const SAML_RESPONSE_MAX_BYTES = 200_000;
/** The clock difference tolerated between the identity provider and Rovara, in seconds. */
export const SAML_CLOCK_SKEW_SECONDS = 60;
export const SAML_IDP_ENTITY_ID_MAX_CHARS = 512;
export const SAML_CERTIFICATE_MAX_CHARS = 8192;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]{1,200}\r?\n){1,100}-----END CERTIFICATE-----\r?\n?$/;

export const SamlIdpSettingsSchema = z.object({
  /** The provider's entity id: what its assertions name as their issuer. Compared exactly. */
  idpEntityId: z.string().min(1).max(SAML_IDP_ENTITY_ID_MAX_CHARS).regex(NO_CONTROL),
  /** Where the browser is sent to sign in (SSO redirect binding). HTTPS only. */
  ssoUrl: z.string().min(1).max(1024).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "" && url.hostname !== "";
    } catch {
      return false;
    }
  }, "an https address with no credentials or fragment"),
  /** The provider's signing certificate, PEM. Public; never a private key (the pattern admits only a certificate block). */
  certificate: z.string().min(1).max(SAML_CERTIFICATE_MAX_CHARS).regex(PEM_CERTIFICATE, "a PEM certificate"),
  enabled: z.boolean(),
  /**
   * Whether the email address in an assertion counts as verified (the Slack link, invites by address). Off unless an owner turns it on, because on many providers people can edit
   * their own profile email. Leaving it out of a save turns it off.
   */
  trustEmail: z.boolean().default(false),
}).strict();
export type SamlIdpSettings = z.infer<typeof SamlIdpSettingsSchema>;

export const SamlIdpConfigSchema = SamlIdpSettingsSchema.extend({
  /** SAML sessions that started before this (epoch seconds) are over: set when SAML is turned off, the certificate changes or the entity id changes. */
  sessionsValidFrom: z.number().int().min(0).default(0),
  version: z.number().int().min(1),
  updatedAt: z.string().min(1).max(64),
  updatedBy: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SamlIdpConfig = z.infer<typeof SamlIdpConfigSchema>;

export function samlIdpConfigKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "SSO_SAML_IDP" };
}
export function samlSeenKey(orgId: OrgId, digest: string): OrgKey {
  return { pk: orgPk(orgId), sk: `SSO_SAML_SEEN#${digest}` };
}
export function samlStashKey(orgId: OrgId, handle: string): OrgKey {
  return { pk: orgPk(orgId), sk: `SSO_SAML_RESP#${handle}` };
}

/** The fixed words a SAML sign-in is refused with (audit and logs); never the response's own words. */
export const SAML_REFUSALS = [
  "not_configured", "response_too_large", "response_unreadable", "forbidden_markup", "weak_algorithm", "not_signed", "bad_signature", "bad_status", "not_for_this_request",
  "wrong_issuer", "wrong_audience", "wrong_recipient", "wrong_destination", "expired", "not_yet_valid", "unsolicited", "replayed", "no_subject", "transient_subject", "bad_assertion",
] as const;
export type SamlRefusal = (typeof SAML_REFUSALS)[number];
/** What the person sees for any SAML refusal: one sentence, so the page tells an attacker nothing about which check failed. */
export const SAML_SIGN_IN_REFUSED_MESSAGE = "Your company sign-in response could not be accepted. Start the sign-in again, and ask your administrator if it keeps failing.";
export const SAML_NOT_CONFIGURED_MESSAGE = "Your administrator has not set up SAML sign-in. Use your company's other sign-in, or ask them.";
