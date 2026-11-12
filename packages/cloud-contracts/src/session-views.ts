import { z } from "zod";
import { LiveTileSchema as CodeLiveTileSchema, SessionWhereSchema, LIVE_PAGE_MAX, AGENT_SESSION_CONTRACT_VERSION, AGENTX_NAME_PATTERN, ChainRunViewSchema, CountSchema, ErrorRefSchema, forwardReader, InstantSchema, LocalToolSchema, PRESENCE_VIEWERS_MAX, SESSION_ACTIONS, SESSION_ANCHORS_MAX, SESSION_KINDS, SESSION_LEGS_MAX, SESSION_LEVELS, SESSION_MODES, SessionActionSchema, SessionAgentSchema, SessionAnchorRefSchema, SessionIdSchema, SessionLegSchema, SessionOwnerSchema, SessionStartedBySchema, SessionSummarySchema, SessionWhereViewSchema, TaskStatusSchema } from "@rovara-code/contracts";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { FinishedAsSchema } from "./finished-as.js";

export const URL_MAX = 2048;

export const LinkSchema = z.string().url().max(URL_MAX);

export const PayerNameSchema = z.object({ kind: z.enum(["member", "project", "agent", "chain"]), name: z.string().min(1).max(200) }).strict();

/**
 * One person's reading of one session: the header, its cost, what they may do, and the work itself (`body`). A session on a Mac (`kind: "local"`) always costs 0 and has no payer: it runs on the
 * person's own machine and credentials, and a Mac can never report `paused` (a pause for budget is Rovara's, for cloud work). `approvals` are the caller's own
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
    /** UX2 slice 2: where the work stands in the one status model, for this reader (a task's own `statusView`, a budget pause's next step says who can raise it). Absent from older servers. */
    display: TaskStatusSchema.optional(),
    /** Live interaction F1: what "Fix with agent" is about for this session (the task's error, when it shows one). Fixed codes and ids only. */
    errorRef: ErrorRefSchema.optional(),
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
    // `mayMerge`: set (true) only where the level alone would hide Merge from someone the server lets press it: a task's effective project maintainer or an org admin who reads it at `view`.
    you: z.object({ level: z.enum(SESSION_LEVELS), owner: z.boolean(), following: z.boolean(), actions: z.array(SessionActionSchema).max(SESSION_ACTIONS.length), mayMerge: z.literal(true).optional(),
      /** Live buttons: `ask` / `fix` are present (true) only when the install's switch is on AND the reader may use the feature on this session (the routes' own gate). Both absent: the key is left out. */
      live: z.object({ ask: z.literal(true).optional(), fix: z.literal(true).optional() }).strict().optional() }).strict(),
    link: LinkSchema,
    bindings: z.array(z.object({ kind: z.enum(["slack_thread", "linear_issue", "tracker_item"]), url: LinkSchema }).strict()).max(3),
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
export const SessionResponseSchema = z.object({
  session: SessionViewSchema,
  /** Only on a Stop's answer: `NOTHING_RUNNING` when the stop found nothing to stop, so the page does not say "Stop requested". */
  stop: z.literal("NOTHING_RUNNING").optional(),
  /** With `stop`: why nothing was stopped, when the page should say more than "Nothing was running" (a blocked task is ended by Close task, not Stop). */
  message: z.string().max(500).optional(),
}).strict();

export const SessionResponseReaderSchema = forwardReader(SessionResponseSchema);

/**
 * `POST /v1/app/sessions/{id}/close`: the task's own close (the one the Slack button and the AI-tool close run), as the page needs it. `closed: false` with `unpublished` means the workspace holds work that
 * was never published and a close that discards it must be asked for again (`discardUnpublished: true`); `message` says why a task is not closed yet and what to do next.
 */
export const SessionCloseResponseSchema = z.object({
  session: SessionViewSchema,
  closed: z.boolean(),
  discardedUnpublished: z.boolean().optional(),
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) }).strict()).optional(),
  message: z.string().optional(),
}).strict();

export const SessionCloseResponseReaderSchema = forwardReader(SessionCloseResponseSchema);

/** `GET /v1/app/sessions/{id}/sections/{seq}/task`: a chain step's task, as the task view shows it. */
export const SessionStepTaskResponseSchema = z.object({ task: DeveloperTaskViewSchema }).strict();

export const SessionStepTaskResponseReaderSchema = forwardReader(SessionStepTaskResponseSchema);

export const DeveloperTaskViewReaderSchema = forwardReader(DeveloperTaskViewSchema);

// ---- asking for a confirmation

export { SoleOwnerConfirmationSchema, CHANGE_TEXT_MAX } from "./needs-confirmation.js";

// ---- the session tile and the session list, with how a finished session ended (srv/needs-broker-ui-2): Cloud's own text of Code's, plus `finishedAs`. Owed upstream: see owed-upstream.json.

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
    /** Only on an ended session: how it ended (`FINISHED_AS`). Absent on an open one and on a tile an older server wrote. */
    finishedAs: FinishedAsSchema.optional(),
  })
  .strict();

export type SessionTile = z.infer<typeof SessionTileSchema>;

export const SessionTileReaderSchema = forwardReader(SessionTileSchema);

/** `GET /v1/app/sessions`: one page of sessions, newest first; `next` is opaque, passed back as `cursor`. */
export const SessionListSchema = z.object({
  sessions: z.array(SessionTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional(),
  /** Only on the Finished list for Team or Company, when the caller reaches more projects than one answer reads (the rest are left to their own project's list). */
  projectsCut: z.literal(true).optional(),
}).strict();

export type SessionList = z.infer<typeof SessionListSchema>;

export const SessionListReaderSchema = forwardReader(SessionListSchema);

// ---- the Live wall's tile, with whether the session ended and whether its owner may dismiss it (this lane, 0.5.16): Code's tile plus two optional fields. Owed upstream: see owed-upstream.json.

/**
 * One session on the Live wall (Code's tile) and two facts the Work list needs about an ENDED session: `endedAt` (when it ended; absent on an open one, so a row can say "Failed (ended)" and never offer what
 * only an open session takes), and `canDismiss` (an ended failed session its owner may dismiss: the same dismissal Home's failure card keeps, so it leaves Needs attention and Home's count together).
 */
export const LiveTileSchema = CodeLiveTileSchema.extend({
  endedAt: InstantSchema.optional(),
  canDismiss: z.literal(true).optional(),
});

export type LiveTile = z.infer<typeof LiveTileSchema>;

export const LiveTileReaderSchema = forwardReader(LiveTileSchema);

/** `GET /v1/app/live?filter=&project=&cursor=`: one page of tiles, newest session first; `next` is opaque, passed back as `cursor`. */
export const LiveResponseSchema = z.object({ tiles: z.array(LiveTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();

export type LiveResponse = z.infer<typeof LiveResponseSchema>;

export const LiveResponseReaderSchema = forwardReader(LiveResponseSchema);
