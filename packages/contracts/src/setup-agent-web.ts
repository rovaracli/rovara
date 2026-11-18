// The setup run, as the app's Setup screen reads and writes it (sh-setup-wire, SH15): the run's state, its journal and host asks, a person's command, the stop, and "Use this setup" (confirm). Browser-safe: it
// imports only other browser-safe contracts. The server (`rovara-code/setup-agent.ts`, `setup-confirm.ts`) is the authority; these are the shapes the page reads and sends, so a newer server's unknown words are refused.
import { z } from "zod";
import { SESSION_ID_PATTERN } from "./browser-ids.js";
import { SETUP_VERIFICATION_STATES, SetupProposalSchema } from "./setup-proposal.js";
import { SetupAgentLimitsSchema, SetupHostSchema, SetupJournalEntrySchema, SetupRunEndWordSchema, SetupRunSummarySchema } from "./setup-run.js";

export const SETUP_AGENT_VIEW_STATUSES = ["none", "running", "ready", "failed"] as const;

// L4-D (Code #899, DEC 254z b): the candidate setup waiting for a decision, as the run's read carries it once "Use this setup" was pressed (hosted Code only; the laptop decides on its own cards).
export const SETUP_RISKS = ["low", "medium", "high"] as const;
export const SETUP_CHANGE_AREAS = ["setup_commands", "test_commands", "test_mocks", "websites", "registries", "integrations", "dev_container", "other"] as const;
export const SETUP_CHECK_STATES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
export const SetupApplyViewSchema = z.object({
  candidateRevision: z.number().int().min(1),
  baseRevision: z.number().int().min(0),
  /** The candidate's commands as a person would type them, whole. */
  setup: z.array(z.string().min(1).max(2_000)).max(64),
  readiness: z.array(z.string().min(1).max(2_000)).max(64),
  /** Where the candidate's check on a fresh workspace stands; a decision is offered only once it is `ready`. */
  check: z.object({ status: z.enum(SETUP_CHECK_STATES), failedStep: z.string().min(1).max(1_000).optional() }).passthrough(),
  risk: z.enum(SETUP_RISKS),
  changes: z.array(z.object({ area: z.enum(SETUP_CHANGE_AREAS), risk: z.enum(SETUP_RISKS) }).passthrough()).max(16),
  /** Who must approve at this risk: a project maintainer (or a company owner or admin), or a company owner or admin. */
  approver: z.enum(["maintainer", "admin"]),
  canApprove: z.boolean(),
  canReject: z.boolean(),
  /** What a decision is bound to: the id Code offered and the revision and digest the person saw. Sent back as it is; never shown. */
  approval: z.object({ requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u), revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[0-9a-f]{64}$/u), kind: z.literal("setup"), risk: z.enum(SETUP_RISKS) }).passthrough().optional(),
}).passthrough();
export type SetupApplyView = z.infer<typeof SetupApplyViewSchema>;

export const SetupDecideRequestSchema = z.object({
  requestId: z.string().regex(/^setup-[A-Za-z0-9_-]{2,122}$/u),
  outcome: z.enum(["approve", "reject"]),
  seen: z.object({ revision: z.number().int().min(1), artifactDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
  reason: z.string().max(500).optional(),
}).strict();
export const SetupDecideReplySchema = z.object({
  project: z.string().min(1).max(100),
  decision: z.enum(["approved", "rejected"]),
  risk: z.enum(SETUP_RISKS),
  revision: z.number().int().min(1),
  replayed: z.boolean(),
}).passthrough();
export type SetupDecideReply = z.infer<typeof SetupDecideReplySchema>;
export const SetupDiscardRequestSchema = z.object({ requestId: z.string().uuid() }).strict();
export const SetupDiscardReplySchema = z.object({ discarded: z.boolean() }).passthrough();

export const SetupAgentViewSchema = z.object({
  status: z.enum(SETUP_AGENT_VIEW_STATUSES),
  basedOnRevision: z.number().int().min(0),
  limits: SetupAgentLimitsSchema,
  taskId: z.string().uuid().optional(),
  startedAt: z.string().datetime().optional(),
  /** The run's session: the Live wall's steer messages go to it. */
  sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
  stop: SetupRunEndWordSchema.optional(),
  summary: SetupRunSummarySchema.optional(),
  proposal: SetupProposalSchema.optional(),
  failure: z.string().max(1_000).optional(),
  verification: z.record(z.string().min(1).max(100), z.enum(SETUP_VERIFICATION_STATES)).optional(),
  verified: z.boolean().optional(),
  /** A company admin has turned setup runs off: nothing can be started. */
  companySetupOff: z.literal(true).optional(),
  /** The company's locks row does not read: runs are held until an admin repairs it. */
  companyLocksUnreadable: z.literal(true).optional(),
  /** The candidate waiting for a decision (hosted Code, after "Use this setup"). */
  apply: SetupApplyViewSchema.optional(),
  /** A run a person stopped: who (a name, one plain line) and when. Its proposal, if it has one, is what the run had so far: unproven and never applied. */
  stoppedBy: z.object({ name: z.string().min(1).max(100), at: z.string().datetime() }).strict().optional(),
}).passthrough();
export type SetupAgentView = z.infer<typeof SetupAgentViewSchema>;

export const SetupAgentRequestBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const SetupAgentCommandRequestSchema = z.object({ requestId: z.string().uuid(), command: z.string().min(1).max(2_000) }).strict();
export const SetupAgentCommandReplySchema = z.object({ seq: z.number().int().min(1), state: z.enum(["queued", "taken", "done"]) }).passthrough();

export const SetupHostAskViewSchema = z.object({
  host: SetupHostSchema,
  status: z.enum(["open", "approved", "refused"]),
  journalN: z.number().int().min(1).max(400).optional(),
  from: z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).max(10_000_000) }).strict().optional(),
}).passthrough();
export type SetupHostAskView = z.infer<typeof SetupHostAskViewSchema>;

export const SetupJournalReplySchema = z.object({
  status: z.enum(SETUP_AGENT_VIEW_STATUSES),
  entries: z.array(SetupJournalEntrySchema).max(400),
  hostAsks: z.array(SetupHostAskViewSchema).max(50),
}).passthrough();
export type SetupJournalReply = z.infer<typeof SetupJournalReplySchema>;

export const SetupConfirmRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  itemIds: z.array(z.string().min(1).max(100)).max(64).optional(),
}).strict();
export const SETUP_CONFIRM_LEFT_OUT = ["unverified", "refused_command", "not_a_command_item", "too_many", "invalid_command"] as const;
export const SetupConfirmReplySchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  used: z.array(z.string().min(1).max(100)).max(64),
  unchecked: z.array(z.string().min(1).max(100)).max(64),
  left: z.array(z.object({ id: z.string().min(1).max(100), reason: z.enum(SETUP_CONFIRM_LEFT_OUT) }).strict()).max(200),
  /** Hosted Code (L4-D): the revision the candidate was made at; the card that follows reads the candidate from the run's read. */
  candidateRevision: z.number().int().min(1).optional(),
  /** Always false here: the Prove is the wizard's, on the project's setup check. */
  proved: z.boolean(),
  next: z.literal("check"),
}).passthrough();
export type SetupConfirmReply = z.infer<typeof SetupConfirmReplySchema>;

// L4-EVC (DEC 254zzz20 D8), slice 1: the setup flow's ONE eval card, in plain dollars. Code serves the read and the one approval (setup-run-routes.ts, eval-card.ts); Cloud passes them on as the person. Every sentence
// the card shows comes from Code (dollars, never counts or micro-dollar words). The whole-number `seen` figures travel as data only: they are copied from the read into the act that follows, never worked out here.
export const EVAL_CARD_STATES = ["none", "propose", "waiting", "approved", "renew", "rejected"] as const;
const microDollars = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const EvalCardSuiteSchema = z.object({
  selection: z.string().min(1).max(512),
  files: z.array(z.string().min(1).max(500)).max(200),
  cases: z.number().int().min(0).max(1_000_000),
  /** "Running your evals on each AI change will cost about $A-$B per PR, at most $X a month. Approve?" */
  sentence: z.string().min(1).max(600),
  perPr: z.string().min(1).max(100),
  monthly: z.string().min(1).max(100),
  /** What the person's yes echoes back; copied from here, never computed by the page. */
  seen: z.object({ perCheckHighMicros: microDollars, monthlyCapMicros: microDollars }).strict(),
  /** L4-EVW2 (DEC 254zzz20 D2): false when Rovara cannot read this eval's results yet (a small file it proposed as a pull request is merged first). Absent (an older Code): readable. */
  readable: z.boolean().optional(),
  needsFile: z.string().min(1).max(600).optional(),
}).passthrough();
/**
 * L4-EVW4 (DEC 254zzz43): ONE card per eval whose results Rovara cannot read as they are. Code's own words and file: Cloud shows the title, the line and the file's path and text as they come, and works nothing out.
 * [View the file] and [I'll add it myself] use `path` and `content`; [Let Rovara open a pull request] is offered only where `canOpenPullRequest`; [Not now] sets the card aside (`dismissed`).
 */
export const EVAL_WRAPPER_STEPS = ["needs_file", "pull_request_open", "file_found", "file_outdated", "test_approved", "readable", "unreadable", "not_offered", "dismissed"] as const;
export const EVAL_WRAPPER_COPY_REASONS = ["custom", "another_eval", "cannot_write", "file_exists", "closed", "not_checked"] as const;
export const EvalWrapperCardSchema = z.object({
  selection: z.string().min(1).max(512),
  repository: z.string().max(200).optional(),
  language: z.enum(["python", "node"]),
  kind: z.enum(["template", "custom"]),
  /** Where the file goes in the repository, and what it holds. Everyone who can see the project may see and copy it. */
  path: z.string().min(1).max(200),
  content: z.string().max(40_000),
  summary: z.string().max(300).optional(),
  /** "Rovara can't read the results of <eval> yet" */
  title: z.string().min(1).max(700),
  step: z.enum(EVAL_WRAPPER_STEPS),
  line: z.string().min(1).max(400),
  offered: z.boolean(),
  canOpenPullRequest: z.boolean(),
  copyOnly: z.object({ reason: z.enum(EVAL_WRAPPER_COPY_REASONS), text: z.string().min(1).max(400) }).passthrough().optional(),
  pullRequest: z.object({ number: z.string().min(1).max(40).optional(), url: z.string().min(1).max(500).optional(), state: z.enum(["opening", "open", "merged", "closed", "failed"]) }).passthrough().optional(),
  fileStatus: z.enum(["same", "edited", "outdated"]).optional(),
  dismissed: z.boolean(),
  checkedAt: z.string().max(40).optional(),
}).passthrough();
export type EvalWrapperCard = z.infer<typeof EvalWrapperCardSchema>;
export const EvalCardViewSchema = z.object({
  project: z.string().min(1).max(100).optional(),
  state: z.enum(EVAL_CARD_STATES),
  canApprove: z.boolean(),
  report: z.object({ taskId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u), reportDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).passthrough().optional(),
  suites: z.array(EvalCardSuiteSchema).max(16),
  wrappers: z.array(EvalWrapperCardSchema).max(8).optional(),
  spend: z.object({
    state: z.string().min(1).max(60),
    perPr: z.string().min(1).max(100).optional(),
    monthly: z.string().min(1).max(100).optional(),
    needsApproval: z.string().min(1).max(600).optional(),
    carried: z.boolean().optional(),
  }).passthrough().optional(),
  unavailable: z.string().min(1).max(600).optional(),
}).passthrough();
export type EvalCardView = z.infer<typeof EvalCardViewSchema>;
export type EvalCardSuite = z.infer<typeof EvalCardSuiteSchema>;

export const EvalApproveRequestSchema = z.object({
  taskId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u),
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  selection: z.string().min(1).max(512),
  paths: z.array(z.string().min(1).max(500)).min(1).max(200),
  approve: z.literal(true),
  seen: z.object({ perCheckHighMicros: microDollars, monthlyCapMicros: microDollars }).strict(),
}).strict();
export const EvalApproveReplySchema = z.object({ project: z.string().min(1).max(100), state: z.string().max(60).optional(), perPr: z.string().max(100).optional(), monthly: z.string().max(100).optional(), carried: z.boolean().optional() }).passthrough();

/** L4-EVW4: a person's act on the wrapper card: open the pull request for one eval, Not now, Set up now, or Check now (look for the file on the default branch). Exactly these members. */
export const EVAL_WRAPPER_ACTIONS = ["open_pull_request", "dismiss", "reopen", "check"] as const;
export const EvalWrapperActionRequestSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(EVAL_WRAPPER_ACTIONS),
  selection: z.string().min(1).max(512).optional(),
}).strict().refine(body => body.action !== "open_pull_request" || body.selection !== undefined, "open_pull_request names the eval");
export const EvalWrapperActionReplySchema = z.object({
  project: z.string().min(1).max(100),
  action: z.enum(EVAL_WRAPPER_ACTIONS),
  outcome: z.object({ selection: z.string().max(512), state: z.string().max(40), failure: z.string().max(40).optional(), number: z.string().max(40).optional(), url: z.string().max(500).optional() }).passthrough().optional(),
  wrappers: z.array(EvalWrapperCardSchema).max(8),
}).passthrough();
