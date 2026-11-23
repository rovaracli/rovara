// Browser testing in a project's setup (owner decisions 417, 420, 421): what Rovara Code's route family `/v1/app/projects/{p}/browser-testing` answers and takes, as Cloud passes it on and the page reads it.
// SOURCE-BACKED, NOTHING TYPED: there is no field for a password, a secret, a token, an address a person typed, or a sandbox address anywhere in this file, and the strict schemas refuse any extra member, so a view that
// carried one is not a reading. The words are Rovara's: the start command, the health path, a user kind's name and the sign-in snippet are the customer's own repository's text and are shown as text only.
import { z } from "zod";

export const BROWSER_TESTING_LIMITS = { name: 120, role: 200, command: 300, path: 500, applications: 4, kinds: 16, build: 16, snippet: 8_000, snippetPath: 200, failedStep: 300, sentence: 400 } as const;
export const BROWSER_RUN_TIMEOUT_MIN_MS = 60_000;
export const BROWSER_RUN_TIMEOUT_MAX_MS = 1_800_000;

const oneLine = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]+$/u);
/** A file's text: new lines and tabs are its own, any other control or format character is not a reading. */
const block = (max: number) => z.string().min(1).max(max).regex(/^(?:[^\p{Cc}\p{Cf}]|[\n\t])+$/u);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u);
const requestId = z.string().uuid();

export const BrowserTestingProofSchema = z.object({ screenshotMode: z.enum(["failed", "all"]), video: z.boolean() }).strict();
export type BrowserTestingProof = z.infer<typeof BrowserTestingProofSchema>;

export const BrowserTestingUserKindSchema = z.object({ profileId: oneLine(BROWSER_TESTING_LIMITS.name), roleRef: oneLine(BROWSER_TESTING_LIMITS.role), signInPath: oneLine(BROWSER_TESTING_LIMITS.path).nullable() }).strict();
export type BrowserTestingUserKind = z.infer<typeof BrowserTestingUserKindSchema>;

export const BrowserTestingApplicationSchema = z.object({
  applicationId: oneLine(BROWSER_TESTING_LIMITS.name), recipeSource: z.enum(["repo", "inferred"]),
  build: z.array(oneLine(BROWSER_TESTING_LIMITS.command)).max(BROWSER_TESTING_LIMITS.build), start: oneLine(BROWSER_TESTING_LIMITS.command), healthPath: oneLine(BROWSER_TESTING_LIMITS.path), healthStatus: z.number().int().min(100).max(599),
  userKinds: z.array(BrowserTestingUserKindSchema).max(BROWSER_TESTING_LIMITS.kinds),
  signInDeclared: z.boolean(),
  /** The file to add when the repository declares no sign-in: valid JSON for the app's `agentx.e2e`, built by Code from its own schema. It needs a seed step beside it. */
  snippet: z.object({ path: oneLine(BROWSER_TESTING_LIMITS.snippetPath), text: block(BROWSER_TESTING_LIMITS.snippet), needsSeedStep: z.literal(true) }).strict().nullable(),
}).strict();
export type BrowserTestingApplication = z.infer<typeof BrowserTestingApplicationSchema>;

export const BROWSER_TESTING_PROBLEMS = ["no-application", "needs-input", "too-many-user-kinds", "more-than-one-repository"] as const;
export const BrowserTestingFoundSchema = z.object({
  applications: z.array(BrowserTestingApplicationSchema).max(BROWSER_TESTING_LIMITS.applications),
  problem: z.enum(BROWSER_TESTING_PROBLEMS).nullable(),
}).strict();
export type BrowserTestingFound = z.infer<typeof BrowserTestingFoundSchema>;

const runTimeoutMs = z.number().int().min(BROWSER_RUN_TIMEOUT_MIN_MS).max(BROWSER_RUN_TIMEOUT_MAX_MS);
export const BrowserTestingSummarySchema = z.object({ found: BrowserTestingFoundSchema, proof: BrowserTestingProofSchema, runTimeoutMs }).strict();
export type BrowserTestingSummary = z.infer<typeof BrowserTestingSummarySchema>;

export const BROWSER_TESTING_STATES = ["not-set-up", "draft", "checking", "check-failed", "waiting", "on", "paused"] as const;
export const BROWSER_TESTING_FAULTS = ["sandbox-unavailable", "accounts-refresh-failed", "approved-setup-unreadable"] as const;
export type BrowserTestingFault = (typeof BROWSER_TESTING_FAULTS)[number];

export const BrowserTestingViewSchema = z.object({
  project: z.string().min(1).max(100), canManage: z.boolean(), viewerRole: z.enum(["owner", "admin", "project-admin", "member"]),
  state: z.enum(BROWSER_TESTING_STATES), paused: z.boolean(), sandboxAvailable: z.boolean(), faults: z.array(z.enum(BROWSER_TESTING_FAULTS)).max(3),
  setupWaiting: z.boolean(),
  draft: z.object({ revision: z.number().int().min(1), foundAt: instant, found: BrowserTestingFoundSchema, proof: BrowserTestingProofSchema, runTimeoutMs, locked: z.boolean(), stale: z.boolean() }).strict().nullable(),
  candidate: z.object({
    status: z.enum(["checking", "ready", "failed"]), failedStep: z.string().min(1).max(BROWSER_TESTING_LIMITS.failedStep).optional(), checkedAt: instant.optional(), revision: z.number().int().min(1),
    summary: BrowserTestingSummarySchema.nullable(),
    approval: z.object({ requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u), revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().nullable(),
    canApprove: z.boolean(),
  }).strict().nullable(),
  approved: z.object({ revision: z.number().int().min(1), approvedAt: instant.nullable(), approvedBy: z.string().min(1).max(200).nullable(), decidedByYou: z.boolean(), summary: BrowserTestingSummarySchema.nullable() }).strict().nullable(),
  newerChange: z.object({
    kind: z.enum(["repo", "choices"]), found: BrowserTestingFoundSchema, newUserKinds: z.array(oneLine(BROWSER_TESTING_LIMITS.name)).max(BROWSER_TESTING_LIMITS.kinds), removedUserKinds: z.array(oneLine(BROWSER_TESTING_LIMITS.name)).max(BROWSER_TESTING_LIMITS.kinds),
    proof: BrowserTestingProofSchema, runTimeoutMs,
  }).strict().nullable(),
  accounts: z.array(z.object({
    profileId: oneLine(BROWSER_TESTING_LIMITS.name), roleRef: oneLine(BROWSER_TESTING_LIMITS.role), signInPath: oneLine(BROWSER_TESTING_LIMITS.path).nullable(),
    /** null: not tried yet (no real browser check has reported for this kind of user); never a guess. */
    lastSignIn: z.object({ status: z.enum(["ok", "refused"]), checkedAt: instant }).strict().nullable(),
  }).strict()).max(BROWSER_TESTING_LIMITS.kinds),
}).strict();
export type BrowserTestingView = z.infer<typeof BrowserTestingViewSchema>;

/** The decision's answer: what was decided, and the page's read again. */
export const BrowserTestingDecisionAnswerSchema = z.object({ project: z.string().min(1).max(100), decision: z.enum(["approved", "rejected"]), revision: z.number().int().min(1), replayed: z.boolean(), view: BrowserTestingViewSchema }).strict();
export type BrowserTestingDecisionAnswer = z.infer<typeof BrowserTestingDecisionAnswerSchema>;

/** The bodies. Each is strict: a member that is not listed here is refused, never passed on. */
export const BrowserTestingSimpleBodySchema = z.object({ requestId }).strict();
export const BrowserTestingChoicesBodySchema = z.object({
  requestId, expectedDraftRevision: z.number().int().min(1), proof: BrowserTestingProofSchema.optional(), runTimeoutMs: runTimeoutMs.optional(),
}).strict().refine((body) => body.proof !== undefined || body.runTimeoutMs !== undefined, { message: "nothing to change" });
export const BrowserTestingCheckBodySchema = z.object({ requestId, expectedDraftRevision: z.number().int().min(1) }).strict();
export const BrowserTestingDecisionBodySchema = z.object({
  requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u), outcome: z.enum(["approve", "reject"]),
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict();
export type BrowserTestingChoicesBody = z.infer<typeof BrowserTestingChoicesBodySchema>;
export type BrowserTestingCheckBody = z.infer<typeof BrowserTestingCheckBodySchema>;
export type BrowserTestingDecisionBody = z.infer<typeof BrowserTestingDecisionBodySchema>;

/**
 * The sentences a refusal of this page may reach the person in: Code's fixed words (core/setup-agent/browser-testing-state.ts `BROWSER_TESTING_WORDS`, matched exactly) and Cloud's own. The page shows no other text of a
 * refusal. `unknown` is the one answer that says a change MAY have been made.
 */
export const BROWSER_TESTING_CODE_SENTENCES = Object.freeze({
  projectNotFound: "That project doesn't exist, or you don't have access to it.",
  notAllowed: "Only a company owner or admin can change browser testing. Ask your company's admins.",
  unreadable: "Rovara couldn't read this project's browser testing just now. Try again in a minute.",
  invalid: "The request wasn't in the shape Rovara expects.",
  stale: "This changed while you were looking. Refresh to see the current setup before you change anything.",
  anotherWaiting: "Another change is waiting for approval. Approve, reject or discard it first.",
  noDraft: "There is nothing to check yet. Start setting up first.",
  nothingWaiting: "There is no browser testing change waiting for a decision. Open the page again.",
  notChecked: "The setup check has not passed yet, so there is nothing to approve.",
  sandboxUnavailable: "Rovara can't start the test sandbox right now. What you set here is kept. Try again in a few minutes.",
  needsInput: "Rovara didn't find a web or API app it can start in this repository.",
  tooManyKinds: "This repository declares more kinds of user than one approval can hold. Remove some, then run the project setup again.",
  oneRepository: "Browser testing works on a project with one repository.",
  archived: "This project is archived. Unarchive it to change browser testing.",
  auditUnavailable: "Rovara couldn't record this change just now, so it was not made. Try again.",
  noProof: "Your approval could not be proved just now, so nothing was decided. Try again.",
  adminOnly: "Only a company owner or admin can approve or reject browser testing.",
  accountsRefresh: "Rovara couldn't refresh this project's test accounts. Browser checks can't sign in until it does. Try again in a few minutes.",
});
export const BROWSER_TESTING_CLOUD_SENTENCES = Object.freeze({
  invalid: "the request is not valid",
  notFound: "project not found",
  notYet: "Browser testing isn't available on this Rovara yet.",
  unavailable: "Browser testing could not be read just now. Try again.",
  /** Cloud's own: the answer to a change did not arrive, so it may or may not have been made. */
  outcomeUnknown: "The request's outcome is unknown. Check its status before trying again.",
});
export const BROWSER_TESTING_SENTENCES: ReadonlySet<string> = new Set([...Object.values(BROWSER_TESTING_CODE_SENTENCES), ...Object.values(BROWSER_TESTING_CLOUD_SENTENCES)]);
