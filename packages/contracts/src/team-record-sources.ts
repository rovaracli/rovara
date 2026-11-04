// The Team record source rows: the body of the write route (add, change, remove), the replies, and the view a person who may edit sources sees
// (learning v2 design 2026-10-30 sections 4.2, 4.3, 4.4).
// Browser-safe: nothing here imports a Node module. Bodies and stored shapes are strict; the two answers the web reads have forward readers.
//
// Who may edit (enforced by the route, not by these shapes): company owners and admins for any project, and project maintainers for their own project.
// Owner decision 2026-11-04: NO second person for any source change, in either edition. Every editor's change applies at once and is audited; a change that widens
// what is kept (a retention raise, adding above the edition default, a private channel, a DM or a group DM) says so in the audit event's `widened` fact. This replaces
// the 2026-10-30 proposal flow (`SRCCHG#`, approve and reject, `soleApprover`). Slack Connect stays refused; DMs stay Enterprise only; Public Slack stays at A or B.
// The org is never in a body: it comes only from the caller's session.
import { z } from "zod";
import { LessonSourceRowSchema } from "./app-lessons.js";
import { forwardReader } from "./forward-reader.js";
import { RecordSystemSchema, RetentionModeSchema } from "./team-record.js";

const Revision = z.number().int().min(0);
const DeveloperIdSchema = z.string().min(1).max(100);
const RequestIdSchema = z.string().uuid();
const AudienceDefaultSchema = z.enum(["maintainers", "project"]);
const ExcludeSchema = z.array(z.string().min(1).max(300)).max(200);

/** The place a source row is for (`slack:T1/C9`, `github:repo/9`): 1 to 300 characters, no control or format characters (they could hide text or reorder it on screen). */
export const SourceScopeSchema = z.string().min(1).max(300).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");

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

export const SourceWriteBodySchema = z.discriminatedUnion("action", [SourceAddBodySchema, SourceChangeBodySchema, SourceRemoveBodySchema]);
export type SourceWriteBody = z.infer<typeof SourceWriteBodySchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// What a write widened (the audit fact `widened`)

/** The fixed words of what a write widened, in the order they are written: a retention raise (adding above the edition default counts), then the kind of place (a private channel, a DM, a group DM). Both editions. */
export const SOURCE_WIDENED_WORDS = ["retention_raise", "private_channel", "dm", "mpim"] as const;
export const SourceWidenedWordSchema = z.enum(SOURCE_WIDENED_WORDS);
export type SourceWidenedWord = z.infer<typeof SourceWidenedWordSchema>;

// ---------------------------------------------------------------------------------------------------------------------------
// Replies

export const SourceWriteReplySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), revision: Revision }).strict(),
  z.object({ status: z.literal("removed") }).strict(),
]);
export type SourceWriteReply = z.infer<typeof SourceWriteReplySchema>;
export const SourceWriteReplyReaderSchema = forwardReader(SourceWriteReplySchema);

/**
 * What a person who may edit sources sees on the Sources tab. Members keep `LessonSourcesSchema` as it is. A row always names its place (an editor may see it),
 * its revision (to send back as `expectedRevision`), who added it, the approval behind it if an older row has one, and its exclusions.
 */
export const SourceAdminRowSchema = LessonSourceRowSchema.extend({
  scope: SourceScopeSchema,
  revision: Revision,
  addedBy: DeveloperIdSchema,
  approval: z.object({ by: DeveloperIdSchema, at: z.string().datetime() }).strict().optional(),
  exclude: ExcludeSchema,
}).strict();

export const SourcesAdminViewSchema = z.object({
  sources: z.array(SourceAdminRowSchema).max(200),
  otherPaused: z.number().int().min(0),
  canEdit: z.boolean(),
  /** The retention each source offers on this edition, so the screen never offers one the ingest would refuse. */
  /** Present (true) only in the Public edition: Slack's "notes with links" is a switch there (off: read live only, A; on: B). Absent in Enterprise, which never shows it. */
  notesSwitch: z.literal(true).optional(),
  offered: z.record(z.string().min(1).max(60), z.array(RetentionModeSchema).max(4)),
  /** TRW-4: what the record left out because the author is not a linked Rovara person, per source (counts only), as the route has always shown the project's maintainers. */
  skippedUnlinked: z.record(z.string().min(1).max(60), z.number().int().min(0)).optional(),
  /** The project's repositories and the place each is (`github:repo/<id>`), read live, so the screen offers exactly these when adding a repository. Absent when the list cannot be read. */
  repositories: z.array(z.object({ name: z.string().min(1).max(200), scope: SourceScopeSchema }).strict()).max(100).optional(),
  /** Sources that were removed and whose stored data the delete worker has not finished clearing yet (oldest first). The screen shows each as a row with no controls and does not offer to add it again. Absent when none (or when the queue cannot be read). */
  clearing: z.array(z.object({ source: RecordSystemSchema, scope: SourceScopeSchema, since: z.string().datetime() }).strict()).max(100).optional(),
}).strict();
export type SourcesAdminView = z.infer<typeof SourcesAdminViewSchema>;
export const SourcesAdminViewReaderSchema = forwardReader(SourcesAdminViewSchema);
