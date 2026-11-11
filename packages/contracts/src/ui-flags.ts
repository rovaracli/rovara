// Runtime per-company UI flags (lane U5, requirement P-52): the new screens, each behind one named flag that a company owner or admin turns on for the whole company in the app, with no stack deploy.
// Browser-safe (the web app reads the names and the shapes). The closed list of flag names is the only place that says which flags exist: a name outside it is refused everywhere (the route, the store, the nav answer).
//
// WHAT A FLAG CAN BE, for one company, as the person's browser is told in the navigation answer (`uiFlags`):
//   on       the screen is on for everyone in the company (the company's admin turned it on and the install's operator has not forced it off);
//   preview  the screen is off for the company, but the company allows previews, so a person may turn it on for THIS DEVICE ONLY with the older per-device switch (a local storage key);
//   off      off, and no device can turn it on: the default, a company that has not allowed previews, or a flag the install's operator forced off.
// The operator's override (stack parameter UiFlagsForceOff, broker setting `uo`) forces flags off for every company on the install. It wins over a company's choice and over a preview.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/**
 * The known flags, in the order the admin screen lists them. A new screen adds its name here (and to UI_FLAG_CATALOG) in the change that builds the screen; nothing else grows.
 * `leadingHeader` is the task page's header block (task-page-flags.ts). `health`, `setup`, `insights`, `publish`, `billing` and `agreement` are reserved for screens other lanes are building: the names are accepted,
 * stored and sent now, so those lanes only call their own `isXOn(host)`; `wired: false` in the catalog says no screen reads them yet.
 */
export const UI_FLAG_NAMES = ["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement"] as const;
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
}

export const UI_FLAG_CATALOG: readonly UiFlagCatalogEntry[] = [
  { name: "look", label: "New look", summary: "The redesigned colours, type and spacing across the app.", wired: true },
  { name: "nav", label: "New navigation", summary: "The sidebar and phone tab bar with Home, Work, Projects, Agents and Settings.", wired: true },
  { name: "home", label: "New Home", summary: "One list of what needs you, with a box to start something and your agents beside it.", wired: true },
  { name: "work", label: "Work list", summary: "One list of everything in progress, in plain states, instead of today's Live page.", wired: true },
  { name: "spending", label: "Spending page", summary: "Spending in one place for admins: what was used, what is committed and what is left.", wired: true },
  { name: "leadingHeader", label: "Task page summary", summary: "A header on the task page that says the next step, who has it and why, above the details.", wired: true },
  { name: "health", label: "Health page", summary: "A page that shows whether connections, models and environments work.", wired: false },
  { name: "setup", label: "Project setup", summary: "The new guided project setup.", wired: false },
  { name: "insights", label: "Insights", summary: "How work flows: waiting time, review time, failures and shipped outcomes.", wired: false },
  { name: "publish", label: "Agent publishing", summary: "Draft, request and publish agents with versions.", wired: false },
  { name: "billing", label: "Billing", summary: "Plan, trial and invoices.", wired: false },
  { name: "agreement", label: "Company agreement", summary: "The company's agreement, with where each rule comes from.", wired: false },
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
 * The body of `PUT /v1/app/org/ui-flags`. `flags` names only the flags to change (the rest keep their value); a name outside the closed list is refused. At least one of `flags` and `previews` must change something.
 * `expectedRevision` is what the caller read; a stale one is CHANGE_STALE.
 */
export const UiFlagsBodySchema = z.object({
  expectedRevision: z.number().int().min(0).max(1_000_000_000),
  flags: z.object(Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, z.boolean().optional()])) as Record<UiFlagName, z.ZodOptional<z.ZodBoolean>>).strict().optional(),
  previews: z.boolean().optional(),
}).strict().refine((body) => body.previews !== undefined || (body.flags !== undefined && Object.keys(body.flags).length > 0), { message: "nothing to change", path: ["flags"] });
export type UiFlagsBody = z.infer<typeof UiFlagsBodySchema>;

/** The stored row (`ORG#<org>` / `UI_FLAGS`): the company's switches. A flag that is absent is off. */
export const UiFlagsRecordSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
  previews: z.boolean(),
  revision: z.number().int().min(1),
  changedAt: z.string().datetime(),
}).passthrough();

/** The operator's override: the install's stack parameter UiFlagsForceOff, as the broker reads it. `none` (the default), `all`, or flag names joined by `-` (letters only). */
export const UI_FLAGS_FORCE_OFF_VARIABLE = "UI_FLAGS_FORCE_OFF";
export const UI_FLAGS_FORCE_OFF_ALL = "all";
/** The parameter's default: nothing is forced off (an empty value reads the same). */
export const UI_FLAGS_FORCE_OFF_NONE = "none";

/**
 * Which flags the operator forces off, from the override's value. Empty or absent: none. `none`: none. `all`: every flag. A list of known names joined by `-`: those. Anything else (a typo, an unknown name, a stray space) fails
 * CLOSED: every flag is forced off, so a mistake gives today's screens, never a screen the operator meant to hold back. `unreadable` says it was read that way, for the broker's log.
 */
export function uiFlagsForcedOff(value: string | undefined): { names: ReadonlySet<UiFlagName>; unreadable: boolean } {
  const all = new Set<UiFlagName>(UI_FLAG_NAMES);
  if (value === undefined || value === "" || value === UI_FLAGS_FORCE_OFF_NONE) return { names: new Set(), unreadable: false };
  if (value === UI_FLAGS_FORCE_OFF_ALL) return { names: all, unreadable: false };
  const names = new Set<UiFlagName>();
  for (const part of value.split("-")) {
    const parsed = UiFlagNameSchema.safeParse(part);
    if (!parsed.success) return { names: all, unreadable: true };
    names.add(parsed.data);
  }
  return { names, unreadable: false };
}

/** What a person gets for one flag: the company's switch, the company's preview permission and the operator's force-off, in one place. */
export function uiFlagState(input: { enabled: boolean; previews: boolean; forcedOff: boolean }): UiFlagState {
  if (input.forcedOff) return "off";
  if (input.enabled) return "on";
  return input.previews ? "preview" : "off";
}
