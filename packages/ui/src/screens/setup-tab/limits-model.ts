// The limits section's rules, pure: the helper line of each read-only row, the fields' starting text, what each field may hold and the setting a save sends (FABLE-REVIEW section 2). Money is whole cents on the wire and dollars on the page.
import type { LimitSetting, ProjectLimits, SetupLimitName } from "../../api/setup-limits.js";
import { SETUP_LIMIT_NAMES } from "../../api/setup-limits.js";
import { limitFromField, limitShown } from "../setup/limits-text.js";
import { LIMITS } from "./setup-tab-text.js";

/** The most a field may hold: Rovara's most, or the company's cap when that is lower. */
export const mostOf = (view: ProjectLimits, name: SetupLimitName): number => Math.min(view.maxima[name], view.companyLock[name] ?? view.maxima[name]);
/** A company cap that is in force: lower than Rovara's most. */
export const capOf = (view: ProjectLimits, name: SetupLimitName): number | undefined => { const cap = view.companyLock[name]; return cap !== undefined && cap < view.maxima[name] ? cap : undefined; };

/** A limit as a helper line says it: money in dollars, time with its unit, the rest as counts. */
const said = (name: SetupLimitName, value: number): string => name === "wallClockMin" ? `${String(value)} minutes` : limitShown(name, value);

/** The muted line under a read-only row: the first case that applies (2, "Helper line variants"). Nothing is said about a cap that is not there. */
export function restHelper(view: ProjectLimits, name: SetupLimitName, company: string): string {
  const cap = capOf(view, name), own = view.limits[name];
  if (cap !== undefined && view.effective[name] === cap && cap < view.defaults[name]) return LIMITS.capIsValue(company);
  if (cap !== undefined) return LIMITS.capInForce(company, said(name, cap));
  if (own !== undefined && own !== view.defaults[name]) return LIMITS.own(said(name, view.defaults[name]));
  return LIMITS.standardRest(said(name, view.maxima[name]));
}
/** The muted line under a field. */
export function fieldHelper(view: ProjectLimits, name: SetupLimitName, company: string): string {
  const cap = capOf(view, name), standard = said(name, view.defaults[name]);
  const line = cap !== undefined ? LIMITS.fieldHintCap(standard, company, said(name, cap)) : LIMITS.fieldHint(standard, said(name, mostOf(view, name)));
  return name === "budgetCents" ? `${line} ${LIMITS.spendHint}` : line;
}

export type Fields = Record<SetupLimitName, string>;
/** The fields start from the value in force, never empty. */
/** A limit as a field holds it: dollars with two decimals for the spend ("4.00"), a whole number for the rest. */
export const fieldText = (name: SetupLimitName, value: number): string => name === "budgetCents" ? (value / 100).toFixed(2) : String(value);
export const startFields = (view: ProjectLimits): Fields => Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, fieldText(name, view.effective[name])])) as Fields;

/** What is wrong with a field, in the words of 2 ("Field errors"); undefined when it holds a good value. */
export function fieldProblem(view: ProjectLimits, name: SetupLimitName, text: string, company: string): string | undefined {
  const value = limitFromField(name, text);
  if (value === undefined || value === "invalid") return name === "budgetCents" ? LIMITS.errSpend : LIMITS.errNumber;
  if (value < 1) return name === "budgetCents" ? LIMITS.errSmallSpend : LIMITS.errSmall;
  const most = mostOf(view, name);
  if (value > most) { const cap = capOf(view, name); return cap !== undefined && cap === most ? LIMITS.errCap(company, said(name, cap)) : LIMITS.errMost(said(name, most)); }
  return undefined;
}

/**
 * The setting a save sends. A field left as it started keeps what the project held for it (so opening the form and changing one box never turns another into the project's own). A field changed to Rovara's standard
 * is sent as "not set": the project then follows the standard, including when Rovara changes it later. Anything else is the project's own value. `problems` is the first problem per field.
 */
export function settingOfFields(view: ProjectLimits, fields: Fields, company: string): { setting: LimitSetting; problems: Partial<Record<SetupLimitName, string>>; dirty: boolean } {
  const start = startFields(view), setting: Record<string, number> = {}, problems: Partial<Record<SetupLimitName, string>> = {};
  let dirty = false;
  for (const name of SETUP_LIMIT_NAMES) {
    const text = fields[name].trim();
    if (text === start[name]) { const own = view.limits[name]; if (own !== undefined) setting[name] = own; continue; }
    dirty = true;
    const problem = fieldProblem(view, name, text, company);
    if (problem !== undefined) { problems[name] = problem; continue; }
    const value = limitFromField(name, text) as number;
    if (value !== view.defaults[name]) setting[name] = value;
  }
  return { setting, problems, dirty };
}
