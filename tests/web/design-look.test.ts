// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LOOK_COLORS, LOOK_DENSITY, LOOK_EFFECTS, LOOK_SHAPE, LOOK_TEXT_PAIRS, LOOK_UI_PAIRS, TOKENS, contrastRatio, lookV2Css, tokensCss } from "../../packages/design-tokens/src/index.js";
import { ThemeProvider, useTheme } from "../../packages/ui/src/theme.js";
import { DENSITY_STORAGE_KEY, readDensity } from "../../packages/ui/src/look.js";
import { h } from "./support/h.js";
function host(initial: Record<string, string> = {}) { const values = new Map(Object.entries(initial));return { storage: { get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } }, values }; }
afterEach(() => { cleanup(); for (const attribute of ["data-look", "data-density", "data-theme"]) document.documentElement.removeAttribute(attribute); });
const kebab = (key: string) => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const ROOT = ':root[data-look="v2"]';
/** Every `selector{declarations}` rule in a sheet (a rule inside @media is read on its own), as selector -> { --name: value }. */
function rules(css: string): Map<string, Record<string, string>> {
 const out = new Map<string, Record<string, string>>();
 for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const declared: Record<string, string> = out.get(selector!.trim()) ?? {};
  for (const part of body!.split(/;(?![^(]*\))/)) { const at = part.indexOf(":");if (at > 0) declared[part.slice(0, at).trim()] = part.slice(at + 1).trim(); }
  out.set(selector!.trim(), declared);
 }
 return out;
}
function expectedColors(theme: "light" | "dark"): Record<string, string> {
 const e = LOOK_EFFECTS[theme];
 return { ...Object.fromEntries(Object.entries(LOOK_COLORS[theme]).map(([key, value]) => [`--rv-${kebab(key)}`, value])), "--rv-shadow-1": e.shadow1, "--rv-shadow-2": e.shadow2, "--rv-shadow-3": e.shadow3, "--rv-focus-halo": e.focusHalo, "color-scheme": theme };
}
function expectedDensity(name: "comfortable" | "compact"): Record<string, string> {
 const d = LOOK_DENSITY[name];
 return { "--rv-density-row-y": `${String(d.rowY)}px`, "--rv-density-row-y-dense": `${String(d.rowYDense)}px`, "--rv-density-card": `${String(d.card)}px`, "--rv-density-gap": `${String(d.gap)}px`, "--rv-control-h": `${String(d.controlH)}px`, "--rv-font-lg": `${String(d.font.lg)}px`, "--rv-font-xl": `${String(d.font.xl)}px`, "--rv-font-xxl": `${String(d.font.xxl)}px`, "--rv-font-title-size": `${String(d.font.title)}px` };
}
describe("v2 look tokens: the emitted CSS variables match look.ts (no drift)", () => {
 const sheet = rules(lookV2Css());
 it("emits every light colour, shadow and density value in the base v2 rule", () => {
  expect(sheet.get(ROOT)).toMatchObject({ ...expectedColors("light"), ...expectedDensity("comfortable") });
 });
 it("emits every dark value both for the system preference and for an explicit choice", () => {
  expect(sheet.get(`${ROOT}:not([data-theme="light"])`)).toEqual(expectedColors("dark"));
  expect(sheet.get(`${ROOT}[data-theme="dark"]`)).toEqual(expectedColors("dark"));
 });
 it("emits the compact density values", () => {
  expect(sheet.get(`${ROOT}[data-density="compact"]`)).toEqual(expectedDensity("compact"));
 });
 it("emits the shape values and the touch rule", () => {
  expect(sheet.get(ROOT)).toMatchObject({ "--rv-radius-sm": `${String(LOOK_SHAPE.radius.sm)}px`, "--rv-radius-md": `${String(LOOK_SHAPE.radius.md)}px`, "--rv-radius-lg": `${String(LOOK_SHAPE.radius.lg)}px`, "--rv-radius-card": "var(--rv-radius-md)", "--rv-motion-fast": `${String(LOOK_SHAPE.motionFastMs)}ms`, "--rv-control-size": "max(var(--rv-control-h),var(--rv-touch-min))" });
  expect(lookV2Css()).toContain("--rv-touch-min:0px;");
  expect(lookV2Css()).toContain(`@media (max-width: 767px), (pointer: coarse){${ROOT}{--rv-touch-min:${String(LOOK_SHAPE.touchMinPx)}px}}`);
 });
 it("declares nothing else: every emitted name is accounted for", () => {
  const known = new Set([...Object.keys(expectedColors("light")), ...Object.keys(expectedDensity("comfortable")), "--rv-radius-sm", "--rv-radius-md", "--rv-radius-lg", "--rv-radius-card", "--rv-motion-fast", "--rv-font-xs", "--rv-font-title", "--rv-touch-min", "--rv-control-size", "--rv-focus-offset"]);
  for (const declared of sheet.values()) for (const name of Object.keys(declared)) expect(known.has(name), name).toBe(true);
 });
 it("reaches the page: the theme provider writes the same sheet after the base tokens", () => {
  render(h(ThemeProvider, { host: host(), children: h("p", null, "x") }));
  const css = [...document.querySelectorAll("style")].map(style => style.textContent).join("");
  expect(css).toBe(tokensCss() + lookV2Css());
 });
});
describe("v2 values agree with the design mock-ups (tokens.css)", () => {
 it("keeps the published light and dark values for the key tokens", () => {
  const sheet = rules(lookV2Css());
  expect(sheet.get(ROOT)).toMatchObject({ "--rv-bg": "#f9fafb", "--rv-accent": "#3157d5", "--rv-accent-soft": "#eef2ff", "--rv-status-needs-you": "#8a5300", "--rv-text-subtle": "#626b7d", "--rv-radius-md": "10px", "--rv-density-row-y": "14px" });
  expect(sheet.get(`${ROOT}[data-theme="dark"]`)).toMatchObject({ "--rv-bg": "#0e1116", "--rv-accent": "#6f8ff6", "--rv-accent-soft": "#1c2440", "--rv-status-done": "#6fd3a2", "--rv-text-subtle": "#8792a3" });
  expect(sheet.get(`${ROOT}[data-density="compact"]`)).toMatchObject({ "--rv-density-row-y": "10px", "--rv-control-h": "36px", "--rv-font-xxl": "26px" });
 });
});
describe("the four new tokens", () => {
 it("are emitted with the mock-up values, Comfortable and Compact", () => {
  const sheet = rules(lookV2Css());
  expect(sheet.get(ROOT)).toMatchObject({ "--rv-font-xs": "11px", "--rv-font-title": 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', "--rv-font-title-size": "21px", "--rv-density-row-y-dense": "9px" });
  expect(sheet.get(`${ROOT}[data-density="compact"]`)).toMatchObject({ "--rv-font-title-size": "19px", "--rv-density-row-y-dense": "5px" });
 });
 it("do not leak into the base token sheet", () => {
  for (const name of ["--rv-font-xs", "--rv-font-title", "--rv-density-row-y-dense"]) expect(tokensCss()).not.toContain(name);
 });
});
describe("v2 look tokens", () => {
 for (const theme of ["light", "dark"] as const) {
  it(`${theme}: every text pair reaches 4.5:1 and every interface part 3:1`, () => {
   for (const [front, back] of LOOK_TEXT_PAIRS) expect(contrastRatio(LOOK_COLORS[theme][front], LOOK_COLORS[theme][back]), `${front} on ${back}`).toBeGreaterThanOrEqual(4.5);
   for (const [front, back] of LOOK_UI_PAIRS) expect(contrastRatio(LOOK_COLORS[theme][front], LOOK_COLORS[theme][back]), `${front} on ${back}`).toBeGreaterThanOrEqual(3);
  });
 }
 it("uses the same token names in both themes and keeps every existing name", () => {
  expect(Object.keys(LOOK_COLORS.light)).toEqual(Object.keys(LOOK_COLORS.dark));
  for (const key of Object.keys(TOKENS.light)) expect(Object.keys(LOOK_COLORS.light)).toContain(key);
 });
 it("scopes every rule to data-look=v2 and leaves the base token sheet untouched", () => {
  expect(tokensCss()).not.toContain("data-look");
  const selectors = lookV2Css().split("}").map(rule => rule.replace(/^@media[^{]*\{/, "").split("{")[0]!.trim()).filter(selector => selector.length > 0);
  expect(selectors.length).toBeGreaterThan(4);
  for (const selector of selectors) expect(selector, selector).toContain(ROOT);
  expect(lookV2Css()).toContain("prefers-color-scheme: dark");
  expect(LOOK_DENSITY.comfortable.controlH).toBeGreaterThan(LOOK_DENSITY.compact.controlH);
 });
});
describe("density switch (tokens only)", () => {
 it("reads density, Comfortable by default, and refuses unknown values", () => {
  expect(readDensity(host())).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "toString" }))).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "compact" }))).toBe("compact");
  expect(readDensity({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe("comfortable");
 });
 it("puts the look and density attributes on the page and stores density apart from the theme", async () => {
  const f = host({ "rovara.theme": "dark" });
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
 it("still changes density when the store is blocked", async () => {
  const blocked = { storage: { get: () => undefined, set() { throw new Error("blocked"); } } };
  function Probe() { const theme = useTheme();return h("button", { type: "button", onClick: () => theme.setDensity("compact") }, theme.density); }
  render(h(ThemeProvider, { host: blocked, children: h(Probe) }));
  await userEvent.click(screen.getByRole("button", { name: "comfortable" }));
  expect(document.documentElement.getAttribute("data-density")).toBe("compact");
 });
});
