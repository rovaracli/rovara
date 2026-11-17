// Lead 4 slice C1 (DEC 254zh/254zi): the project wiki's CORRECTIONS (Add a note, approve, delete, Mark wrong, resolve, suggest as a lesson, the disputed list), as Rovara Code serves them
// (Code's `packages/contracts/src/wiki-corrections.ts`, branch `pr/l4-wiki-corrections` on top of W2) and the words Cloud answers with. Browser-safe: it imports only zod.
//
// MIRROR of Code's contract, schema for schema and word for word:
//   GET  /v1/app/projects/{p}/wiki/pages/{id}/corrections                          -> WikiCorrectionsResponseSchema   what THIS person may do on the page (the app shows only those controls)
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes                  { text, file? }   -> WikiNoteAddedResponseSchema      contributor and up; PENDING (people see it now, agents after approval)
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/approve      {}                -> WikiNoteApprovedResponseSchema   maintainer only
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/delete       {}                -> WikiNoteDeletedResponseSchema    the note's author or a maintainer
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/suggest-lesson {}              -> WikiSuggestedResponseSchema      the note's author or a maintainer; a PENDING lesson an admin approves
//   POST /v1/app/projects/{p}/wiki/pages/{id}/flags                  { claimId?, reason? } -> WikiMarkedResponseSchema     contributor and up
//   POST /v1/app/projects/{p}/wiki/pages/{id}/flags/resolve          {}                -> WikiResolvedResponseSchema       maintainer only
//   GET  /v1/app/projects/{p}/wiki/disputed                                            -> WikiDisputedResponseSchema       maintainer only
// Code decides who may do each; Cloud passes the person's own token and never a person, company or role. The corrections answer says which controls to show, so the app has no dead button.
// Cloud's server rebuilds each answer field by field (`packages/cloud-server/src/wiki-corrections-routes.ts`); when Code's contract changes, change this file, that rebuild and the tests together.
import { z } from "zod";
import { WikiIdSchema, WikiPageIdSchema, WikiPathSchema, WikiRepoSchema, WikiShownNoteSchema } from "./app-wiki.js";

const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const words = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL_BUT_NEWLINES).refine((text) => text.trim() !== "", "words, not blanks");

export const WIKI_CORRECTION_LIMITS = { noteChars: 2_000, reasonChars: 500, notesPerPage: 50, disputed: 100, lessonBodyChars: 600 } as const;

export const WikiAddNoteBodySchema = z.object({
  text: words(WIKI_CORRECTION_LIMITS.noteChars),
  file: z.object({ repo: WikiRepoSchema, path: WikiPathSchema }).strict().optional(),
}).strict();
export type WikiAddNoteBody = z.infer<typeof WikiAddNoteBodySchema>;
export const WikiMarkWrongBodySchema = z.object({ claimId: WikiIdSchema.optional(), reason: words(WIKI_CORRECTION_LIMITS.reasonChars).optional() }).strict();
export type WikiMarkWrongBody = z.infer<typeof WikiMarkWrongBodySchema>;

export const WIKI_CORRECTION_ROLES = ["maintainer", "contributor", "viewer"] as const;
export const WikiYouCanSchema = z.object({
  role: z.enum(WIKI_CORRECTION_ROLES), addNote: z.boolean(), markWrong: z.boolean(), approveNotes: z.boolean(), resolveMarks: z.boolean(), seeDisputed: z.boolean(),
}).strict();
export type WikiYouCan = z.infer<typeof WikiYouCanSchema>;
export const WikiNoteStateSchema = z.object({
  noteId: WikiIdSchema, mine: z.boolean(), canDelete: z.boolean(), canApprove: z.boolean(), canSuggestLesson: z.boolean(), mayBeOutOfDate: z.boolean(),
}).strict();
export type WikiNoteState = z.infer<typeof WikiNoteStateSchema>;
export const WikiCorrectionsResponseSchema = z.object({ project: z.string(), pageId: WikiPageIdSchema, you: WikiYouCanSchema, notes: z.array(WikiNoteStateSchema).max(WIKI_CORRECTION_LIMITS.notesPerPage) }).strict();
export type WikiCorrectionsResponse = z.infer<typeof WikiCorrectionsResponseSchema>;

export const WikiNoteAddedResponseSchema = z.object({ note: WikiShownNoteSchema }).strict();
export const WikiNoteApprovedResponseSchema = z.object({ noteId: WikiIdSchema, approval: z.literal("approved") }).strict();
export const WikiNoteDeletedResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export const WikiMarkedResponseSchema = z.object({ flagId: WikiIdSchema, pageId: WikiPageIdSchema, claimId: WikiIdSchema.optional() }).strict();
export const WikiResolvedResponseSchema = z.object({ resolved: z.number().int().min(0) }).strict();
export const WikiSuggestedResponseSchema = z.object({ state: z.enum(["proposed", "already_proposed"]), lessonId: z.string() }).strict();
export type WikiSuggestedResponse = z.infer<typeof WikiSuggestedResponseSchema>;
export const WikiDisputedItemSchema = z.object({
  flagId: WikiIdSchema, pageId: WikiPageIdSchema, pageTitle: z.string(), claimId: WikiIdSchema.optional(), claimText: z.string().optional(), markedBy: z.string(), markedAt: z.string(), reason: z.string().optional(),
}).strict();
/** `more`: Code cut the list (at most 100 marks an answer): close some and read again. */
export const WikiDisputedResponseSchema = z.object({ project: z.string(), items: z.array(WikiDisputedItemSchema).max(WIKI_CORRECTION_LIMITS.disputed), more: z.boolean() }).strict();
export type WikiDisputedResponse = z.infer<typeof WikiDisputedResponseSchema>;

/** Code's fixed refusal words for the corrections (the same texts), plus Cloud's own. A refusal shows one of these and nothing the server or the browser sent. */
export const WIKI_CORRECTION_WORDS = Object.freeze({
  needsWorkingRole: "Only people with a working role on this project can do that.",
  needsMaintainer: "Only a project maintainer, or an owner or admin of the company, can do that.",
  noteNotYours: "Only the person who wrote a note, or a project maintainer, can do that.",
  noteNotFound: "That note is not there.",
  notARule: "That note is too long to be a lesson. Shorten it to a rule of a few lines first.",
  lessonRefused: "That note cannot be suggested as a lesson. Reword it as advice about the code.",
  lessonsOff: "Lessons are off for this project, so a note cannot be suggested as one.",
  badRequest: "That request is not valid.",
  tooMany: "This page has as many notes or marks as it can hold.",
  noSuchClaim: "That claim is not on the page.",
  actionFailed: "That could not be saved. Try again.",
  notYet: "Corrections aren't available on this Rovara yet.",
  unavailable: "That could not be done just now. Try again.",
});
export const WIKI_CORRECTION_SENTENCES: ReadonlySet<string> = new Set(Object.values(WIKI_CORRECTION_WORDS));

/** A note that reads like a rule ("always", "never", "must"): the page then offers "Suggest it as a lesson" (Code decides whether this person may). */
export const wikiNoteLooksLikeRule = (text: string): boolean => /\b(always|never|must)\b/iu.test(text);
