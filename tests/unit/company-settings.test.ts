// A company's settings and rules (company-settings.ts): every field validated at run time with a fixed problem and no echo; the
// conservative "does this loosen anything" check; what the policy hook answers from; the settings decision under the CURRENT rules;
// and Code's step-up claims (step-up.ts).
import { describe, expect, it } from "vitest";
import {
  COMPANY_SETTINGS_LIMITS, DEFAULT_COMPANY_SETTINGS, STEP_UP_WINDOW_SECONDS, answerFor, defaultCompanySettings, freshStepUp, hookRulesOf, loosens, settingsDecision, stepUpClaim,
  validateCompanySettings, type CompanySettings,
} from "../../packages/cloud-server/src/index.js";

const base = (): CompanySettings => defaultCompanySettings();
const withPart = (part: Partial<CompanySettings>): CompanySettings => ({ ...base(), ...part });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (payload: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT", kid: "k" })}.${b64(payload)}.c2ln`;
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const NOW_S = NOW / 1000;

describe("validateCompanySettings", () => {
  it("reads the defaults, unchanged (golden)", () => {
    expect(validateCompanySettings(structuredClone(DEFAULT_COMPANY_SETTINGS))).toEqual({ ok: true, settings: DEFAULT_COMPANY_SETTINGS });
    expect(DEFAULT_COMPANY_SETTINGS.decisions).toEqual([{ what: "setting.loosen", secondPerson: true }]);
    expect(DEFAULT_COMPANY_SETTINGS.start).toEqual({ allow: true, maxEstimateUsdMicros: null });
    expect(DEFAULT_COMPANY_SETTINGS.freshSignInSeconds).toBe(600);
  });

  it("reads a full document, folding instructions", () => {
    const settings = {
      ...base(), featureGates: { slack: true, auto_merge: false }, websiteCeiling: { mode: "listed", hosts: ["github.com", "*.npmjs.org"] },
      instructions: [{ text: "  Use​  British\tEnglish  ", priority: "preferred" }], evalBudgetUsdMicros: 5_000_000, freshSignInSeconds: 120,
      start: { allow: true, maxEstimateUsdMicros: 3_000_000 }, decisions: [{ what: "setting.*", deciders: ["dev_1", "dev_2"], signInMaxAgeSeconds: 300 }, { what: "merge", minApprovers: 2 }],
      locks: { real_check: "their_ci_fix", ci_fix_rounds: 2, extra_review: true, model_budget_usd: null }, budgets: { companyMonthlyUsdMicros: 100_000_000, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: 10, taskUsdMicros: 0 },
    };
    const read = validateCompanySettings(settings);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.settings.instructions).toEqual([{ text: "Use British English", priority: "preferred" }]);
  });

  const SECRET = "SECRET-VALUE-xyz";
  const refusals: Array<[string, (s: Record<string, unknown>) => unknown]> = [
    ["not an object", () => [SECRET]],
    ["an unknown field", (s) => ({ ...s, companyId: SECRET })],
    ["a missing field", (s) => { const rest = { ...s }; delete rest["locks"]; return rest; }],
    ["a gate name with capitals", (s) => ({ ...s, featureGates: { [SECRET]: true } })],
    ["a gate value not a boolean", (s) => ({ ...s, featureGates: { slack: SECRET } })],
    ["too many gates", (s) => ({ ...s, featureGates: Object.fromEntries(Array.from({ length: COMPANY_SETTINGS_LIMITS.featureGatesMax + 1 }, (_, i) => [`g${String(i)}`, true])) })],
    ["a bad host", (s) => ({ ...s, websiteCeiling: { mode: "listed", hosts: [SECRET] } })],
    ["a repeated host", (s) => ({ ...s, websiteCeiling: { mode: "listed", hosts: ["a.com", "a.com"] } })],
    ["an unknown ceiling mode", (s) => ({ ...s, websiteCeiling: { mode: SECRET } })],
    ["extra ceiling keys", (s) => ({ ...s, websiteCeiling: { mode: "any", hosts: [] } })],
    ["too many hosts", (s) => ({ ...s, websiteCeiling: { mode: "listed", hosts: Array.from({ length: 51 }, (_, i) => `h${String(i)}.com`) } })],
    ["an empty instruction", (s) => ({ ...s, instructions: [{ text: " ​ ", priority: "required" }] })],
    ["a long instruction", (s) => ({ ...s, instructions: [{ text: "x".repeat(601), priority: "required" }] })],
    ["a huge instruction", (s) => ({ ...s, instructions: [{ text: SECRET.repeat(100_000), priority: "required" }] })],
    ["too much instruction text in all", (s) => ({ ...s, instructions: Array.from({ length: 21 }, () => ({ text: "y".repeat(600), priority: "preferred" })) })],
    ["an unknown priority", (s) => ({ ...s, instructions: [{ text: "a", priority: SECRET }] })],
    ["too many instructions", (s) => ({ ...s, instructions: Array.from({ length: 31 }, () => ({ text: "a", priority: "preferred" })) })],
    ["a fractional eval budget", (s) => ({ ...s, evalBudgetUsdMicros: 1.5 })],
    ["a negative eval budget", (s) => ({ ...s, evalBudgetUsdMicros: -1 })],
    ["a step-up window over Code's", (s) => ({ ...s, freshSignInSeconds: 601 })],
    ["a step-up window under a minute", (s) => ({ ...s, freshSignInSeconds: 59 })],
    ["start without allow", (s) => ({ ...s, start: { maxEstimateUsdMicros: null } })],
    ["a decision rule with an unknown key", (s) => ({ ...s, decisions: [{ what: "merge", [SECRET]: 1 }] })],
    ["a decision rule with a bad kind", (s) => ({ ...s, decisions: [{ what: SECRET }] })],
    ["a decision rule asking 11 approvers", (s) => ({ ...s, decisions: [{ what: "merge", minApprovers: 11 }] })],
    ["empty deciders", (s) => ({ ...s, decisions: [{ what: "merge", deciders: [] }] })],
    ["a rule freezing settings (allow false)", (s) => ({ ...s, decisions: [{ what: "setting.*", allow: false }] })],
    ["a rule freezing settings (three approvers)", (s) => ({ ...s, decisions: [{ what: "setting.change", minApprovers: 3 }] })],
    ["a rule freezing every settings change (setting.change allow false)", (s) => ({ ...s, decisions: [{ what: "setting.change", allow: false }] })],
    ["a rule on every settings change asking a step-up in the same second", (s) => ({ ...s, decisions: [{ what: "setting.*", signInMaxAgeSeconds: 0 }] })],
    ["a prefix rule handing settings to one decider", (s) => ({ ...s, decisions: [{ what: "setting.*", deciders: ["dev_1"] }] })],
    ["a rule handing settings to one decider", (s) => ({ ...s, decisions: [{ what: "setting.change", deciders: ["dev_1"] }] })],
    ["a lock Code doesn't have", (s) => ({ ...s, locks: { [SECRET.toLowerCase()]: 1 } })],
    ["Code's preset lock, which Code refuses in an answer", (s) => ({ ...s, locks: { preset_level: "careful" } })],
    ["a lock value out of range", (s) => ({ ...s, locks: { ci_fix_rounds: 4 } })],
    ["a lock value of the wrong kind", (s) => ({ ...s, locks: { real_check: SECRET } })],
    ["a budget field missing", (s) => ({ ...s, budgets: { companyMonthlyUsdMicros: null } })],
    ["a budget over the most", (s) => ({ ...s, budgets: { ...(s["budgets"] as object), taskUsdMicros: 1_000_000_000_001 } })],
  ];
  for (const [name, make] of refusals) {
    it(`refuses ${name}, in fixed words`, () => {
      const read = validateCompanySettings(make(base() as unknown as Record<string, unknown>));
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.problem).not.toContain(SECRET);
        expect(read.problem).not.toContain(SECRET.toLowerCase());
      }
    });
  }

  it("lets a company forbid loosening its settings (a ratchet), which never freezes them", () => {
    for (const rule of [{ what: "setting.loosen", allow: false }, { what: "setting.loosen", minApprovers: 3 }, { what: "setting.loosen", deciders: ["dev_1"] }, { what: "setting.change", signInMaxAgeSeconds: 60 }]) {
      const read = validateCompanySettings({ ...base(), decisions: [rule] });
      expect(read.ok).toBe(true);
    }
  });

  it("refuses an object that isn't plain (a class instance, a null prototype)", () => {
    expect(validateCompanySettings(Object.assign(Object.create(null) as object, base())).ok).toBe(false);
    expect(validateCompanySettings({ ...base(), featureGates: Object.assign(Object.create(null) as object, { a: true }) }).ok).toBe(false);
  });
});

describe("loosens", () => {
  it("counts no change, and every stricter change, as not loosening", () => {
    const current = withPart({
      featureGates: { slack: true }, websiteCeiling: { mode: "listed", hosts: ["a.com", "b.com"] }, evalBudgetUsdMicros: 10, freshSignInSeconds: 300,
      start: { allow: true, maxEstimateUsdMicros: 100 }, budgets: { companyMonthlyUsdMicros: 100, memberMonthlyUsdMicros: null, projectMonthlyUsdMicros: 50, taskUsdMicros: 5 },
    });
    expect(loosens(current, structuredClone(current))).toBe(false);
    expect(loosens(current, { ...current, featureGates: { slack: false, newgate: false } })).toBe(false);
    expect(loosens(current, { ...current, websiteCeiling: { mode: "listed", hosts: ["a.com"] } })).toBe(false);
    expect(loosens(current, { ...current, evalBudgetUsdMicros: 5, freshSignInSeconds: 120, start: { allow: false, maxEstimateUsdMicros: 50 } })).toBe(false);
    expect(loosens(current, { ...current, decisions: [...current.decisions, { what: "merge", minApprovers: 2 }] })).toBe(false);
    expect(loosens(current, { ...current, budgets: { companyMonthlyUsdMicros: 10, memberMonthlyUsdMicros: 1, projectMonthlyUsdMicros: 50, taskUsdMicros: 0 } })).toBe(false);
    expect(loosens(base(), withPart({ websiteCeiling: { mode: "listed", hosts: [] } }))).toBe(false);
  });

  const current = withPart({
    featureGates: { slack: false, beta: true }, websiteCeiling: { mode: "listed", hosts: ["a.com"] }, instructions: [{ text: "Be careful", priority: "required" }],
    evalBudgetUsdMicros: 10, freshSignInSeconds: 120, start: { allow: false, maxEstimateUsdMicros: 100 }, locks: { extra_review: true },
    budgets: { companyMonthlyUsdMicros: 100, memberMonthlyUsdMicros: 100, projectMonthlyUsdMicros: 100, taskUsdMicros: 100 },
  });
  const looser: Array<[string, Partial<CompanySettings>]> = [
    ["a gate turned on", { featureGates: { slack: true, beta: true } }],
    ["a gate removed", { featureGates: { beta: true } }],
    ["a new gate turned on", { featureGates: { slack: false, beta: true, other: true } }],
    ["a ceiling host added", { websiteCeiling: { mode: "listed", hosts: ["a.com", "b.com"] } }],
    ["the ceiling lifted", { websiteCeiling: { mode: "any" } }],
    ["an instruction changed", { instructions: [{ text: "Be careful.", priority: "required" }] }],
    ["an instruction added", { instructions: [{ text: "Be careful", priority: "required" }, { text: "More", priority: "required" }] }],
    ["the eval budget raised", { evalBudgetUsdMicros: 11 }],
    ["the eval budget removed", { evalBudgetUsdMicros: null }],
    ["a longer step-up window", { freshSignInSeconds: 121 }],
    ["starts allowed", { start: { allow: true, maxEstimateUsdMicros: 100 } }],
    ["the start estimate cap raised", { start: { allow: false, maxEstimateUsdMicros: 101 } }],
    ["the start estimate cap removed", { start: { allow: false, maxEstimateUsdMicros: null } }],
    ["the second-person rule removed", { decisions: [] }],
    ["a decision rule changed", { decisions: [{ what: "setting.loosen", secondPerson: false }] }],
    ["a rule on settings changes added", { decisions: [...current.decisions, { what: "setting.*", deciders: ["dev_1", "dev_2"] }] }],
    ["a stricter-looking rule on loosening added", { decisions: [...current.decisions, { what: "setting.loosen", minApprovers: 2 }] }],
    ["a lock changed", { locks: { extra_review: false } }],
    ["a lock added", { locks: { extra_review: true, ci_fix_rounds: 0 } }],
    ["a company cap raised", { budgets: { ...current.budgets, companyMonthlyUsdMicros: 101 } }],
    ["a member cap removed", { budgets: { ...current.budgets, memberMonthlyUsdMicros: null } }],
    ["a project cap raised", { budgets: { ...current.budgets, projectMonthlyUsdMicros: 101 } }],
    ["a task cap raised", { budgets: { ...current.budgets, taskUsdMicros: 101 } }],
  ];
  for (const [name, part] of looser) it(`counts ${name} as loosening`, () => { expect(loosens(current, { ...current, ...part })).toBe(true); });
});

describe("what the hook answers from, and the settings decision", () => {
  it("maps the settings to the hook's rules", () => {
    const settings = withPart({ start: { allow: false, maxEstimateUsdMicros: 7 }, decisions: [{ what: "merge", deciders: ["a"] }], locks: { extra_review: true } });
    expect(hookRulesOf(settings)).toEqual({ start: { allow: false, maxEstimateUsdMicros: 7 }, decisions: [{ what: "merge", deciders: ["a"] }], locks: { extra_review: true } });
    expect(hookRulesOf(base()).start).toEqual({ allow: true });
    expect(answerFor("decide", { what: "setting.loosen", stage: "requirement" }, hookRulesOf(base()))).toMatchObject({ allow: true, secondPerson: true });
  });

  it("asks for a second admin to loosen under the defaults, not to tighten", () => {
    expect(settingsDecision(base(), true, "requirement", "dev")).toEqual({ allow: true, secondPerson: true, signInMaxAgeSeconds: 600 });
    expect(settingsDecision(base(), false, "verdict", "dev")).toEqual({ allow: true, secondPerson: false, signInMaxAgeSeconds: 600 });
  });

  it("follows the company's own rules: a shorter window, deciders, a refusal, two approvals, more than two", () => {
    const short = withPart({ freshSignInSeconds: 120, decisions: [{ what: "setting.*", signInMaxAgeSeconds: 90 }] });
    expect(settingsDecision(short, false, "verdict", "dev")).toEqual({ allow: true, secondPerson: false, signInMaxAgeSeconds: 90 });
    expect(settingsDecision(withPart({ freshSignInSeconds: 120 }), false, "verdict", "dev")).toMatchObject({ signInMaxAgeSeconds: 120 });
    const deciders = withPart({ decisions: [{ what: "setting.change", deciders: ["boss"] }] });
    expect(settingsDecision(deciders, false, "verdict", "dev")).toEqual({ allow: false });
    expect(settingsDecision(deciders, false, "verdict", "boss")).toMatchObject({ allow: true });
    expect(settingsDecision(withPart({ decisions: [{ what: "setting.loosen", allow: false }] }), true, "requirement", "dev")).toEqual({ allow: false });
    expect(settingsDecision(withPart({ decisions: [{ what: "setting.change", minApprovers: 2 }] }), false, "requirement", "dev")).toMatchObject({ allow: true, secondPerson: true });
    expect(settingsDecision(withPart({ decisions: [{ what: "setting.change", minApprovers: 3 }] }), false, "requirement", "dev")).toEqual({ allow: false });
  });
});

describe("Code's step-up claims", () => {
  it("reads a step-up Code put in the token, by each of Code's own factors", () => {
    for (const method of ["email_code", "passkey", "company_reauth"]) expect(stepUpClaim(token({ sub: "x", step_up_at: NOW_S - 10, step_up_amr: method }))).toEqual({ at: NOW_S - 10, method });
  });

  it("reads nothing from a token without one, or with one that does not read", () => {
    const cases = [
      token({ sub: "x" }), token({ step_up_at: NOW_S }), token({ step_up_amr: "passkey" }), token({ step_up_at: NOW_S, step_up_amr: "slack" }),
      token({ step_up_at: String(NOW_S), step_up_amr: "passkey" }), token({ step_up_at: NOW_S + 0.5, step_up_amr: "passkey" }), token({ step_up_at: 0, step_up_amr: "passkey" }),
      token({ step_up_at: 9e12, step_up_amr: "passkey" }), "opaque-token", "a.b", `${b64({})}.!!!.sig`, `${b64({})}.${Buffer.from("not json").toString("base64url")}.sig`, `${b64({})}.${b64([1])}.sig`,
    ];
    for (const each of cases) expect(stepUpClaim(each)).toBeUndefined();
  });

  it("is fresh inside the window, never past Code's own window, and not from the future", () => {
    const at = (age: number) => token({ step_up_at: NOW_S - age, step_up_amr: "passkey" });
    expect(freshStepUp(at(600), NOW, 600)).toBeDefined();
    expect(freshStepUp(at(601), NOW, 600)).toBeUndefined();
    expect(freshStepUp(at(601), NOW, 10_000)).toBeUndefined();
    expect(STEP_UP_WINDOW_SECONDS).toBe(600);
    expect(freshStepUp(at(120), NOW, 120)).toBeDefined();
    expect(freshStepUp(at(121), NOW, 120)).toBeUndefined();
    expect(freshStepUp(at(-30), NOW, 600)).toBeDefined();
    expect(freshStepUp(at(-31), NOW, 600)).toBeUndefined();
    expect(freshStepUp(at(0), NOW, -1)).toBeUndefined();
    expect(freshStepUp(at(0), NOW, 1.5)).toBeUndefined();
  });
});
