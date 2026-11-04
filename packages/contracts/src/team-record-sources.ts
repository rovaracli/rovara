// The Team record source rows: the body of the write route (add, change, remove, and approving or rejecting a waiting change), the stored
// proposal of a less-safe change, the replies, and the view a person who may edit sources sees (learning v2 design 2026-10-30 sections 4.2, 4.3, 4.4).
// Browser-safe: nothing here imports a Node module. Bodies and stored shapes are strict; the two answers the web reads have forward readers.
//
// Who may edit (enforced by the route, not by these shapes): company owners and admins for any project, and project maintainers for their own project.
// In Enterprise a less-safe change (a private channel, a DM or group DM, or a retention raise) needs a second eligible person to approve it, except when
// the company (or the project) has exactly one eligible approver: that person may approve their own change (`soleApprover`; owner decision Q1).
// The org is never in a body: it comes only from the caller's session.
import { z } from "zod";
import { LessonSourceRowSchema } from "./app-lessons.js";
import { forwardReader } from "./forward-reader.js";
import { RecordSystemSchema, RetentionModeSchema, SourceConfigSchema, RecordProjectSchema } from "./team-record.js";
import { OrgIdSchema } from "./browser-ids.js";

const Revision = z.number().int().min(0);
const DeveloperIdSchema = z.string().min(1).max(100);
const RequestIdSchema = z.string().uuid();
const AudienceDefaultSchema = z.enum(["maintainers", "project"]);
const ExcludeSchema = z.array(z.string().min(1).max(300)).max(200);

/** The place a source row is for (`slack:T1/C9`, `github:repo/9`): 1 to 300 characters, no control or format characters (they could hide text or reorder it on screen). */
export const SourceScopeSchema = z.string().min(1).max(300).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");

/** The id of a waiting change (`SRCCHG#<id>`). A fixed alphabet, so it is safe in a key and in a path. */
export const SourceChangeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const CHANGE_FIELDS = ["retention", "audienceDefault", "enabled", "exclude", "notesOptIn"] as const;

export const SourceAddBodySchema = z.object({
  action: z.literal("add"),
  requestId: RequestIdSchema,
  source: RecordSystemSchema,
  scope: SourceScopeSchema,
  retention: RetentionModeSchema,
  audienceDefault: AudienceDefaultSchema,
  enabled: z.boolean(),
  exclude: ExcludeSchema.optional(),
  notesOptIn: z.literal(true).optional(),
}).strict();

export const SourceChangeBodySchema = z.object({
  action: z.literal("change"),
  requestId: RequestIdSchema,
  source: RecordSystemSchema,
  scope: SourceScopeSchema,
  /** The revision the caller read (a row written before the route reads as 0). A row that moved since refuses the write. */
  expectedRevision: Revision,
  retention: RetentionModeSchema.optional(),
  audienceDefault: AudienceDefaultSchema.optional(),
  enabled: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
  /** `true` keeps notes with links on a Public Slack source; `null` takes the opt-in away. */
  notesOptIn: z.union([z.literal(true), z.null()]).optional(),
}).strict().refine((body) => CHANGE_FIELDS.some((field) => body[field] !== undefined), { message: "a change names at least one thing to change", path: ["action"] });

export const SourceRemoveBodySchema = z.object({
  action: z.literal("remove"),
  requestId: RequestIdSchema,
  source: RecordSystemSchema,
  scope: SourceScopeSchema,
  expectedRevision: Revision,
}).strict();

/** Approving or rejecting a waiting change names the change only. It carries no request id: a repeat of a decision finds the change already decided. */
export const SourceApproveBodySchema = z.object({ action: z.literal("approve"), changeId: SourceChangeIdSchema }).strict();
export const SourceRejectBodySchema = z.object({ action: z.literal("reject"), changeId: SourceChangeIdSchema }).strict();

export const SourceWriteBodySchema = z.discriminatedUnion("action", [
  SourceAddBodySchema, SourceChangeBodySchema, SourceRemoveBodySchema, SourceApproveBodySchema, SourceRejectBodySchema,
]);
export type SourceWriteBody = z.infer<typeof SourceWriteBodySchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// A waiting less-safe change (`SRCCHG#<id>`)

export const SOURCE_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Why a change waits: a private channel, a DM, a group DM, or a retention raise (Enterprise only). */
export const SOURCE_CHANGE_REASONS = ["private_channel", "dm", "mpim", "retention_raise"] as const;
export const SourceChangeReasonSchema = z.enum(SOURCE_CHANGE_REASONS);
export type SourceChangeReason = z.infer<typeof SourceChangeReasonSchema>;
/** One or more reasons, each at most once (a repeat is refused, not folded: a writer that builds the list twice has a bug worth seeing). */
export const SourceChangeReasonsSchema = z.array(SourceChangeReasonSchema).min(1).max(SOURCE_CHANGE_REASONS.length).refine((reasons) => new Set(reasons).size === reasons.length, "each reason at most once");

/**
 * Invariants checked here, so no writer can store a change that breaks them: an add is against no row (`againstRevision` null) and a change against one;
 * the change lives exactly seven days; the row is for the proposal's own company, project, source and place. `row` is the whole row as it would be saved, without what the save
 * sets itself (`revision`, `updatedAt`), the approval (set when the change is approved, never carried in) and the ingest cursor.
 */
export const SourceChangeProposalSchema = z.object({
  id: SourceChangeIdSchema,
  workspaceId: OrgIdSchema,
  project: RecordProjectSchema,
  source: RecordSystemSchema,
  scope: SourceScopeSchema,
  kind: z.enum(["add", "change"]),
  row: SourceConfigSchema.omit({ revision: true, updatedAt: true, approval: true, lastCursor: true }),
  reasons: SourceChangeReasonsSchema,
  proposedBy: DeveloperIdSchema,
  againstRevision: Revision.nullable(),
  /** A fingerprint of the people who may approve, taken when the change was made. If the set moved, the approval is refused and the change is made again. */
  membershipDigest: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((proposal, context) => {
  if (proposal.kind === "add" && proposal.againstRevision !== null) context.addIssue({ code: "custom", path: ["againstRevision"], message: "an add is against no row" });
  if (proposal.kind === "change" && proposal.againstRevision === null) context.addIssue({ code: "custom", path: ["againstRevision"], message: "a change is against a revision" });
  const { row } = proposal;
  if (row.workspaceId !== proposal.workspaceId) context.addIssue({ code: "custom", path: ["row", "workspaceId"], message: "the row is for the proposal's company" });
  if (row.project !== proposal.project) context.addIssue({ code: "custom", path: ["row", "project"], message: "the row is for the proposal's project" });
  if (row.source !== proposal.source) context.addIssue({ code: "custom", path: ["row", "source"], message: "the row is for the proposal's source" });
  if (row.scope !== proposal.scope) context.addIssue({ code: "custom", path: ["row", "scope"], message: "the row is for the proposal's place" });
  if (Date.parse(proposal.expiresAt) !== Date.parse(proposal.createdAt) + SOURCE_PROPOSAL_TTL_MS) context.addIssue({ code: "custom", path: ["expiresAt"], message: "a change lives seven days" });
});
export type SourceChangeProposal = z.infer<typeof SourceChangeProposalSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Replies

export const SourceWriteReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), revision: Revision }).strict(),
  z.object({ status: z.literal("needs_approval"), changeId: SourceChangeIdSchema, expiresAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("removed") }).strict(),
  z.object({ status: z.literal("rejected") }).strict(),
]);
export type SourceWriteReply = z.infer<typeof SourceWriteReplySchema>;
export const SourceWriteReplyReaderSchema = forwardReader(SourceWriteReplySchema);

/**
 * What a person who may edit sources sees on the Sources tab. Members keep `LessonSourcesSchema` as it is. A row always names its place (an editor may see it),
 * its revision (to send back as `expectedRevision`), who added it, the approval behind it if any, and its exclusions.
 */
export const SourceAdminRowSchema = LessonSourceRowSchema.extend({
  scope: SourceScopeSchema,
  revision: Revision,
  addedBy: DeveloperIdSchema,
  approval: z.object({ by: DeveloperIdSchema, at: z.string().datetime() }).strict().optional(),
  exclude: ExcludeSchema,
}).strict();

export const SourcePendingChangeSchema = z.object({
  changeId: SourceChangeIdSchema,
  source: RecordSystemSchema,
  scope: SourceScopeSchema,
  kind: z.enum(["add", "change"]),
  reasons: SourceChangeReasonsSchema,
  /** The proposer's id is not shown; the screen needs only to know whether the change is the viewer's own (a person does not approve their own, except a sole approver). */
  proposedByYou: z.boolean(),
  expiresAt: z.string().datetime(),
}).strict();

export const SourcesAdminViewSchema = z.object({
  sources: z.array(SourceAdminRowSchema).max(200),
  otherPaused: z.number().int().min(0),
  pending: z.array(SourcePendingChangeSchema).max(100),
  canEdit: z.boolean(),
  /** Exactly one eligible approver (owner decision Q1): that person may approve their own less-safe change. */
  soleApprover: z.boolean(),
  /** The retention each source offers on this edition, so the screen never offers one the ingest would refuse. */
  offered: z.record(z.string().min(1).max(60), z.array(RetentionModeSchema).max(4)),
}).strict();
export type SourcesAdminView = z.infer<typeof SourcesAdminViewSchema>;
export const SourcesAdminViewReaderSchema = forwardReader(SourcesAdminViewSchema);
