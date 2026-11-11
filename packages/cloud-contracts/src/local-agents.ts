// Plan 5 Task 17: a person's registered Macs (devices) and the company's rules for local agents (which tools, on which projects).
// The ids, limits, tool names and the texts of LOCAL_AGENT_NOT_ALLOWED are in `agent-sessions.ts`; this file holds the shapes of what is stored and sent.
import { z } from "zod";
import { AgentPrincipalSchema, AGENTX_NAME_PATTERN, DEVICE_LABEL_MAX, DeviceIdSchema, DEVICES_PER_MEMBER_MAX, LOCAL_REGISTER_SHARES_MAX, LOCAL_TOOLS, LOCAL_TURN_MAX_CHARS, LOCAL_UPDATE_TURNS_MAX, LocalToolSchema, OrgIdSchema, SESSION_STATUSES, SessionIdSchema, SessionLevelSchema, SessionMessageIdSchema } from "@rovara-code/contracts";

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

// ---- local sessions (Plan 5 Task 18)

/** `POST /v1/app/sessions/local` refuses a session shared with nobody. */
export const LOCAL_NEEDS_SHARE_MESSAGE = "Share a local session before it can appear in Rovara.";
/** ... and one shared with more than `LOCAL_REGISTER_SHARES_MAX` at once (more go through `PUT …/shares`). */
export const LOCAL_TOO_MANY_SHARES_MESSAGE = `Add up to ${String(LOCAL_REGISTER_SHARES_MAX)} people when you share; add more afterwards.`;
/** An update with turns for a session that already holds `LOCAL_TURNS_MAX` of them. */
export const LOCAL_TRANSCRIPT_FULL_MESSAGE = "This session's transcript is full; start a new one.";
/** What a session says when its Mac was removed: the device's label, then this. */
export function deviceRemovedMessage(label: string): string {
  return `${label} was removed, so this session stopped.`;
}

/** What a session says when its Mac went silent for `LOCAL_ABANDONED_HOURS`, and when the company closed. */
export const LOCAL_ABANDONED_MESSAGE = "This Mac stopped responding, so this session ended.";
export const LOCAL_ORG_CLOSED_MESSAGE = "Your company was closed, so this session stopped.";

/** Limits on what a Mac may write (an end is never limited). Fixed windows, counted in the write's own transaction. */
export const LOCAL_UPDATES_PER_MINUTE_SESSION = 30;
export const LOCAL_UPDATES_PER_MINUTE_DEVICE = 120;
/** Status changes that tell followers (needs a person, waiting, stopped), per session and hour; past it the status still saves but no follower is told. */
export const LOCAL_FOLLOWER_STATUS_PER_HOUR = 12;
export const LOCAL_OPEN_PER_DEVICE_MAX = 20;
export const LOCAL_REGISTRATIONS_PER_HOUR = 60;
export const LOCAL_STOPS_PER_HOUR = 20;
export const LOCAL_UPDATE_RATE_MESSAGE = "This Mac is sending updates too fast; it will send the rest shortly.";
export const LOCAL_REGISTER_RATE_MESSAGE = "You've started a lot of local sessions in the last hour. Try again later.";
export const LOCAL_STOP_RATE_MESSAGE = "This session has been asked to stop a lot in the last hour. Try again later.";
export const LOCAL_OPEN_MAX_MESSAGE = `This Mac already has ${String(LOCAL_OPEN_PER_DEVICE_MAX)} open sessions. End one first.`;

/** How long a command waits for its device, and the most one poll gives. */
export const DEVICE_COMMAND_KEEP_DAYS = 30;
export const DEVICE_COMMANDS_PAGE_MAX = 100;
/** What a device is told to do: pass on a message to the agent, or stop. */
export const DEVICE_COMMAND_KINDS = ["steer", "stop"] as const;

const InstantText = z.string().datetime();
const codePoints = (max: number) => (value: string) => [...value].length <= max;

/** The statuses a Mac reports: all but `paused` (a pause for budget is Rovara's, and a Mac session has no payer and costs 0: it runs on the person's own machine and credentials). */
export const LOCAL_REPORTED_STATUSES = ["starting", "running", "needs_person", "waiting", "stopped", "succeeded", "failed", "cancelled"] as const satisfies ReadonlyArray<(typeof SESSION_STATUSES)[number]>;

/** `POST /v1/app/sessions/local`. The counts of `shares` are checked with their own texts, after the shape. */
export const RegisterLocalSessionBodySchema = z
  .object({
    requestId: z.string().uuid(),
    deviceId: DeviceIdSchema,
    tool: LocalToolSchema,
    title: z.string().max(2000),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    startedAt: InstantText,
    shares: z.array(z.object({ principal: AgentPrincipalSchema, level: SessionLevelSchema }).strict()),
  })
  .strict();
export type RegisterLocalSessionBody = z.infer<typeof RegisterLocalSessionBodySchema>;

/** One line of the conversation on the Mac. */
export const LocalTurnSchema = z
  .object({ at: InstantText, role: z.enum(["person", "agent"]), text: z.string().min(1).refine(codePoints(LOCAL_TURN_MAX_CHARS), `must be at most ${String(LOCAL_TURN_MAX_CHARS)} characters`) })
  .strict();
export type LocalTurn = z.infer<typeof LocalTurnSchema>;

/** `POST /v1/app/sessions/{id}/local/updates`. */
export const LocalUpdateBodySchema = z
  .object({
    requestId: z.string().uuid(),
    deviceId: DeviceIdSchema,
    status: z.enum(LOCAL_REPORTED_STATUSES),
    step: z.string().max(1000).optional(),
    peek: z.string().max(2000).optional(),
    turns: z.array(LocalTurnSchema).max(LOCAL_UPDATE_TURNS_MAX, `An update holds at most ${String(LOCAL_UPDATE_TURNS_MAX)} turns; send the rest in the next update.`).optional(),
    tokens: z.object({ input: z.number().int().min(0).max(1e12), output: z.number().int().min(0).max(1e12) }).strict().optional(),
  })
  .strict();
export type LocalUpdateBody = z.infer<typeof LocalUpdateBodySchema>;

/** One command as the device reads it from `GET /v1/app/devices/{id}/commands`. */
export const DeviceCommandViewSchema = z
  .object({
    seq: z.number().int().min(1),
    kind: z.enum(DEVICE_COMMAND_KINDS),
    sessionId: SessionIdSchema,
    messageId: SessionMessageIdSchema.optional(),
    text: z.string().optional(),
    /** Who sent the steer or the stop, by name (information for the Mac to show; it grants nothing). */
    from: z.string().max(200).optional(),
    at: InstantText,
  })
  .strict();
export type DeviceCommandView = z.infer<typeof DeviceCommandViewSchema>;
