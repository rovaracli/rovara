// Lead 4 slice W5 (DEC 254zi; designs-2026-11-17/wiki-and-just-answer-plan.md section 1.2): the project Wiki tab's four reads, as Rovara Code serves them (slice W2) and the
// fixed words Cloud answers for them. Browser-safe: it imports only zod.
//
// MIRROR of the read-route part of Code's `packages/contracts/src/wiki-store.ts` at 07cd73a5f (Code local branch `pr/l4-wiki-store`), schema for schema and word for word:
//   GET /v1/app/projects/{project}/wiki                          -> WikiIndexResponseSchema
//   GET /v1/app/projects/{project}/wiki/search?q=                 -> WikiSearchResponseSchema
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}           -> WikiPageResponseSchema
//   GET /v1/app/projects/{project}/wiki/pages/{pageId}/sources   -> WikiSourcesResponseSchema
// Cloud's server rebuilds each Code answer field by field into exactly these shapes (`packages/cloud-server/src/wiki-routes.ts`), so the app reads them strictly. When W2's
// contract changes, change this file, that rebuild and tests/support/wiki-fixture.ts together.
//
// Rules the shapes carry (wiki-design-review.md, accepted by DEC 254zh):
//   - Wiki text is untrusted data (it is made from repository content). Every string is bounded and free of control and format characters (a paragraph may hold new lines); the
//     app draws it as plain text, never as HTML or Markdown.
//   - A claim shows its source state: "found" (source found, never "verified"), "changed" (a cited file moved on) or "not_found". No quote is ever sent to people.
//   - Every answer names its project; Cloud refuses an answer for any other project than the one in the path.
//   - Only reads are here. Mark wrong and pinned notes are C1's writes and are not part of this file.
import { z } from "zod";

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);
const prose = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL_BUT_NEWLINES);
const isoTime = z.string().datetime({ offset: false });
/** The fixed footer line under every wiki page and search result. */
export const WIKI_TRUST_LINE = "Written by Rovara from the code. It can be wrong. The code is the truth.";

/** Limits, as W2's WIKI_LIMITS (the page and its claims). */
export const WIKI_LIMITS = { pagesPerProject: 300, blocksPerPage: 120, claimsPerPage: 80, citationsPerClaim: 3, claimsPerBlock: 12, reposPerPage: 20, notesPerPage: 50 } as const;

export const WIKI_PROJECT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
export const WIKI_PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/u;
export const WIKI_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/u;
export const WIKI_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const WikiProjectSchema = z.string().regex(WIKI_PROJECT_PATTERN);
export const WikiRepoSchema = z.string().regex(WIKI_PROJECT_PATTERN);
export const WikiPageIdSchema = z.string().regex(WIKI_PAGE_ID_PATTERN);
export const WikiIdSchema = z.string().regex(WIKI_ID_PATTERN);
export const WikiCommitSchema = z.string().regex(WIKI_COMMIT_PATTERN);
/** A path inside a repository: relative, no `..` or `.` segment, no backslash, no control characters. */
export const WikiPathSchema = z.string().min(1).max(256).regex(NO_CONTROL).refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === "." || part === ""), "not a safe path");

export const WIKI_PAGE_KINDS = ["overview", "repo", "module", "connections", "data_flow", "glossary", "patterns", "how_to_run", "docs"] as const;
export const WikiPageKindSchema = z.enum(WIKI_PAGE_KINDS);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;
export const WikiRepoCommitSchema = z.object({ repo: WikiRepoSchema, commit: WikiCommitSchema }).strict();
export type WikiRepoCommit = z.infer<typeof WikiRepoCommitSchema>;
/** found: source found. changed: a cited file changed since ("may be out of date"). not_found: a later re-check did not find it. */
export const WIKI_SOURCE_STATES = ["found", "changed", "not_found"] as const;
export const WikiSourceStateSchema = z.enum(WIKI_SOURCE_STATES);
export type WikiSourceState = z.infer<typeof WikiSourceStateSchema>;

/** The prose of a page, in order. A paragraph or a diagram names the claims it rests on, so a stale or flagged claim marks exactly its paragraph. */
export const WikiBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), blockId: WikiIdSchema, level: z.union([z.literal(2), z.literal(3)]), text: line(200) }).strict(),
  z.object({ kind: z.literal("paragraph"), blockId: WikiIdSchema, text: prose(4_000), claimIds: z.array(WikiIdSchema).max(WIKI_LIMITS.claimsPerBlock) }).strict(),
  z.object({ kind: z.literal("diagram"), blockId: WikiIdSchema, mermaid: prose(4_000), claimIds: z.array(WikiIdSchema).max(WIKI_LIMITS.claimsPerBlock) }).strict(),
]);
export type WikiBlock = z.infer<typeof WikiBlockSchema>;

export const WikiIndexEntrySchema = z.object({
  pageId: WikiPageIdSchema,
  kind: WikiPageKindSchema,
  title: z.string(),
  summary: z.string(),
  parentId: WikiPageIdSchema.optional(),
  order: z.number().int(),
  repos: z.array(WikiRepoCommitSchema),
  writtenAt: isoTime,
  /** How many of the page's claims are `found` and how many `changed` (the free freshness line). */
  claims: z.object({ found: z.number().int().min(0), changed: z.number().int().min(0) }).strict(),
  /** An open "Mark wrong" on the whole page (it is hidden from agents). */
  flagged: z.boolean(),
}).strict();
export type WikiIndexEntry = z.infer<typeof WikiIndexEntrySchema>;

export const WIKI_BUILD_KINDS = ["first", "refresh", "nightly"] as const;
export const WIKI_BUILD_STATES = ["running", "done", "stopped", "failed"] as const;
export const WIKI_BUILD_STOP_REASONS = ["cap", "person", "repo_unreadable", "no_ai_key", "unpriced_model", "failed"] as const;
export const WikiLastBuildSchema = z.object({ buildId: WikiIdSchema, kind: z.enum(WIKI_BUILD_KINDS), state: z.enum(WIKI_BUILD_STATES), startedAt: isoTime, endedAt: isoTime.optional(), stopReason: z.enum(WIKI_BUILD_STOP_REASONS).optional() }).strict();
export type WikiLastBuild = z.infer<typeof WikiLastBuildSchema>;

/** `GET /v1/app/projects/{p}/wiki`. `empty`: no page yet. */
export const WikiIndexResponseSchema = z.object({
  project: WikiProjectSchema,
  state: z.enum(["empty", "ready"]),
  agentsEnabled: z.boolean(),
  pages: z.array(WikiIndexEntrySchema).max(WIKI_LIMITS.pagesPerProject),
  lastBuild: WikiLastBuildSchema.optional(),
}).strict();
export type WikiIndexResponse = z.infer<typeof WikiIndexResponseSchema>;

/** `GET /v1/app/projects/{p}/wiki/search?q=...`; text is a bounded plain-text excerpt. */
export const WikiSearchResponseSchema = z.object({
  project: WikiProjectSchema,
  query: z.string().min(1).max(80).regex(NO_CONTROL),
  results: z.array(z.object({ pageId: WikiPageIdSchema, title: line(120), summary: z.string().max(300).regex(NO_CONTROL), snippet: prose(240) }).strict()).max(20),
  trustLine: z.literal(WIKI_TRUST_LINE),
}).strict();
export type WikiSearchResponse = z.infer<typeof WikiSearchResponseSchema>;

/** A claim as people see it: no quotes. */
export const WikiShownClaimSchema = z.object({
  claimId: WikiIdSchema,
  text: z.string(),
  source: WikiSourceStateSchema,
  citations: z.array(z.object({ repo: WikiRepoSchema, path: z.string(), commit: WikiCommitSchema, line: z.number().int(), lineEnd: z.number().int().optional() }).strict()),
  /** An open "Mark wrong" on this claim. */
  flagged: z.boolean(),
}).strict();
export type WikiShownClaim = z.infer<typeof WikiShownClaimSchema>;

export const WikiShownNoteSchema = z.object({
  noteId: WikiIdSchema,
  text: z.string(),
  /** The author's display name now ("a former member" once they are erased or gone). */
  author: z.string(),
  createdAt: isoTime,
  file: z.object({ repo: WikiRepoSchema, path: z.string() }).strict().optional(),
  /** `pending`: people see it; agents do not until a maintainer approves it. */
  approval: z.enum(["pending", "approved"]),
}).strict();
export type WikiShownNote = z.infer<typeof WikiShownNoteSchema>;

/** `GET /v1/app/projects/{p}/wiki/pages/{pageId}`. */
export const WikiPageResponseSchema = z.object({
  project: WikiProjectSchema,
  page: z.object({
    pageId: WikiPageIdSchema,
    kind: WikiPageKindSchema,
    title: z.string(),
    summary: z.string(),
    parentId: WikiPageIdSchema.optional(),
    repos: z.array(WikiRepoCommitSchema),
    writtenAt: isoTime,
    blocks: z.array(WikiBlockSchema),
    claims: z.array(WikiShownClaimSchema),
  }).strict(),
  notes: z.array(WikiShownNoteSchema),
  /** Open "Mark wrong" flags on the page and its claims (who and why are not shown here). */
  openFlags: z.number().int().min(0),
  trustLine: z.literal(WIKI_TRUST_LINE),
}).strict();
export type WikiPageResponse = z.infer<typeof WikiPageResponseSchema>;

/** `GET /v1/app/projects/{p}/wiki/pages/{pageId}/sources`: each cited file once, with the line ranges cited in it and the claims that cite it. */
export const WikiSourcesResponseSchema = z.object({
  project: WikiProjectSchema,
  pageId: WikiPageIdSchema,
  files: z.array(z.object({
    repo: WikiRepoSchema,
    path: z.string(),
    commit: WikiCommitSchema,
    ranges: z.array(z.object({ line: z.number().int(), lineEnd: z.number().int().optional() }).strict()),
    claimIds: z.array(WikiIdSchema),
  }).strict()),
}).strict();
export type WikiSourcesResponse = z.infer<typeof WikiSourcesResponseSchema>;

/** W2's fixed words (WIKI_PROJECT_NOT_FOUND, WIKI_PAGE_NOT_FOUND, WIKI_UNAVAILABLE) and Cloud's own for the rest. The app shows these and nothing Code or the browser sent. */
export const WIKI_PROJECT_NOT_FOUND = "project not found";
export const WIKI_PAGE_NOT_FOUND = "That wiki page is not there.";
export const WIKI_UNAVAILABLE = "The project wiki could not be read just now. Try again.";
export const WIKI_WORDS = Object.freeze({
  notFound: WIKI_PROJECT_NOT_FOUND,
  noPage: WIKI_PAGE_NOT_FOUND,
  forbidden: "You can't read this project's wiki.",
  invalid: "the request is not valid",
  notYet: "The wiki isn't available on this Rovara yet.",
  unavailable: WIKI_UNAVAILABLE,
});
export const WIKI_SENTENCES: ReadonlySet<string> = new Set(Object.values(WIKI_WORDS));
