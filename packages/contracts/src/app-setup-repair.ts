// Lead 4 L4-U5 (designs-2026-11-17/setup-upkeep-plan.md, steps 3c and 9): the "Setup needs repair" card on a project's setup page, the "Re-check setup" button and the nightly upkeep pause notice, as Rovara Code serves them and
// as Cloud answers the app. Browser-safe: it imports only zod.
//
// MIRROR of Code's `GET /v1/app/projects/{p}/setup-check` (the hosted read of L4-P1, extended in L4-U5 with `canManage` and, while the setup is broken, `repair`), `POST` of the same path, and `paused` on
// `GET /v1/app/projects/{p}/upkeep`. Cloud's server (`packages/cloud-server/src/setup-repair-routes.ts`) rebuilds each Code answer field by field into exactly these shapes.
//
// ONE EXPERIENCE: the words below are the SAME words Code puts in the chat thread, on the ticket and in the admins' notice (`setupBrokenTaskWords`, `setupAdminNoticeWords` in Code's
// core/setup-agent/recheck-rows.ts). A test pins each sentence against the text Code's fixture holds. Slack and Linear never carry a dollar figure: the cost of "Fix setup" is said on this page only, where it is pressed.
import { z } from "zod";

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);

/** The route family Cloud serves the app, under a project (`/v1/app/projects/{p}/...`). The read is Cloud's own path (Code serves it as `setup-check`), so it never meets the older onboarding `setup-check` row. */
export const SETUP_REPAIR_PATHS = { read: "setup-repair", recheck: "setup-repair/recheck" } as const;

/** What "Fix setup" may spend, as the design states it ("uses your AI, up to $4"). The figure is the design's; the run's own limit is Code's and the gateway's (decision pending: read it from the setup run when it is exposed). */
export const SETUP_FIX_UP_TO_USD = 4;

export const SETUP_REPAIR_SENTENCES = Object.freeze({
  title: "Setup needs repair",
  /** Code's card sentence (`setupRepairCardOf`) and the admins' notice (`setupAdminNoticeWords`) build on it. The step is the check's own redacted failing step. */
  body: (step: string): string => `The project's setup stopped working after recent code changes (${step}). Rovara cannot build on this project until it is fixed.`,
  fixSetup: "Fix setup",
  approveNewSetup: "Approve new setup",
  /** The button: the same label the design gives it, with what it costs. The cost is said here and only here. */
  fixLabel: `Fix setup (uses your AI, up to $${String(SETUP_FIX_UP_TO_USD)})`,
  recheck: "Re-check setup",
  readerNote: "The project's admins have been asked to fix it.",
  changedLabel: "What changed",
  upkeepPausedTitle: "Nightly upkeep is paused",
});

/** The nightly upkeep pause, in Code's fixed sentences (`UPKEEP_NOTICE_WORDS`), keyed by the reason. */
export const UPKEEP_PAUSE_SENTENCES = Object.freeze({
  no_budget: "Nightly upkeep is paused: no spending limit is set for it. Set one on Spending limits.",
  monthly_limit: "Nightly upkeep is paused: this month's upkeep limit is used up. Raise it on Spending limits, or it resumes next month.",
  cost_too_high: "Nightly upkeep is paused: one refresh is larger than the monthly upkeep limit. Raise it on Spending limits.",
} as const);
export const UpkeepPauseReasonSchema = z.enum(["no_budget", "monthly_limit", "cost_too_high"]);
export type UpkeepPauseReason = z.infer<typeof UpkeepPauseReasonSchema>;

export const SetupRepairActionSchema = z.object({ id: z.enum(["fix_setup", "approve_new_setup"]), label: line(60) }).strict();
export const SetupRepairCardSchema = z.object({
  /** The check's own failing step (redacted, one line, cut). The only repository text on the card; the app shows it as plain text. */
  step: line(300),
  /** What changed since the setup was approved, in Code's fixed words ("dependency files"); absent when it could not be told. */
  changed: line(160).optional(),
  at: z.string().datetime({ offset: false }),
  /** A fix was drafted and its check passed: it waits for a person's approval. */
  fixReady: z.boolean(),
  /** Empty for a person who may not act. */
  actions: z.array(SetupRepairActionSchema).max(1),
}).strict();
export type SetupRepairCard = z.infer<typeof SetupRepairCardSchema>;

export const SETUP_STATE_WORDS = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
/** `GET .../setup-repair`: where the project's setup check stands, who may act, and the card while the setup is broken. */
export const SetupRepairViewSchema = z.object({
  state: z.enum(SETUP_STATE_WORDS),
  canManage: z.boolean(),
  repair: SetupRepairCardSchema.optional(),
}).strict();
export type SetupRepairView = z.infer<typeof SetupRepairViewSchema>;

/** `POST .../setup-repair/recheck`: a request id and nothing else (Code starts the project's plain setup check; no AI). */
export const SetupRecheckBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type SetupRecheckBody = z.infer<typeof SetupRecheckBodySchema>;
export const SetupRecheckAnswerSchema = z.object({ started: z.literal(true) }).strict();
export type SetupRecheckAnswer = z.infer<typeof SetupRecheckAnswerSchema>;

/** The refusals Cloud's server may answer these routes with (`SETUP_REPAIR_WORDS` in cloud-server's setup-repair-routes.ts; a unit test pins the two lists to each other). The app shows only these. */
export const SETUP_REPAIR_REFUSALS: ReadonlySet<string> = new Set([
  "the request is not valid",
  "project not found",
  "Only company owners and admins, or this project's admins, can re-check the project's setup.",
  "Setup repair isn't available on this Rovara yet.",
  "The project's setup could not be read or checked just now. Try again.",
  "A setup check is already running for this project. Wait for it to finish.",
  "Checking the project's setup isn't available for this company yet.",
]);
