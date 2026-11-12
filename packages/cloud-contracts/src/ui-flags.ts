// Runtime per-company UI flags (lane U5, requirement P-52): a screen that is still being finished sits behind one named flag.
// Decision 125 (2026-11-12, "delete now"): the eight finished screens (look, nav, home, work, spending, leadingHeader, insights, continue) are no longer flags. Their old screens were deleted from the app, so they
// are always on and cannot be turned off, by a company or by the install's operator. Their names are listed in REMOVED_UI_FLAG_NAMES, only so that a value written before decision 125 (a stored company choice, the
// operator's override) is ignored instead of being read as an unknown name. The flag mechanism stays for the screens still being finished (health, setup, publish, billing, agreement, companies) and for future ones
// (decision 116: a finished screen may be on by default, `defaultOn`).
// Browser-safe (the web app reads the names and the shapes). The closed list of flag names is the only place that says which flags exist: a name outside it is refused everywhere (the route, the store, the nav answer).
//
// WHAT A FLAG CAN BE, for one company, as the person's browser is told in the navigation answer (`uiFlags`):
//   on       the screen is on for everyone in the company (its default, or the company's admin turned it on, and the install's operator has not forced it off);
//   preview  the screen is off for the company, but the company allows previews, so a person may turn it on for THIS DEVICE ONLY with its per-device switch (a local storage key);
//   off      off, and no device can turn it on: a screen that is not finished (default off), one the company turned off without allowing previews, or a flag the install's operator forced off.
// The operator's override (stack parameter UiFlagsForceOff, broker setting `uo`) forces flags off for every company on the install. It wins over a company's choice and over a preview.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";

/**
 * The known flags, in the order the admin screen lists them. A new screen adds its name here (and to UI_FLAG_CATALOG) in the change that builds the screen; nothing else grows.
 * `companies` (the company switcher) is read by `isCompanySwitcherOn` and is `wired: false` until the broker answers `/v1/app/companies`. `health`, `setup`, `publish`, `billing` and `agreement` are for screens other lanes
 * are still finishing: the names are accepted, stored and sent, and each lane's own `isXOn(host)` reads its flag (so the server's `off` holds the screen back, and only a company that allows previews lets a device try it);
 * `wired: false` in the catalog says the screen is not offered in Settings and not on by default yet (decision 116: off until it is finished). When a screen is finished and its old screen deleted, its name moves to
 * REMOVED_UI_FLAG_NAMES (decision 125).
 */
export const UI_FLAG_NAMES = ["health", "setup", "publish", "billing", "agreement", "companies"] as const;
/**
 * Decision 125: the finished screens whose old screens were deleted. They are no flags any more: always on, never sent in the navigation answer or the admin answer, never stored, and ignored (never "unknown", so never
 * fail closed) where an older value still names them: the operator's override (`uiFlagsForcedOff`) and a company's stored row (the broker's store). An older app on this broker reads them as absent, which it reads as
 * off, so it shows its own old screens. A name never moves back from this list to UI_FLAG_NAMES.
 */
export const REMOVED_UI_FLAG_NAMES = ["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"] as const;
export type RemovedUiFlagName = (typeof REMOVED_UI_FLAG_NAMES)[number];
const REMOVED: ReadonlySet<string> = new Set(REMOVED_UI_FLAG_NAMES);
/** Whether a name is one of the finished screens' former flags (decision 125), to be ignored wherever an older value still names it. */
export function isRemovedUiFlagName(name: string): name is RemovedUiFlagName {
  return REMOVED.has(name);
}
export type UiFlagName = (typeof UI_FLAG_NAMES)[number];
export const UiFlagNameSchema = z.enum(UI_FLAG_NAMES);

export interface UiFlagCatalogEntry {
  readonly name: UiFlagName;
  /** The words the admin screen shows (plain, no jargon). */
  readonly label: string;
  /** One sentence: what changes for people when it is on. */
  readonly summary: string;
  /** False while no screen reads the flag yet (the admin screen may hide it). */
  readonly wired: boolean;
  /**
   * What a company that never chose gets (decision 116): true for a finished screen. Only a wired flag may be on by default (tests/contract/ui-flags-contracts.test.ts); a wired screen that is not ready yet says false here, explicitly.
   * A company's stored choice (true or false, written only when an owner or admin pressed it) wins over this; the operator's override wins over both.
   */
  readonly defaultOn: boolean;
}

export const UI_FLAG_CATALOG: readonly UiFlagCatalogEntry[] = [
  { name: "health", label: "Health page", summary: "A page that shows whether connections, models and environments work.", wired: false, defaultOn: false },
  { name: "setup", label: "Project setup", summary: "The new guided project setup.", wired: false, defaultOn: false },
  { name: "publish", label: "Agent publishing", summary: "Draft, request and publish agents with versions.", wired: false, defaultOn: false },
  { name: "billing", label: "Billing", summary: "Plan, trial and invoices.", wired: false, defaultOn: false },
  { name: "agreement", label: "Company agreement", summary: "The company's agreement, with where each rule comes from.", wired: false, defaultOn: false },
  { name: "companies", label: "Companies", summary: "Switch between the companies you belong to from the header, and follow a link into the right company.", wired: false, defaultOn: false },
];

export const UiFlagStateSchema = z.enum(["on", "preview", "off"]);
export type UiFlagState = z.infer<typeof UiFlagStateSchema>;

/**
 * The `uiFlags` field of the navigation answer (`GET /v1/app/nav`): one state per known flag. Every key is optional so a client that knows a flag this server does not still reads the answer
 * (a missing flag is off, no preview). The broker always sends all of them.
 */
export const UiFlagsMapSchema = z.object(Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, UiFlagStateSchema.optional()])) as Record<UiFlagName, z.ZodOptional<typeof UiFlagStateSchema>>).strict();
export type UiFlagsMap = z.infer<typeof UiFlagsMapSchema>;

/** One flag as the admin screen reads it. `enabled` is the company's own switch; `forcedOff` says the install's operator forces it off (the company's switch may be on, and `state` is then `off`); `state` is what people get. */
export const UiFlagAdminRowSchema = z.object({
  name: UiFlagNameSchema,
  label: z.string().max(80),
  summary: z.string().max(240),
  wired: z.boolean(),
  enabled: z.boolean(),
  forcedOff: z.boolean(),
  state: UiFlagStateSchema,
}).strict();
export type UiFlagAdminRow = z.infer<typeof UiFlagAdminRowSchema>;

/** `GET` and `PUT /v1/app/org/ui-flags` (owner or admin, a live browser session). `revision` is 0 while the company has never changed anything; send it back as `expectedRevision`. */
export const UiFlagsAdminAnswerSchema = z.object({
  revision: z.number().int().min(0),
  /** Whether a person may turn a flag that is off for the company on for their own device. Off by default. */
  previews: z.boolean(),
  flags: z.array(UiFlagAdminRowSchema).max(UI_FLAG_NAMES.length),
  changedAt: z.string().datetime().optional(),
}).strict();
export type UiFlagsAdminAnswer = z.infer<typeof UiFlagsAdminAnswerSchema>;
export const UiFlagsAdminAnswerReaderSchema = forwardReader(UiFlagsAdminAnswerSchema);

/**
 * The body of `PUT /v1/app/org/ui-flags`. `flags` names only the flags to change (the rest keep their value); a name outside the closed list is refused (a removed name, decision 125, included: nothing is
 * written for it). Per name: `true` or `false` stores the company's choice; `null` removes the stored choice, so the company follows the catalog default again (and any later change of that default) instead of being
 * pinned to an explicit `true`. `null` is additive: a broker from before it refuses the body (400, nothing written), never misreads it. At least one of `flags` and `previews` must change something.
 * `expectedRevision` is what the caller read; a stale one is CHANGE_STALE.
 */
export const UiFlagsBodySchema = z.object({
  expectedRevision: z.number().int().min(0).max(1_000_000_000),
  flags: z.object(Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, z.boolean().nullable().optional()])) as Record<UiFlagName, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>).strict().optional(),
  previews: z.boolean().optional(),
}).strict().refine((body) => body.previews !== undefined || (body.flags !== undefined && Object.keys(body.flags).length > 0), { message: "nothing to change", path: ["flags"] });
export type UiFlagsBody = z.infer<typeof UiFlagsBodySchema>;

/**
 * The stored row (`ORG#<org>` / `UI_FLAGS`): the company's switches. A name is written only when an owner or admin pressed its switch, so a stored value is a deliberate choice and wins over the default;
 * a flag that is absent takes its catalog default (`defaultOn`, decision 116). Rows written before decision 116 read the same way: their `false` values were all pressed (an older admin screen only offered
 * "Turn off" for a flag that was on), so they are kept as the company's choice of the old screen. A removed name (decision 125) in a stored row is ignored when read and is not written back.
 */
export const UiFlagsRecordSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
  previews: z.boolean(),
  revision: z.number().int().min(1),
  changedAt: z.string().datetime(),
}).passthrough();

/** The operator's override: the install's stack parameter UiFlagsForceOff, as the broker reads it. `none` (the default), `all`, or flag names joined by `-` (letters only). A removed name (decision 125) is ignored. */
export const UI_FLAGS_FORCE_OFF_VARIABLE = "UI_FLAGS_FORCE_OFF";
export const UI_FLAGS_FORCE_OFF_ALL = "all";
/** The parameter's default: nothing is forced off (an empty value reads the same). */
export const UI_FLAGS_FORCE_OFF_NONE = "none";

/**
 * Which flags the operator forces off, from the override's value. Empty or absent: none. `none`: none. `all`: every flag in UI_FLAG_NAMES. A list of names joined by `-`: those. A name in REMOVED_UI_FLAG_NAMES (a finished
 * screen, decision 125) is skipped: it can no longer be forced off, and an install whose override still names it (set before decision 125) keeps the rest of its list. Anything else (a typo, any other unknown name, a stray
 * space, an empty part) fails CLOSED: every flag is forced off, so a mistake gives the old screens of what is left, never a screen the operator meant to hold back. `unreadable` says it was read that way, for the broker's log.
 */
export function uiFlagsForcedOff(value: string | undefined): { names: ReadonlySet<UiFlagName>; unreadable: boolean } {
  const all = new Set<UiFlagName>(UI_FLAG_NAMES);
  if (value === undefined || value === "" || value === UI_FLAGS_FORCE_OFF_NONE) return { names: new Set(), unreadable: false };
  if (value === UI_FLAGS_FORCE_OFF_ALL) return { names: all, unreadable: false };
  const names = new Set<UiFlagName>();
  for (const part of value.split("-")) {
    if (isRemovedUiFlagName(part)) continue;
    const parsed = UiFlagNameSchema.safeParse(part);
    if (!parsed.success) return { names: all, unreadable: true };
    names.add(parsed.data);
  }
  return { names, unreadable: false };
}

/**
 * A flag's default for a company that never chose (decision 116): on only for a wired, finished screen. Read from the catalog when asked, never at module load: a module-level set would keep the whole catalog
 * (labels and summaries) in the web app's initial chunk, which never asks for a default (only the broker does).
 */
export function uiFlagDefaultOn(name: UiFlagName): boolean {
  return UI_FLAG_CATALOG.some((entry) => entry.name === name && entry.wired && entry.defaultOn);
}
/** The company's effective switch for one flag: its stored choice when there is one, else the default. */
export function uiFlagEnabled(name: UiFlagName, stored: boolean | undefined): boolean {
  return stored ?? uiFlagDefaultOn(name);
}

/** What a person gets for one flag: the company's switch (`uiFlagEnabled`), the company's preview permission and the operator's force-off, in one place. */
export function uiFlagState(input: { enabled: boolean; previews: boolean; forcedOff: boolean }): UiFlagState {
  if (input.forcedOff) return "off";
  if (input.enabled) return "on";
  return input.previews ? "preview" : "off";
}
