// What session routes answer and clients read (Plan 5 Task 1 declares the shapes; the tasks that serve each one fill it in).
//
// Every shape has a strict server schema (`…Schema`, which refuses what it doesn't know) and a forward-compatible reader (`…ReaderSchema`,
// which keeps unknown fields and reads a value a newer server added to an enum as "unknown"). Clients parse with the reader; the server
// validates what it writes with the strict one. The reader is derived from the strict schema, so the two can't drift apart.
import { z } from "zod";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  SESSION_ACTIONS,
  SESSION_SHARES_MAX,
  LocalToolSchema,
  SessionActionSchema,
  LIVE_PAGE_MAX,
  LIVE_FILTERS,
  LIVE_VIEWING_MAX,
  SESSION_EVENTS_PAGE_MAX,
  SESSION_ANCHORS_MAX,
  SESSION_MESSAGES_PAGE_MAX,
  SESSION_KINDS,
  SessionAnchorRefSchema,
  SESSION_LEVELS,
  SESSION_MODES,
  SessionAgentSchema,
  SessionEventSchema,
  SessionIdSchema,
  SessionLegSchema,
  SessionMessageSchema,
  SessionOwnerSchema,
  SessionStartedBySchema,
  SessionSummarySchema,
  SessionWhereSchema,
  SESSION_LEGS_MAX,
} from "./agent-sessions.js";
import { AgentIdSchema, AgentPrincipalSchema } from "./agent.js";
import { ProjectRoleSchema, ProjectSetupStatusSchema, ProjectStatusSchema } from "./app-projects.js";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { ChainRunViewSchema } from "./chain-session.js";
import { forwardReader } from "./forward-reader.js";

const InstantSchema = z.string().datetime();
/** The most people `viewingNow` names. */
export const PRESENCE_VIEWERS_MAX = 20;
const NEEDS_CONFIRMATION_CHANGES_MAX = 10;
const CHANGE_TEXT_MAX = 300;
const URL_MAX = 2048;

// ---- the session as one person reads it

const LinkSchema = z.string().url().max(URL_MAX);
const CountSchema = z.number().int().min(0);

/** Where a session runs as a person is told: the cloud, or a Mac by its label (never its device id) and whether it is offline. */
export const SessionWhereViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("mac"), label: z.string().min(1).max(200), offline: z.boolean() }).strict(),
]);

/** Who pays for a session: the kind and a name to show (a person, a project or an agent). */
const PayerNameSchema = z.object({ kind: z.enum(["member", "project", "agent", "chain"]), name: z.string().min(1).max(200) }).strict();

/**
 * One person's reading of one session: the header, its cost, what they may do, and the work itself (`body`). `approvals` are the caller's own
 * pending decisions on this session and `cost.paused.confirmUrl` is the link of a budget request they may decide: bare `/v1/app/approve/<id>`
 * links, never present for a person who may not decide, and never holding what is being approved (the confirmation page shows that).
 */
export const SessionViewSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    mode: z.enum(SESSION_MODES),
    title: z.string().min(1),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    agent: SessionAgentSchema.optional(),
    owner: SessionOwnerSchema,
    startedBy: SessionStartedBySchema,
    where: SessionWhereViewSchema,
    status: SessionSummarySchema.shape.status,
    step: SessionSummarySchema.shape.step,
    peek: SessionSummarySchema.shape.peek,
    lastRunFailed: SessionSummarySchema.shape.lastRunFailed,
    cost: z
      .object({
        spentUsd: z.number().min(0),
        runLimitUsd: z.number().min(0).optional(),
        stopAtUsd: z.number().min(0).optional(),
        payer: PayerNameSchema,
        paused: z.object({ scope: z.string().min(1).max(100), spendRequestId: z.string().min(1).max(100).optional(), confirmUrl: LinkSchema.optional() }).strict().optional(),
      })
      .strict(),
    approvals: z.array(z.object({ approvalId: z.string().min(1).max(100), title: z.string().min(1).max(300), confirmUrl: LinkSchema }).strict()).max(50),
    followers: CountSchema,
    viewingNow: z.array(SessionOwnerSchema).max(PRESENCE_VIEWERS_MAX),
    you: z.object({ level: z.enum(SESSION_LEVELS), owner: z.boolean(), following: z.boolean(), actions: z.array(SessionActionSchema).max(SESSION_ACTIONS.length) }).strict(),
    link: LinkSchema,
    bindings: z.array(z.object({ kind: z.enum(["slack_thread", "linear_issue"]), url: LinkSchema }).strict()).max(2),
    legs: z.array(SessionLegSchema).max(SESSION_LEGS_MAX),
    retryOf: SessionIdSchema.optional(),
    /** Task 10b: the parts of the work a comment can be pinned to (a paragraph of the plan, a step, a changed file) with the revision of each now. Absent when there are none. */
    anchors: z.array(SessionAnchorRefSchema).max(SESSION_ANCHORS_MAX).optional(),
    /** The session's revision: what a change to it (a take-over, a share) is asked against. */
    revision: CountSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("task"), task: DeveloperTaskViewSchema }).strict(),
      // Plan 4's run view. A gate's `confirmUrl` is optional in it: it is there for a person who may decide the gate and left out for anyone else.
      z.object({ kind: z.literal("chain"), chain: ChainRunViewSchema }).strict(),
      z.object({ kind: z.literal("local"), tool: LocalToolSchema }).strict(),
    ]),
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;
export const SessionViewReaderSchema = forwardReader(SessionViewSchema);

/** `GET /v1/app/sessions/{id}`. */
export const SessionResponseSchema = z.object({ session: SessionViewSchema }).strict();
export const SessionResponseReaderSchema = forwardReader(SessionResponseSchema);

/** `GET /v1/app/sessions/{id}/sections/{seq}/task`: a chain step's task, as the task view shows it. */
export const SessionStepTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema }).strict();
export const SessionStepTaskResponseReaderSchema = forwardReader(SessionStepTaskResponseSchema);

/** One share on a session, as `GET .../shares` lists it. */
export const SessionShareSchema = z
  .object({
    principal: AgentPrincipalSchema,
    level: z.enum(SESSION_LEVELS),
    sharedBy: z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1) }).strict(),
    sharedAt: InstantSchema,
  })
  .strict();
export type SessionShare = z.infer<typeof SessionShareSchema>;
export const SessionShareReaderSchema = forwardReader(SessionShareSchema);
/** `GET /v1/app/sessions/{id}/shares`. */
export const SessionSharesResponseSchema = z.object({ shares: z.array(SessionShareSchema).max(SESSION_SHARES_MAX) }).strict();
export const SessionSharesResponseReaderSchema = forwardReader(SessionSharesResponseSchema);
/** `PUT /v1/app/sessions/{id}/shares` when it applies at once (a person or a project); a company-wide share answers `NeedsConfirmationSchema` with 202. */
export const SessionSharePutResponseSchema = z.object({ share: SessionShareSchema }).strict();
export const SessionSharePutResponseReaderSchema = forwardReader(SessionSharePutResponseSchema);
/** `DELETE /v1/app/sessions/{id}/shares/{principalKey}`. */
export const SessionShareDeleteResponseSchema = z.object({ removed: z.boolean() }).strict();
export const SessionShareDeleteResponseReaderSchema = forwardReader(SessionShareDeleteResponseSchema);

/** `POST` and `DELETE /v1/app/sessions/{id}/follow`: whether the caller follows now (the session's owner always does, with no item). */
export const SessionFollowResponseSchema = z.object({ following: z.boolean() }).strict();
export const SessionFollowResponseReaderSchema = forwardReader(SessionFollowResponseSchema);
/** `POST /v1/app/sessions/{id}/presence`: who is looking at the session now, counting this heartbeat. */
export const SessionPresenceResponseSchema = z.object({ viewingNow: z.array(SessionOwnerSchema).max(PRESENCE_VIEWERS_MAX) }).strict();
export const SessionPresenceResponseReaderSchema = forwardReader(SessionPresenceResponseSchema);

/** One session on the Live wall, a project page or a Home card: the header's short form. */
export const SessionTileSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    title: z.string().min(1),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    agent: SessionAgentSchema.optional(),
    owner: SessionOwnerSchema,
    where: SessionWhereSchema,
    level: z.enum(SESSION_LEVELS),
    revision: z.number().int().min(0),
    summary: SessionSummarySchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
  })
  .strict();
export type SessionTile = z.infer<typeof SessionTileSchema>;
export const SessionTileReaderSchema = forwardReader(SessionTileSchema);

// ---- the Live wall (Plan 5 Task 14)

/** The filter of `GET /v1/app/live`. */
export const LiveFilterSchema = z.enum(LIVE_FILTERS);
export type LiveFilter = z.infer<typeof LiveFilterSchema>;

/**
 * One session on the Live wall, as one person sees it. Everything on it is read for that person now: `actions` is what they may do (the session view's `you.actions` without
 * `make_agent`), `approvalUrl` is the bare confirmation link of the first pending decision they may make (never present for anyone who may not decide, and never with a ticket),
 * `needsYou` says a decision or a plan waits on them, `following` that they follow it (the owner always does), and `viewingNow` names at most `LIVE_VIEWING_MAX` of the people
 * looking at it now, of whom there are `viewingNowCount`. `status`, `step`, `peek`, `lastRunFailed`, `costUsd` and `updatedAt` are the session summary's; a client keeps the tile
 * with the newer `updatedAt` when two answers cross.
 */
export const LiveTileSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    title: z.string().min(1),
    agent: SessionAgentSchema.optional(),
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    owner: SessionOwnerSchema,
    where: SessionWhereViewSchema,
    status: SessionSummarySchema.shape.status,
    statusWords: z.string().min(1),
    step: SessionSummarySchema.shape.step,
    peek: SessionSummarySchema.shape.peek,
    lastRunFailed: SessionSummarySchema.shape.lastRunFailed,
    costUsd: SessionSummarySchema.shape.costUsd,
    viewingNow: z.array(SessionOwnerSchema).max(LIVE_VIEWING_MAX),
    viewingNowCount: CountSchema,
    needsYou: z.boolean(),
    following: z.boolean(),
    actions: z.array(SessionActionSchema).max(SESSION_ACTIONS.length),
    approvalUrl: LinkSchema.optional(),
    updatedAt: InstantSchema,
  })
  .strict();
export type LiveTile = z.infer<typeof LiveTileSchema>;
export const LiveTileReaderSchema = forwardReader(LiveTileSchema);

/** `GET /v1/app/live?filter=&project=&cursor=`: one page of tiles, newest session first; `next` is opaque, passed back as `cursor`. */
export const LiveResponseSchema = z.object({ tiles: z.array(LiveTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();
export type LiveResponse = z.infer<typeof LiveResponseSchema>;
export const LiveResponseReaderSchema = forwardReader(LiveResponseSchema);

/** `GET /v1/app/sessions`: one page of sessions, newest first; `next` is opaque, passed back as `cursor`. */
export const SessionListSchema = z.object({ sessions: z.array(SessionTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();
export type SessionList = z.infer<typeof SessionListSchema>;
export const SessionListReaderSchema = forwardReader(SessionListSchema);

export const SessionEventReaderSchema = forwardReader(SessionEventSchema);

/** A page of a session's timeline, oldest first. `next` is the last event's sort key (`<at>#<eventId>`); readers re-read a little before it and de-duplicate by `eventId`. */
export const SessionEventPageSchema = z
  .object({ events: z.array(SessionEventSchema).max(SESSION_EVENTS_PAGE_MAX), next: z.string().min(1).optional() })
  .strict();
export type SessionEventPage = z.infer<typeof SessionEventPageSchema>;
export const SessionEventPageReaderSchema = forwardReader(SessionEventPageSchema);

/**
 * A page of a session's conversation, oldest first: its own comments and, for a task session, the task page's (`source: "page"`). `next` is the cursor for the following read: the last
 * new message's `<createdAt>#<messageId>`. A read with a cursor starts with the few seconds of messages before it (at most `SESSION_MESSAGES_PAGE_MAX`), so one committed late is still
 * found: readers de-duplicate by `messageId`. An edit or a deletion shows on a read that reaches the message again (a reload); a cursor read gives it only while it is that recent.
 */
export const SessionMessagePageSchema = z
  .object({ messages: z.array(SessionMessageSchema).max(2 * SESSION_MESSAGES_PAGE_MAX), next: z.string().min(1).optional() })
  .strict();
export type SessionMessagePage = z.infer<typeof SessionMessagePageSchema>;
export const SessionMessagePageReaderSchema = forwardReader(SessionMessagePageSchema);

// ---- the project page (Plan 5 Task 16; Home's shapes are in home.ts)

/** The most repositories, channels and agents a project page lists. */
export const PROJECT_OVERVIEW_REPOSITORIES_MAX = 50;
export const PROJECT_OVERVIEW_CHANNELS_MAX = 20;
export const PROJECT_OVERVIEW_AGENTS_MAX = 100;

/** The project's card: what it is, where its code is, how ready it is, and the Slack channels that reach it. */
export const ProjectOverviewProjectSchema = z
  .object({
    name: z.string().regex(AGENTX_NAME_PATTERN),
    description: z.string().max(2000).optional(),
    status: ProjectStatusSchema,
    latestRevision: z.number().int().positive().optional(),
    repositories: z.array(z.object({ fullName: z.string().min(1).max(200), defaultBranch: z.string().min(1).max(200) }).strict()).max(PROJECT_OVERVIEW_REPOSITORIES_MAX),
    setup: z
      .object({ status: ProjectSetupStatusSchema, checkedRevision: z.number().int().positive().optional(), checkedAt: InstantSchema.optional(), failedStep: z.string().max(300).optional() })
      .strict(),
    channels: z.array(z.string().min(1).max(40)).max(PROJECT_OVERVIEW_CHANNELS_MAX),
  })
  .strict();

/** What the reader may do on the project, from their role now: a flag is true only when the action is allowed. */
export const ProjectOverviewYouSchema = z
  .object({ role: ProjectRoleSchema, canStartWork: z.boolean(), canEditSettings: z.boolean(), canViewSpend: z.boolean() })
  .strict();

/** An agent on the project, with how many of the sessions the reader can see it is running now. */
export const ProjectOverviewAgentSchema = z
  .object({ agentId: AgentIdSchema, name: z.string().min(1).max(200), description: z.string().max(2000), running: z.number().int().min(0) })
  .strict();

/** The month's money on the project. Present only for a reader who may see the project's spend. `costPerMergedPullRequestUsd` is absent until a pull request has merged this month. */
export const ProjectOverviewBudgetSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
    spentUsd: z.number().min(0),
    limitUsd: z.number().min(0).optional(),
    mergedPullRequests: z.number().int().min(0),
    costPerMergedPullRequestUsd: z.number().min(0).optional(),
  })
  .strict();

/**
 * `GET /v1/app/projects/{name}/overview`: a project's page. Read now for the reader: a person with no role in the project gets `PROJECT_NOT_FOUND`; `budget` is present only for a reader
 * who may see spend; `agents` are the agents the reader may see; `running` is the Live wall's `team` filter for this project (at most one page of `LiveTile`s the reader can view).
 */
export const ProjectOverviewSchema = z
  .object({
    project: ProjectOverviewProjectSchema,
    you: ProjectOverviewYouSchema,
    agents: z.array(ProjectOverviewAgentSchema).max(PROJECT_OVERVIEW_AGENTS_MAX),
    budget: ProjectOverviewBudgetSchema.optional(),
    running: z.array(LiveTileSchema).max(LIVE_PAGE_MAX),
  })
  .strict();
export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;
export const ProjectOverviewReaderSchema = forwardReader(ProjectOverviewSchema);

// ---- asking for a confirmation

/**
 * What a take-over or a company-wide share answers (HTTP 202) when the caller isn't signed in freshly enough to decide it: a link to open
 * in a browser. It is the shape of Plan 3's own pending-change routes, so CLI and MCP clients print the link and never say the sign-in ended.
 */
export const NeedsConfirmationSchema = z
  .object({
    status: z.literal("NEEDS_CONFIRMATION"),
    code: z.literal("REAUTH_REQUIRED"),
    confirmUrl: z.string().url().max(URL_MAX).refine((value) => value.startsWith("https://"), "must be an https link"),
    changes: z.array(z.string().min(1).max(CHANGE_TEXT_MAX)).max(NEEDS_CONFIRMATION_CHANGES_MAX),
  })
  .strict();
export type NeedsConfirmation = z.infer<typeof NeedsConfirmationSchema>;
