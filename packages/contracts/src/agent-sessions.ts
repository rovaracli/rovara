// Agent sessions (Plan 5): one agent working on one thing, as a live conversation with a link. This file holds the ids, the fixed
// words and limits, the stored record and its parts, the event and message shapes, and the texts of the session error codes.
// The shapes clients read (view, tile, event page) and their forward-compatible readers are in session-views.ts.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentIdSchema } from "./agent.js";
import { cleanDisplayName } from "./display-name.js";
import { PayerSchema, WorkOriginSchema } from "./agent-run.js";
import { OrgIdSchema } from "./org.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { SlackChannelIdSchema, SlackMessageTimestampSchema, SlackTeamIdSchema } from "./slack.js";

/**
 * The version of the shapes clients read (`SessionViewSchema`, `SessionTileSchema`, `SessionEventSchema`). Removing or renaming a key
 * there bumps it and needs Plans 5, 7 and 8; adding an optional key or a new enum value stays under the same version.
 */
export const AGENT_SESSION_CONTRACT_VERSION = 1;

// ---- limits

export const SESSION_TITLE_MAX = 200;
export const SESSION_PEEK_MAX_CHARS = 280;
export const SESSION_EVENT_TEXT_MAX = 500;
export const SESSION_EVENTS_PAGE_MAX = 200;
/** The same limit as a task page comment (`COMMENT_TEXT_MAX_CHARS`). */
export const SESSION_MESSAGE_MAX_CHARS = 2000;
export const SESSION_MESSAGES_MAX = 1000;
export const STEER_RATE = { perPersonPerHour: 20, perSessionPerHour: 60 } as const;
export const SESSION_LEGS_MAX = 20;
export const SESSION_NEEDS_PEOPLE_MAX = 50;
export const SESSION_SHARES_MAX = 50;
export const LOCAL_REGISTER_SHARES_MAX = 10;
export const SESSION_FOLLOWERS_MAX = 200;
export const PRESENCE_TTL_SECONDS = 90;
export const PRESENCE_HEARTBEAT_SECONDS = 30;
export const LIVE_ENDED_KEEP_HOURS = 24;
export const LIVE_PAGE_MAX = 100;
export const LIVE_INDEX_SCAN_MAX = 1000;
export const HOME_CARDS_MAX = 10;
export const HOME_CARD_BUTTONS_MAX = 3;
export const HOME_FAILURE_DAYS = 7;
/** How long a session's own records stay (owner answer 8, 2026-10-22; a placeholder constant). */
export const SESSION_RETENTION_DAYS = 365;
export const CHANGES_FEED_DAYS = 7;
export const CHANGES_PAGE_MAX = 500;
export const SESSION_SWEEP_PAGE = 100;
export const SESSION_SWEEP_BUDGET_MS = 20_000;
export const PROJECTOR_SESSIONS_PER_BATCH_MAX = 100;
export const PROJECTOR_CONCURRENCY = 8;
export const REALTIME_EVENTS_PER_PUBLISH = 5;
export const REALTIME_PUBLISH_DEADLINE_MS = 1000;
export const REALTIME_TOKEN_SECONDS = 900;
export const LOCAL_HEARTBEAT_SECONDS = 60;
export const LOCAL_OFFLINE_MINUTES = 10;
export const LOCAL_UPDATE_TURNS_MAX = 50;
export const LOCAL_TURN_MAX_CHARS = 4000;
export const LOCAL_TURNS_MAX = 2000;
export const DEVICE_LABEL_MAX = 60;
export const DEVICES_PER_MEMBER_MAX = 10;
export const HANDOFF_SUMMARY_MAX_BYTES = 8192;

const NAME_MAX_CHARS = 80;
const LINEAR_ISSUE_ID_MAX = 64;
const LINEAR_URL_MAX = 2048;
const DIGEST_MAX = 128;
const NEEDS_PERSON_MAX_CHARS = 200;
const DELIVERY_REASON_MAX_CHARS = 200;

// ---- text rules (lengths count characters, not UTF-16 units)

/** One line: no control or invisible-format characters, 1 to `max` characters. */
function lineText(max: number) {
  return z
    .string()
    .min(1)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");
}

/** Text that may span lines (newline, tab and carriage return are allowed; other control characters are not), up to `max` characters. */
function blockText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/(?![\n\t\r])\p{Cc}/u.test(value), "must not contain control characters");
}

const InstantSchema = z.string().datetime();
const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Control and format characters, except the two joiners that real names and emoji need (ZWNJ U+200C, ZWJ U+200D). The variation selectors (U+FE0E, U+FE0F) are not format characters, so they stay too. */
const NAME_UNSAFE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

/**
 * A person's or an agent's name as a session keeps it: control characters become spaces, every format character other than ZWNJ and ZWJ (bidi
 * controls, tag characters, soft hyphens, zero-width spaces) is dropped, and the rest is cleaned and cut to 80 characters between whole character
 * clusters. A ZWJ emoji, a Persian name with ZWNJ and a flag keep their meaning. `undefined` when nothing is left. The session schemas accept exactly
 * what this leaves alone, so a start that builds a record with this never fails on a name.
 */
export function cleanSessionName(name: string): string | undefined {
  return cleanDisplayName(name.replace(/\p{Cc}+/gu, " ").replace(/(?![\u200C\u200D])\p{Cf}/gu, ""));
}

const PersonNameSchema = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= NAME_MAX_CHARS, `must be at most ${String(NAME_MAX_CHARS)} characters`)
  .refine((value) => !NAME_UNSAFE.test(value), "must not contain control characters");
const ProjectNameSchema = z.string().regex(AGENTX_NAME_PATTERN);
const CountSchema = z.number().int().min(0);

// ---- ids

const SESSION_ID_PATTERN = /^ses_[0-9a-z]{20}$/;
// TODO(Plan 4 merge): Plan 4 defines `ChainRunIdSchema` (`/^crn_[0-9a-z]{20}$/`) in `packages/contracts/src/chains.ts` (branch
// feat/chains-plan4-a). It is not on this branch. Replace this private copy with that import when the branches meet.
const chainRunIdPlaceholder = z.string().regex(/^crn_[0-9a-z]{20}$/);
// TODO(Plan 4 merge): likewise Plan 4's `TriggerIdSchema` (`/^ctr_[0-9a-z]{20}$/`), in the same file.
const triggerIdPlaceholder = z.string().regex(/^ctr_[0-9a-z]{20}$/);

/** What started a run no person started (Plan 4's trigger dispatch passes it; Plan 5 records it on the session). */
export const SessionTriggerSchema = z.object({ kind: z.enum(["event", "schedule"]), triggerId: triggerIdPlaceholder }).strict();
export type SessionTrigger = z.infer<typeof SessionTriggerSchema>;

/** A session id: `ses_` for a task or local session, the chain run's own id for a chain session (Plan 4 pins `sessionId = ChainRunId`). */
export const SessionIdSchema = z.union([z.string().regex(SESSION_ID_PATTERN), chainRunIdPlaceholder]);
export const DeviceIdSchema = z.string().regex(/^dvc_[0-9a-z]{20}$/);
export const SessionMessageIdSchema = z.string().regex(/^msg_[0-9a-z]{20}$/);
export const SessionEventIdSchema = z.string().regex(/^evt_[0-9a-f]{24}$/);
export type SessionId = z.infer<typeof SessionIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type SessionMessageId = z.infer<typeof SessionMessageIdSchema>;
export type SessionEventId = z.infer<typeof SessionEventIdSchema>;

/**
 * The id of one event, the same every time the same occurrence is recorded: `"evt_" + sha256Hex(kind + "\n" + occurrence).slice(0, 24)`.
 * `occurrence` names what happened (a message id, an approval id, a source record and its time), so a retry writes the same key.
 */
export function sessionEventId(kind: string, occurrence: string): string {
  return `evt_${createHash("sha256").update(`${kind}\n${occurrence}`, "utf8").digest("hex").slice(0, 24)}`;
}

/** The link to a session: `<origin>/s/<sessionId>`. */
export function sessionLink(origin: string, sessionId: SessionId): string {
  return `${origin.replace(/\/+$/u, "")}/s/${sessionId}`;
}

// ---- kinds, statuses, modes, tools, levels

export const SESSION_KINDS = ["task", "chain", "local"] as const;
export const SESSION_STATUSES = ["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded", "failed", "cancelled"] as const;
export const ENDED_SESSION_STATUSES = ["succeeded", "failed", "cancelled"] as const;
/** What each status that isn't plain says to a person (a stopped or between-turn session stays open: owner answer 3). */
export const STATUS_WORDS = { waiting: "Waiting for you", stopped: "Stopped", paused: "Paused for budget", needs_person: "Needs a person" } as const;
/** Ask and Pair are later plans (owner answer 10); every session Plan 5 creates is `delegate`. */
export const SESSION_MODES = ["delegate"] as const;
export const LOCAL_TOOLS = ["rovara", "claude-code", "codex", "gemini-cli", "cursor-cli"] as const;
/** What a person may do on a session; compared with `atLeast` from agent.ts (view < use < edit). */
export const SESSION_LEVELS = ["view", "use", "edit"] as const;
export const LEVEL_WORDS = { view: "can view", use: "can use", edit: "can edit" } as const;

/** What a person may do on a session (`sessionActionsFor` in the broker decides who gets which). */
export const SESSION_ACTIONS = ["watch", "comment", "steer", "stop", "retry", "take_over", "share", "handoff"] as const;
export const SessionActionSchema = z.enum(SESSION_ACTIONS);
export type SessionAction = z.infer<typeof SessionActionSchema>;

export const SessionKindSchema = z.enum(SESSION_KINDS);
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export const SessionModeSchema = z.enum(SESSION_MODES);
export const LocalToolSchema = z.enum(LOCAL_TOOLS);
export const SessionLevelSchema = z.enum(SESSION_LEVELS);
export type SessionKind = z.infer<typeof SessionKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type LocalTool = z.infer<typeof LocalToolSchema>;
export type SessionLevel = z.infer<typeof SessionLevelSchema>;

// ---- the record and its parts

/** What the session is about: a Rovara Code or agent task, a chain run, or a local agent on a Mac. */
export const SessionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("chain"), chainRunId: chainRunIdPlaceholder }).strict(),
  z.object({ kind: z.literal("local"), deviceId: DeviceIdSchema, tool: LocalToolSchema }).strict(),
]);
export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

/** Where it runs now. */
export const SessionWhereSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("mac"), deviceId: DeviceIdSchema, label: lineText(DEVICE_LABEL_MAX) }).strict(),
]);
export type SessionWhere = z.infer<typeof SessionWhereSchema>;

/** One stretch of a session on one place; a move between a Mac and the cloud starts a new leg (owner answer 11). */
export const SessionLegSchema = z
  .object({
    seq: z.number().int().min(0),
    subject: SessionSubjectSchema,
    where: SessionWhereSchema,
    startedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
    endedBy: z.enum(["handoff", "end"]).optional(),
  })
  .strict();
export type SessionLeg = z.infer<typeof SessionLegSchema>;

/** What Live, Home and the header show; recomputed from the source records, redacted, and never moved backwards (Task 7a). */
export const SessionSummarySchema = z
  .object({
    status: SessionStatusSchema,
    step: lineText(SESSION_TITLE_MAX).optional(),
    peek: blockText(SESSION_PEEK_MAX_CHARS).optional(),
    lastRunFailed: z.literal(true).optional(),
    costUsd: z.number().min(0),
    runLimitUsd: z.number().min(0).optional(),
    stopAtUsd: z.number().min(0).optional(),
    needsPeople: z.array(lineText(NEEDS_PERSON_MAX_CHARS)).max(SESSION_NEEDS_PEOPLE_MAX),
    pendingApprovals: CountSchema,
    offline: z.literal(true).optional(),
    digest: z.string().min(1).max(DIGEST_MAX),
    computedAt: InstantSchema,
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionOwnerSchema = z.object({ developerId: DeveloperIdSchema, name: PersonNameSchema }).strict();
export const SessionAgentSchema = z
  .object({ agentId: AgentIdSchema, name: PersonNameSchema, version: z.union([z.number().int().min(1), z.literal("draft")]) })
  .strict();
export const SessionStartedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), developerId: DeveloperIdSchema }).strict(),
  z.object({ kind: z.literal("event"), triggerId: triggerIdPlaceholder }).strict(),
  z.object({ kind: z.literal("schedule"), triggerId: triggerIdPlaceholder }).strict(),
  z.object({ kind: z.literal("local") }).strict(),
]);
export type SessionOwner = z.infer<typeof SessionOwnerSchema>;
export type SessionAgent = z.infer<typeof SessionAgentSchema>;
export type SessionStartedBy = z.infer<typeof SessionStartedBySchema>;

/** The session's header, at `agentSessionKey(orgId, sessionId, "META")`. The work itself stays in the task, run and chain records. */
export const AgentSessionRecordSchema = z
  .object({
    orgId: OrgIdSchema,
    sessionId: SessionIdSchema,
    kind: SessionKindSchema,
    mode: SessionModeSchema,
    subject: SessionSubjectSchema,
    legs: z.array(SessionLegSchema).max(SESSION_LEGS_MAX),
    where: SessionWhereSchema,
    project: ProjectNameSchema.optional(),
    agent: SessionAgentSchema.optional(),
    title: lineText(SESSION_TITLE_MAX),
    owner: SessionOwnerSchema,
    startedBy: SessionStartedBySchema,
    origin: z.union([WorkOriginSchema, z.literal("local")]),
    payer: PayerSchema.optional(),
    retryOf: SessionIdSchema.optional(),
    followerCount: CountSchema,
    summary: SessionSummarySchema,
    summaryRevision: CountSchema,
    revision: CountSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
  })
  .strict();
export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

// ---- events and messages

export const SESSION_EVENT_TYPES = [
  "started", "status", "step", "comment", "steer", "steer_delivered", "steer_not_delivered", "take_over", "stopped", "retried", "shared", "handoff", "local_turn", "ended",
] as const;
export const SESSION_EVENT_SOURCES = ["app", "slack", "linear", "mac", "page"] as const;

/**
 * One line of a session's timeline, at `EVENT#<at>#<eventId>`. Events are ordered by `at`, then `eventId`; a page's cursor is the last item's
 * sort key. Once early events expire, the first readable event may come after `started` (owner answer 8).
 */
export const SessionEventSchema = z
  .object({
    eventId: SessionEventIdSchema,
    at: InstantSchema,
    type: z.enum(SESSION_EVENT_TYPES),
    actor: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("member"), developerId: DeveloperIdSchema, name: PersonNameSchema }).strict(),
        z.object({ kind: z.literal("agent") }).strict(),
        z.object({ kind: z.literal("system") }).strict(),
      ])
      .optional(),
    source: z.enum(SESSION_EVENT_SOURCES).optional(),
    messageId: SessionMessageIdSchema.optional(),
    text: blockText(SESSION_EVENT_TEXT_MAX),
  })
  .strict();
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** A comment (for people only) or a message to the agent (needs "can use"), at `MESSAGE#<messageId>`. */
export const SessionMessageSchema = z
  .object({
    messageId: SessionMessageIdSchema,
    sessionId: SessionIdSchema,
    kind: z.enum(["comment", "steer"]),
    source: z.enum(["app", "slack", "linear", "page"]),
    author: z.object({ developerId: DeveloperIdSchema, name: PersonNameSchema }).strict(),
    text: blockText(SESSION_MESSAGE_MAX_CHARS, 1),
    createdAt: InstantSchema,
    editedAt: InstantSchema.optional(),
    deletedAt: InstantSchema.optional(),
    rev: CountSchema,
    delivery: z
      .object({ state: z.enum(["queued", "delivered", "not_delivered"]), at: InstantSchema, reason: lineText(DELIVERY_REASON_MAX_CHARS).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/** The outside place a session is bound to: one Slack thread or one Linear issue, at `BINDING#<kind>` (Plan 9 posts through it). */
export const SessionBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack_thread"), teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, threadTs: SlackMessageTimestampSchema }).strict(),
  z
    .object({
      kind: z.literal("linear_issue"),
      issueId: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${String(LINEAR_ISSUE_ID_MAX)}}$`)),
      url: z.string().url().max(LINEAR_URL_MAX).refine((value) => value.startsWith("https://"), "must be an https link"),
    })
    .strict(),
]);
export type SessionBinding = z.infer<typeof SessionBindingSchema>;

// ---- what a refusal says (the codes are in errors.ts; the texts are exact)

export const SESSION_ENDED_MESSAGE = "This session has ended.";
export const SESSION_REVISION_CONFLICT_MESSAGE = "This session changed since you loaded it. Reload it and try again.";

/** SESSION_LEVEL_REQUIRED, for a person whose share is too low. `action` is a verb phrase such as "stop it". */
export function sessionLevelRequiredMessage(level: SessionLevel, action: string, owner: string): string {
  return `You need "${LEVEL_WORDS[level]}" on this session to ${action}. Ask ${owner} to share it with you.`;
}

/** SESSION_LEVEL_REQUIRED, for a viewer of the session's project. */
export function sessionViewerOnlyMessage(project: string): string {
  return `Viewers of ${project} can only watch its sessions.`;
}

/** SESSION_ON_MAC. */
export function sessionOnMacMessage(owner: string): string {
  return `This session runs on ${owner}'s Mac. Ask ${owner} to move it to the cloud first.`;
}

/** LOCAL_AGENT_NOT_ALLOWED, for a tool the company hasn't allowed. */
export function localToolNotAllowedMessage(tool: string): string {
  return `${tool} isn't allowed in your company. Ask an admin to allow it.`;
}

/** LOCAL_AGENT_NOT_ALLOWED, for a project that doesn't allow local agents. */
export function localAgentsNotAllowedOnProjectMessage(project: string): string {
  return `Local agents aren't allowed on ${project}. Ask an admin to allow them.`;
}
