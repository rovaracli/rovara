// Agents: ids, owners, who an agent is shared with, how much access a person has to one, and the limits
// on its profile. The recipe an agent runs is in agent-recipe.ts.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";

export const AGENT_NAME_MAX = 60;
export const AGENT_DESCRIPTION_MAX = 500;

export const BUILTIN_AGENT_IDS = ["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const;
export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];
export const ROVARA_CODE_AGENT_ID: BuiltinAgentId = "rovara-code";

const PREFIXED_ID_BODY_LENGTH = 20;
const MIN_RANDOM_BYTES = 16;

export type IdPrefix = "agt" | "skl" | "spr" | "apr" | "src" | "con" | "chn" | "crn" | "ctr" | "ses" | "dvc" | "msg";

function prefixedIdPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-9a-z]{${PREFIXED_ID_BODY_LENGTH}}$`);
}

/**
 * A server-generated id: the prefix and 20 base36 characters from at least 16 random bytes, reduced modulo 36^20
 * the way org ids are. Ids are never taken from a request.
 */
export function newPrefixedId(prefix: IdPrefix, random: () => Uint8Array = () => randomBytes(32)): string {
  const bytes = random();
  if (bytes.length < MIN_RANDOM_BYTES) throw new Error(`an id needs at least ${MIN_RANDOM_BYTES} random bytes`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `${prefix}_${(value % 36n ** BigInt(PREFIXED_ID_BODY_LENGTH)).toString(36).padStart(PREFIXED_ID_BODY_LENGTH, "0")}`;
}

export const BuiltinAgentIdSchema = z.enum(BUILTIN_AGENT_IDS);
export const AgentIdSchema = z.union([BuiltinAgentIdSchema, z.string().regex(prefixedIdPattern("agt"))]);
export const SkillIdSchema = z.string().regex(prefixedIdPattern("skl"));
export const SpendRequestIdSchema = z.string().regex(prefixedIdPattern("spr"));
export const ApprovalIdSchema = z.string().regex(prefixedIdPattern("apr"));
export const ConnectionIdSchema = z.string().regex(prefixedIdPattern("con"));
/** `rovara` is Rovara's own models and `personal-chatgpt` a member's ChatGPT plan; every other source is a company's own. */
export const ModelSourceIdSchema = z.union([z.literal("rovara"), z.literal("personal-chatgpt"), z.string().regex(prefixedIdPattern("src"))]);

export type AgentId = z.infer<typeof AgentIdSchema>;
export type SkillId = z.infer<typeof SkillIdSchema>;
export type SpendRequestId = z.infer<typeof SpendRequestIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;
export type ModelSourceId = z.infer<typeof ModelSourceIdSchema>;

export function isBuiltinAgentId(agentId: string): agentId is BuiltinAgentId {
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(agentId);
}

const MemberOwnerSchema = z.object({ kind: z.literal("member"), developerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ProjectOwnerSchema = z.object({ kind: z.literal("project"), project: z.string().regex(AGENTX_NAME_PATTERN) }).strict();

/** Who owns an agent: one member, or a project (whose accountable maintainer answers for it). */
export const AgentOwnerSchema = z.discriminatedUnion("kind", [MemberOwnerSchema, ProjectOwnerSchema]);
/** Who an agent can be shared with: an owner variant, or everyone in the org. */
export const AgentPrincipalSchema = z.discriminatedUnion("kind", [MemberOwnerSchema, ProjectOwnerSchema, z.object({ kind: z.literal("org") }).strict()]);

export type AgentOwner = z.infer<typeof AgentOwnerSchema>;
export type AgentPrincipal = z.infer<typeof AgentPrincipalSchema>;

export const AGENT_ACCESS_LEVELS = ["none", "view", "use", "edit", "manage"] as const;
export const AgentAccessLevelSchema = z.enum(AGENT_ACCESS_LEVELS);
export type AgentAccessLevel = z.infer<typeof AgentAccessLevelSchema>;

/** Whether `level` grants everything `wanted` does; the levels are ordered `none` < `view` < `use` < `edit` < `manage`. */
export function atLeast(level: AgentAccessLevel, wanted: AgentAccessLevel): boolean {
  return AGENT_ACCESS_LEVELS.indexOf(level) >= AGENT_ACCESS_LEVELS.indexOf(wanted);
}

/** How far an agent may act on its own: `suggest` proposes, `prepare` readies changes for a person, `run` carries them out. */
export const AutonomySchema = z.enum(["suggest", "prepare", "run"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

/** The agent an agent builds on, pinned to one published version. */
export const BaseRefSchema = z.object({ agentId: AgentIdSchema, version: z.number().int().min(1) }).strict();
export type BaseRef = z.infer<typeof BaseRefSchema>;
