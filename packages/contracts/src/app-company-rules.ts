// Company rules (lane G-04, owner decisions 51, 57 and 85; switch `si`): what the browser reads and sends for Settings > Company rules: `/v1/app/org/company-rules` (state, history, versions, sync) and its one browser-only POST.
// Strict shapes for what the app sends, readers (forward compatible) for what it reads. Words, ids, counts and the rules' own text; never an error text from a code host. Browser-safe: nothing here imports a Node module, and the limits
// are spelled out (`tests/contract/company-rules-store.test.ts` checks they equal `COMPANY_RULE_LIMITS`). The API is described in `briefs/company-rules-api.md`.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

export const COMPANY_RULES_PATH = "/v1/app/org/company-rules";
export const COMPANY_RULES_BROWSER_MESSAGE = "Use a live browser session to change the company rules.";
/** The file a company connects in its meta repository, when it names no other. The same format Rovara Code reads (`## Required` and `## Preferred` headings with `- ` bullets). */
export const COMPANY_RULES_DEFAULT_FILE_PATH = ".rovara/company-rules.md";
export const COMPANY_RULES_APP_LIMITS = { maxRules: 30, maxRuleCharacters: 600, maxTotalCharacters: 12_000 } as const;
/** The most characters of one rule's text the app may send (the server folds white space and then holds the rule to 600). */
export const COMPANY_RULE_INPUT_MAX = 5_000;
export const COMPANY_RULES_NOTE_MAX = 300;
/** The read-only route every member may read: the version in force, nothing about proposals. */
export const COMPANY_RULES_CURRENT_PATH = `${COMPANY_RULES_PATH}/current`;
export const COMPANY_RULES_PROPOSAL_TTL_MS = 7 * 86_400_000;

const Priority = z.enum(["required", "preferred"]);
/** An id as it is stored: lower case. The app may send either case; it is lower-cased on the way in (an upper-case id once wedged the waiting slot). */
const LowerUuid = z.string().uuid().transform((value) => value.toLowerCase());
const Iso = z.string().datetime();
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const CompanyRuleViewSchema = z.object({ text: z.string().min(1).max(COMPANY_RULE_INPUT_MAX), priority: Priority }).strict();
export type CompanyRuleView = z.infer<typeof CompanyRuleViewSchema>;

/** A person as the page shows them. `id` is null for the repository ("Company repository") and for a seeded version ("Rovara setup"). `login` is a code host account name on a repo proposal: untrusted text. */
export const CompanyRulesPersonSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), name: z.string().max(200), login: z.string().max(100).optional() }).strict();
export type CompanyRulesPerson = z.infer<typeof CompanyRulesPersonSchema>;

/** Which side a difference came from, against the last point where the file and Rovara agreed (`both`: both moved, or there is no such point). Only the file link's diff carries it. */
export const COMPANY_RULES_SIDES = ["rovara", "repo", "both"] as const;
const SideSchema = z.enum(COMPANY_RULES_SIDES);
export const CompanyRulesDiffSchema = z.object({
  summary: z.object({ added: z.number().int().min(0), removed: z.number().int().min(0), changed: z.number().int().min(0), unchanged: z.number().int().min(0) }).strict(),
  entries: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("same"), after: CompanyRuleViewSchema }).strict(),
    z.object({ kind: z.literal("added"), after: CompanyRuleViewSchema, side: SideSchema.optional() }).strict(),
    z.object({ kind: z.literal("removed"), before: CompanyRuleViewSchema, side: SideSchema.optional() }).strict(),
    z.object({ kind: z.literal("changed"), before: CompanyRuleViewSchema, after: CompanyRuleViewSchema, side: SideSchema.optional() }).strict(),
  ])).max(120),
}).strict();
export type CompanyRulesDiff = z.infer<typeof CompanyRulesDiffSchema>;

export const COMPANY_RULES_SOURCES = ["rovara", "repo", "seed"] as const;
export const COMPANY_RULES_APPROVAL_MODES = ["second_person", "sole_owner_exception", "admin_review", "seed"] as const;

/** An approved, immutable version. A member sees the first five fields only. */
export const CompanyRulesVersionSchema = z.object({
  version: z.number().int().min(1),
  digest: Digest,
  rules: z.array(CompanyRuleViewSchema).max(COMPANY_RULES_APP_LIMITS.maxRules),
  ruleCount: z.number().int().min(0),
  approvedAt: Iso,
  approvedBy: CompanyRulesPersonSchema.optional(),
  proposedBy: CompanyRulesPersonSchema.optional(),
  source: z.enum(COMPANY_RULES_SOURCES).optional(),
  approvalMode: z.enum(COMPANY_RULES_APPROVAL_MODES).optional(),
  baseVersion: z.number().int().min(0).optional(),
  /** The admin who adopted a proposal that came back from the repository (the person the second admin's approval is measured against). */
  adoptedBy: CompanyRulesPersonSchema.nullable().optional(),
  /** The proposer's note (admins only); for a version made from the repository, the fixed line saying which file and revision. Plain text. */
  note: z.string().max(COMPANY_RULES_NOTE_MAX).nullable().optional(),
}).strict();
export type CompanyRulesVersion = z.infer<typeof CompanyRulesVersionSchema>;

export const CompanyRulesSoleOwnerSchema = z.object({
  available: z.boolean(),
  availableAt: Iso.nullable(),
  reasonCode: z.enum(["SOLE_OWNER_COOL_OFF", "SECOND_PERSON_REQUIRED", "ELIGIBILITY_UNAVAILABLE", "SOLE_OWNER_EXCEPTION_AVAILABLE"]),
}).strict();

export const CompanyRulesProposalSchema = z.object({
  proposalId: z.string().uuid(),
  state: z.literal("pending"),
  baseVersion: z.number().int().min(0),
  stale: z.boolean(),
  source: z.enum(["rovara", "repo"]),
  rules: z.array(CompanyRuleViewSchema).max(COMPANY_RULES_APP_LIMITS.maxRules),
  ruleCount: z.number().int().min(0),
  digest: Digest,
  note: z.string().max(COMPANY_RULES_NOTE_MAX).nullable(),
  proposedBy: CompanyRulesPersonSchema,
  /** A repository proposal: who adopted it (null until an admin does); nobody can approve it before. */
  adoptedBy: CompanyRulesPersonSchema.nullable(),
  /** You proposed it, or (a repository proposal) you adopted it: a different admin approves. */
  proposedByYou: z.boolean(),
  proposedAt: Iso,
  expiresAt: Iso,
  diff: CompanyRulesDiffSchema,
  approval: z.object({
    canApprove: z.boolean(),
    reason: z.enum(["you_proposed", "needs_adoption", "stale", "expired"]).nullable(),
    freshSignInNeeded: z.boolean(),
    soleOwner: CompanyRulesSoleOwnerSchema.nullable(),
  }).strict(),
}).strict();
export type CompanyRulesProposal = z.infer<typeof CompanyRulesProposalSchema>;

export const COMPANY_RULES_SYNC_STATUSES = ["in_sync", "file_differs", "file_missing", "file_unreadable", "waiting_for_pull_request", "never_checked", "problem"] as const;
export const CompanyRulesSyncSummarySchema = z.object({
  connected: z.literal(true),
  repository: z.string().max(300),
  path: z.string().max(512),
  branch: z.string().max(255),
  status: z.enum(COMPANY_RULES_SYNC_STATUSES),
  lastCheckedAt: Iso.nullable(),
}).strict();

export const CompanyRulesStateSchema = z.object({
  enabled: z.literal(true),
  viewer: z.object({ role: z.enum(["owner", "admin", "member"]), canPropose: z.boolean(), canDecide: z.boolean() }).strict(),
  limits: z.object({ maxRules: z.number().int(), maxRuleCharacters: z.number().int(), maxTotalCharacters: z.number().int() }).strict(),
  current: CompanyRulesVersionSchema.nullable(),
  pending: CompanyRulesProposalSchema.nullable(),
  sync: CompanyRulesSyncSummarySchema.nullable(),
}).strict();
export type CompanyRulesState = z.infer<typeof CompanyRulesStateSchema>;
export const CompanyRulesStateReaderSchema = forwardReader(CompanyRulesStateSchema);

const Summary = z.object({ added: z.number().int().min(0), removed: z.number().int().min(0), changed: z.number().int().min(0), unchanged: z.number().int().min(0) }).strict();
export const CompanyRulesHistorySchema = z.object({
  entries: z.array(z.object({
    version: z.number().int().min(1), approvedAt: Iso, approvedBy: CompanyRulesPersonSchema, proposedBy: CompanyRulesPersonSchema,
    source: z.enum(COMPANY_RULES_SOURCES), approvalMode: z.enum(COMPANY_RULES_APPROVAL_MODES), ruleCount: z.number().int().min(0), summary: Summary, note: z.string().max(COMPANY_RULES_NOTE_MAX).nullable(), adoptedBy: CompanyRulesPersonSchema.nullable(),
  }).strict()).max(50),
  decided: z.array(z.object({
    proposalId: z.string().uuid(), state: z.enum(["rejected", "cancelled", "expired"]), source: z.enum(["rovara", "repo"]),
    proposedBy: CompanyRulesPersonSchema, proposedAt: Iso, decidedAt: Iso, decidedBy: CompanyRulesPersonSchema.nullable(), note: z.string().max(COMPANY_RULES_NOTE_MAX).nullable(), adoptedBy: CompanyRulesPersonSchema.nullable(),
  }).strict()).max(20),
  nextBefore: z.number().int().min(1).nullable(),
}).strict();
export type CompanyRulesHistory = z.infer<typeof CompanyRulesHistorySchema>;
export const CompanyRulesHistoryReaderSchema = forwardReader(CompanyRulesHistorySchema);

export const CompanyRulesVersionViewSchema = z.object({ version: CompanyRulesVersionSchema, diffFromPrevious: CompanyRulesDiffSchema }).strict();
export type CompanyRulesVersionView = z.infer<typeof CompanyRulesVersionViewSchema>;
export const CompanyRulesVersionReaderSchema = forwardReader(CompanyRulesVersionViewSchema);

export const COMPANY_RULES_SYNC_PROBLEMS = ["file_unreadable", "file_too_large", "over_limits", "host_unavailable", "repository_changed", "no_write_access", "no_pull_request_support"] as const;
export const COMPANY_RULES_SYNC_PROBLEM_TEXT: Record<(typeof COMPANY_RULES_SYNC_PROBLEMS)[number], string> = {
  file_unreadable: "Rovara could not read the file. Each rule must be a bullet under a Required or Preferred heading.",
  file_too_large: "The file is larger than Rovara reads (64 KiB).",
  over_limits: "The file holds more than the company rules allow (30 rules, 600 characters each, 12,000 in all).",
  host_unavailable: "Rovara could not reach the repository. It will try again.",
  repository_changed: "The repository is no longer the one that was connected. Connect it again.",
  no_write_access: "Rovara may not write to this repository, so it cannot send the approved rules to the file.",
  no_pull_request_support: "This repository's code host cannot take a pull request from Rovara, so the file is only read.",
};

export const CompanyRulesSyncSchema = z.discriminatedUnion("connected", [
  z.object({ connected: z.literal(false) }).strict(),
  z.object({
    connected: z.literal(true),
    repository: z.object({ name: z.string().max(300), url: z.string().max(500) }).strict(),
    path: z.string().max(512),
    branch: z.string().max(255),
    connectedBy: CompanyRulesPersonSchema,
    connectedAt: Iso,
    lastCheckedAt: Iso.nullable(),
    lastCheckedRevision: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
    fileState: z.enum(["match", "differs", "missing", "unreadable", "never_checked"]),
    problem: z.object({ code: z.enum(COMPANY_RULES_SYNC_PROBLEMS), text: z.string().max(400) }).strict().nullable(),
    fileRules: z.array(CompanyRuleViewSchema).max(COMPANY_RULES_APP_LIMITS.maxRules).nullable(),
    diff: CompanyRulesDiffSchema.nullable(),
    /** Which side changed since the file and Rovara last agreed: null when there is no difference to show. The diff's entries carry the same per rule. */
    changedSide: SideSchema.nullable(),
    pendingFromRepo: z.boolean(),
    writeBack: z.object({
      version: z.number().int().min(1),
      state: z.enum(["waiting", "open", "merged", "closed", "failed"]),
      pullRequest: z.object({ number: z.number().int().min(1), url: z.string().max(500) }).strict().nullable(),
      updatedAt: Iso,
    }).strict().nullable(),
  }).strict(),
]);
export type CompanyRulesSync = z.infer<typeof CompanyRulesSyncSchema>;
export const CompanyRulesSyncReaderSchema = forwardReader(CompanyRulesSyncSchema);

const ProposalId = LowerUuid;
const RepositoryName = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/u);

/** What the app sends. The server decides who may; a refusal comes back in its own words. */
export const CompanyRulesBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("propose"), requestId: LowerUuid, baseVersion: z.number().int().min(0).max(999_999_999),
    /** An empty list is allowed (rules are optional: it clears them). Up to 200 are read so that the server, not the schema, says which limit a list is over (30 rules). */
    rules: z.array(CompanyRuleViewSchema).max(200), note: z.string().max(COMPANY_RULES_NOTE_MAX).optional(),
  }).strict(),
  z.object({ action: z.literal("adopt"), proposalId: LowerUuid, expectedDigest: Digest }).strict(),
  z.object({ action: z.literal("approve"), proposalId: ProposalId, expectedDigest: Digest, soleOwnerAcknowledged: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal("reject"), proposalId: ProposalId, expectedDigest: Digest }).strict(),
  z.object({ action: z.literal("cancel"), proposalId: ProposalId }).strict(),
  z.object({ action: z.literal("sync-connect"), repository: RepositoryName, path: z.string().min(1).max(512).optional(), branch: z.string().min(1).max(255).optional() }).strict(),
  z.object({ action: z.literal("sync-disconnect") }).strict(),
  z.object({ action: z.literal("sync-now") }).strict(),
]);
export type CompanyRulesBody = z.infer<typeof CompanyRulesBodySchema>;

/** 202 `needs_approval` after a proposal, 200 for the rest. `state` is the state for this caller, exactly as GET returns it. */
export const CompanyRulesAnswerSchema = z.object({
  status: z.enum(["needs_approval", "adopted", "approved", "rejected", "cancelled", "done"]),
  state: CompanyRulesStateSchema,
}).strict();
export type CompanyRulesAnswer = z.infer<typeof CompanyRulesAnswerSchema>;
export const CompanyRulesAnswerReaderSchema = forwardReader(CompanyRulesAnswerSchema);

/** `GET /v1/app/org/company-rules/current`: what any member may read: the version in force (rules, version, time) and the limits. Nothing about proposals, people or the file link. */
export const CompanyRulesCurrentSchema = z.object({
  enabled: z.literal(true),
  limits: z.object({ maxRules: z.number().int(), maxRuleCharacters: z.number().int(), maxTotalCharacters: z.number().int() }).strict(),
  current: CompanyRulesVersionSchema.nullable(),
}).strict();
export type CompanyRulesCurrent = z.infer<typeof CompanyRulesCurrentSchema>;
export const CompanyRulesCurrentReaderSchema = forwardReader(CompanyRulesCurrentSchema);
