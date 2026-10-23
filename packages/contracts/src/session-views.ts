// What session routes answer and clients read (Plan 5 Task 1 declares the shapes; the tasks that serve each one fill it in).
//
// Every shape has a strict server schema (`…Schema`, which refuses what it doesn't know) and a forward-compatible reader (`…ReaderSchema`,
// which keeps unknown fields and reads a value a newer server added to an enum as "unknown"). Clients parse with the reader; the server
// validates what it writes with the strict one. The reader is derived from the strict schema, so the two can't drift apart.
import { z } from "zod";
import {
  AGENT_SESSION_CONTRACT_VERSION,
  HOME_CARDS_MAX,
  HOME_CARD_BUTTONS_MAX,
  LIVE_PAGE_MAX,
  SESSION_EVENTS_PAGE_MAX,
  SESSION_KINDS,
  SESSION_LEVELS,
  SESSION_MODES,
  SessionAgentSchema,
  SessionEventSchema,
  SessionIdSchema,
  SessionLegSchema,
  SessionOwnerSchema,
  SessionStartedBySchema,
  SessionSubjectSchema,
  SessionSummarySchema,
  SessionWhereSchema,
  SESSION_LEGS_MAX,
} from "./agent-sessions.js";
import { WorkOriginSchema } from "./agent-run.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

const UNKNOWN = "unknown" as const;
const InstantSchema = z.string().datetime();
const PRESENCE_VIEWERS_MAX = 20;
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

/** One person's reading of one session: the header, the summary, and what the caller may do and is doing. */
export const SessionViewSchema = z
  .object({
    contractVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION),
    sessionId: SessionIdSchema,
    kind: z.enum(SESSION_KINDS),
    mode: z.enum(SESSION_MODES),
    subject: SessionSubjectSchema,
    legs: z.array(SessionLegSchema).max(SESSION_LEGS_MAX),
    where: SessionWhereSchema,
    project: z.string().regex(AGENTX_NAME_PATTERN).optional(),
    agent: SessionAgentSchema.optional(),
    title: z.string().min(1),
    owner: SessionOwnerSchema,
    startedBy: SessionStartedBySchema,
    origin: z.union([WorkOriginSchema, z.literal("local")]),
    retryOf: SessionIdSchema.optional(),
    followerCount: z.number().int().min(0),
    following: z.boolean(),
    viewing: z.array(z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1) }).strict()).max(PRESENCE_VIEWERS_MAX),
    level: z.enum(SESSION_LEVELS),
    link: LinkSchema,
    revision: z.number().int().min(0),
    summary: SessionSummarySchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    endedAt: InstantSchema.optional(),
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;
export const SessionViewReaderSchema = forwardReader(SessionViewSchema);

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

export const SessionEventReaderSchema = forwardReader(SessionEventSchema);

/** A page of a session's timeline, oldest first. `next` is the last event's sort key (`<at>#<eventId>`); readers re-read a little before it and de-duplicate by `eventId`. */
export const SessionEventPageSchema = z
  .object({ events: z.array(SessionEventSchema).max(SESSION_EVENTS_PAGE_MAX), next: z.string().min(1).optional() })
  .strict();
export type SessionEventPage = z.infer<typeof SessionEventPageSchema>;
export const SessionEventPageReaderSchema = forwardReader(SessionEventPageSchema);

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
