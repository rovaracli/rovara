// Meta repo lane F (F1): task intake from every channel, as one generic record and one rule (design 3.7).
//
//   - `IntakeItem`: what a channel hands Rovara when someone asks for work (a Jira or GitHub issue, a ticket from a team's own tracker, a chat message, a person's own session).
//     The text of a ticket is written by whoever filed it. It is DATA: it never widens a permission, never starts work for a non-member and is always framed as untrusted.
//   - `standing`: who the request came from. Only a `member` can start work. An `outsider` (someone outside the company, or an account no member is linked to) and a `bot`
//     wait until a member says "Start".
//   - `IntakeChannelRef`: one place work is asked for, as a project's settings or the meta repo's config file name it. It is generic: Jira and GitHub Issues are the first
//     channels, and any tracker plugs in as a `tracker` with its own `system` name. Nothing here names a company.
//   - The poll settings (`INTAKE_POLL_*`) are the defaults for a source that is read on a timer (2 minutes, at most 60 reads an hour); a source may set its own, inside limits.
//
// This file depends on nothing but zod, so the browser, the meta repo config and the broker can all import it.
import { z } from "zod";

// ---- channels, standing, the external reference

export const INTAKE_CHANNELS = ["web", "cli", "slack", "linear", "jira", "github_issue", "tracker", "session", "offer"] as const;
export const IntakeChannelSchema = z.enum(INTAKE_CHANNELS);
export type IntakeChannel = z.infer<typeof IntakeChannelSchema>;

/** The channels that carry a ticket from an outside tracker. Each needs an `externalRef`, and each can have a source that is polled or listened to. */
export const INTAKE_TRACKER_CHANNELS = ["jira", "github_issue", "tracker"] as const;
export type IntakeTrackerChannel = (typeof INTAKE_TRACKER_CHANNELS)[number];
const isTrackerChannel = (channel: string): boolean => (INTAKE_TRACKER_CHANNELS as readonly string[]).includes(channel) || channel === "linear";

export const INTAKE_STANDINGS = ["member", "outsider", "bot"] as const;
export const IntakeStandingSchema = z.enum(INTAKE_STANDINGS);
export type IntakeStanding = z.infer<typeof IntakeStandingSchema>;

/** The system names the built-in channels use for `externalRef.system`. A `tracker` channel names its own system (any other value). */
export const INTAKE_JIRA_SYSTEM = "jira";
export const INTAKE_GITHUB_SYSTEM = "github";

/** A tracker's short, lower-case name: `jira`, `github`, `sim`. */
export const IntakeSystemSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "a system is a short lower-case name");
/** A ticket's id inside its system: a Jira key (`PAY-12`), a GitHub issue (`owner/repo/123`, lower-case). No `#` (it separates parts of a stored key) and no spaces. */
export const IntakeItemIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/, "an item id has letters, digits and . _ : / - only");
const HttpsLinkSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "must be an https link without a user name or password");
const NoControls = (text: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(text);
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);

export const IntakeExternalRefSchema = z.object({ system: IntakeSystemSchema, id: IntakeItemIdSchema, url: HttpsLinkSchema }).strict();
export type IntakeExternalRef = z.infer<typeof IntakeExternalRefSchema>;

export const INTAKE_TITLE_MAX = 300;
export const INTAKE_DISPLAY_MAX = 200;

export const IntakeItemSchema = z.object({
  channel: IntakeChannelSchema,
  externalRef: IntakeExternalRefSchema.optional(),
  requester: z.object({
    developerId: Hex64.optional(),
    display: z.string().min(1).max(INTAKE_DISPLAY_MAX).refine(NoControls, "must not contain control or invisible characters"),
    standing: IntakeStandingSchema,
  }).strict(),
  /** The member whose act started the work. Absent while the item waits for a member. */
  startedBy: z.object({ developerId: Hex64 }).strict().optional(),
  title: z.string().min(1).max(INTAKE_TITLE_MAX).refine(NoControls, "must not contain control or invisible characters"),
  fetchedAt: z.string().datetime(),
}).strict().superRefine((item, context) => {
  if (isTrackerChannel(item.channel) && item.externalRef === undefined) context.addIssue({ code: "custom", path: ["externalRef"], message: "a ticket from a tracker names the ticket" });
  if (item.requester.standing === "member" && item.requester.developerId === undefined) context.addIssue({ code: "custom", path: ["requester", "developerId"], message: "a member is named by their id" });
  if (item.requester.standing !== "member" && item.requester.developerId !== undefined) context.addIssue({ code: "custom", path: ["requester", "developerId"], message: "only a member has an id here" });
});
export type IntakeItem = z.infer<typeof IntakeItemSchema>;

// ---- the poll settings

/** A source that is read on a timer: how often, and the most reads it may make an hour (design Q13). Both are settings; these are the defaults and the limits. */
export const INTAKE_POLL_DEFAULT_MINUTES = 2;
export const INTAKE_POLL_MIN_MINUTES = 1;
export const INTAKE_POLL_MAX_MINUTES = 60;
export const INTAKE_DEFAULT_MAX_CALLS_PER_HOUR = 60;
export const INTAKE_MAX_CALLS_PER_HOUR_CEILING = 600;
/** The most items one read may hand over; more is cut and noted, never trusted. */
export const INTAKE_MAX_ITEMS_PER_POLL = 50;

export const IntakePollSettingsSchema = z.object({
  everyMinutes: z.number().int().min(INTAKE_POLL_MIN_MINUTES).max(INTAKE_POLL_MAX_MINUTES).optional(),
  maxCallsPerHour: z.number().int().min(1).max(INTAKE_MAX_CALLS_PER_HOUR_CEILING).optional(),
}).strict();
export type IntakePollSettings = z.infer<typeof IntakePollSettingsSchema>;

/** The settings of a source with its defaults filled in. */
export function intakePollSettingsOf(settings: IntakePollSettings | undefined): { everyMinutes: number; maxCallsPerHour: number } {
  return { everyMinutes: settings?.everyMinutes ?? INTAKE_POLL_DEFAULT_MINUTES, maxCallsPerHour: settings?.maxCallsPerHour ?? INTAKE_DEFAULT_MAX_CALLS_PER_HOUR };
}

// ---- one place work is asked for

const LabelSchema = z.string().trim().min(1).max(100).refine(NoControls, "must not contain control or invisible characters");

/**
 * One place a project's work is asked for. `when` says what asks: a label someone puts on a ticket, or the ticket being assigned to Rovara's own account on that tracker.
 * It is only a routing hint: whether work STARTS depends on who did it (a member), never on the label. `connection` names an org connection (a name or id, never an address
 * or a secret) that a poll reads through. A channel with no `poll` is only listened to (webhooks).
 */
export const IntakeChannelRefSchema = z.object({
  channel: z.enum(INTAKE_TRACKER_CHANNELS),
  /** A `tracker` names its system; `jira` and `github_issue` are fixed and may leave it out. */
  system: IntakeSystemSchema.optional(),
  connection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, "a connection is a name or id, never an address").optional(),
  when: z.object({ label: LabelSchema.optional(), assignedToRovara: z.literal(true).optional() }).strict()
    .refine((when) => when.label !== undefined || when.assignedToRovara === true, "name the label, or assignment to Rovara, that asks for work"),
  poll: IntakePollSettingsSchema.optional(),
}).strict().superRefine((ref, context) => {
  if (ref.channel === "tracker" && ref.system === undefined) context.addIssue({ code: "custom", path: ["system"], message: "a tracker names its system" });
  if (ref.channel === "tracker" && (ref.system === INTAKE_JIRA_SYSTEM || ref.system === INTAKE_GITHUB_SYSTEM)) context.addIssue({ code: "custom", path: ["system"], message: "Jira and GitHub have channels of their own" });
  if (ref.channel === "jira" && ref.system !== undefined && ref.system !== INTAKE_JIRA_SYSTEM) context.addIssue({ code: "custom", path: ["system"], message: "a Jira channel is the system jira" });
  if (ref.channel === "github_issue" && ref.system !== undefined && ref.system !== INTAKE_GITHUB_SYSTEM) context.addIssue({ code: "custom", path: ["system"], message: "a GitHub Issues channel is the system github" });
});
export type IntakeChannelRef = z.infer<typeof IntakeChannelRefSchema>;

/** The system a channel reads, with the built-in channels' fixed names filled in. */
export function intakeSystemOf(ref: Pick<IntakeChannelRef, "channel" | "system">): string {
  return ref.channel === "jira" ? INTAKE_JIRA_SYSTEM : ref.channel === "github_issue" ? INTAKE_GITHUB_SYSTEM : ref.system ?? "";
}

// ---- items that wait, as a maintainer sees them

export const INTAKE_ITEM_STATES = ["waiting", "starting", "started"] as const;
export type IntakeItemState = (typeof INTAKE_ITEM_STATES)[number];

/**
 * Why an item waits instead of starting. Fixed codes; the words are the client's.
 *   outsider: the person who asked is not a member Rovara can tell (outside the company, or an account no member is linked to);
 *   bot: an automation asked; no_authority: a member asked but cannot start work on the project;
 *   start_refused: a member's act tried to start it and the start was refused (the budget, the project); `lastRefusal` says the code.
 */
export const INTAKE_WAIT_REASONS = ["outsider", "bot", "no_authority", "start_refused"] as const;
export type IntakeWaitReason = (typeof INTAKE_WAIT_REASONS)[number];

/** One item that waits for a member to say "Start". The title is the ticket's own words (untrusted, shown as text only). */
export const IntakeWaitingItemSchema = z.object({
  itemId: z.string().regex(/^[a-f0-9]{32}$/),
  channel: z.enum(INTAKE_TRACKER_CHANNELS),
  system: IntakeSystemSchema,
  id: IntakeItemIdSchema,
  url: HttpsLinkSchema,
  title: z.string().max(INTAKE_TITLE_MAX),
  requester: z.object({ display: z.string().max(INTAKE_DISPLAY_MAX), standing: IntakeStandingSchema }).strict(),
  reason: z.enum(INTAKE_WAIT_REASONS),
  /** With `start_refused`: the refusal's code (never its words). */
  lastRefusal: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  waitingSince: z.string().datetime(),
}).strict();
export type IntakeWaitingItem = z.infer<typeof IntakeWaitingItemSchema>;

export const IntakeWaitingListSchema = z.object({ items: z.array(IntakeWaitingItemSchema).max(100) }).strict();
export type IntakeWaitingList = z.infer<typeof IntakeWaitingListSchema>;

/** `POST /v1/app/projects/{project}/intake/{itemId}/start`: a member says "Start". The request id makes a repeat the same start. */
export const IntakeStartBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type IntakeStartBody = z.infer<typeof IntakeStartBodySchema>;
