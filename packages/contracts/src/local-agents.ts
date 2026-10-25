// Plan 5 Task 17: a person's registered Macs (devices) and the company's rules for local agents (which tools, on which projects).
// The ids, limits, tool names and the texts of LOCAL_AGENT_NOT_ALLOWED are in `agent-sessions.ts`; this file holds the shapes of what is stored and sent.
import { z } from "zod";
import { DEVICE_LABEL_MAX, DeviceIdSchema, LOCAL_TOOLS, LocalToolSchema } from "./agent-sessions.js";
import { DEVICES_PER_MEMBER_MAX } from "./agent-sessions-node.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { OrgIdSchema } from "./org.js";

/** A project list in the rule holds at most this many names. */
export const LOCAL_AGENT_PROJECTS_MAX = 100;

/** What a Mac is called, on one line: no control or invisible-format characters, 1 to `DEVICE_LABEL_MAX` characters once trimmed. */
export const DeviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= DEVICE_LABEL_MAX, `must be at most ${String(DEVICE_LABEL_MAX)} characters`)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");

const InstantSchema = z.string().datetime();

/** A registered Mac as stored (the `META` item of its partition). `revokedAt` is set once, when it is removed. */
export const DeviceRecordSchema = z
  .object({
    orgId: OrgIdSchema,
    deviceId: DeviceIdSchema,
    developerId: z.string().regex(/^[a-f0-9]{64}$/),
    label: DeviceLabelSchema,
    platform: z.literal("mac"),
    createdAt: InstantSchema,
    lastSeenAt: InstantSchema,
    revokedAt: InstantSchema.optional(),
  })
  .strict();
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/** What the person sees of their device. */
export const DeviceViewSchema = z
  .object({ deviceId: DeviceIdSchema, label: DeviceLabelSchema, platform: z.literal("mac"), createdAt: InstantSchema, lastSeenAt: InstantSchema })
  .strict();
export type DeviceView = z.infer<typeof DeviceViewSchema>;

/** `POST /v1/app/devices`. */
export const RegisterDeviceBodySchema = z.object({ requestId: z.string().uuid(), label: DeviceLabelSchema, platform: z.literal("mac") }).strict();
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBodySchema>;

/** The text of the refusal when a member already has `DEVICES_PER_MEMBER_MAX` live devices. */
export const DEVICES_LIMIT_MESSAGE = `You can register up to ${String(DEVICES_PER_MEMBER_MAX)} devices. Remove one first.`;

const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** The company's rule: whether local agents are allowed at all, which tools, and on which projects (`"all"`, or a list; an empty list allows none, and a session with no project is held to a list too). */
export const LocalAgentPolicySchema = z
  .object({
    allowed: z.boolean(),
    tools: z.array(LocalToolSchema).max(LOCAL_TOOLS.length).refine(unique, "must not repeat a tool"),
    projects: z.union([z.literal("all"), z.array(z.string().regex(AGENTX_NAME_PATTERN)).max(LOCAL_AGENT_PROJECTS_MAX).refine(unique, "must not repeat a project")]),
  })
  .strict();
export type LocalAgentPolicy = z.infer<typeof LocalAgentPolicySchema>;

/** Until an owner or admin changes it (proposed default): allowed, every tool, every project. */
export function defaultLocalAgentPolicy(): LocalAgentPolicy {
  return { allowed: true, tools: [...LOCAL_TOOLS], projects: "all" };
}

/** The rule with its tools in the usual order and its projects sorted, so two rules that mean the same compare equal. */
export function normalizeLocalAgentPolicy(policy: LocalAgentPolicy): LocalAgentPolicy {
  return {
    allowed: policy.allowed,
    tools: LOCAL_TOOLS.filter((tool) => policy.tools.includes(tool)),
    projects: policy.projects === "all" ? "all" : [...policy.projects].sort(),
  };
}

/** `PUT /v1/app/org/local-agents`: the rule as it should become, and the revision the caller read. */
export const PutLocalAgentsBodySchema = z.object({ requestId: z.string().uuid(), revision: z.number().int().min(0), policy: LocalAgentPolicySchema }).strict();
export type PutLocalAgentsBody = z.infer<typeof PutLocalAgentsBodySchema>;

/** The rule and the revision a change must name (0 while it has never been written). */
export interface StoredLocalAgentPolicy {
  policy: LocalAgentPolicy;
  revision: number;
}

/** AGENT_REVISION_CONFLICT, for the rule. */
export const LOCAL_AGENTS_CONFLICT_MESSAGE = "Someone else changed your company's rules for local agents. Reload them and make your change again.";

/** LOCAL_AGENT_NOT_ALLOWED, third text: the rule lists projects and the session has none. */
export const LOCAL_AGENTS_NEED_PROJECT_MESSAGE = "Local agents need a project your company allows. Ask an admin to allow them.";
