// Enterprise foundations, task I1: the evaluator and the store of company sign-in group mapping (the pure rules and the schemas are in contracts/src/sso.ts).
//
// The rules, all fail closed:
//  - Enterprise only: the `sso` feature is read from the edition policy before anything else.
//  - A missing, unreadable or invalid mapping refuses the sign-in; so does a claim that is missing, malformed or too large.
//  - A person in no mapped group has no access.
//  - A mapping never grants `owner`, and never changes an owner's role. Owners go through the mapping like everyone else; only when the mapping itself is
//    broken may one of at most two named owners sign in as break-glass (audited, alerted, one hour, fresh sign-in): see `decideSignIn`.
//  - The mapped role replaces the person's role at every sign-in, so leaving a group takes the access away.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  agentXError, featureEnabled, requireFeature, BREAK_GLASS_FRESH_AUTH_SECONDS, BREAK_GLASS_SESSION_MAX_SECONDS, BROKEN_MAPPING_REFUSALS, BreakGlassOwnersSchema, GROUP_CLAIM_MAX_GROUPS, GROUP_MAPPING_MESSAGES, GROUP_NAME_MAX_CHARS, GroupMappingConfigSchema, MAPPED_ORG_ROLE_PRECEDENCE,
  PROJECT_ROLE_PRECEDENCE, groupMappingKey,
  type BreakGlassOwner, type EditionPolicy, type GroupMappingConfig, type GroupMappingEvaluation, type GroupMappingRefusal, type MappedAccess, type OrgId, type OrgRole, type SignInDecision,
} from "@agentx/contracts";

/**
 * The groups a sign-in carries, from the configured claim. An array of strings is the groups; a single string is one group (never split on spaces or commas:
 * a group's name may hold both). Anything else, an entry that is not a short string, or more than the cap, is refused.
 */
export function groupsOfClaim(claims: Readonly<Record<string, unknown>>, claim: string): { ok: true; groups: string[] } | { ok: false; reason: "claim_missing" | "claim_invalid" } {
  if (!Object.hasOwn(claims, claim)) return { ok: false, reason: "claim_missing" };
  const raw = claims[claim];
  if (raw === undefined || raw === null) return { ok: false, reason: "claim_missing" };
  if (!Array.isArray(raw) && typeof raw !== "string") return { ok: false, reason: "claim_invalid" };
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (list.length > GROUP_CLAIM_MAX_GROUPS) return { ok: false, reason: "claim_invalid" };
  const groups: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry === "" || entry.length > GROUP_NAME_MAX_CHARS) return { ok: false, reason: "claim_invalid" };
    groups.push(entry);
  }
  return { ok: true, groups };
}

/**
 * Evaluates a person's groups against the mapping. The config is parsed again here, so a record that was changed in storage to grant `owner`, or to anything
 * that does not fit the schema, is refused rather than followed.
 */
export function evaluateGroupMapping(input: { policy: EditionPolicy; config: unknown; claims: Readonly<Record<string, unknown>> }): GroupMappingEvaluation {
  if (!featureEnabled(input.policy, "sso")) return { ok: false, reason: "edition_off" };
  if (input.config === undefined || input.config === null) return { ok: false, reason: "not_configured" };
  const parsed = GroupMappingConfigSchema.safeParse(input.config);
  if (!parsed.success) return { ok: false, reason: "config_invalid" };
  const config = parsed.data;
  const found = groupsOfClaim(input.claims, config.claim);
  if (!found.ok) return found;
  const present = new Set(found.groups);
  const matched = config.rules.filter((rule) => present.has(rule.group));
  if (matched.length === 0) return { ok: false, reason: "no_group" };
  const orgRole = MAPPED_ORG_ROLE_PRECEDENCE.find((role) => matched.some((rule) => rule.orgRole === role));
  // Every mappable role is in the precedence list (pinned by a test); a role that is not is refused, never ranked last.
  if (orgRole === undefined) return { ok: false, reason: "config_invalid" };
  // A mapping that grants the Auditor in an edition without it is a broken mapping, not a member: it is refused.
  if (orgRole === "auditor" && !featureEnabled(input.policy, "auditorRole")) return { ok: false, reason: "config_invalid" };
  const byProject = new Map<string, (typeof PROJECT_ROLE_PRECEDENCE)[number]>();
  for (const rule of matched) {
    for (const { project, role } of rule.projectRoles) {
      const current = byProject.get(project);
      if (current === undefined || PROJECT_ROLE_PRECEDENCE.indexOf(role) < PROJECT_ROLE_PRECEDENCE.indexOf(current)) byProject.set(project, role);
    }
  }
  const access: MappedAccess = {
    orgRole, projectRoles: [...byProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([project, role]) => ({ project, role })),
    matchedRuleIds: matched.map((rule) => rule.id).sort(),
  };
  return { ok: true, access };
}

/**
 * What a sign-in comes to. Everyone, owners included, goes through the mapping: a person who matches no mapped group is refused even if they are an owner,
 * because that is how a company takes access away (it removes the person from the group; their account at the provider stays active).
 *
 * The one exception is a BROKEN mapping (not configured, unreadable, or the provider stopped sending the claim), so that a mistake cannot lock every owner out.
 * It applies only to an owner who is on the explicit `breakGlass` list (at most two people, each may expire), and it is never silent: the decision carries the
 * `sso.break_glass_used` audit event and the alert the route must raise, a one-hour session, and a sign-in no older than five minutes.
 * The edition is checked first, so Public refuses everyone.
 */
export function decideSignIn(input: {
  policy: EditionPolicy; config: unknown; claims: Readonly<Record<string, unknown>>; currentRole: OrgRole | undefined;
  personId: string; breakGlass: readonly BreakGlassOwner[]; now: number;
}): SignInDecision {
  const refuse = (reason: GroupMappingRefusal): SignInDecision => ({ allow: false, reason, message: GROUP_MAPPING_MESSAGES[reason] });
  if (!featureEnabled(input.policy, "sso")) return refuse("edition_off");
  const evaluation = evaluateGroupMapping(input);
  if (evaluation.ok) {
    // A mapping never changes an owner's role; it only decides whether they may come in.
    return {
      allow: true, orgRole: input.currentRole === "owner" ? "owner" : evaluation.access.orgRole, source: "mapping", projectRoles: evaluation.access.projectRoles,
      matchedRuleIds: evaluation.access.matchedRuleIds, sessionMaxSeconds: input.policy.sessionMaxSeconds,
    };
  }
  const broken = (BROKEN_MAPPING_REFUSALS as readonly string[]).includes(evaluation.reason);
  const listed = BreakGlassOwnersSchema.safeParse(input.breakGlass);
  if (broken && input.currentRole === "owner" && listed.success && listed.data.some((entry) => entry.personId === input.personId && (entry.expiresAt === undefined || entry.expiresAt > input.now))) {
    return {
      allow: true, orgRole: "owner", source: "break-glass", projectRoles: [], matchedRuleIds: [], auditEvent: "sso.break_glass_used", alert: true,
      sessionMaxSeconds: Math.min(BREAK_GLASS_SESSION_MAX_SECONDS, input.policy.sessionMaxSeconds ?? BREAK_GLASS_SESSION_MAX_SECONDS), freshAuthWithinSeconds: BREAK_GLASS_FRESH_AUTH_SECONDS,
    };
  }
  return refuse(evaluation.reason);
}

// ---- the store

type DocumentClient = { send(command: unknown): Promise<unknown> };

export interface GroupMappingStore {
  /** The org's mapping, or undefined when none is saved. A stored record that does not parse throws: the caller refuses the sign-in. */
  get(orgId: OrgId): Promise<GroupMappingConfig | undefined>;
  /**
   * Saves a mapping. `expectedVersion` is the version the admin read (0 when none is saved): the save is refused (IDEMPOTENCY_CONFLICT) if another save came
   * first. The saved version is `expectedVersion + 1`.
   */
  put(orgId: OrgId, config: Omit<GroupMappingConfig, "version">, expectedVersion: number): Promise<GroupMappingConfig>;
}

export function dynamoGroupMappingStore(input: { documentClient: DocumentClient; tableName: string; policy: EditionPolicy }): GroupMappingStore {
  const { documentClient, tableName, policy } = input;
  return {
    async get(orgId) {
      requireFeature(policy, "sso");
      const result = await documentClient.send(new GetCommand({ TableName: tableName, Key: groupMappingKey(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (result.Item === undefined) return undefined;
      const { pk: _pk, sk: _sk, ...rest } = result.Item;
      void _pk; void _sk;
      const parsed = GroupMappingConfigSchema.safeParse(rest);
      // A fixed sentence: the parser's paths and messages never reach a response.
      if (!parsed.success) throw agentXError("CONFIG_INVALID", GROUP_MAPPING_MESSAGES.config_invalid);
      return parsed.data;
    },
    async put(orgId, config, expectedVersion) {
      requireFeature(policy, "sso");
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw agentXError("CONFIG_INVALID", "the mapping version is invalid");
      const next = GroupMappingConfigSchema.parse({ ...config, version: expectedVersion + 1 });
      if (next.rules.some((rule) => rule.orgRole === "auditor")) requireFeature(policy, "auditorRole");
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName, Item: { ...groupMappingKey(orgId), ...next },
          ...(expectedVersion === 0
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } }),
        }));
      } catch (error) {
        if ((error as { name?: string }).name === "ConditionalCheckFailedException") throw agentXError("IDEMPOTENCY_CONFLICT", "Someone else changed the group mapping. Reload it and make your change again.");
        throw error;
      }
      return next;
    },
  };
}

/**
 * The mapping as the sign-in reads it: the saved mapping, undefined when there is none, and a value that never parses when the saved one cannot be read, so the
 * evaluator answers `config_invalid` (a broken mapping, which only break-glass owners may sign in through) and never throws into the route.
 */
export async function readMappingForSignIn(store: GroupMappingStore, orgId: OrgId): Promise<GroupMappingConfig | undefined | { unreadable: true }> {
  try {
    return await store.get(orgId);
  } catch (error) {
    if ((error as { code?: string }).code === "CONFIG_INVALID") return { unreadable: true };
    throw error;
  }
}

export type { GroupMappingRefusal };
