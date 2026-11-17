// Guided onboarding PR 9 (DEC 254j/254k/254l, design section 1 "Project setup checklist"): the project checklist's one read and its "Set up later" change, as
// Rovara Code serves them (PrepLabsAI/Rovara #841, `GET /v1/dev/client/projects/{project}/setup-status`, `PUT .../setup-status/skips`), and the fixed words Cloud
// answers for them and for the hosted setup run (Code #844, `/v1/app/projects/{project}/setup-agent`). Browser-safe: it imports only zod.
//
// The reader below is Code's ProjectSetupChecklistSchema (contracts/src/project-setup-status.ts on #841), copied field for field: every row is derived by Code
// from records it already keeps on each read, so the page is right after a reload, on another device and for a second admin. The only thing stored for the
// checklist is which OPTIONAL rows were set aside.
import { z } from "zod";

/** The checklist's rows, in the order the screen shows them. */
export const SETUP_STATUS_ROWS = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "slackChannel", "linear", "invites", "firstTask"] as const;
export type SetupStatusRow = (typeof SETUP_STATUS_ROWS)[number];
/** The rows that must be done before the first task (design section 1: 1 to 4, then the finish line). */
export const SETUP_REQUIRED_ROWS = ["repos", "setupRun", "evalConfirm", "aiAndSpend", "firstTask"] as const;

/** The rows a person may mark "Set up later" (DEC 254k). Skipped rows count toward 100%. */
export const SETUP_SKIPPABLE_ROWS = ["slackChannel", "linear", "invites"] as const;
export type SetupSkippableRow = (typeof SETUP_SKIPPABLE_ROWS)[number];

/** done: complete. needs_you: a person must act. running: Rovara is working. optional: not set up, and not required. skipped: an optional row set aside. failed: it ran and did not work. */
export const SETUP_ROW_STATES = ["done", "needs_you", "running", "optional", "skipped", "failed"] as const;
export type SetupRowState = (typeof SETUP_ROW_STATES)[number];
const State = z.enum(SETUP_ROW_STATES);

const Channel = z.object({ channelId: z.string().min(1).max(64), name: z.string().min(1).max(200).optional(), isPrivate: z.boolean().optional() }).passthrough();

/** `GET /v1/app/projects/{p}/setup-status` (Code's answer, rebuilt by Cloud). Unknown fields are allowed (a newer Code may add some); every field named here is fixed. */
export const ProjectSetupChecklistSchema = z.object({
  project: z.string().min(1).max(128),
  /** What the caller may do here, from live records: `canSkip` is true for a company owner or admin and for the project's administrator. */
  viewer: z.object({ companyRole: z.enum(["owner", "admin", "member"]).nullable(), projectAdmin: z.boolean(), canSkip: z.boolean() }).passthrough(),
  /** `percent` counts done and skipped rows. `nextRequired` is the first required row that is not done, else null. */
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(1), percent: z.number().int().min(0).max(100), nextRequired: z.enum(SETUP_STATUS_ROWS).nullable() }).passthrough(),
  repos: z.object({
    state: State, count: z.number().int().min(0),
    items: z.array(z.object({ name: z.string().min(1).max(128), fullName: z.string().min(1).max(256).optional(), defaultBranch: z.string().min(1).max(256) }).passthrough()).max(32),
  }).passthrough(),
  setupRun: z.object({
    state: State,
    status: z.enum(["none", "running", "ready", "failed"]),
    startedAt: z.string().max(40).optional(),
    elapsedMs: z.number().int().min(0).optional(),
    costCents: z.number().int().min(0).optional(),
    commandsRun: z.number().int().min(0).optional(),
    commandsFound: z.object({ setup: z.number().int().min(0), tests: z.number().int().min(0) }).passthrough().optional(),
    testOutcome: z.enum(["passed", "failed", "unknown"]).optional(),
    partial: z.boolean().optional(),
    stop: z.string().max(60).optional(),
    /** Code's fixed sentence (never a log line or a model's words). */
    failure: z.string().max(1_000).optional(),
    failedCommand: z.object({ n: z.number().int().min(1), command: z.string().max(2_000), exitCode: z.number().int().nullable(), timedOut: z.boolean(), lastLines: z.array(z.string().max(300)).max(20) }).passthrough().optional(),
  }).passthrough(),
  evalConfirm: z.object({
    state: State,
    report: z.enum(["none", "reported", "confirmed"]),
    blockedBy: z.literal("setupRun").optional(),
    suites: z.array(z.object({ selection: z.string().max(512), questions: z.number().int().min(0) }).passthrough()).max(4).optional(),
    confirmedSelection: z.string().max(512).optional(),
  }).passthrough(),
  aiAndSpend: z.object({
    state: State,
    source: z.enum(["project", "company", "default"]),
    companyModelSaved: z.boolean(),
    modelBudgetUsd: z.number().min(0).nullable(),
  }).passthrough(),
  slackChannel: z.object({ state: State, channels: z.array(Channel).max(32) }).passthrough(),
  linear: z.object({ state: State, team: z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200).optional() }).passthrough().nullable() }).passthrough(),
  invites: z.object({ state: State }).passthrough(),
  firstTask: z.object({ state: State, hasTask: z.boolean(), canStart: z.boolean() }).passthrough(),
}).passthrough();
export type ProjectSetupChecklist = z.infer<typeof ProjectSetupChecklistSchema>;

/** `PUT /v1/app/projects/{p}/setup-status/skips`: strict; a row that is not skippable, or a missing flag, is refused. */
export const ProjectSetupSkipBodySchema = z.object({ row: z.enum(SETUP_SKIPPABLE_ROWS), skipped: z.boolean() }).strict();
export type ProjectSetupSkipBody = z.infer<typeof ProjectSetupSkipBodySchema>;

/** The answer of the skip change: the row, its new flag (a repeat answers the same) and every skipped row now. */
export const ProjectSetupSkipResponseSchema = z.object({
  project: z.string().min(1).max(128), row: z.enum(SETUP_SKIPPABLE_ROWS), skipped: z.boolean(), skippedRows: z.array(z.enum(SETUP_SKIPPABLE_ROWS)).max(SETUP_SKIPPABLE_ROWS.length),
}).passthrough();
export type ProjectSetupSkipResponse = z.infer<typeof ProjectSetupSkipResponseSchema>;

/** Cloud's fixed words for the checklist and the hosted setup run. The app shows one of these (or its own words), never Code's or the browser's text. */
export const SETUP_CHECKLIST_WORDS = Object.freeze({
  notFound: "project not found",
  skipNotAllowed: "Only company owners and admins, or this project's admins, can set a row aside.",
  runNotAllowed: "Only company owners and admins, or this project's admins, can run the project's setup.",
  invalid: "the request is not valid",
  stale: "The project changed. Look again, then try once more.",
  busy: "A setup run is already going for this project. Wait for it to finish, or stop it first.",
  runUnavailable: "Setting a project up with Rovara isn't available for this company yet.",
  notYet: "The setup checklist isn't available on this Rovara yet.",
  runNotYet: "Setting up with Rovara isn't available on this Rovara yet.",
  unavailable: "The project's setup couldn't be read just now. Try again.",
});
/** Every sentence a checklist or setup-run refusal may carry. */
export const SETUP_CHECKLIST_SENTENCES: ReadonlySet<string> = new Set(Object.values(SETUP_CHECKLIST_WORDS));
