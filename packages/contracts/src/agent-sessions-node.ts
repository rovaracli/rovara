import type { SessionId } from "./agent-sessions.js";
import { cleanDisplayName } from "./display-name.js";
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import type { DeviceIdSchema, SessionMessageIdSchema, SessionEventIdSchema, SessionStatusSchema, LocalToolSchema, SessionEventSchema} from "./agent-sessions.js";
import { triggerIdPlaceholder, SessionIdSchema, SESSION_KINDS, SESSION_MODES, SESSION_LEVELS, SessionSubjectSchema, SessionWhereSchema, SessionLegSchema, SessionSummarySchema, SessionOwnerSchema, SessionAgentSchema, SessionStartedBySchema, SESSION_LEGS_MAX, lineText, SESSION_TITLE_MAX, CountSchema, InstantSchema } from "./agent-sessions.js";
import { createHash } from "node:crypto";
import { OrgIdSchema } from "./org.js";
import { WorkOriginSchema, PayerSchema } from "./agent-run-node.js";
import { SlackTeamIdSchema, SlackChannelIdSchema, SlackMessageTimestampSchema } from "./slack.js";





export const LOCAL_REGISTER_SHARES_MAX = 10;

export const SESSION_FOLLOWERS_MAX = 200;

export const PRESENCE_TTL_SECONDS = 90;

export const LIVE_ENDED_KEEP_HOURS = 24;

export const LIVE_INDEX_SCAN_MAX = 1000;



/** How long a session's own records stay (owner answer 8, 2026-10-22; a placeholder constant). */






























export const DEVICES_PER_MEMBER_MAX = 10;

export const HANDOFF_SUMMARY_MAX_BYTES = 8192;

const LINEAR_ISSUE_ID_MAX = 64;

const LINEAR_URL_MAX = 2048;


/**
 * A person's or an agent's name as a session keeps it: control characters become spaces, every format character other than ZWNJ and ZWJ (bidi
 * controls, tag characters, soft hyphens, zero-width spaces) is dropped, and the rest is cleaned and cut to 80 characters between whole character
 * clusters. A ZWJ emoji, a Persian name with ZWNJ and a flag keep their meaning. `undefined` when nothing is left. The session schemas accept exactly
 * what this leaves alone, so a start that builds a record with this never fails on a name.
 */
export function cleanSessionName(name: string): string | undefined {
  return cleanDisplayName(name.replace(/\p{Cc}+/gu, " ").replace(/(?![\u200C\u200D])\p{Cf}/gu, ""));
}

const ProjectNameSchema = z.string().regex(AGENTX_NAME_PATTERN);


/** What started a run no person started (Plan 4's trigger dispatch passes it; Plan 5 records it on the session). */
export const SessionTriggerSchema = z.object({ kind: z.enum(["event", "schedule"]), triggerId: triggerIdPlaceholder }).strict();

export type SessionTrigger = z.infer<typeof SessionTriggerSchema>;

export type { SessionId } from "./agent-sessions.js";

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

export const ENDED_SESSION_STATUSES = ["succeeded", "failed", "cancelled"] as const;




export const SessionKindSchema = z.enum(SESSION_KINDS);

export const SessionModeSchema = z.enum(SESSION_MODES);

export const SessionLevelSchema = z.enum(SESSION_LEVELS);

export type SessionKind = z.infer<typeof SessionKindSchema>;

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export type SessionMode = z.infer<typeof SessionModeSchema>;

export type LocalTool = z.infer<typeof LocalToolSchema>;



export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

export type SessionWhere = z.infer<typeof SessionWhereSchema>;

export type SessionLeg = z.infer<typeof SessionLegSchema>;

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

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

export type SessionEvent = z.infer<typeof SessionEventSchema>;




/** The outside place a session is bound to: one Slack thread or one Linear issue, at `BINDING#<kind>` (Plan 9 posts through it). */





// ---- what a refusal says (the codes are in errors.ts; the texts are exact)






/** SESSION_LEVEL_REQUIRED, for a person whose share is too low. `action` is a verb phrase such as "stop it". */



/** SESSION_LEVEL_REQUIRED, for a viewer of the session's project. */



/** SESSION_ON_MAC. */



/** LOCAL_AGENT_NOT_ALLOWED, for a tool the company hasn't allowed. */



/** LOCAL_AGENT_NOT_ALLOWED, for a project that doesn't allow local agents. */


export { AGENT_SESSION_CONTRACT_VERSION, SESSION_TITLE_MAX, SESSION_PEEK_MAX_CHARS, SESSION_EVENT_TEXT_MAX, SESSION_EVENTS_PAGE_MAX, SESSION_MESSAGE_MAX_CHARS, SESSION_LEGS_MAX, SESSION_NEEDS_PEOPLE_MAX, SESSION_SHARES_MAX, PRESENCE_HEARTBEAT_SECONDS, LIVE_PAGE_MAX, HOME_CARDS_MAX, HOME_CARD_BUTTONS_MAX, DEVICE_LABEL_MAX, SessionIdSchema, DeviceIdSchema, SessionMessageIdSchema, SessionEventIdSchema, SESSION_KINDS, SESSION_STATUSES, STATUS_WORDS, SESSION_MODES, LOCAL_TOOLS, SESSION_LEVELS, LEVEL_WORDS, SESSION_ACTIONS, SessionActionSchema, SessionStatusSchema, LocalToolSchema, SessionSubjectSchema, SessionWhereSchema, SessionLegSchema, SessionSummarySchema, SessionOwnerSchema, SessionAgentSchema, SessionStartedBySchema, SESSION_EVENT_TYPES, SESSION_EVENT_SOURCES, SessionEventSchema, SessionMessageSchema } from "./agent-sessions.js";

export { SESSION_MESSAGES_MAX, STEER_RATE, HOME_FAILURE_DAYS, SESSION_RETENTION_DAYS, CHANGES_FEED_DAYS, CHANGES_PAGE_MAX, SESSION_SWEEP_PAGE, SESSION_SWEEP_BUDGET_MS, PROJECTOR_SESSIONS_PER_BATCH_MAX, PROJECTOR_CONCURRENCY, REALTIME_EVENTS_PER_PUBLISH, REALTIME_PUBLISH_DEADLINE_MS, REALTIME_TOKEN_SECONDS, LOCAL_HEARTBEAT_SECONDS, LOCAL_OFFLINE_MINUTES, LOCAL_UPDATE_TURNS_MAX, LOCAL_TURN_MAX_CHARS, LOCAL_TURNS_MAX, type SessionAction, type SessionLevel, type SessionMessage, SESSION_ENDED_MESSAGE, SESSION_REVISION_CONFLICT_MESSAGE, sessionLevelRequiredMessage, sessionViewerOnlyMessage, sessionOnMacMessage, localToolNotAllowedMessage, localAgentsNotAllowedOnProjectMessage } from "./agent-sessions.js";

export { SESSION_MESSAGES_PAGE_MAX, CHANGES_SETTLE_MS, SESSION_ANCHOR_TARGETS, SESSION_ANCHOR_STATES, SESSION_ANCHOR_EXCERPT_MAX, SESSION_ANCHORS_MAX, SessionAnchorRefSchema, type SessionAnchorRef, SessionAnchorSchema, type SessionAnchor, SessionGoneAnchorSchema, type SessionGoneAnchor, SessionAnchorInputSchema, type SessionAnchorInput, AgentOriginSchema, type AgentOrigin, AgentOriginViewSchema, type AgentOriginView, MAKE_AGENT_NOT_COPIED_REASON, SessionMakeAgentCopiedSchema, type SessionMakeAgentCopied, SessionMakeAgentBodySchema, type SessionMakeAgentBody } from "./agent-sessions.js";

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
