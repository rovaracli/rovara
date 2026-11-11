// Company rules (lane exp/company-rules): the pure parts of the page, to the exact boundary: the limits and counts, the comparison of two lists, the preview of the block, and the wording copied from the contract.
import { describe, expect, it } from "vitest";
import { STANDING_INSTRUCTIONS_WORDING, COMPANY_RULE_LIMITS } from "@agentx/contracts";
import { COMPANY_RULES_APP_LIMITS } from "@agentx/contracts/web";
import { buildStandingInstructions } from "../../packages/broker/src/instructions/standing-block.js";
import { BLOCK_WORDING, canMove, characterCount, checkRules, changeKind, diffRules, draftFrom, foldRuleText, moveRule, numbered, previewBlock, sameRules, setPriority, summaryWords, toDiff, toRule, addRule, deleteRule, type DraftRule } from "../../packages/ui/src/screens/admin/company-rules/rules-logic.js";
import { RULES_14 } from "./support/company-rules-fixture.js";

const draft = (texts: string[], priority: DraftRule["priority"] = "required"): DraftRule[] => texts.map((text, index) => ({ id: "r" + String(index), text, priority }));
let counter = 0;
const id = () => "id" + String(counter++);

describe("limits and counts", () => {
 it("the page's limits are the contract's limits", () => { expect(COMPANY_RULES_APP_LIMITS).toEqual(COMPANY_RULE_LIMITS); });
 it("30 rules are allowed and 31 are refused with the size budget sentence", () => {
  expect(checkRules(draft(Array.from({ length: 30 }, () => "a"))).problems).toEqual([]);
  expect(checkRules(draft(Array.from({ length: 31 }, () => "a"))).problems).toEqual(["Company rules exceed the size budget: 31 rules, at most 30. Delete some rules."]);
 });
 it("600 characters are allowed in one rule and 601 are refused, naming the rule and the count", () => {
  expect(checkRules(draft(["x".repeat(600)])).problems).toEqual([]);
  const over = checkRules(draft(["short", "x".repeat(601)]));
  expect(over.problems).toEqual(["Company rules exceed the size budget: rule 2 has 601 characters, at most 600. Shorten it."]);
  expect(over.rules[1]!.problem).toBe("This rule has 601 characters, at most 600.");
  expect(over.rules[0]!.problem).toBeUndefined();
 });
 it("12,000 characters in all are allowed and 12,001 are refused", () => {
  const twenty = (last: number) => draft([...Array.from({ length: 19 }, () => "y".repeat(600)), "z".repeat(last)]); // 19 * 600 = 11,400
  expect(checkRules(twenty(600)).total).toBe(12_000);
  expect(checkRules(twenty(600)).problems).toEqual([]);
  expect(checkRules(twenty(601)).problems).toEqual(["Company rules exceed the size budget: rule 20 has 601 characters, at most 600. Shorten it.", "Company rules exceed the size budget: 12001 characters in all, at most 12000. Shorten the rules."]);
  const spread = draft(Array.from({ length: 21 }, (_, index) => "w".repeat(index < 20 ? 571 : 581))); // 20*571 + 581 = 12,001, no rule over 600
  expect(checkRules(spread).total).toBe(12_001);
  expect(checkRules(spread).problems).toEqual(["Company rules exceed the size budget: 12001 characters in all, at most 12000. Shorten the rules."]);
  expect(checkRules(draft([...Array.from({ length: 20 }, () => "w".repeat(571)), "w".repeat(580)])).problems).toEqual([]);
 });
 it("counts what the server counts: white space folds to one space, hidden characters are dropped, code points are one each", () => {
  expect(foldRuleText("  a \n\n b\t\tc​‮  ")).toBe("a b c");
  expect(characterCount("a   b")).toBe(3);
  expect(characterCount("\u{1F600}".repeat(600))).toBe(600);
  expect(checkRules(draft(["\u{1F600}".repeat(600)])).problems).toEqual([]);
  expect(checkRules(draft(["x ".repeat(300).trim() + "    ".repeat(50)])).rules[0]!.length).toBe(599);
 });
 it("an empty rule and an empty list are refused with their own sentences", () => {
  expect(checkRules(draft(["ok", "  \n "])).problems).toEqual(["Rule 2 is empty. Write it or delete it."]);
  expect(checkRules([]).problems).toEqual(["Add at least one rule to propose a change."]);
  expect(checkRules(draft(["x".repeat(30)]), { maxRules: 30, maxRuleCharacters: 20, maxTotalCharacters: 100 }).problems[0]).toContain("at most 20");
 });
 it("the 14 approved rules fit, with room", () => {
  const check = checkRules(RULES_14);
  expect(check.problems).toEqual([]);
  expect(check.count).toBe(14);
  expect(check.total).toBeGreaterThan(2000);
  expect(check.total).toBeLessThan(3000);
 });
 it("nothing changed means the same rules after folding", () => {
  expect(sameRules(RULES_14, RULES_14.map(rule => ({ ...rule, text: "  " + rule.text.replace(/ /gu, "  ") })))).toBe(true);
  expect(sameRules(RULES_14, [...RULES_14].reverse())).toBe(false);
  expect(sameRules(RULES_14, RULES_14.map((rule, index) => (index === 0 ? { ...rule, priority: "preferred" as const } : rule)))).toBe(false);
 });
});

describe("editing a draft", () => {
 it("keeps Required before Preferred; moves stay inside a list; switching sends a rule to the end of the other list", () => {
  let rules = draftFrom(RULES_14, id);
  expect(rules.map(rule => rule.priority).join("")).toBe("required".repeat(7) + "preferred".repeat(7));
  const firstPreferred = rules[7]!.id, lastRequired = rules[6]!.id;
  expect(canMove(rules, lastRequired, 1)).toBe(false);
  expect(canMove(rules, firstPreferred, -1)).toBe(false);
  expect(moveRule(rules, lastRequired, 1)).toBe(rules);
  const before = rules.map(rule => rule.id);
  rules = moveRule(rules, rules[1]!.id, -1);
  expect(rules.map(rule => rule.id).slice(0, 2)).toEqual([before[1], before[0]]);
  rules = setPriority(rules, rules[0]!.id, "preferred");
  expect(rules.at(-1)!.id).toBe(before[1]);
  expect(rules.filter(rule => rule.priority === "required")).toHaveLength(6);
  rules = addRule(rules, "required", "new");
  expect(rules[6]!.id).toBe("new");
  expect(deleteRule(rules, "new")).toHaveLength(14);
 });
 it("numbers Preferred rules on from Required, 1 to N", () => {
  const groups = numbered(RULES_14);
  expect(groups.required.map(item => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(groups.preferred.map(item => item.number)).toEqual([8, 9, 10, 11, 12, 13, 14]);
 });
});

describe("the difference between two lists", () => {
 const a = (text: string, priority: "required" | "preferred" = "required") => ({ text, priority });
 it("names added, removed, changed and priority changed, in the order of the new list", () => {
  const before = [a("one"), a("two"), a("three"), a("four", "preferred")], after = [a("one"), a("two changed"), a("four", "required")];
  const diff = diffRules(before, after);
  expect(diff.entries.map(entry => entry.kind + ":" + ("after" in entry ? entry.after.text : entry.before.text))).toEqual(["same:one", "removed:three", "changed:two changed", "changed:four"]);
  expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 2, unchanged: 1 });
  expect(diffRules([a("one")], [a("one"), a("five")]).entries.map(entry => entry.kind)).toEqual(["same", "added"]);
  expect(diff.entries.map(changeKind)).toEqual(["same", "removed", "changed", "priority"]);
  expect(summaryWords(diff.summary, 1)).toBe("0 added, 1 removed, 1 changed, 1 priority changed, 1 unchanged");
 });
 it("an unchanged list is all same; an empty before makes everything added", () => {
  expect(diffRules(RULES_14, RULES_14).summary).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 14 });
  expect(diffRules([], RULES_14).summary).toEqual({ added: 14, removed: 0, changed: 0, unchanged: 0 });
  expect(diffRules(RULES_14, []).summary).toEqual({ added: 0, removed: 14, changed: 0, unchanged: 0 });
 });
 it("a server comparison with an entry kind this page does not know shows the rest, and an unknown priority is shown as Preferred", () => {
  const diff = toDiff({ summary: { added: 0, removed: 0, changed: 0, unchanged: 1 }, entries: [{ kind: "same", after: { text: "x", priority: "unknown" } } as { kind: string }, { kind: "unknown", whatever: 1 } as { kind: string }] });
  expect(diff.entries).toEqual([{ kind: "same", after: { text: "x", priority: "preferred" } }]);
  expect(toRule({ text: "y", priority: "required" }).priority).toBe("required");
 });
});

describe("the preview of the block", () => {
 it("copies the contract's wording", () => {
  const { header, company, required, preferred, closingStart, closingEnd } = STANDING_INSTRUCTIONS_WORDING;
  expect(BLOCK_WORDING).toEqual({ header, company, required, preferred, closingStart, closingEnd });
 });
 it("is the company part of the block the broker builds, word for word, apart from the closing code", () => {
  const built = buildStandingInstructions({ company: { version: "1", rules: RULES_14 } })!.text;
  const preview = previewBlock(RULES_14)!;
  const normalize = (text: string) => text.replace(/End of standing instructions [^.]*\./u, "End of standing instructions CODE.");
  expect(normalize(preview)).toBe(normalize(built));
 });
 it("folds white space, escapes angle brackets and groups Required before Preferred whatever the order", () => {
  const preview = previewBlock([{ text: "later  <b>one</b>\n\nline", priority: "preferred" }, { text: "first", priority: "required" }])!;
  expect(preview).toContain("Required (never break these):\n- first\nPreferred (follow these unless the task cannot be done that way, and say so when you do not):\n- later &lt;b&gt;one&lt;/b&gt; line");
  const built = buildStandingInstructions({ company: { version: "1", rules: [{ text: "later  <b>one</b>\n\nline", priority: "preferred" }, { text: "first", priority: "required" }] } })!.text;
  expect(built).toContain("- later &lt;b&gt;one&lt;/b&gt; line");
 });
 it("is nothing when there are no rules, and leaves out an empty Preferred list", () => {
  expect(previewBlock([])).toBeUndefined();
  expect(previewBlock([{ text: "  ", priority: "required" }])).toBeUndefined();
  expect(previewBlock([{ text: "only", priority: "required" }])).not.toContain("Preferred (");
 });
});
