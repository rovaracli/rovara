// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LOOK_COLORS, LOOK_DENSITY, LOOK_TEXT_PAIRS, LOOK_UI_PAIRS, TOKENS, contrastRatio, lookV2Css, tokensCss } from "../../packages/design-tokens/src/index.js";
import { ThemeProvider, useTheme } from "../../packages/ui/src/theme.js";
import { Chip } from "../../packages/ui/src/design/Chip.js";
import { DENSITY_STORAGE_KEY, LOOK_STORAGE_KEY, isNewLookOn, readDensity } from "../../packages/ui/src/look.js";
import { h } from "./support/h.js";
function host(initial: Record<string, string> = {}) { const values = new Map(Object.entries(initial));return { storage: { get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } }, values }; }
afterEach(() => { cleanup(); for (const attribute of ["data-look", "data-density", "data-theme"]) document.documentElement.removeAttribute(attribute); });
describe("v2 look tokens", () => {
 for (const theme of ["light", "dark"] as const) {
  it(`${theme}: every text pair reaches 4.5:1 and every interface part 3:1`, () => {
   for (const [front, back] of LOOK_TEXT_PAIRS) expect(contrastRatio(LOOK_COLORS[theme][front], LOOK_COLORS[theme][back]), `${front} on ${back}`).toBeGreaterThanOrEqual(4.5);
   for (const [front, back] of LOOK_UI_PAIRS) expect(contrastRatio(LOOK_COLORS[theme][front], LOOK_COLORS[theme][back]), `${front} on ${back}`).toBeGreaterThanOrEqual(3);
  });
 }
 it("uses the same token names in both themes, keeps every existing name, and one accent hue", () => {
  expect(Object.keys(LOOK_COLORS.light)).toEqual(Object.keys(LOOK_COLORS.dark));
  for (const key of Object.keys(TOKENS.light)) expect(Object.keys(LOOK_COLORS.light)).toContain(key);
  expect(LOOK_COLORS.light.statusFailed).toBe(LOOK_COLORS.light.danger);
  expect(LOOK_COLORS.dark.statusFailed).toBe(LOOK_COLORS.dark.danger);
  const hue = (hex: string) => { const [r, g, b] = [1, 3, 5].map(o => parseInt(hex.slice(o, o + 2), 16) / 255) as [number, number, number];const max = Math.max(r, g, b), min = Math.min(r, g, b);return max === r ? (60 * ((g - b) / (max - min)) + 360) % 360 : max === g ? 60 * (2 + (b - r) / (max - min)) : 60 * (4 + (r - g) / (max - min)); };
  expect(Math.abs(hue(LOOK_COLORS.light.accent) - hue(LOOK_COLORS.dark.accent))).toBeLessThan(6);
 });
 it("scopes every rule to data-look=v2 and leaves the base token sheet untouched", () => {
  const css = lookV2Css();
  expect(tokensCss()).not.toContain("data-look");
  const selectors = css.split("}").map(rule => rule.replace(/^@media[^{]*\{/, "").split("{")[0]!.trim()).filter(selector => selector.length > 0);
  expect(selectors.length).toBeGreaterThan(5);
  for (const selector of selectors) expect(selector, selector).toContain(':root[data-look="v2"]');
  expect(css).toContain('[data-density="compact"]');
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("pointer: coarse");
  expect(LOOK_DENSITY.comfortable.controlH).toBeGreaterThan(LOOK_DENSITY.compact.controlH);
 });
});
describe("v2 look switch", () => {
 it("is off unless the stored value is exactly v2, and density defaults to comfortable", () => {
  expect(isNewLookOn(host())).toBe(false);
  expect(isNewLookOn(host({ [LOOK_STORAGE_KEY]: "V2" }))).toBe(false);
  expect(isNewLookOn(host({ [LOOK_STORAGE_KEY]: "v2" }))).toBe(true);
  expect(isNewLookOn({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe(false);
  expect(readDensity(host())).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "toString" }))).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "compact" }))).toBe("compact");
 });
 it("puts no look or density attribute on the page while off", () => {
  render(h(ThemeProvider, { host: host({ [DENSITY_STORAGE_KEY]: "compact" }), children: h("p", null, "x") }));
  expect(document.documentElement.hasAttribute("data-look")).toBe(false);
  expect(document.documentElement.hasAttribute("data-density")).toBe(false);
 });
 it("turns the attributes on, and stores density separately from the theme, when switched on", async () => {
  const f = host({ [LOOK_STORAGE_KEY]: "v2", "rovara.theme": "dark" });
  function Probe() { const theme = useTheme();return h("button", { type: "button", onClick: () => theme.setDensity("compact") }, `${theme.preference}/${theme.density}`); }
  render(h(ThemeProvider, { host: f, children: h(Probe) }));
  expect(document.documentElement.getAttribute("data-look")).toBe("v2");
  expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  await userEvent.click(screen.getByRole("button", { name: "dark/comfortable" }));
  expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(f.values.get(DENSITY_STORAGE_KEY)).toBe("compact");
  expect(f.values.get("rovara.theme")).toBe("dark");
 });
});
describe("Chip", () => {
 it("shows words and a decorative icon for the company lock and the outside change", () => {
  const { container } = render(h("div", null, h(Chip, { kind: "company-lock" }, "Company lock"), h(Chip, { kind: "outside-change" }, "Changed outside Rovara"), h(Chip, null, "Project default")));
  expect(screen.getByText("Company lock").className).toContain("rv-chip-company-lock");
  expect(screen.getByText("Changed outside Rovara").className).toContain("rv-chip-outside-change");
  expect(container.querySelectorAll("svg[aria-hidden='true']").length).toBe(2);
  expect(screen.getByText("Project default").querySelector("svg")).toBeNull();
 });
});
