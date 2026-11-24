// REPAIR-SENTENCE-DRIFT: the contract-drift check's text rules (scripts/contract-drift/text-rules.ts). Code train 22 changed the setup repair card's sentence while Cloud still matched the old one, and the
// schema comparison could not see it (a sentence is just a string). The rules read the sentences Code builds, and fail when a strict Cloud parser would refuse the current one.
import { describe, expect, it } from "vitest";
import { collectCodeText, PROBE_STEP, readPinnedText, TEXT_RULES, textDrifts, type TextRule } from "../../scripts/contract-drift/text-rules.js";
import * as repairRoutes from "../../packages/cloud-server/src/setup-repair-routes.js";
import { SETUP_REPAIR_CHANGED_MAX } from "../../packages/cloud-server/src/setup-repair-routes.js";
import { evaluateCodeExpression, flatten, Unreadable } from "../../scripts/contract-drift/text-eval.js";

const SOURCE = { repository: "PrepLabsAI/Rovara", ref: "fake", sha: "0".repeat(40) };
const ROWS = "packages/broker/src/core/setup-agent/recheck-rows.ts";
const OLD_TAIL = "Rovara cannot build on this project until it is fixed.";
const NEW_TAIL = "Work continues; results may be less reliable until setup is fixed.";

/** The Code text of the real files, with the constants a test wants changed, as a fake Code. */
const fakeCode = (tail: string | undefined, extra: Record<string, string> = {}) => (file: string): string | undefined => {
  if (file === ROWS) {
    return [
      tail === undefined ? "" : `export const SETUP_WORK_CONTINUES_TAIL = ${JSON.stringify(tail)};`,
      `export const setupRepairCardOf = (failedStep: string) => ({ title: "Setup needs repair", body: \`The project's setup stopped working after recent code changes (\${failedStep}). ${tail ?? OLD_TAIL}\` });`,
    ].join("\n");
  }
  return extra[file];
};
const cardRules: readonly TextRule[] = TEXT_RULES.filter((rule) => rule.id === "setup-repair-card-body");

describe("contract drift: text rules", () => {
  it("passes for the Code text pinned in the snapshot (Code train 22's sentence) and covers every rule value", () => {
    const pinned = readPinnedText();
    expect(pinned.source.sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(pinned.unreadable).toEqual({});
    expect(textDrifts(pinned)).toEqual([]);
    for (const rule of TEXT_RULES) for (const value of rule.values) if (value.optional !== true) expect(Object.keys(pinned.values).some((key) => key.startsWith(`${rule.id}/${value.label}`)), `${rule.id}/${value.label}`).toBe(true);
    expect(pinned.values["setup-repair-card-body/card-body"]).toBe(`The project's setup stopped working after recent code changes (${PROBE_STEP}). ${NEW_TAIL}`);
  });

  it("passes for both Code sentences Cloud knows: the old tail (before Code train 22) and the new one", () => {
    expect(textDrifts(collectCodeText(fakeCode(undefined), SOURCE, cardRules), cardRules)).toEqual([]);
    expect(textDrifts(collectCodeText(fakeCode(NEW_TAIL), SOURCE, cardRules), cardRules)).toEqual([]);
  });

  it("FAILS when Code changes the card's tail to words Cloud's strict parser does not take (a fake Code constant change)", () => {
    const failures = textDrifts(collectCodeText(fakeCode("Work goes on; results may be worse until setup is fixed."), SOURCE, cardRules), cardRules);
    expect(failures.map((line) => line.split(":")[0])).toEqual(["TEXT setup-repair-card-body/card-body", "TEXT setup-repair-card-body/tail"]);
    expect(failures[0]).toContain("Work goes on; results may be worse until setup is fixed.");
    expect(failures[0]).toContain("BODY_STEP");
  });

  it("FAILS when Code changes the wording around the step, not only the tail", () => {
    const read = (file: string) => (file === ROWS ? `export const setupRepairCardOf = (failedStep: string) => ({ body: \`Your project's setup broke (\${failedStep}). ${NEW_TAIL}\` });` : undefined);
    expect(textDrifts(collectCodeText(read, SOURCE, cardRules), cardRules)).toHaveLength(1);
  });

  it("FAILS for an equality rule when Code rewords a refusal Cloud matches exactly, and for a sentence the wiki whitelist lacks", () => {
    const memberRules = TEXT_RULES.filter((rule) => rule.id === "member-refusal-words");
    const member = "packages/broker/src/aws/company-member-routes.ts";
    const read = (own: string) => (file: string) => (file === member
      ? `import { MEMBER_ONLY_OWNER } from "./company-member-contract.js";\nexport const OWN_MEMBERSHIP = ${JSON.stringify(own)};\nexport const OWNER_ONLY = MEMBER_ONLY_OWNER;\nexport const NOT_FOUND = "not found";\nexport const NO_PENDING_HANDOVER = "this person has no hand-over waiting to be finished";\nexport const HANDOVER_IN_PROGRESS = "this removal is still being made; try again in a few minutes";`
      : file === "packages/broker/src/aws/company-member-contract.ts" ? `export const MEMBER_ONLY_OWNER = "only an owner can change or remove an owner";` : undefined);
    expect(textDrifts(collectCodeText(read("you cannot change your own role or remove yourself here"), SOURCE, memberRules), memberRules)).toEqual([]);
    const reworded = textDrifts(collectCodeText(read("you can not change your own role"), SOURCE, memberRules), memberRules);
    expect(reworded).toHaveLength(1);
    expect(reworded[0]).toContain("member-refusal-words/own-membership");

    const wikiRules = TEXT_RULES.filter((rule) => rule.id === "wiki-build-words");
    const wiki = "packages/contracts/src/wiki-build.ts";
    const added = textDrifts(collectCodeText((file) => (file === wiki ? `export const WIKI_BUILD_WORDS = { busy: "Rovara is already building this project's wiki.", fresh: "A brand new sentence." } as const;` : undefined), SOURCE, wikiRules), wikiRules);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("wiki-build-words/words.fresh");
  });

  it("FAILS loudly, naming the rule, when a Code refactor moves a constant out of the reader's reach, and when the pinned text lacks a value", () => {
    const gone = textDrifts(collectCodeText(() => undefined, SOURCE, cardRules), cardRules);
    expect(gone.some((line) => line.includes("card-body") && line.includes("could not be read"))).toBe(true);
    const pinned = readPinnedText();
    const values = Object.fromEntries(Object.entries(pinned.values).filter(([key]) => !key.startsWith("upkeep-consent-words/")));
    expect(textDrifts({ ...pinned, values }).filter((line) => line.includes("upkeep-consent-words")).length).toBe(2);
  });

  it("FAILS when Code's longest `changed` text (setupDriftWords of every class) is longer than the card parser's limit, and passes at the limit", () => {
    const rules = TEXT_RULES.filter((rule) => rule.id === "setup-repair-changed-words");
    const file = "packages/contracts/src/setup-snapshot.ts";
    // Ten class words; the joined text is sum(words) + 8 * 2 (", ") + 5 (" and ").
    const words = (total: number): string => {
      const first = "w".repeat(total - 21 - 9);
      const entries = Array.from({ length: 10 }, (_, index) => `c${String(index)}: ${JSON.stringify(index === 0 ? first : "w")}`);
      return `export const SETUP_WATCH_WORDS = Object.freeze({ ${entries.join(", ")} });`;
    };
    const at = (length: number): string[] => textDrifts(collectCodeText((name) => (name === file ? words(length) : undefined), SOURCE, rules), rules);
    expect(at(SETUP_REPAIR_CHANGED_MAX)).toEqual([]);
    const over = at(SETUP_REPAIR_CHANGED_MAX + 1);
    expect(over).toHaveLength(1);
    expect(over[0]).toContain(`${String(SETUP_REPAIR_CHANGED_MAX + 1)} characters`);
  });

  it("FAILS when Code rewords the card's action or title words", () => {
    const rules = TEXT_RULES.filter((rule) => rule.id === "setup-repair-card-words");
    const read = (fix: string) => (file: string): string | undefined => (file === ROWS ? `export const SETUP_REPAIR_WORDS = { title: "Setup needs repair", fixSetup: ${JSON.stringify(fix)}, approveNewSetup: "Approve new setup" } as const;` : undefined);
    expect(textDrifts(collectCodeText(read("Fix setup"), SOURCE, rules), rules)).toEqual([]);
    const failures = textDrifts(collectCodeText(read("Repair setup"), SOURCE, rules), rules);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("setup-repair-card-words/fixSetup");
  });

  // Needs the setup-agent repair parser (SETUP_AGENT_REPAIR_WORDS / SETUP_AGENT_FIX_LABEL), which arrives with the branch that fixes the repair card (5240628bb).
  const hasAgentParser = (repairRoutes as Record<string, unknown>)["SETUP_AGENT_REPAIR_WORDS"] !== undefined;
  it.skipIf(!hasAgentParser)("FAILS when Code rewords a setup-agent repair sentence or the Fix setup label's shape", () => {
    const rules = TEXT_RULES.filter((rule) => rule.id === "setup-agent-repair-words");
    const file = "packages/broker/src/core/setup-agent/repair-draft.ts";
    const pinned = readPinnedText();
    const real = (name: string): string => JSON.stringify(pinned.values[`setup-agent-repair-words/words.${name}`]);
    const words = (drafting: string): string => `{ drafting: ${drafting}, failed: { run_failed: ${real("failed.run_failed")}, no_usable_fix: ${real("failed.no_usable_fix")}, check_failed: ${real("failed.check_failed")}, upkeep_paused: ${real("failed.upkeep_paused")} }, withdrawn: ${real("withdrawn")} }`;
    const source = (drafting: string, label: string): string => `export const REPAIR_WORDS = ${words(drafting)};\nexport const fixSetupLabel = (cents: number): string => ${JSON.stringify(label)};`;
    const failures = (drafting: string, label: string): string[] => textDrifts(collectCodeText((name) => (name === file ? source(drafting, label) : undefined), SOURCE, rules), rules);
    expect(failures(real("drafting"), "Fix setup (uses your AI, up to $4)")).toEqual([]);
    expect(failures('"Rovara is working on a fix."', "Fix setup (uses your AI, up to $4)").some((line) => line.includes("words.drafting"))).toBe(true);
    expect(failures(real("drafting"), "Fix setup (free)").some((line) => line.includes("fix-label"))).toBe(true);
  });

  it("every Cloud strict parser it covers is registered with a Code file and an expression, once", () => {
    expect(new Set(TEXT_RULES.map((rule) => rule.id)).size).toBe(TEXT_RULES.length);
    for (const rule of TEXT_RULES) {
      expect(rule.codeFile, rule.id).toMatch(/^packages\/.+\.ts$/u);
      expect(rule.cloud, rule.id).toMatch(/packages\/cloud-server\/src\//u);
      expect(rule.values.length, rule.id).toBeGreaterThan(0);
    }
  });
});

describe("contract drift: reading Code's constants without running Code", () => {
  const files: Record<string, string> = {
    "a/one.ts": `import { SHARED, twice } from "./two.js";\nexport const LOCAL = "x" + "y";\nexport const WORDS = { a: LOCAL, b: \`\${SHARED}!\` } as const;\nexport const card = (step: string) => ({ body: \`(\${step}) \${twice(step)}\` });`,
    "a/two.ts": `export const SHARED = "shared";\nexport const twice = (s: string): string => { return s + s; };`,
  };
  const read = (file: string) => files[file];
  it("evaluates literals, templates, objects, imports and small functions", () => {
    expect(evaluateCodeExpression(read, "a/one.ts", "WORDS")).toEqual({ a: "xy", b: "shared!" });
    expect(flatten(evaluateCodeExpression(read, "a/one.ts", "WORDS"), "w")).toEqual({ "w.a": "xy", "w.b": "shared!" });
    expect(evaluateCodeExpression(read, "a/one.ts", `card("s").body`)).toBe("(s) ss");
  });
  it("evaluates the number formatting Code's labels use (remainder, division, conditional, toFixed, String, Object.freeze)", () => {
    const code: Record<string, string> = {
      "b/x.ts": "export const dollars = (c: number): string => `$${c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2)}`;\nexport const W = Object.freeze({ a: dollars(400), b: dollars(150) });",
    };
    expect(evaluateCodeExpression((file) => code[file], "b/x.ts", "W")).toEqual({ a: "$4", b: "$1.50" });
  });
  it("throws Unreadable for anything it does not follow, instead of guessing", () => {
    expect(() => evaluateCodeExpression(read, "a/one.ts", "Math.random()")).toThrow(Unreadable);
    expect(() => evaluateCodeExpression(read, "a/one.ts", "MISSING")).toThrow(Unreadable);
    expect(() => evaluateCodeExpression(read, "a/none.ts", "LOCAL")).toThrow(Unreadable);
    expect(() => flatten(evaluateCodeExpression(read, "a/one.ts", "card"), "c")).toThrow(Unreadable);
  });
});
