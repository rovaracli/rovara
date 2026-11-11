import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookV2Css, tokensCss } from "../../packages/design-tokens/src/index.js";
import { readCssRules, resolveFallbacks, type CssRule } from "./support/css-rules.js";
// "Look off = unchanged", pinned. The base sheets (as they were before the v2 look was added, commit ba3e33415) are kept in tests/web/fixtures/look-off-base/.
// Every token the v2 look introduced is read with `var(--rv-new-token, fallback)`; replacing each such wrapper by its fallback must give back the base values.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const names = (css: string) => new Set([...css.matchAll(/(--rv-[a-z0-9-]+):/gu)].map(match => match[1]!));
const baseNames = names(tokensCss());
const NEW_TOKENS: ReadonlySet<string> = new Set([...names(lookV2Css())].filter(name => !baseNames.has(name)));
const SHEETS = [
 { name: "design.css", current: "../../packages/ui/src/design/design.css", base: "./fixtures/look-off-base/design.base.css" },
 { name: "shell.css", current: "../../packages/ui/src/shell/shell.css", base: "./fixtures/look-off-base/shell.base.css" },
 { name: "home.css", current: "../../packages/ui/src/screens/home/home.css", base: "./fixtures/look-off-base/home.base.css" },
] as const;
const key = (rule: CssRule) => `${rule.context}|${rule.selector}`;
/** Later declarations of the same property win, as in the cascade (rules with the same selector in one sheet have equal specificity). */
function merged(rules: CssRule[], resolve: boolean): Map<string, Map<string, string>> {
 const result = new Map<string, Map<string, string>>();
 for (const rule of rules) {
  const target = result.get(key(rule)) ?? new Map<string, string>();
  for (const [property, value] of rule.declarations) target.set(property, resolve ? resolveFallbacks(value, NEW_TOKENS) : value);
  result.set(key(rule), target);
 }
 return result;
}
/** Declarations the v2 work ADDED to an existing rule, each equal to the property's initial value in that rule (so no computed style changes while off). */
const ADDED_DECLARATIONS: Record<string, string> = {
 ".rv-surface|box-shadow": "none", ".rv-toast|box-shadow": "none", ".rv-decision|box-shadow": "none",
 ".rv-banner|border-radius": "0",
 ".rv-theme-options label|min-height": "0",
 // The tinted banner backgrounds fall back to the plain banner's own background (var(--rv-bg-raised)) on the same element.
 ".rv-banner-warning|background": "var(--rv-bg-raised)", ".rv-banner-danger|background": "var(--rv-bg-raised)", ".rv-banner-success|background": "var(--rv-bg-raised)",
};
/**
 * Whole rules that exist only since the v2 work. `.rv-chip*` match no element while off (nothing renders a Chip yet), so any content is fine.
 * The other two match existing elements, so their content must be exactly what those elements already had.
 */
const NEW_RULES: Record<string, Record<string, string> | null> = {
 ".rv-chip": null, ".rv-chip svg": null, ".rv-chip-company-lock": null, ".rv-chip-outside-change": null,
 // New navigation (switch `rovara.nav`): each selector needs an element only the new navigation renders (.rv-nav-v2 on the shell, .rv-tabbar, .rv-nav-icon, .rv-projects-*; the toast rule needs .rv-tabbar on the page), so none matches anything while it is off.
 ".rv-nav-v2 .rv-nav-label": null, ".rv-nav-icon": null, ".rv-nav-v2 .rv-sidebar-primary": null, ".rv-tabbar": null, ".rv-tabbar a": null, ".rv-tabbar a[aria-current=page]": null, ".rv-tabbar .rv-nav-label": null, ".rv-tabbar .rv-nav-count": null,
 ".rv-projects-list": null, ".rv-projects-list a": null, ".rv-projects-list a:hover": null, ".rv-projects-name": null, ".rv-projects-counts": null,
 ":root .rv-app-shell.rv-nav-v2 .rv-shell-main": null, ":root:has(.rv-tabbar) .rv-toast": null,
 ".rv-banner-info": { background: "var(--rv-bg-raised)", "border-left-color": "var(--rv-accent)" }, // the plain banner's own values
 ".rv-button-primary:hover": { background: "var(--rv-accent)", "border-color": "var(--rv-accent)" }, // the primary button's own values
};
/** Same value, written differently once the new tokens are resolved. */
const EQUIVALENT: Record<string, [string, string]> = {
 ".rv-table th,.rv-table td|padding": ["var(--rv-space-3)", "var(--rv-space-3) var(--rv-space-3)"],
};
describe("the old look is unchanged while the v2 switch is off", () => {
 it("found the new tokens (a guard against reading nothing)", () => {
  for (const name of ["--rv-control-size", "--rv-density-card", "--rv-density-row-y", "--rv-density-gap", "--rv-bg-popover", "--rv-shadow-1", "--rv-accent-hover", "--rv-focus-offset"]) expect(NEW_TOKENS.has(name), name).toBe(true);
  expect(NEW_TOKENS.has("--rv-bg-raised")).toBe(false);
 });
 for (const sheet of SHEETS) {
  it(`${sheet.name}: every base value is still there once the new tokens fall back, and nothing else changed`, () => {
   const base = merged(readCssRules(read(sheet.base)), false), now = merged(readCssRules(read(sheet.current)), true);
   const problems: string[] = [];
   for (const [rule, declarations] of base) {
    const current = now.get(rule);
    if (current === undefined) { problems.push(`rule gone: ${rule}`);continue; }
    for (const [property, value] of declarations) {
     const have = current.get(property), equivalent = EQUIVALENT[`${rule.split("|")[1]!}|${property}`];
     if (have !== value && !(equivalent !== undefined && value === equivalent[0] && have === equivalent[1])) problems.push(`${rule} { ${property}: ${value} } is now ${String(have)}`);
    }
    for (const [property, value] of current) if (!declarations.has(property) && ADDED_DECLARATIONS[`${rule.split("|")[1]!}|${property}`] !== value) problems.push(`${rule}: new declaration ${property}: ${value}`);
   }
   for (const [rule, declarations] of now) {
    if (base.has(rule)) continue;
    const allowed = NEW_RULES[rule.split("|")[1]!];
    if (allowed === undefined) problems.push(`new rule: ${rule}`);
    else if (allowed !== null && JSON.stringify([...declarations].sort()) !== JSON.stringify(Object.entries(allowed).sort())) problems.push(`new rule changed: ${rule} ${JSON.stringify([...declarations])}`);
   }
   expect(problems).toEqual([]);
  });
 }
 it("look-v2.css (density for screen sections) is inert while off: every selector is under data-look=v2, it reads only defined tokens, and it leaves other lanes' screens alone", () => {
  const source = read("../../packages/ui/src/look-v2.css"), rules = readCssRules(source);
  expect(rules.length).toBeGreaterThan(30);
  for (const rule of rules) for (const selector of rule.selector.split(",")) expect(selector.trim(), selector).toMatch(/^:root\[data-look="v2"\] /u);
  const known = new Set([...names(tokensCss()), ...names(lookV2Css())]);
  for (const used of source.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/var\((--[a-z0-9-]+)/gu)) expect(known.has(used[1]!), used[1]).toBe(true);
  expect(source.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(/@import|rv-hww|rv-session|rv-agent|rv-plan|rv-entry|rv-onboarding-entry/u);
 });
 it("look-v2.css is copied into the package build (scripts/ui-copy-assets.mjs) and imported by the app", () => {
  expect(read("../../scripts/ui-copy-assets.mjs")).toContain('"look-v2.css"');
  expect(read("../../packages/ui/src/App.tsx")).toContain('import "./look-v2.css"');
  expect(read("../../packages/ui/src/index.ts")).toContain('import "./look-v2.css"');
 });
 it("the check itself bites: a changed fallback, an added declaration and a lost rule are all reported", () => {
  const base = merged(readCssRules(".a{min-height:44px;padding:8px}.b{color:red}"), false);
  const changed = merged(readCssRules(".a{min-height:var(--rv-control-size,40px);padding:8px;margin:0}"), true);
  expect(changed.get("|.a")?.get("min-height")).toBe("40px");
  expect(changed.get("|.a")?.get("min-height")).not.toBe(base.get("|.a")?.get("min-height"));
  expect(changed.get("|.a")?.has("margin")).toBe(true);
  expect(changed.has("|.b")).toBe(false);
 });
});
