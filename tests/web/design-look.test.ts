// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LOOK_OWN_SHADOWS, LOOK_COLORS, LOOK_DENSITY, LOOK_TEXT_PAIRS, LOOK_UI_PAIRS, TOKENS, contrastRatio, lookV2Css, tokensCss } from "../../packages/design-tokens/src/index.js";
import { ThemeProvider, useTheme } from "../../packages/ui/src/theme.js";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AccountMenu } from "../../packages/ui/src/shell/AccountMenu.js";
import { fakeHost } from "./support/fake-host.js";
import { Chip } from "../../packages/ui/src/design/Chip.js";
import { DENSITY_STORAGE_KEY, readDensity } from "../../packages/ui/src/look.js";
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
describe("v2 focus halo and component shadows", () => {
 const rules = () => lookV2Css().split("}").map(rule => rule.split("{") as [string, string | undefined]).filter(([, body]) => body !== undefined);
 it("keeps a component's own elevation while it has keyboard focus: halo plus shadow, never the halo alone", () => {
  const owners = rules().filter(([selector]) => selector.includes(":focus-visible") && selector.includes(".rv-"));
  const selectors = LOOK_OWN_SHADOWS.flatMap(entry => entry.selectors);
  for (const component of [".rv-surface", ".rv-decision", ".rv-popover", ".rv-tooltip", ".rv-toast", ".rv-dialog"]) expect(selectors, component).toContain(component);
  for (const { selectors: group, shadow } of LOOK_OWN_SHADOWS) for (const selector of group) {
   const own = owners.find(([text]) => text.split(",").includes(`:root[data-look="v2"] ${selector}:focus-visible`));
   expect(own, selector).toBeDefined();
   expect(own![1], selector).toBe(`box-shadow:var(--rv-focus-halo),var(${shadow})`);
  }
  // Elements without a shadow of their own still get the halo alone, and the component rules come later so they win.
  const all = lookV2Css(), plain = all.indexOf(':root[data-look="v2"] :focus-visible{box-shadow:var(--rv-focus-halo)}');
  expect(plain).toBeGreaterThan(-1);
  expect(all.indexOf(':root[data-look="v2"] .rv-surface:focus-visible')).toBeGreaterThan(plain);
 });
 it("only names components that really carry that shadow in the sheets", () => {
  const sheets = readFileSync(join(process.cwd(), "packages/ui/src/design/design.css"), "utf8") + readFileSync(join(process.cwd(), "packages/ui/src/screens/home/home.css"), "utf8");
  for (const { selectors, shadow } of LOOK_OWN_SHADOWS) for (const selector of selectors) {
   const rule = new RegExp(`(^|[},\\s])${selector.replace(".", "\\.")}(,[^{]*)?\\{[^}]*box-shadow:var\\(${shadow}`, "mu");
   expect(sheets, selector).toMatch(rule);
  }
 });
});
describe("the v2 look, the only look (decision 125)", () => {
 it("reads density, Comfortable by default", () => {
  expect(readDensity(host())).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "toString" }))).toBe("comfortable");
  expect(readDensity(host({ [DENSITY_STORAGE_KEY]: "compact" }))).toBe("compact");
  expect(readDensity({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe("comfortable");
 });
 it("puts the look and density attributes on the page with no device key, and stores density separately from the theme", async () => {
  document.documentElement.removeAttribute("data-look");document.documentElement.removeAttribute("data-density");
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
 it("ignores a leftover device key from before (rovara.look), whatever its value", () => {
  for (const value of ["v2", "off", ""]) {
   document.documentElement.removeAttribute("data-look");
   const ui = render(h(ThemeProvider, { host: host({ "rovara.look": value }), children: h("p", null, "x") }));
   expect(document.documentElement.getAttribute("data-look"), value).toBe("v2");
   ui.unmount();
  }
 });
});
describe("Chip", () => {
 it("shows words and a decorative icon for the company lock and the outside change", () => {
  const { container } = render(h("div", null, h(Chip, { kind: "company-lock", children: "Company lock" }), h(Chip, { kind: "outside-change", children: "Changed outside Rovara" }), h(Chip, { children: "Project default" })));
  expect(screen.getByText("Company lock").className).toContain("rv-chip-company-lock");
  expect(screen.getByText("Changed outside Rovara").className).toContain("rv-chip-outside-change");
  expect(container.querySelectorAll("svg[aria-hidden='true']").length).toBe(2);
  expect(screen.getByText("Project default").querySelector("svg")).toBeNull();
 });
});

describe("Density choice in the account dialog", () => {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Trial team" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 function openAccount(stored: Record<string, string>) {
  const f = fakeHost(async () => ({ status: 200, body: {} })), query = createQueryClient();
  for (const [key, value] of Object.entries(stored)) f.host.storage.set(key, value);
  const ui = render(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(MemoryRouter, null, h(AccountMenu, { nav })) }) }) }));
  return { ...f, close() { ui.unmount();query.clear(); } };
 }
 it("is always shown beside Appearance (decision 125), and choosing Compact stores it and sets the page attribute", async () => {
  const f = openAccount({});
  await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
  expect(await screen.findByRole("group", { name: "Appearance" })).toBeTruthy();
  const group = await screen.findByRole("group", { name: "Density" });
  expect(group.querySelectorAll("input[type=radio]").length).toBe(2);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Comfortable" }).checked).toBe(true);
  expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
  expect(f.host.storage.get(DENSITY_STORAGE_KEY)).toBe("compact");
  expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Compact" }).checked).toBe(true);
  await userEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
  expect(f.host.storage.get(DENSITY_STORAGE_KEY)).toBe("comfortable");
  expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  f.close();
 });
});
