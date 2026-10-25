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
  HOME_CARDS_MAX,
  HOME_CARD_BUTTONS_MAX,
  LIVE_PAGE_MAX,
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
import { AgentPrincipalSchema } from "./agent.js";
import { DeveloperTaskViewSchema } from "./developer-tasks.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

const UNKNOWN = "unknown" as const;
const InstantSchema = z.string().datetime();
/** The most people `viewingNow` names. */
export const PRESENCE_VIEWERS_MAX = 20;
const NEEDS_CONFIRMATION_CHANGES_MAX = 10;
const CHANGE_TEXT_MAX = 300;
const URL_MAX = 2048;
const HOME_TEXT_MAX = 300;

// ---- forward-compatible readers

/**
 * A value of an enum that reads a string a newer server added as "unknown". A missing or non-string value stays an error.
 * TODO(Plan 4 merge): Plan 4 defines `openEnum` in `packages/contracts/src/chain-session.ts` as `z.enum(values).catch("unknown")`, which also
 * turns a missing value into "unknown". Keep this one private and stricter, or move both onto one definition when the branches meet.
 */
function openEnum<const T extends readonly [string, ...string[]]>(values: T): z.ZodType<T[number] | typeof UNKNOWN> {
  return z.string().transform((value): T[number] | typeof UNKNOWN => ((values as readonly string[]).includes(value) ? value : UNKNOWN));
}

/** What a reader gives for a strict type: objects keep unknown fields, and a string-literal union may read as "unknown". */
export type ForwardReader<T> = T extends string
  ? string extends T ? T : T | typeof UNKNOWN
  : T extends readonly (infer Item)[]
    ? Array<ForwardReader<Item>>
    : T extends object
      ? { [Key in keyof T]: ForwardReader<T[Key]> } & { [other: string]: unknown }
      : T;

type Def = { type: string } & Record<string, unknown>;
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/**
 * The reader for a strict schema: objects become `looseObject`s, enums become `openEnum`s, an object variant of a discriminated union with a
 * kind the schema doesn't know is read with `kind: "unknown"` and its other fields kept, and everything else (strings, numbers, literals,
 * arrays, optionals) is rebuilt around the same pieces. Length and pattern rules on plain values are kept.
 */
export function forwardReader<S extends z.ZodType>(schema: S): z.ZodType<ForwardReader<z.output<S>>> {
  return readerOf(schema) as z.ZodType<ForwardReader<z.output<S>>>;
}

function readerOf(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = (schema as unknown as z.ZodObject).shape;
      return z.looseObject(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, readerOf(field)])));
    }
    case "enum":
      return openEnum((schema as unknown as z.ZodEnum).options as unknown as readonly [string, ...string[]]);
    case "array":
      return z.array(readerOf(def.element as z.ZodType));
    case "optional":
      return readerOf(def.innerType as z.ZodType).optional();
    case "union": {
      const options = def.options as z.ZodType[];
      if (typeof def.discriminator !== "string") return z.union(options.map(readerOf) as unknown as [z.ZodType, z.ZodType]);
      const discriminator = def.discriminator;
      const known = options.flatMap((option) => [...((option as unknown as z.ZodObject).shape[discriminator] as unknown as z.ZodLiteral).values]);
      const unknownVariant = z.looseObject({ [discriminator]: z.string().refine((value) => !known.includes(value)).transform((): typeof UNKNOWN => UNKNOWN) });
      return z.union([...options.map(readerOf), unknownVariant] as unknown as [z.ZodType, z.ZodType]);
    }
    default:
      return schema;
  }
}

// ---- the session as one person reads it

const LinkSchema = z.string().url().max(URL_MAX);
const CountSchema = z.number().int().min(0);

/**
 * What Plan 4's `chainRunView` answers for a chain session's body. Plan 4 is not on this branch, so the body is read as an object whose fields
 * are kept as they come. TODO(Plan 4 merge): replace with `ChainRunViewSchema` from `packages/contracts/src/chain-session.ts`.
 */
export const ChainRunViewPlaceholderSchema = z.looseObject({});

/** Who pays for a session: the kind and a name to show (a person, a project or an agent). */
const PayerNameSchema = z.object({ kind: z.enum(["member", "project", "agent"]), name: z.string().min(1).max(200) }).strict();

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
    where: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cloud") }).strict(),
      z.object({ kind: z.literal("mac"), label: z.string().min(1).max(200), offline: z.boolean() }).strict(),
    ]),
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
      z.object({ kind: z.literal("chain"), chain: ChainRunViewPlaceholderSchema }).strict(),
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

/** `GET /v1/app/sessions`: one page of sessions, newest first; `next` is opaque, passed back as `cursor`. */
export const SessionListSchema = z.object({ sessions: z.array(SessionTileSchema).max(LIVE_PAGE_MAX), next: z.string().min(1).max(200).optional() }).strict();
export type SessionList = z.infer<typeof SessionListSchema>;
export const SessionListReaderSchema = forwardReader(SessionListSchema);

export const DeveloperTaskViewReaderSchema = forwardReader(DeveloperTaskViewSchema);
export const SessionEventReaderSchema = forwardReader(SessionEventSchema);
export const SessionMessageReaderSchema = forwardReader(SessionMessageSchema);

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

// ---- Home and the project page (declared here; Tasks 15 and 16 fill them in)

/** One card on Home. Task 15 adds its kinds and their fields; until then a card has an id, a kind, a title and a time. */
export const HomeCardSchema = z
  .object({
    cardId: z.string().min(1).max(200),
    kind: z.enum(["needs_you", "failed", "finished", "running"]),
    title: z.string().min(1).max(HOME_TEXT_MAX),
    sessionId: SessionIdSchema.optional(),
    buttons: z.array(z.object({ label: z.string().min(1).max(HOME_TEXT_MAX), action: z.string().min(1).max(HOME_TEXT_MAX) }).strict()).max(HOME_CARD_BUTTONS_MAX).optional(),
    at: InstantSchema,
  })
  .strict();
export type HomeCard = z.infer<typeof HomeCardSchema>;
export const HomeCardReaderSchema = forwardReader(HomeCardSchema);

export const HomeResponseSchema = z.object({ cards: z.array(HomeCardSchema).max(HOME_CARDS_MAX) }).strict();
export type HomeResponse = z.infer<typeof HomeResponseSchema>;
export const HomeResponseReaderSchema = forwardReader(HomeResponseSchema);

/** A project's page of sessions. Task 16 adds counts and cost; until then it lists what is running. */
export const ProjectOverviewSchema = z
  .object({ project: z.string().regex(AGENTX_NAME_PATTERN), running: z.array(SessionTileSchema).max(LIVE_PAGE_MAX) })
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
