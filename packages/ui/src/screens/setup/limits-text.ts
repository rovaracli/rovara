// The fixed words of the setup limits and locks screens. A number, a name or a message that comes from the server is shown as text through VisibleText; nothing here is built from one.
import type { LimitSetting, SetupLimitName } from "../../api/setup-limits.js";

export const LIMIT_LABELS: Record<SetupLimitName, string> = {
 commands: "Commands a run may run",
 sameStepTries: "Tries of the same failing step",
 wallClockMin: "Time a run may take, in minutes",
 budgetCents: "Model spend of a run, in dollars",
 hostAsks: "New websites a run may ask for",
};
export const LIMIT_SHORT: Record<SetupLimitName, string> = { commands: "Commands", sameStepTries: "Tries of the same step", wallClockMin: "Minutes", budgetCents: "Model spend", hostAsks: "Website asks" };

export const PROJECT_LIMITS = {
 HEADING: "Setup limits",
 HELP: "What a setup run of this project may use. Leave a box empty to use Rovara's default. Your company can set a cap that these cannot go above.",
 LOADING: "Loading the setup limits", LOAD_FAILED: "Couldn't load the setup limits.", TRY_AGAIN: "Try again",
 NOW: "A run started now would use", CAP: "Company cap", NO_CAP: "No company cap", DEFAULT: "Default", MOST: "Most",
 SAVE: "Save limits", SAVED: "Saved. New runs use these limits.", STALE: "The limits changed since you looked. They were read again.",
 FAILED: "Couldn't save the limits. Try again.",
 NOT_A_NUMBER: "Use a whole number", TOO_BIG: "No more than", TOO_SMALL: "At least",
} as const;

export const SETUP_LOCKS = {
 HEADING: "Setup locks",
 HELP: "Company-wide settings for Rovara's setup runs. Making a lock stricter applies at once. Loosening one waits for a different admin to approve it.",
 LOADING: "Loading the setup locks", LOAD_FAILED: "Couldn't load the setup locks.", RETRY: "Try again",
 AGENT_OFF: "Setup agent off", AGENT_ON: "Setup agent on",
 AGENT_OFF_HELP: "No setup run can start in any project of the company.",
 AGENT_ON_HELP: "Projects can start setup runs, within the limits below.",
 CAPS: "Company limits for a run", NO_CAPS: "No company limit is set; each project uses its own, up to Rovara's most.",
 IMAGES: "Dev container images allowed", IMAGES_NONE: "Any image",
 SOLE_OWNER_OFF: "A company with one admin cannot loosen locks by itself.", SOLE_OWNER_ON: "A company with one admin may loosen locks after the waiting time.",
 PENDING: "A change is waiting for a different admin", PENDING_WOULD: "It would set",
 PENDING_MINE: "You proposed this. A different admin has to approve it.", PENDING_OTHER: "Another admin proposed this. You can approve it.",
 APPROVE: "Approve this change", APPROVE_HELP: "You need to have signed in within the last 10 minutes.", APPROVED: "Approved. The change is on.",
 UNREADABLE_RUNS: "The company's setup locks can't be read, so setup runs are held until a company admin repairs them (company How we work page).",
 UNREADABLE_HEADING: "The setup locks can't be read", REPAIR: "Repair the locks", REPAIR_HELP: "Repair puts safe default values in place of the unreadable ones. Setup runs stay held until then. You need to have signed in within the last 10 minutes.", REPAIRED: "Repaired. Setup runs can start again.",
 EDIT: "Change the locks", TURN_OFF: "Turn off setup runs for the company", SAVE: "Save locks", SAVED: "Saved. The change is on.", WAITING: "Saved. Part of this loosens a lock, so a different admin has to approve it.",
 SIGN_IN_AGAIN: "Sign in again", CHANGED: "The locks changed since you looked. They were read again.", FAILED: "Couldn't change the locks. Try again.", NOTHING: "Nothing was changed.",
} as const;

export const expiresText = (proposedAt: string): string => {
 const at = Date.parse(proposedAt);
 return Number.isFinite(at) ? `It expires at ${new Date(at + 24 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "It expires 24 hours after it was proposed.";
};

/** A limit as a person reads it: the model spend in dollars, the rest as counts. */
export const limitShown = (name: SetupLimitName, value: number): string => name === "budgetCents" ? "$" + (value / 100).toFixed(2) : String(value);
/** A limit as a text box holds it. */
export const limitField = (name: SetupLimitName, value: number | undefined): string => value === undefined ? "" : name === "budgetCents" ? String(Number((value / 100).toFixed(2))) : String(value);

/** A text box as a limit: `undefined` for an empty box, a whole number (cents for the spend), or "invalid". */
export function limitFromField(name: SetupLimitName, text: string): number | undefined | "invalid" {
 const trimmed = text.trim();
 if (trimmed === "") return undefined;
 if (name === "budgetCents") {
  if (!/^\d{1,5}(?:\.\d{1,2})?$/u.test(trimmed)) return "invalid";
  return Math.round(Number(trimmed) * 100);
 }
 return /^\d{1,7}$/u.test(trimmed) ? Number(trimmed) : "invalid";
}

/** The setting the boxes make, or the first problem per limit. `most` is the smaller of Rovara's most and the company's cap. */
export function settingOfFields(fields: Record<SetupLimitName, string>, most: Record<SetupLimitName, number>): { setting: LimitSetting; problems: Partial<Record<SetupLimitName, string>> } {
 const setting: Record<string, number> = {}, problems: Partial<Record<SetupLimitName, string>> = {};
 for (const name of Object.keys(fields) as SetupLimitName[]) {
  const value = limitFromField(name, fields[name]);
  if (value === undefined) continue;
  if (value === "invalid") problems[name] = PROJECT_LIMITS.NOT_A_NUMBER;
  else if (value < 1) problems[name] = `${PROJECT_LIMITS.TOO_SMALL} ${limitShown(name, 1)}`;
  else if (value > most[name]) problems[name] = `${PROJECT_LIMITS.TOO_BIG} ${limitShown(name, most[name])}`;
  else setting[name] = value;
 }
 return { setting, problems };
}
export const sameSetting = (left: LimitSetting, right: LimitSetting): boolean => (Object.keys({ ...left, ...right }) as SetupLimitName[]).every(name => left[name] === right[name]);
