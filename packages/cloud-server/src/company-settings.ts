// A company's settings and rules, kept by Cloud (migration plan v3.2, 2.2: "Company settings and rules ... Cloud backend"; 7.5: Code asks
// for them through the policy hook at the moment of the action). One document per company: feature gates, the website ceiling, the
// company's instructions (rules text), the eval budget, the step-up window, whether tasks may start, decision rules (who may decide,
// second person, sign-in age; the owner's row 11.5 rule `{ what: "setting.loosen", secondPerson: true }` is in the defaults), Code
// policy locks, and the money budgets the gateway enforces.
//
// Everything here is total over untrusted data: `validateCompanySettings` reads a request body or a stored row and either returns the
// whole document or one fixed problem (never the input, never a partial document). `loosens` is conservative: a change counts as
// loosening unless every part of it is the same or provably stricter.
import { answerFor, type CompanyRules, type DecisionRule } from "./policy-hook.js";

export const COMPANY_SETTINGS_LIMITS = Object.freeze({
  featureGatesMax: 40,
  websitesMax: 50,
  hostChars: 253,
  /** Decision 57.6: at most 30 instructions, 600 characters each (after folding white space and removing hidden characters), 12,000 in all. */
  instructionsMax: 30,
  instructionChars: 600,
  instructionsTotalChars: 12_000,
  decisionsMax: 50,
  decidersMax: 50,
  /** $1,000,000 in micro-dollars, as the app's budget schema allows. */
  usdMicrosMax: 1_000_000_000_000,
  /** The step-up window a company may set: never longer than Code's own (600 s, DEVELOPER_STEP_UP_WINDOW_SECONDS). */
  freshSignInSecondsMin: 60,
  freshSignInSecondsMax: 600,
  /** A settings request body, as JSON. */
  bodyBytesMax: 64 * 1024,
});
const L = COMPANY_SETTINGS_LIMITS;

export interface CompanyInstruction { text: string; priority: "required" | "preferred" }
export type WebsiteCeiling = { mode: "any" } | { mode: "listed"; hosts: string[] };
export interface CompanyBudgets {
  /** Micro-dollars; null: no cap of this kind. */
  companyMonthlyUsdMicros: number | null;
  memberMonthlyUsdMicros: number | null;
  projectMonthlyUsdMicros: number | null;
  taskUsdMicros: number | null;
  /**
   * What lessons' learning calls may spend a month on the company's own provider account (DEC 226), in micro-dollars: a number, never
   * null. Never above `companyMonthlyUsdMicros` when that is set (the gateway also holds it under the company's one monthly cap, which
   * learning spend counts in). Raising it is loosening.
   */
  learningMonthlyUsdMicros: number;
}
/** DEC 226: $20 a month, in micro-dollars (the gateway's LEARNING_DEFAULT_MONTH_MICROS; a contract test holds the two together). */
export const LEARNING_DEFAULT_MONTHLY_USD_MICROS = 20_000_000;
export type LockValue = string | number | boolean | null;

export interface CompanySettings {
  /** Feature name to on (true) or off (false). */
  featureGates: Record<string, boolean>;
  /** The most any project may allow: any website, or only these hosts. */
  websiteCeiling: WebsiteCeiling;
  /** The company's instructions to every task (rules text). */
  instructions: CompanyInstruction[];
  /** Micro-dollars a month for evals; null: no eval budget of its own. */
  evalBudgetUsdMicros: number | null;
  /** How recent an admin's step-up must be to change these settings. */
  freshSignInSeconds: number;
  start: { allow: boolean; maxEstimateUsdMicros: number | null };
  decisions: DecisionRule[];
  /** Code policy locks (Code's own field list, `POLICY_FIELDS`), answered to Code's "what are the company's values?". */
  locks: Record<string, LockValue>;
  budgets: CompanyBudgets;
}

/** A company Cloud has no saved settings for. Loosening a setting needs a second admin (owner row 11.5). */
export const DEFAULT_COMPANY_SETTINGS: Readonly<CompanySettings> = Object.freeze<CompanySettings>({
  featureGates: {},
  websiteCeiling: { mode: "any" },
  instructions: [],
  evalBudgetUsdMicros: null,
  freshSignInSeconds: L.freshSignInSecondsMax,
  start: { allow: true, maxEstimateUsdMicros: null },
  decisions: [{ what: "setting.loosen", secondPerson: true }],
  locks: {},
  budgets: { companyMonthlyUsdMicros: null, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: null, taskUsdMicros: null, learningMonthlyUsdMicros: LEARNING_DEFAULT_MONTHLY_USD_MICROS },
});

export const defaultCompanySettings = (): CompanySettings => structuredClone(DEFAULT_COMPANY_SETTINGS);

/**
 * Code's lockable policy fields (copied from Rovara Code's `POLICY_FIELDS`, packages/contracts/src/policy.ts, without `preset_level`, which
 * Code refuses in a hook answer). Code reads a values answer whose locks it can't read as no answer, so Cloud never stores one it can't send.
 */
export const CODE_LOCK_FIELDS: Readonly<Record<string, { kind: "enum"; order: readonly string[] } | { kind: "int"; min: number; max: number } | { kind: "number"; nullable: true } | { kind: "boolean" }>> = Object.freeze({
  real_check: { kind: "enum", order: ["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"] },
  ci_fix_rounds: { kind: "int", min: 0, max: 3 },
  round_time_minutes: { kind: "int", min: 30, max: 120 },
  model_budget_usd: { kind: "number", nullable: true },
  machine_budget_minutes: { kind: "number", nullable: true },
  extra_review: { kind: "boolean" },
  after_merge_revert: { kind: "enum", order: ["off", "report_only", "offer_revert"] },
  mutation_spot_check: { kind: "enum", order: ["off", "on"] },
  prompt_side_by_side: { kind: "enum", order: ["off", "on"] },
});

const GATE = /^[a-z][a-z0-9_]{0,47}$/u;
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DECISION_KIND = /^[a-z][a-z0-9_.-]{0,63}$/u;
const DECISION_PREFIX = /^[a-z][a-z0-9_.-]{0,61}\.\*$/u;
const PERSON = /^[A-Za-z0-9_.:@+-]{1,128}$/u;
/** Control and format characters (bidi controls, zero-width spaces, tag characters), removed from instructions before they are measured. */
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

export const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const plainArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
const keysAre = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed) =>
  Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const usdOrNull = (value: unknown): value is number | null => value === null || whole(value, 0, L.usdMicrosMax);

export type SettingsCheck = { ok: true; settings: CompanySettings } | { ok: false; problem: string };
const problem = (text: string): SettingsCheck => ({ ok: false, problem: text });

/** Folds white space and removes hidden characters, as decision 57.6 measures an instruction. */
export function foldInstruction(text: string): string {
  // White space first (a tab is also a control character), then the hidden characters, then white space again.
  return text.replace(/\s+/gu, " ").replace(HIDDEN, "").replace(/\s+/gu, " ").trim();
}

/** Whether a decision rule's `what` (a kind, or a prefix ending in `.*`) applies to `kind`, as the hook matches it. */
const ruleCovers = (what: string, kind: string) => (what.endsWith(".*") ? kind.startsWith(what.slice(0, -1)) : what === kind);
/** Whether a decision rule applies to changing these settings (`setting.loosen`, `setting.change`, or a prefix such as `setting.*`). */
export function governsSettings(what: string): boolean {
  return ruleCovers(what, "setting.loosen") || ruleCovers(what, "setting.change");
}

function readDecision(value: unknown): DecisionRule | undefined {
  if (!plainObject(value) || !keysAre(value, ["what", "allow", "minApprovers", "secondPerson", "selfApproval", "signInMaxAgeSeconds", "deciders"], ["what"])) return undefined;
  const { what, allow, minApprovers, secondPerson, selfApproval, signInMaxAgeSeconds, deciders } = value;
  if (typeof what !== "string" || !(DECISION_KIND.test(what) || DECISION_PREFIX.test(what))) return undefined;
  if ((allow !== undefined && typeof allow !== "boolean") || (secondPerson !== undefined && typeof secondPerson !== "boolean") || (selfApproval !== undefined && typeof selfApproval !== "boolean")) return undefined;
  if ((minApprovers !== undefined && !whole(minApprovers, 1, 10)) || (signInMaxAgeSeconds !== undefined && !whole(signInMaxAgeSeconds, 0, 2_592_000))) return undefined;
  if (deciders !== undefined && (!plainArray(deciders) || deciders.length === 0 || deciders.length > L.decidersMax || deciders.some((who) => typeof who !== "string" || !PERSON.test(who)) || new Set(deciders).size !== deciders.length)) return undefined;
  return {
    what,
    ...(allow === undefined ? {} : { allow }), ...(minApprovers === undefined ? {} : { minApprovers }), ...(secondPerson === undefined ? {} : { secondPerson }),
    ...(selfApproval === undefined ? {} : { selfApproval }), ...(signInMaxAgeSeconds === undefined ? {} : { signInMaxAgeSeconds }),
    ...(deciders === undefined ? {} : { deciders: [...(deciders as string[])] }),
  };
}

function readLock(field: string, value: unknown): boolean {
  const spec = CODE_LOCK_FIELDS[field];
  if (spec === undefined) return false;
  if (spec.kind === "enum") return typeof value === "string" && spec.order.includes(value);
  if (spec.kind === "int") return whole(value, spec.min, spec.max);
  if (spec.kind === "number") return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= L.usdMicrosMax);
  return typeof value === "boolean";
}

/** The whole document, or one fixed problem. Every field is required, so a stored row and a request read the same way. */
export function validateCompanySettings(value: unknown): SettingsCheck {
  const fields = ["featureGates", "websiteCeiling", "instructions", "evalBudgetUsdMicros", "freshSignInSeconds", "start", "decisions", "locks", "budgets"];
  if (!plainObject(value) || !keysAre(value, fields)) return problem("settings: give exactly the settings fields");

  const gates = value["featureGates"];
  if (!plainObject(gates)) return problem("featureGates: must be an object of names to true or false");
  const gateNames = Object.keys(gates);
  if (gateNames.length > L.featureGatesMax) return problem(`featureGates: at most ${String(L.featureGatesMax)} gates`);
  if (gateNames.some((name) => !GATE.test(name) || typeof gates[name] !== "boolean")) return problem("featureGates: each name is lower-case letters, digits or _, and each value true or false");

  const ceiling = value["websiteCeiling"];
  let websiteCeiling: WebsiteCeiling;
  if (plainObject(ceiling) && ceiling["mode"] === "any" && keysAre(ceiling, ["mode"])) websiteCeiling = { mode: "any" };
  else if (plainObject(ceiling) && ceiling["mode"] === "listed" && keysAre(ceiling, ["mode", "hosts"]) && plainArray(ceiling["hosts"])) {
    const hosts = ceiling["hosts"];
    if (hosts.length > L.websitesMax) return problem(`websiteCeiling: at most ${String(L.websitesMax)} hosts`);
    if (hosts.some((host) => typeof host !== "string" || host.length > L.hostChars || !HOST.test(host))) return problem("websiteCeiling: each host is a lower-case host name, optionally starting with *.");
    if (new Set(hosts).size !== hosts.length) return problem("websiteCeiling: a host is listed twice");
    websiteCeiling = { mode: "listed", hosts: [...(hosts as string[])] };
  } else return problem("websiteCeiling: must be { mode: any } or { mode: listed, hosts }");

  const list = value["instructions"];
  if (!plainArray(list)) return problem("instructions: must be a list");
  if (list.length > L.instructionsMax) return problem(`instructions: at most ${String(L.instructionsMax)} instructions`);
  const instructions: CompanyInstruction[] = [];
  let total = 0;
  for (const entry of list) {
    if (!plainObject(entry) || !keysAre(entry, ["text", "priority"]) || typeof entry["text"] !== "string" || (entry["priority"] !== "required" && entry["priority"] !== "preferred")) {
      return problem("instructions: each is { text, priority: required or preferred }");
    }
    // Bounded before folding, so a huge string costs nothing.
    if (entry["text"].length > L.instructionChars * 4) return problem(`instructions: each has at most ${String(L.instructionChars)} characters`);
    const text = foldInstruction(entry["text"]);
    const length = Array.from(text).length;
    if (length === 0) return problem("instructions: an instruction is empty");
    if (length > L.instructionChars) return problem(`instructions: each has at most ${String(L.instructionChars)} characters`);
    total += length;
    instructions.push({ text, priority: entry["priority"] });
  }
  if (total > L.instructionsTotalChars) return problem(`instructions: at most ${String(L.instructionsTotalChars)} characters in all`);

  const evalBudget = value["evalBudgetUsdMicros"];
  if (!usdOrNull(evalBudget)) return problem("evalBudgetUsdMicros: a whole number of micro-dollars, or null");
  const fresh = value["freshSignInSeconds"];
  if (!whole(fresh, L.freshSignInSecondsMin, L.freshSignInSecondsMax)) return problem(`freshSignInSeconds: a whole number from ${String(L.freshSignInSecondsMin)} to ${String(L.freshSignInSecondsMax)}`);

  const start = value["start"];
  if (!plainObject(start) || !keysAre(start, ["allow", "maxEstimateUsdMicros"]) || typeof start["allow"] !== "boolean" || !usdOrNull(start["maxEstimateUsdMicros"])) {
    return problem("start: must be { allow, maxEstimateUsdMicros }");
  }

  const decisionList = value["decisions"];
  if (!plainArray(decisionList)) return problem("decisions: must be a list");
  if (decisionList.length > L.decisionsMax) return problem(`decisions: at most ${String(L.decisionsMax)} rules`);
  const decisions: DecisionRule[] = [];
  for (const entry of decisionList) {
    const rule = readDecision(entry);
    if (rule === undefined) return problem("decisions: each rule is { what, allow?, minApprovers?, secondPerson?, selfApproval?, signInMaxAgeSeconds?, deciders? }");
    // A company may forbid loosening (`setting.loosen` with allow false is a ratchet: tightening still works). A rule on EVERY settings change
    // (`setting.change`, or a prefix such as `setting.*`) must leave a way to change them in the app: no refusal, at most two approvals, at
    // least two deciders. Otherwise no change, not even removing that rule, could ever be made again.
    if (ruleCovers(rule.what, "setting.change") && (rule.allow === false || (rule.minApprovers ?? 1) > 2 || (rule.deciders !== undefined && rule.deciders.length < 2)
      || (rule.signInMaxAgeSeconds !== undefined && rule.signInMaxAgeSeconds < L.freshSignInSecondsMin))) {
      return problem("decisions: a rule on every settings change must not stop them changing (no allow false, at most 2 approvers, at least 2 deciders, a sign-in age of at least 60 s)");
    }
    decisions.push(rule);
  }

  const locks = value["locks"];
  if (!plainObject(locks) || Object.entries(locks).some(([field, entry]) => !readLock(field, entry))) return problem("locks: each is one of Code's lockable policy fields with a value it accepts");

  const budgets = value["budgets"];
  const budgetFields = ["companyMonthlyUsdMicros", "memberMonthlyUsdMicros", "projectMonthlyUsdMicros", "taskUsdMicros"] as const;
  // The learning cap is the one optional budget field: a stored row or a client from before it existed reads as the default, held under
  // the company monthly cap (never above it), so an older document can never carry more than a new one could.
  if (!plainObject(budgets) || !keysAre(budgets, [...budgetFields, "learningMonthlyUsdMicros"], budgetFields) || budgetFields.some((name) => !usdOrNull(budgets[name]))) {
    return problem("budgets: each of companyMonthlyUsdMicros, memberMonthlyUsdMicros, projectMonthlyUsdMicros, taskUsdMicros is micro-dollars or null");
  }
  const companyCap = budgets["companyMonthlyUsdMicros"] as number | null;
  const learningGiven = budgets["learningMonthlyUsdMicros"];
  if (Object.hasOwn(budgets, "learningMonthlyUsdMicros") && (!whole(learningGiven, 0, L.usdMicrosMax) || (companyCap !== null && learningGiven > companyCap))) {
    return problem("budgets: the learning cap is a whole number of micro-dollars, never above the company monthly cap");
  }
  const learning = Object.hasOwn(budgets, "learningMonthlyUsdMicros") ? learningGiven as number : Math.min(LEARNING_DEFAULT_MONTHLY_USD_MICROS, companyCap ?? LEARNING_DEFAULT_MONTHLY_USD_MICROS);

  return {
    ok: true,
    settings: {
      featureGates: { ...(gates as Record<string, boolean>) }, websiteCeiling, instructions, evalBudgetUsdMicros: evalBudget, freshSignInSeconds: fresh,
      start: { allow: start["allow"], maxEstimateUsdMicros: start["maxEstimateUsdMicros"] }, decisions, locks: { ...(locks as Record<string, LockValue>) },
      budgets: { ...Object.fromEntries(budgetFields.map((name) => [name, budgets[name]])), learningMonthlyUsdMicros: learning } as unknown as CompanyBudgets,
    },
  };
}

/** The same value whatever the key order, for comparing documents and rules. */
export function canonical(value: unknown): string {
  if (plainArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Lower is stricter; null is "no cap", the loosest. */
const capNotLooser = (next: number | null, current: number | null) => next === current || (next !== null && (current === null || next <= current));

/**
 * Whether `next` loosens anything in `current`. Conservative: anything not the same or provably stricter counts. Turning a gate off is
 * stricter, any other gate change is not; a ceiling may only shrink; instructions and locks may not change at all (whether a changed
 * instruction or a Code lock is stricter is not something Cloud can tell); decision rules may only be added (every matching rule applies
 * and the strictest wins, so an added rule never loosens an answer), except a rule on settings changes, which decides who changes them
 * next and so counts too; caps may only fall.
 */
export function loosens(current: CompanySettings, next: CompanySettings): boolean {
  const gates = new Set([...Object.keys(current.featureGates), ...Object.keys(next.featureGates)]);
  for (const gate of gates) if (next.featureGates[gate] !== current.featureGates[gate] && next.featureGates[gate] !== false) return true;
  if (next.websiteCeiling.mode === "any" && current.websiteCeiling.mode !== "any") return true;
  if (next.websiteCeiling.mode === "listed" && current.websiteCeiling.mode === "listed") {
    const allowed = new Set(current.websiteCeiling.hosts);
    if (next.websiteCeiling.hosts.some((host) => !allowed.has(host))) return true;
  }
  if (canonical(next.instructions) !== canonical(current.instructions)) return true;
  if (!capNotLooser(next.evalBudgetUsdMicros, current.evalBudgetUsdMicros)) return true;
  if (next.freshSignInSeconds > current.freshSignInSeconds) return true;
  if (next.start.allow && !current.start.allow) return true;
  if (!capNotLooser(next.start.maxEstimateUsdMicros, current.start.maxEstimateUsdMicros)) return true;
  const kept = new Set(next.decisions.map(canonical));
  if (current.decisions.some((rule) => !kept.has(canonical(rule)))) return true;
  // A new rule on settings changes decides who may change them next (deciders, approvals): a second admin agrees to it, like loosening.
  const before = new Set(current.decisions.map(canonical));
  if (next.decisions.some((rule) => !before.has(canonical(rule)) && governsSettings(rule.what))) return true;
  if (canonical(next.locks) !== canonical(current.locks)) return true;
  const caps = ["companyMonthlyUsdMicros", "memberMonthlyUsdMicros", "projectMonthlyUsdMicros", "taskUsdMicros", "learningMonthlyUsdMicros"] as const;
  return caps.some((name) => !capNotLooser(next.budgets[name], current.budgets[name]));
}

/** What the policy hook answers from (policy-hook.ts `answerFor`). Feature gates, the ceiling, instructions and budgets are not in contract H-1's answers. */
export function hookRulesOf(settings: CompanySettings): CompanyRules {
  return {
    start: { allow: settings.start.allow, ...(settings.start.maxEstimateUsdMicros === null ? {} : { maxEstimateUsdMicros: settings.start.maxEstimateUsdMicros }) },
    decisions: settings.decisions.map((rule) => ({ ...rule, ...(rule.deciders === undefined ? {} : { deciders: [...rule.deciders] }) })),
    locks: { ...settings.locks },
  };
}

/** How a change to the settings may go ahead, under the company's CURRENT rules (never the proposed ones, which could drop the rule that guards them). */
export type SettingsDecision = { allow: false } | { allow: true; secondPerson: boolean; signInMaxAgeSeconds: number };

/**
 * The company's own rules for a settings change: `setting.loosen` when the change loosens anything, else `setting.change`, answered as the
 * hook answers Code. `stage` "verdict" names the deciding person (checked against any `deciders`); "requirement" asks only what is needed.
 * Two approvals or a second person means a second admin approves; more than two approvals is beyond what Cloud's admin screen supports, so refused.
 */
export function settingsDecision(current: CompanySettings, loosening: boolean, stage: "requirement" | "verdict", personId: string): SettingsDecision {
  const what = loosening ? "setting.loosen" : "setting.change";
  const answer = answerFor("decide", { what, stage, per: personId }, hookRulesOf(current));
  if (answer === undefined || answer["allow"] !== true) return { allow: false };
  const minApprovers = answer["minApprovers"] as number;
  if (minApprovers > 2) return { allow: false };
  const age = answer["signInMaxAgeSeconds"];
  return {
    allow: true,
    secondPerson: answer["secondPerson"] === true || minApprovers === 2,
    signInMaxAgeSeconds: Math.min(current.freshSignInSeconds, typeof age === "number" ? age : L.freshSignInSecondsMax),
  };
}
