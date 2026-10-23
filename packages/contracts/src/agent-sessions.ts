import { z } from "zod";
import { AgentIdSchema } from "./agent.js";


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

export const SESSION_LEGS_MAX = 20;

export const SESSION_NEEDS_PEOPLE_MAX = 50;

export const SESSION_SHARES_MAX = 50;

export const PRESENCE_HEARTBEAT_SECONDS = 30;

export const LIVE_PAGE_MAX = 100;

export const HOME_CARDS_MAX = 10;

export const HOME_CARD_BUTTONS_MAX = 3;

export const DEVICE_LABEL_MAX = 60;

export const NAME_MAX_CHARS = 80;

export const DIGEST_MAX = 128;

export const NEEDS_PERSON_MAX_CHARS = 200;

export const DELIVERY_REASON_MAX_CHARS = 200;

export function lineText(max: number) {
  return z
    .string()
    .min(1)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");
}

export function blockText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
    .refine((value) => !/(?![\n\t\r])\p{Cc}/u.test(value), "must not contain control characters");
}

export const InstantSchema = z.string().datetime();

export const DeveloperIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const NAME_UNSAFE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

export const PersonNameSchema = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= NAME_MAX_CHARS, `must be at most ${String(NAME_MAX_CHARS)} characters`)
  .refine((value) => !NAME_UNSAFE.test(value), "must not contain control characters");

export const CountSchema = z.number().int().min(0);

export const SESSION_ID_PATTERN = /^ses_[0-9a-z]{20}$/;

export const chainRunIdPlaceholder = z.string().regex(/^crn_[0-9a-z]{20}$/);

export const triggerIdPlaceholder = z.string().regex(/^ctr_[0-9a-z]{20}$/);


/** A session id: `ses_` for a task or local session, the chain run's own id for a chain session (Plan 4 pins `sessionId = ChainRunId`). */
export const SessionIdSchema = z.union([z.string().regex(SESSION_ID_PATTERN), chainRunIdPlaceholder]);

export const DeviceIdSchema = z.string().regex(/^dvc_[0-9a-z]{20}$/);

export const SessionMessageIdSchema = z.string().regex(/^msg_[0-9a-z]{20}$/);

export const SessionEventIdSchema = z.string().regex(/^evt_[0-9a-f]{24}$/);


// ---- kinds, statuses, modes, tools, levels

export const SESSION_KINDS = ["task", "chain", "local"] as const;

export const SESSION_STATUSES = ["starting", "running", "needs_person", "paused", "waiting", "stopped", "succeeded", "failed", "cancelled"] as const;

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

export const SessionStatusSchema = z.enum(SESSION_STATUSES);

export const LocalToolSchema = z.enum(LOCAL_TOOLS);


// ---- the record and its parts

/** What the session is about: a Rovara Code or agent task, a chain run, or a local agent on a Mac. */
export const SessionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("chain"), chainRunId: chainRunIdPlaceholder }).strict(),
  z.object({ kind: z.literal("local"), deviceId: DeviceIdSchema, tool: LocalToolSchema }).strict(),
]);


/** Where it runs now. */
export const SessionWhereSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("mac"), deviceId: DeviceIdSchema, label: lineText(DEVICE_LABEL_MAX) }).strict(),
]);


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
