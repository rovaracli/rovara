// Enterprise foundations, task I1: company sign-in group mapping. An admin maps the groups the company's identity provider puts in a sign-in (an OIDC claim, or a
// SAML attribute later) to a Rovara org role and to project roles. The mapping is read at every sign-in and fails closed: a person with no mapped group has no
// access. An owner is never granted by mapping. Enterprise edition only (the `sso` feature).
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { ProjectRoleSchema } from "./app-projects.js";
import { OrgRoleSchema, type OrgRole } from "./org.js";
import { orgPk, type OrgKey } from "./org-node.js";
import type { OrgId } from "./browser-ids.js";

/** Roles a mapping may grant: every org role but `owner`. A mapping that names `owner` does not parse, so no stored record can grant it. */
export const MappableOrgRoleSchema = OrgRoleSchema.exclude(["owner"]);
export type MappableOrgRole = z.infer<typeof MappableOrgRoleSchema>;

/**
 * Which mapped org role wins when a person is in several mapped groups, strongest first. Every mappable role must be listed (a test pins it), so adding a role
 * to the org roles without deciding where it ranks fails a test instead of silently ranking last.
 */
export const MAPPED_ORG_ROLE_PRECEDENCE: readonly MappableOrgRole[] = ["admin", "member"];
export const PROJECT_ROLE_PRECEDENCE = ["maintainer", "contributor", "viewer"] as const;

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;

export const GROUP_MAPPING_MAX_RULES = 200;
/** The most groups one sign-in may carry. A person in more is refused: a claim this long is cut by the provider, and a cut list could hide the group that denies. */
export const GROUP_CLAIM_MAX_GROUPS = 500;
export const GROUP_NAME_MAX_CHARS = 256;

export const GroupMappingRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** The group exactly as the identity provider names it. Compared exactly and case-sensitively. */
  group: z.string().min(1).max(GROUP_NAME_MAX_CHARS).regex(NO_CONTROL),
  orgRole: MappableOrgRoleSchema,
  projectRoles: z.array(z.object({ project: z.string().regex(AGENTX_NAME_PATTERN), role: ProjectRoleSchema }).strict()).max(50),
}).strict();
export type GroupMappingRule = z.infer<typeof GroupMappingRuleSchema>;

export const GroupMappingConfigSchema = z.object({
  /** The claim (or attribute) that carries the person's groups. */
  claim: z.string().regex(/^[A-Za-z0-9_:./-]{1,100}$/),
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

/** Why a sign-in was refused by the mapping: a fixed list, never the provider's words. */
export const GROUP_MAPPING_REFUSALS = ["edition_off", "not_configured", "config_invalid", "claim_missing", "claim_invalid", "no_group"] as const;
export type GroupMappingRefusal = (typeof GROUP_MAPPING_REFUSALS)[number];

/** What the person sees. Fixed sentences: nothing from the sign-in is echoed. */
export const GROUP_MAPPING_MESSAGES: Readonly<Record<GroupMappingRefusal, string>> = {
  edition_off: "Company group sign-in is part of the Enterprise edition.",
  not_configured: "Your administrator has not finished setting up company sign-in. Ask them to map your groups to Rovara roles.",
  config_invalid: "Company sign-in is set up in a way Rovara cannot read. Ask your administrator to check the group mapping.",
  claim_missing: "Your company sign-in did not say which groups you belong to. Ask your administrator to check the sign-in settings.",
  claim_invalid: "Your company sign-in gave group information Rovara cannot read. Ask your administrator to check the sign-in settings.",
  no_group: "Your company sign-in did not put you in a group that is allowed to use Rovara. Ask your administrator.",
};

export interface MappedAccess {
  orgRole: MappableOrgRole;
  projectRoles: Array<{ project: string; role: z.infer<typeof ProjectRoleSchema> }>;
  /** The rules that matched, for the audit event. */
  matchedRuleIds: string[];
}

export type GroupMappingEvaluation = { ok: true; access: MappedAccess } | { ok: false; reason: GroupMappingRefusal };

export type SignInDecision =
  | { allow: true; orgRole: OrgRole; source: "owner" | "mapping"; projectRoles: MappedAccess["projectRoles"]; matchedRuleIds: string[] }
  | { allow: false; reason: GroupMappingRefusal; message: string };
