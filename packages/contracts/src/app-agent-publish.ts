// Agent publish requests, favourite agents and suggested agents (experience decisions 23 and 24, owner decision 91): what the browser sends and reads for
// `POST/GET /v1/app/agents/{id}/publish-requests`, `GET /v1/app/agent-publish-requests`, `POST /v1/app/agent-publish-requests/{requestId}/withdraw`,
// `GET /v1/app/me/agents` and `PUT /v1/app/me/agents/favourites`, plus the additive `publication` field of an agent view. The API is described in
// `briefs/agent-publish-api.md`. Strict shapes for what the server writes and the app sends; readers (forward compatible) for what the app reads. Browser-safe:
// nothing here imports a Node module.
import { z } from "zod";
import { AgentAccessLevelSchema, AgentIdSchema, AgentOwnerSchema } from "./agent.js";
import { forwardReader } from "./forward-reader.js";

export const AGENT_PUBLISH_REQUESTS_PATH = "/v1/app/agent-publish-requests";
export const MY_AGENTS_PATH = "/v1/app/me/agents";
export const MY_FAVOURITE_AGENTS_PATH = "/v1/app/me/agents/favourites";
/** The most characters (code points) of a request's note or a decline's reason. */
export const AGENT_PUBLISH_NOTE_MAX = 300;
export const MAX_FAVOURITE_AGENTS = 12;
export const MAX_SUGGESTED_AGENTS = 6;
/** The most requests one person may have waiting at once (429 above it). */
export const MAX_OPEN_PUBLISH_REQUESTS = 5;
/** The most requests one list page holds. */
export const AGENT_PUBLISH_LIST_MAX = 50;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const Instant = z.string().min(1).max(40);
const ProjectName = z.string().min(1).max(63);
/** Plain text of at most 300 code points, with no control or format characters. */
export const AgentPublishNoteSchema = z.string().refine((value) => [...value].length <= AGENT_PUBLISH_NOTE_MAX, "must be at most 300 characters").refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text");

export const PublishTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), project: ProjectName }).strict(),
  z.object({ kind: z.literal("company") }).strict(),
]);
export type PublishTarget = z.infer<typeof PublishTargetSchema>;

/** A person as other people read them: their id and the name they chose (email-safe). */
export const AgentPublishPersonSchema = z.object({ id: Hex64, name: z.string().max(200) }).strict();

/** What the approver is told this agent can do, from the resolved recipe of the version asked about. */
export const AgentSummarySchema = z.object({
  steps: z.number().int().nonnegative(),
  tools: z.array(z.object({ connector: z.string().max(100), access: z.enum(["read", "read_write"]) }).strict()),
  autonomy: z.enum(["suggest", "prepare", "run"]),
  triggers: z.array(z.enum(["manual", "schedule", "event"])),
  skills: z.number().int().nonnegative(),
  monthlyBudgetUsd: z.number().finite().nonnegative().optional(),
  maxPerRunUsd: z.number().finite().nonnegative().optional(),
  extends: z.object({ agentId: AgentIdSchema, version: z.number().int().positive() }).strict().optional(),
  lessSafe: z.array(z.string()),
}).strict();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const PUBLISH_REQUEST_STATES = ["pending", "approved", "declined", "withdrawn", "expired", "stale", "failed"] as const;
export const PUBLISH_REQUEST_REASONS = ["you_requested", "not_a_maintainer", "not_an_admin", "stale", "expired"] as const;

export const AgentPublishRequestSchema = z.object({
  requestId: z.string().uuid(),
  approvalId: z.string().regex(/^apr_[0-9a-z]{20}$/u),
  agent: z.object({ agentId: AgentIdSchema, name: z.string(), description: z.string() }).strict(),
  target: PublishTargetSchema,
  version: z.number().int().positive(),
  digest: Hex64,
  state: z.enum(PUBLISH_REQUEST_STATES),
  requestedBy: AgentPublishPersonSchema,
  requestedAt: Instant,
  expiresAt: Instant,
  note: z.string().nullable(),
  decidedBy: AgentPublishPersonSchema.nullable(),
  decidedAt: Instant.nullable(),
  summary: AgentSummarySchema,
  effect: z.string(),
  approval: z.object({
    canDecide: z.boolean(),
    reason: z.enum(PUBLISH_REQUEST_REASONS).nullable(),
    freshSignInNeeded: z.boolean(),
    confirmUrl: z.string().nullish(),
  }).strict(),
  declineReason: z.string().nullish(),
  failureText: z.string().nullish(),
}).strict();
export type AgentPublishRequest = z.infer<typeof AgentPublishRequestSchema>;

/** The additive field of an agent view: how far the agent is published, and the request that waits (shown to its author, the target's maintainers and admins). */
export const AgentPublicationSchema = z.object({
  level: z.enum(["personal", "project", "company"]),
  projects: z.array(z.string()),
  pending: z.object({ requestId: z.string().uuid(), target: PublishTargetSchema, requestedAt: Instant }).strict().nullable(),
}).strict();
export type AgentPublication = z.infer<typeof AgentPublicationSchema>;

/** Why an agent is in the Home row. `popular_in_company` is reserved: run counts are not kept yet, so the server never sends it. */
export const AGENT_CARD_REASONS = ["favourite", "project_roster", "used_by_you", "popular_in_company", "starter"] as const;

export const AgentCardSchema = z.object({
  agentId: AgentIdSchema, name: z.string(), description: z.string(), builtin: z.boolean(), status: z.enum(["active", "archived"]), access: AgentAccessLevelSchema,
  currentVersion: z.number().int().positive().optional(), owner: AgentOwnerSchema.optional(), publication: AgentPublicationSchema,
  reason: z.enum(AGENT_CARD_REASONS),
}).strict();
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** `POST /v1/app/agents/{id}/publish-requests`: 202 (a request waits) or 200 (applied at once). */
export const AgentPublishAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NEEDS_CONFIRMATION"), confirmUrl: z.string().optional(), changes: z.array(z.string()), request: AgentPublishRequestSchema }).strict(),
  z.object({ status: z.literal("published"), agent: z.object({ agentId: AgentIdSchema, name: z.string() }).passthrough(), request: z.null() }).strict(),
]);

export const AgentPublishRequestListSchema = z.object({ requests: z.array(AgentPublishRequestSchema), next: z.string().optional() }).strict();
export const AgentPublishWithdrawnSchema = z.object({ request: AgentPublishRequestSchema }).strict();
export const MyAgentsSchema = z.object({
  favourites: z.array(AgentCardSchema), suggested: z.array(AgentCardSchema),
  limits: z.object({ maxFavourites: z.number().int().positive(), maxSuggested: z.number().int().positive() }).strict(), revision: z.number().int().nonnegative(),
}).strict();
export const FavouriteAgentsSchema = z.object({ favourites: z.array(AgentCardSchema), revision: z.number().int().nonnegative() }).strict();

export const AgentPublishRequestBodySchema = z.object({ requestId: z.string().uuid(), target: PublishTargetSchema, version: z.number().int().positive(), note: AgentPublishNoteSchema.optional() }).strict();
export const AgentPublishWithdrawBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const FavouriteAgentsBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), agentIds: z.array(AgentIdSchema).max(MAX_FAVOURITE_AGENTS) }).strict();
/** The existing decide route's body, with the optional decline reason this API adds (only with DECLINE). */
export const ApprovalDecideBodySchema = z.object({ requestId: z.string().uuid(), decision: z.enum(["APPROVE", "DECLINE"]), reason: AgentPublishNoteSchema.optional() }).strict();

export const AgentPublishRequestReaderSchema = forwardReader(AgentPublishRequestSchema);
export const AgentPublishRequestListReaderSchema = forwardReader(AgentPublishRequestListSchema);
export const AgentPublishAnswerReaderSchema = forwardReader(AgentPublishAnswerSchema);
export const AgentPublicationReaderSchema = forwardReader(AgentPublicationSchema);
export const AgentPublishWithdrawnReaderSchema = forwardReader(AgentPublishWithdrawnSchema);
export const MyAgentsReaderSchema = forwardReader(MyAgentsSchema);
export const FavouriteAgentsReaderSchema = forwardReader(FavouriteAgentsSchema);
