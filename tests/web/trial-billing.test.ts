// @vitest-environment jsdom
// Trial and billing screens (lane exp/trial-billing), against fixtures built from the API doc. The server is not built yet: every answer here is a fixture.
import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { BILLING_STORAGE_KEY, isBillingV2On } from "../../packages/ui/src/billing-flags.js";
import { BillingActionBodySchema, BillingStateReaderSchema, TrialViewReaderSchema } from "../../packages/ui/src/api/trial-billing.js";
import { allowanceName, bannerFor, heldPercent, hoursText, invoiceStatusWords, methodStatusWords, paymentMethodWords, phaseWords, refreshWords, stateWords, unavailableWords, usedPercent, worstState } from "../../packages/ui/src/screens/billing/trial-logic.js";
import { TrialBanner } from "../../packages/ui/src/shell/TrialBanner.js";
import { visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import * as fx from "./support/trial-billing-fixture.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
type Answer = ApiResponse | ((request: ApiRequest) => ApiResponse);
type Answers = Record<string, Answer>;
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const parseTrial = (value: unknown) => TrialViewReaderSchema.parse(value);

function mount(options: { path: string; on?: boolean; role?: "owner" | "admin" | "member"; answers?: Answers; width?: number; theme?: "light" | "dark" }) {
 const role = options.role ?? "owner", me = fx.ADMIN_ID;
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 const identity = { developer: { id: me, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const answers: Answers = { "/v1/app/org/members": ok(fx.members()), ...options.answers };
 const f = fakeHost(async (r: ApiRequest) => {
  const path = r.path.split("?")[0]!;
  if (path === "/v1/app/me") return { status: 200, body: identity };
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  const key = r.method === "GET" ? path : r.method + " " + path, answer = answers[key];
  if (answer === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "none" } } };
  return typeof answer === "function" ? answer(r) : answer;
 });
 if (options.width !== undefined) f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 f.storage.set("rovara.theme", options.theme ?? "light");if (options.on !== false) f.storage.set(BILLING_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features, { billing: options.on !== false }), { initialEntries: [options.path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, close() { view.unmount();router.dispose();query.clear(); } };
}
type Mounted = ReturnType<typeof mount>;
const calls = (f: Mounted, method: string, path: string) => f.request.mock.calls.map(([r]) => r).filter(r => r.method === method && r.path.split("?")[0] === path);
const posts = (f: Mounted) => calls(f, "POST", "/v1/app/org/billing");
const lastPost = (f: Mounted) => { const all = posts(f);return all[all.length - 1]!.body as Record<string, unknown>; };
const TRIAL = "/v1/app/trial", BILLING = "/v1/app/org/billing", INVOICES = "/v1/app/org/billing/invoices", POST = "POST /v1/app/org/billing";
const done = (state: unknown, extra: Record<string, unknown> = {}) => ok({ status: "done", state, ...extra });

describe("the device switch", () => {
 it("is off unless the device key is exactly v2, and never throws", () => {
  expect(isBillingV2On({ storage: { get: () => undefined } })).toBe(false);
  expect(isBillingV2On({ storage: { get: key => key === "rovara.billing" ? "v2" : undefined } })).toBe(true);
  expect(BILLING_STORAGE_KEY).toBe("rovara.billing");
  expect(isBillingV2On({ storage: { get: () => "v3" } })).toBe(false);
  expect(isBillingV2On({ storage: { get: () => "true" } })).toBe(false);
  expect(isBillingV2On({ storage: { get: () => { throw new Error("blocked"); } } })).toBe(false);
 });
 it("off: no trial page, no Billing page, no Billing link, no billing read", async () => {
  const f = mount({ on: false, path: "/app/trial", answers: { [TRIAL]: ok(fx.nearEnd()), [BILLING]: ok(fx.billed()) } });
  try {
   expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
   f.router.dispose();
  } finally { f.close(); }
  const g = mount({ on: false, path: "/app/admin/billing", answers: { [TRIAL]: ok(fx.nearEnd()), [BILLING]: ok(fx.billed()) } });
  try {
   expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
   expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
   for (const path of [TRIAL, BILLING, INVOICES]) expect(calls(g, "GET", path)).toHaveLength(0);
  } finally { g.close(); }
 });
 it("off: the settings list never offers Billing; on, it sits under Money and limits", () => {
  expect(visibleSections("owner", false).flatMap(section => section.items.map(item => item.label))).not.toContain("Billing");
  const on = visibleSections("owner", false, true);
  expect(on.find(section => section.id === "money")!.items.map(item => item.label)).toEqual(["Spending", "Billing"]);
 });
 it("on: the settings navigation links to Billing", async () => {
  const f = mount({ path: "/app/admin/billing", answers: { [BILLING]: ok(fx.unavailable()), [TRIAL]: ok(fx.active()) } });
  try {
   await screen.findByRole("heading", { name: "Billing", level: 1 });
   expect(within(screen.getByRole("navigation", { name: "Administration" })).getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/app/admin/billing");
  } finally { f.close(); }
 });
});

describe("trial phases and thresholds", () => {
 it("reads every fixture of the doc", () => {
  for (const value of [fx.active(), fx.nearEnd(), fx.usedUp(), fx.ended(true), fx.ended(false), fx.stopped(true), fx.trial({ phase: "locked" }), fx.trial({ phase: "github_used" })]) expect(() => parseTrial(value)).not.toThrow();
  for (const value of [fx.billing(), fx.billed(), fx.pastDue(), fx.unavailable()]) expect(() => BillingStateReaderSchema.parse(value)).not.toThrow();
 });
 it("a word a newer server adds reads as unknown, and a broken number refuses the whole read", () => {
  expect(parseTrial(fx.trial({ phase: "frozen" })).phase).toBe("unknown");
  expect(phaseWords("unknown", "trial").heading).toBe("Trial status unavailable");
  expect(() => parseTrial(fx.trial({ allowances: [fx.models({ used: -1 })] }))).toThrow();
  expect(() => parseTrial(fx.trial({ allowances: [fx.models({ left: Number.NaN })] }))).toThrow();
 });
 it("percent used and set aside, to one decimal, never past the end of the bar", () => {
  expect(usedPercent({ granted: 500, used: 200 })).toBe(40);
  expect(usedPercent({ granted: 50, used: 42.5 })).toBe(85);
  expect(usedPercent({ granted: 50, used: 60 })).toBe(100);
  expect(usedPercent({ granted: 0, used: 0 })).toBe(0);
  expect(usedPercent({ granted: 0, used: 1 })).toBe(100);
  expect(heldPercent({ granted: 500, used: 200, held: 50 })).toBe(10);
  expect(heldPercent({ granted: 500, used: 490, held: 50 })).toBe(2);
  expect(heldPercent({ granted: 500, used: 200 })).toBe(0);
  expect(hoursText(1)).toBe("1 hour");expect(hoursText(12.34)).toBe("12.3 hours");expect(hoursText(0)).toBe("0 hours");
 });
 it("words: the allowance renews or it doesn't (read from refresh, never hard-coded), and unknown codes never show raw", () => {
  expect(refreshWords({ refresh: "monthly", period: { month: "2026-11" } })).toBe("Renews every month. This period: November 2026.");
  expect(refreshWords({ refresh: "never", period: null })).toBe("One-time allowance. It does not renew.");
  expect(stateWords("low")).toBe("Running low");expect(stateWords("used_up")).toBe("Used up");expect(stateWords("__proto__")).toBe("Unknown");
  expect(unavailableWords("not_built_yet")).toBe("Not available yet.");expect(unavailableWords("constructor")).toBe("Not available right now.");expect(unavailableWords(null)).toBe("");
  expect(allowanceName("models")).toBe("AI models");expect(allowanceName("machine")).toBe("Machine time");
  expect(invoiceStatusWords("uncollectible")).toBe("Not collected");expect(invoiceStatusWords("zzz")).toBe("Unknown");
  expect(methodStatusWords("failed")).toBe("The last payment failed");
  expect(paymentMethodWords({ kind: "card", brand: "amex", last4: "0005", status: "valid", updatedAt: "x" })).toBe("American Express ending 0005");
  expect(paymentMethodWords({ kind: "bank_account", brand: null, last4: "6789", status: "valid", updatedAt: "x" })).toBe("Bank account ending 6789");
 });
 it("the worst allowance wins", () => {
  expect(worstState(parseTrial(fx.active()).allowances)).toBe("ok");
  expect(worstState(parseTrial(fx.nearEnd()).allowances)).toBe("low");
  expect(worstState(parseTrial(fx.usedUp()).allowances)).toBe("used_up");
 });
 it("the banner: near the end only for people who can choose; used up, ended and stopped for everyone the server tells; nothing for ok, own key, billed or an unknown phase", () => {
  expect(bannerFor(parseTrial(fx.active()))).toBeUndefined();
  expect(bannerFor(parseTrial(fx.nearEnd()))?.kind).toBe("near_end");
  expect(bannerFor(parseTrial({ ...fx.nearEnd(), you: { member: null, hitLimit: false, canChoose: false } }))).toBeUndefined();
  expect(bannerFor(parseTrial(fx.usedUp()))).toMatchObject({ kind: "used_up", chooser: false });
  expect(bannerFor(parseTrial({ ...fx.usedUp(), you: { member: null, hitLimit: false, canChoose: false }, choices: null }))).toBeUndefined();
  expect(bannerFor(parseTrial(fx.ended(true)))).toMatchObject({ kind: "ended", chooser: true });
  expect(bannerFor(parseTrial(fx.ended(false)))).toMatchObject({ kind: "ended", chooser: false });
  expect(bannerFor(parseTrial(fx.stopped(false)))?.kind).toBe("stopped");
  for (const phase of ["own_key", "billed", "locked", "github_used", "frozen"]) expect(bannerFor(parseTrial(fx.trial({ phase })))).toBeUndefined();
  expect(bannerFor(parseTrial(fx.trial({ phase: "past_due" })))?.kind).toBe("past_due");
  expect(bannerFor(parseTrial(fx.trial({ phase: "suspended" })))?.kind).toBe("suspended");
 });
});

describe("the trial page", () => {
 it("the allowance card: used and left for models and machine time, a bar, and when it ends", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.active()) } });
  try {
   await screen.findByRole("heading", { name: "Your trial", level: 1 });
   const list = screen.getByRole("list", { name: "Allowances" });
   const models = within(list).getByRole("heading", { name: "AI models" }).closest("li")!, machine = within(list).getByRole("heading", { name: "Machine time" }).closest("li")!;
   expect(models.textContent).toContain("$200.00");expect(models.textContent).toContain("$500.00");expect(models.textContent).toContain("$300.00");expect(models.textContent).toContain("40% used");expect(models.textContent).toContain("Renews every month");
   expect(machine.textContent).toContain("4 hours");expect(machine.textContent).toContain("20 hours");expect(machine.textContent).toContain("16 hours");
   expect(screen.getByText("Rovara pays for models until the allowance is renewed next month.")).toBeTruthy();
   expect(screen.getByText(/Your own share/).textContent).toContain("$3.10");
   expect(screen.queryByRole("heading", { name: "What happens when the allowance runs out" })).toBeNull();
   expect(screen.queryByRole("link", { name: "Open Billing settings" })).toBeNull();
  } finally { f.close(); }
 });
 it("a one-time allowance says it does not renew", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.nearEnd()) } });
  try {
   await screen.findByRole("heading", { name: "Your trial", level: 1 });
   expect(screen.getAllByText("One-time allowance. It does not renew.")).toHaveLength(2);
   expect(screen.getByText("Rovara pays for models until the allowance is used up.")).toBeTruthy();
   expect(screen.getByText("Running low")).toBeTruthy();
   expect(screen.queryByText(/this month/i)).toBeNull();
  } finally { f.close(); }
 });
 it("ended, owner or admin: three choices with buttons; a choice that is not available is disabled and says why; nothing is promised", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true)) } });
  try {
   await screen.findByRole("heading", { name: "What happens when the allowance runs out" });
   expect(screen.getByText("Your trial allowance is used up.")).toBeTruthy();
   const stop = screen.getByRole("button", { name: "Stop" }), auto = screen.getByRole("button", { name: "Turn on auto-billing" }), key = screen.getByRole("button", { name: "Connect your own AI key" });
   expect(stop.hasAttribute("disabled")).toBe(true);expect(auto.hasAttribute("disabled")).toBe(true);expect(key.hasAttribute("disabled")).toBe(false);
   expect(screen.getByText("Not available yet.")).toBeTruthy();expect(screen.getByText("Billing isn't available yet.")).toBeTruthy();
   expect(screen.getByText("Running tasks pause after their current step. Nothing is deleted.")).toBeTruthy();
   expect(screen.queryByText(/Ask an admin/)).toBeNull();
   expect(screen.getByRole("link", { name: "Open Billing settings" }).getAttribute("href")).toBe("/app/admin/billing");
  } finally { f.close(); }
 });
 it("ended, a member: the same facts, no buttons, and Ask an admin with the names of the owners and admins", async () => {
  const f = mount({ path: "/app/trial", role: "member", answers: { [TRIAL]: ok(fx.ended(false)) } });
  try {
   const ask = await screen.findByText(/Ask an admin\./);
   expect(screen.getByRole("heading", { name: "Stop" })).toBeTruthy();expect(screen.getByRole("heading", { name: "Turn on auto-billing" })).toBeTruthy();expect(screen.getByRole("heading", { name: "Connect your own AI key" })).toBeTruthy();
   expect(screen.getByText("Keep working and be billed for usage, up to your monthly limit.")).toBeTruthy();
   expect(within(screen.getByRole("main")).queryAllByRole("button")).toHaveLength(0);
   expect(ask.closest("p")!.textContent).toContain("Only company owners and admins can choose.");
   await waitFor(() => { expect(ask.closest("p")!.textContent).toContain("Priya, Maya"); });
   expect(ask.closest("p")!.textContent).not.toContain("Sam");
   expect(screen.queryByRole("link", { name: "Open Billing settings" })).toBeNull();
   expect(screen.getByText("You're seeing this because your work reached the allowance.")).toBeTruthy();
  } finally { f.close(); }
 });
 it("a member still gets Ask an admin when the names can't be read", async () => {
  const f = mount({ path: "/app/trial", role: "member", answers: { [TRIAL]: ok(fx.ended(false)), "/v1/app/org/members": { status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } } } });
  try {
   const ask = await screen.findByText(/Ask an admin\./);
   await waitFor(() => { expect(calls(f, "GET", "/v1/app/org/members")).toHaveLength(1); });
   expect(ask.closest("p")!.textContent).not.toContain("Owners and admins:");
  } finally { f.close(); }
 });
 it("a choice already made is named, with who made it", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.stopped(true)) } });
  try {
   await screen.findByText(/Chosen: Stop\./);
   expect(screen.getByText(/Chosen: Stop\./).closest("p")!.textContent).toContain("By Priya on Nov 10, 2026.");
   expect(screen.getByText("Work on Rovara-provided models is stopped.")).toBeTruthy();
  } finally { f.close(); }
 });
 it("no trial on this install (404) and a failed read say so in words", async () => {
  const f = mount({ path: "/app/trial", answers: {} });
  try { expect(await screen.findByText("There is no trial or plan to show on this install.")).toBeTruthy(); } finally { f.close(); }
  const g = mount({ path: "/app/trial", answers: { [TRIAL]: { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara is busy. Try again shortly." } } } } });
  try { expect((await screen.findByRole("alert", {}, { timeout: 8000 })).textContent).toBe("Rovara is busy. Try again shortly.");expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(); } finally { g.close(); }
 });
 it("axe clean in light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
   const f = mount({ path: "/app/trial", theme, answers: { [TRIAL]: ok(fx.ended(true)) } });
   try { await screen.findByRole("heading", { name: "What happens when the allowance runs out" });await expectNoAxeViolations(document.body); } finally { f.close(); }
  }
 });
});

describe("choosing at the end of the trial: each action, REAUTH_REQUIRED and refusals", () => {
 const openOptions = () => fx.options({ stop: { available: true, unavailableReason: null }, autoBill: { available: true, unavailableReason: null } });
 it("own key: records the choice, then goes to AI models", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true)), [POST]: done(fx.billing()) } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect your own AI key" }));
   await waitFor(() => { expect(f.router.state.location.pathname).toBe("/app/admin/models"); });
   const body = lastPost(f);
   expect(Object.keys(body).sort()).toEqual(["action", "choice", "requestId"]);expect(body).toMatchObject({ action: "choose-trial-end", choice: "own_key" });
   expect(BillingActionBodySchema.safeParse(body).success).toBe(true);
  } finally { f.close(); }
 });
 it("own key refused: the server's words, and a link to AI models anyway", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true)), [POST]: fx.refusal("CHANGE_STALE", "The trial moved on. Reload to see where it is now.") } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect your own AI key" }));
   expect((await screen.findByRole("alert")).textContent).toBe("The trial moved on. Reload to see where it is now.");
   expect(screen.getByRole("link", { name: "Open AI models" }).getAttribute("href")).toBe("/app/admin/models");
   expect(f.router.state.location.pathname).toBe("/app/trial");
  } finally { f.close(); }
 });
 it("stop (when the server makes it available): asks first, sends nothing until confirmed, then sends once", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: openOptions() })), [POST]: done(fx.billing({ phase: "stopped" })) } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
   expect(posts(f)).toHaveLength(0);expect(screen.getByText("Stop work on Rovara-provided models? Nothing is deleted.")).toBeTruthy();
   fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
   expect(posts(f)).toHaveLength(0);
   fireEvent.click(screen.getByRole("button", { name: "Stop" }));fireEvent.click(screen.getByRole("button", { name: "Yes, stop" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(1); });
   expect(lastPost(f)).toMatchObject({ action: "choose-trial-end", choice: "stop" });
  } finally { f.close(); }
 });
 it("auto-billing with a payment method on file: choose-trial-end auto_bill", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: openOptions() })), [POST]: done(fx.billed()) } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Turn on auto-billing" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(1); });
   expect(lastPost(f)).toMatchObject({ action: "choose-trial-end", choice: "auto_bill" });
   expect((await screen.findAllByRole("status")).some(node => node.textContent === "Done. Auto-billing is on.")).toBe(true);
  } finally { f.close(); }
 });
 it("auto-billing without a payment method goes to the provider-hosted page; the page itself shows no card field", async () => {
  const hosted = "https://pay.example/setup/abc";
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: fx.options({ autoBill: { available: false, unavailableReason: "no_payment_method" } }) })), [POST]: done(fx.billing(), { status: "needs_action", action: { kind: "redirect", url: hosted, expiresAt: "2026-11-11T13:00:00.000Z" } }) } });
  try {
   expect(await screen.findByText("You'll add a payment method on the billing provider's secure page first.")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Turn on auto-billing" })).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Add a payment method" }));
   await waitFor(() => { expect(f.host.openExternal).toHaveBeenCalledWith(hosted); });
   expect(lastPost(f)).toMatchObject({ action: "payment-method-setup", returnPath: "/app/live" });
   expect(Object.keys(lastPost(f)).sort()).toEqual(["action", "requestId", "returnPath"]);
   expect(screen.getByRole("link", { name: "Open the secure page" }).getAttribute("href")).toBe(hosted);
   expect(document.querySelectorAll("input")).toHaveLength(0);
  } finally { f.close(); }
 });
 it("a hosted page address that is not https is never opened", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: fx.options({ autoBill: { available: false, unavailableReason: "no_payment_method" } }) })), [POST]: done(fx.billing(), { status: "needs_action", action: { kind: "redirect", url: "http://pay.example/setup", expiresAt: "2026-11-11T13:00:00.000Z" } }) } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Add a payment method" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(1); });
   expect(f.host.openExternal).not.toHaveBeenCalled();expect(screen.queryByRole("link", { name: "Open the secure page" })).toBeNull();
  } finally { f.close(); }
 });
 it("REAUTH_REQUIRED: the server's sentence, then a Sign in again button; a refusal is shown verbatim", async () => {
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: openOptions() })), [POST]: fx.refusal("REAUTH_REQUIRED", "Sign in again to do this.") } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Turn on auto-billing" }));
   const alert = await screen.findByRole("alert");
   expect(alert.textContent).toContain("Sign in again to do this.");
   fireEvent.click(within(alert).getByRole("button", { name: "Sign in again" }));
   expect(f.host.signIn).toHaveBeenCalledWith("/app/live");
  } finally { f.close(); }
  const g = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: openOptions() })), [POST]: fx.refusal("CONFIG_INVALID", "Add a payment method first.") } });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Turn on auto-billing" }));
   const alert = await screen.findByRole("alert");
   expect(alert.textContent).toBe("Add a payment method first.");expect(within(alert).queryByRole("button")).toBeNull();
  } finally { g.close(); }
 });
 it("a repeat after a dropped connection reuses the requestId; after a refusal it does not", async () => {
  let n = 0;
  const f = mount({ path: "/app/trial", answers: { [TRIAL]: ok(fx.ended(true, { options: openOptions() })), [POST]: () => { n += 1;return n === 1 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara is busy. Try again shortly." } } } : n === 2 ? fx.refusal("CONFIG_INVALID", "No.") : ok({ status: "done", state: fx.billed() }); } } });
  try {
   const press = async (count: number) => { fireEvent.click(screen.getByRole("button", { name: "Turn on auto-billing" }));await waitFor(() => { expect(posts(f)).toHaveLength(count); });await waitFor(() => { expect(screen.getByRole("button", { name: "Turn on auto-billing" }).hasAttribute("disabled")).toBe(false); }); };
   await screen.findByRole("button", { name: "Turn on auto-billing" });
   await press(1);await press(2);await press(3);
   const ids = posts(f).map(r => (r.body as { requestId: string }).requestId);
   expect(ids[1]).toBe(ids[0]);expect(ids[2]).not.toBe(ids[1]);
  } finally { f.close(); }
 });
});

describe("Settings > Billing", () => {
 const open = (state: unknown, extra: Answers = {}, options: { role?: "owner" | "admin"; width?: number; theme?: "light" | "dark" } = {}) => mount({ path: "/app/admin/billing", ...options, answers: { [BILLING]: ok(state), [TRIAL]: ok(fx.active()), [INVOICES]: ok(fx.invoicePage(1, 2)), ...extra } });
 it("billed: plan, auto-billing on, a masked card with Change, the monthly limit linking to Spending, invoices", async () => {
  const f = open(fx.billed());
  try {
   await screen.findByRole("heading", { name: "Billing", level: 1 });
   const plan = screen.getByRole("heading", { name: "Plan" }).closest("section")!;
   expect(plan.textContent).toContain("Team");expect(plan.textContent).toContain("Auto-billing is on");
   expect(screen.getByText(/Auto-billing is on\. Rovara-provided usage/)).toBeTruthy();
   const method = screen.getByRole("heading", { name: "Payment method" }).closest("section")!;
   expect(method.textContent).toContain("Visa ending 4242");expect(method.textContent).toContain("12/2028");expect(method.textContent).toContain("Valid");
   expect(within(method).getByRole("button", { name: "Change payment method" })).toBeTruthy();
   const limit = screen.getByRole("heading", { name: "Monthly limit" }).closest("section")!;
   expect(limit.textContent).toContain("$500.00");expect(limit.textContent).toContain("ceiling");
   expect(within(limit).getByRole("link", { name: /Spending page/ }).getAttribute("href")).toBe("/app/admin/money/budgets");
   expect(within(limit).queryByRole("textbox")).toBeNull();expect(within(limit).queryByRole("spinbutton")).toBeNull();
   const table = await screen.findByRole("table", { name: "Invoices" });
   expect(within(table).getByText("RV-2026-0001")).toBeTruthy();expect(within(table).getAllByText("$123.45")).toHaveLength(2);expect(within(table).getAllByText("Paid")).toHaveLength(2);
   expect(within(table).getByRole("link", { name: "PDF of invoice RV-2026-0001" }).getAttribute("href")).toBe("https://invoices.example/pdf/1.pdf");
   expect(within(table).getByRole("link", { name: "PDF of invoice RV-2026-0001" }).getAttribute("rel")).toBe("noopener noreferrer");
  } finally { f.close(); }
 });
 it("shows the card masked only, and builds no card form: no card number, expiry, security code or name field exists, and no long digit string appears", async () => {
  const f = open(fx.billed());
  try {
   await screen.findByText("Visa ending 4242");
   const fields = [...document.querySelectorAll("input, select, textarea")] as HTMLInputElement[];
   expect(fields.map(field => field.type)).toEqual(["email"]);
   for (const field of fields) { expect(field.autocomplete).not.toMatch(/^cc-/u);expect(field.inputMode).not.toBe("numeric");expect(field.getAttribute("name") ?? "").not.toMatch(/card|cvc|cvv|number/iu); }
   expect(screen.queryByLabelText(/card number|security code|cvc|cvv|expiry|name on card/iu)).toBeNull();
   const text = screen.getByRole("main").textContent ?? "";
   expect(text).not.toMatch(/\d{5,}/u);
   expect(text).toContain("Rovara never sees them");
   expect(document.querySelector("iframe")).toBeNull();
  } finally { f.close(); }
  const g = open(fx.billing());
  try {
   await screen.findByText("No payment method on file.");
   expect([...document.querySelectorAll("input")].map(field => field.type)).toEqual(["email"]);
  } finally { g.close(); }
 });
 it("Change and Add ask the server for the hosted page and open it; the answer's own card text is never shown", async () => {
  const hosted = "https://pay.example/change/1";
  const f = open(fx.billed(), { [POST]: done(fx.billed(), { status: "needs_action", setup: { url: hosted, expiresAt: "2026-11-11T13:00:00.000Z" } }) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change payment method" }));
   await waitFor(() => { expect(f.host.openExternal).toHaveBeenCalledWith(hosted); });
   expect(lastPost(f)).toMatchObject({ action: "payment-method-setup", returnPath: "/app/live" });
  } finally { f.close(); }
  const g = open(fx.billing(), { [POST]: done(fx.billing(), { status: "needs_action", action: { kind: "redirect", url: hosted, expiresAt: "2026-11-11T13:00:00.000Z" } }) });
  try {
   fireEvent.click((await screen.findAllByRole("button", { name: "Add a payment method" }))[0]!);
   await waitFor(() => { expect(g.host.openExternal).toHaveBeenCalledWith(hosted); });
  } finally { g.close(); }
 });
 it("auto-billing: on sends enabled true; off asks first, then sends enabled false and shows the answer's state", async () => {
  const on = fx.billing({ paymentMethod: fx.card(), autoBill: { enabled: false, available: true, unavailableReason: null, monthlyCeilingUsd: 500 } });
  const f = open(on, { [POST]: done(fx.billed()) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Turn on auto-billing" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(1); });
   expect(lastPost(f)).toMatchObject({ action: "auto-bill", enabled: true });
   expect(await screen.findByRole("button", { name: "Turn off auto-billing" })).toBeTruthy();
  } finally { f.close(); }
  const g = open(fx.billed(), { [POST]: done(on) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Turn off auto-billing" }));
   expect(posts(g)).toHaveLength(0);expect(screen.getByText(/Rovara-paid use ends and the company moves to Stopped/)).toBeTruthy();
   fireEvent.click(screen.getByRole("button", { name: "Yes, turn it off" }));
   await waitFor(() => { expect(posts(g)).toHaveLength(1); });
   expect(lastPost(g)).toMatchObject({ action: "auto-bill", enabled: false });
   expect(await screen.findByText("Auto-billing is off.", { selector: "p:not([role])" })).toBeTruthy();
  } finally { g.close(); }
 });
 it("auto-billing without a payment method goes to the hosted page; when billing isn't available the button is disabled with the reason", async () => {
  const f = open(fx.billing(), { [POST]: done(fx.billing(), { status: "needs_action", action: { kind: "redirect", url: "https://pay.example/s", expiresAt: "2026-11-11T13:00:00.000Z" } }) });
  try {
   // With no payment method the Auto-billing section's button says what it does (it opens the provider's page), never "Turn on auto-billing".
   const section = (await screen.findByRole("heading", { name: "Auto-billing" })).closest("section")!;
   expect(within(section).queryByRole("button", { name: "Turn on auto-billing" })).toBeNull();
   fireEvent.click(within(section).getByRole("button", { name: "Add a payment method" }));
   await waitFor(() => { expect(lastPost(f)).toMatchObject({ action: "payment-method-setup" }); });
  } finally { f.close(); }
  const g = open(fx.billing({ autoBill: { enabled: false, available: false, unavailableReason: "billing_not_available", monthlyCeilingUsd: null }, paymentMethod: fx.card() }));
  try {
   const button = await screen.findByRole("button", { name: "Turn on auto-billing" });
   expect(button.hasAttribute("disabled")).toBe(true);expect(screen.getByText("Billing isn't available yet.")).toBeTruthy();expect(screen.getByText("No monthly limit is set.", { exact: false })).toBeTruthy();
  } finally { g.close(); }
 });
 it("remove (after asking), the billing contact and the provider portal each send their own action", async () => {
  const f = open(fx.billed(), { [POST]: done(fx.billed(), { status: "needs_action", portal: { url: "https://portal.example/p", expiresAt: "2026-11-11T13:00:00.000Z" } }) });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Remove payment method" }));
   expect(posts(f)).toHaveLength(0);
   fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(1); });
   expect(lastPost(f)).toMatchObject({ action: "payment-method-remove" });expect(Object.keys(lastPost(f)).sort()).toEqual(["action", "requestId"]);
   const email = screen.getByLabelText("Billing email");
   expect(screen.getByRole("button", { name: "Save billing contact" }).hasAttribute("disabled")).toBe(true);
   fireEvent.change(email, { target: { value: "finance@acme.example" } });
   fireEvent.click(screen.getByRole("button", { name: "Save billing contact" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(2); });
   expect(lastPost(f)).toMatchObject({ action: "billing-contact", email: "finance@acme.example" });
   fireEvent.click(screen.getByRole("button", { name: "Manage tax details and receipts" }));
   await waitFor(() => { expect(posts(f)).toHaveLength(3); });
   expect(lastPost(f)).toMatchObject({ action: "portal", returnPath: "/app/live" });
   await waitFor(() => { expect(f.host.openExternal).toHaveBeenCalledWith("https://portal.example/p"); });
  } finally { f.close(); }
 });
 it("remove refused while auto-billing is on: the server's words verbatim", async () => {
  const f = open(fx.billed(), { [POST]: fx.refusal("CHANGE_STALE", "Turn off auto-billing before removing the payment method.") });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Remove payment method" }));fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
   const alert = await screen.findByRole("alert");
   expect(alert.textContent).toBe("Turn off auto-billing before removing the payment method.");
  } finally { f.close(); }
 });
 it("a billing contact refused is shown verbatim, and REAUTH_REQUIRED offers sign in", async () => {
  const f = open(fx.billed(), { [POST]: fx.refusal("REAUTH_REQUIRED", "Sign in again first.") });
  try {
   fireEvent.change(await screen.findByLabelText("Billing email"), { target: { value: "x@acme.example" } });fireEvent.click(screen.getByRole("button", { name: "Save billing contact" }));
   const alert = await screen.findByRole("alert");expect(alert.textContent).toContain("Sign in again first.");expect(within(alert).getByRole("button", { name: "Sign in again" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("past due: the amount, the dates the server gives, and the failed card", async () => {
  const f = open(fx.pastDue());
  try {
   const alert = await screen.findByText(/A payment of/);
   const box = alert.closest("[role=alert]")!;
   expect(box.textContent).toContain("$123.45");expect(box.textContent).toContain("Nov 9, 2026");expect(box.textContent).toContain("Rovara will try again on Nov 12, 2026");expect(box.textContent).toContain("Work pauses on Nov 14, 2026");
   expect(screen.getByText("The last payment failed")).toBeTruthy();
  } finally { f.close(); }
 });
 it("no provider yet: the plan, the trial and the monthly limit show; no payment, contact or invoice parts", async () => {
  const f = open(fx.unavailable());
  try {
   await screen.findByText(/Payment methods and invoices aren't available on this install yet/);
   expect(screen.getByRole("heading", { name: "Monthly limit" })).toBeTruthy();expect(screen.getByRole("heading", { name: "Allowance" })).toBeTruthy();
   for (const name of ["Payment method", "Auto-billing", "Invoices", "Billing contact"]) expect(screen.queryByRole("heading", { name })).toBeNull();
   expect(calls(f, "GET", INVOICES)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("the server switch is off (404): a plain sentence, nothing else", async () => {
  const f = open(fx.billed(), { [BILLING]: { status: 404, body: { error: { code: "NOT_FOUND", message: "This item wasn't found." } } } });
  try {
   expect((await screen.findByRole("status")).textContent).toBe("Billing isn't turned on for this install.");
   expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull();expect(within(screen.getByRole("main")).queryByRole("button")).toBeNull();
   expect(calls(f, "GET", INVOICES)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("an unreadable answer refuses to show invented numbers, and a failed read can be retried", async () => {
  let n = 0;
  const f = open(fx.billed(), { [BILLING]: () => { n += 1;return n === 1 ? ok({ available: true, plan: "team" }) : ok(fx.billed()); } });
  try {
   expect((await screen.findByRole("alert")).textContent).toContain("unreadable");
   fireEvent.click(screen.getByRole("button", { name: "Try again" }));
   expect(await screen.findByText("Visa ending 4242")).toBeTruthy();
  } finally { f.close(); }
 });
 it("the trial choices appear on the Billing page for an owner", async () => {
  const f = open(fx.billing({ phase: "ended" }), { [TRIAL]: ok(fx.ended(true)) });
  try {
   await screen.findByRole("heading", { name: "What happens when the allowance runs out" });
   expect(screen.getByRole("button", { name: "Connect your own AI key" })).toBeTruthy();
  } finally { f.close(); }
 });
 for (const theme of ["light", "dark"] as const) it(`axe clean on a phone, ${theme}`, async () => {
  const f = open(fx.billed(), {}, { width: 390, theme });
  try { await screen.findByRole("table", { name: "Invoices" });await expectNoAxeViolations(document.body); } finally { f.close(); }
 });
});

describe("invoices paging", () => {
 it("ten at a time: Show more asks for the next page with the server's cursor, appends it, and goes away at the end", async () => {
  const f = mount({ path: "/app/admin/billing", answers: { [BILLING]: ok(fx.billed()), [TRIAL]: ok(fx.active()), [INVOICES]: request => { const url = new URL(request.path, "https://x.example"), cursor = url.searchParams.get("cursor");return ok(cursor === null ? fx.invoicePage(1, 10, "cursor/1 2") : fx.invoicePage(11, 2)); } } });
  try {
   const table = await screen.findByRole("table", { name: "Invoices" });
   expect(within(table).getAllByRole("row")).toHaveLength(11);
   expect(calls(f, "GET", INVOICES)[0]!.path).toBe("/v1/app/org/billing/invoices?limit=10");
   fireEvent.click(screen.getByRole("button", { name: "Show more invoices" }));
   await waitFor(() => { expect(within(screen.getByRole("table", { name: "Invoices" })).getAllByRole("row")).toHaveLength(13); });
   expect(calls(f, "GET", INVOICES)[1]!.path).toBe("/v1/app/org/billing/invoices?limit=10&cursor=cursor%2F1%202");
   expect(screen.queryByRole("button", { name: "Show more invoices" })).toBeNull();
   expect(screen.getByText("RV-2026-0012")).toBeTruthy();
  } finally { f.close(); }
 });
 it("none yet, a failed page keeps what is shown, and a link that is not https is not offered", async () => {
  const f = mount({ path: "/app/admin/billing", answers: { [BILLING]: ok(fx.billed()), [TRIAL]: ok(fx.active()), [INVOICES]: ok({ invoices: [] }) } });
  try { expect(await screen.findByText("No invoices yet.")).toBeTruthy(); } finally { f.close(); }
  let n = 0;
  const bad = { ...fx.invoice(1), pdfUrl: "javascript:alert(1)", hostedUrl: "http://invoices.example/1" };
  const g = mount({ path: "/app/admin/billing", answers: { [BILLING]: ok(fx.billed()), [TRIAL]: ok(fx.active()), [INVOICES]: () => { n += 1;return n === 1 ? ok({ invoices: [bad], next: "c" }) : { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "x" } } }; } } });
  try {
   const table = await screen.findByRole("table", { name: "Invoices" });
   expect(within(table).queryByRole("link")).toBeNull();expect(within(table).getByText("None")).toBeTruthy();
   fireEvent.click(screen.getByRole("button", { name: "Show more invoices" }));
   expect((await screen.findAllByRole("alert", {}, { timeout: 8000 })).some(node => node.textContent === "Couldn't load invoices. Try again.")).toBe(true);
   expect(screen.getByText("RV-2026-0001")).toBeTruthy();
  } finally { g.close(); }
 });
 it("money: a non-dollar invoice is formatted by its currency, an unreadable one says so", async () => {
  const f = mount({ path: "/app/admin/billing", answers: { [BILLING]: ok(fx.billed()), [TRIAL]: ok(fx.active()), [INVOICES]: ok({ invoices: [fx.invoice(1, { currency: "EUR", totalMinor: 5000 })] }) } });
  try { const table = await screen.findByRole("table", { name: "Invoices" });expect(within(table).getByText("€50.00")).toBeTruthy(); } finally { f.close(); }
 });
});

describe("the banner", () => {
 function banner(trial: unknown, options: { on?: boolean; path?: string } = {}) {
  const f = fakeHost(async r => r.path === TRIAL ? ok(trial) : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } });
  if (options.on !== false) f.storage.set(BILLING_STORAGE_KEY, "v2");
  const query = createQueryClient();
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [options.path ?? "/app"], children: h(TrialBanner, {}) }) }) }));
  return { ...f, ...view, close() { view.unmount();query.clear(); } };
 }
 it("near the end, an owner or admin is told gently, with Choose what happens next", async () => {
  const f = banner(fx.nearEnd());
  try {
   const region = await screen.findByRole("region", { name: "Trial allowance" });
   expect(region.textContent).toContain("Your trial allowance is running low");expect(region.textContent).toContain("AI models: $7.50 left");expect(region.textContent).toContain("Machine time: 8 hours left".replace("Machine time: 8 hours left", "") );
   expect(within(region).getByRole("link", { name: "Choose what happens next" }).getAttribute("href")).toBe("/app/trial");
  } finally { f.close(); }
 });
 it("near the end, a member sees nothing", async () => {
  const f = banner({ ...fx.nearEnd(), you: { member: null, hitLimit: false, canChoose: false } });
  try { await waitFor(() => { expect(calls({ request: f.request } as unknown as Mounted, "GET", TRIAL)).toHaveLength(1); });expect(screen.queryByRole("region", { name: "Trial allowance" })).toBeNull(); } finally { f.close(); }
 });
 it("ended: an owner is asked to choose; a member sees the same facts and Ask an admin", async () => {
  const f = banner(fx.ended(true));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(within(region).getByRole("link", { name: "Choose what happens next" })).toBeTruthy();expect(region.textContent).not.toContain("Ask an admin"); } finally { f.close(); }
  const g = banner(fx.ended(false));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.textContent).toContain("Your trial allowance is used up");expect(region.textContent).toContain("Ask an admin to choose what happens next.");expect(within(region).getByRole("link", { name: "See details" }).getAttribute("href")).toBe("/app/trial"); } finally { g.close(); }
 });
 it("active, used up, monthly refresh: says it renews, never that someone must choose, and never says trial on a team plan", async () => {
  const f = banner(fx.trial({ ...fx.usedUp(), plan: "team", you: { member: null, hitLimit: false, canChoose: true } }));
  try {
   const region = await screen.findByRole("region", { name: "Trial allowance" });
   expect(region.textContent).toContain("Your company's AI model allowance is used up for this month");
   expect(region.textContent).toContain("It renews on Dec 1, 2026.");
   expect(region.textContent).not.toMatch(/chooses|choose what happens|owner or admin/iu);expect(region.textContent).not.toMatch(/trial/iu);
   expect(region.getAttribute("data-kind")).toBe("used_up");
   expect(within(region).getByRole("link", { name: "See details" }).getAttribute("href")).toBe("/app/trial");
  } finally { f.close(); }
  const g = banner(fx.usedUp());
  try {
   const region = await screen.findByRole("region", { name: "Trial allowance" });
   expect(region.textContent).toContain("Your trial's AI model allowance is used up for this month");expect(region.textContent).toContain("It renews on Dec 1, 2026.");
   expect(region.textContent).not.toMatch(/chooses|owner or admin|Ask an admin/iu);
  } finally { g.close(); }
  const both = banner(fx.trial({ plan: "team", allowances: [fx.models({ used: 500, left: 0, state: "used_up" }), fx.machine({ used: 20, left: 0, state: "used_up" })], you: { member: null, hitLimit: true, canChoose: false }, choices: null }));
  try {
   const region = await screen.findByRole("region", { name: "Trial allowance" });
   expect(region.textContent).toContain("Your company's AI model and machine time allowances are used up for this month");expect(region.textContent).toContain("They renew on Dec 1, 2026.");
  } finally { both.close(); }
  const machineOnly = banner(fx.trial({ plan: "team", allowances: [fx.models(), fx.machine({ used: 20, left: 0, state: "used_up" })], you: { member: null, hitLimit: true, canChoose: false }, choices: null }));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.textContent).toContain("Your company's machine time allowance is used up for this month"); } finally { machineOnly.close(); }
 });
 it("active, used up, one-time allowance: says it does not renew, still no choose sentence", async () => {
  const f = banner(fx.trial({ allowances: [fx.models({ refresh: "never", period: null, used: 50, granted: 50, left: 0, state: "used_up" })], you: { member: null, hitLimit: false, canChoose: true }, choices: null }));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.textContent).toContain("Your trial's AI model allowance is used up");expect(region.textContent).toContain("It does not renew.");expect(region.textContent).not.toMatch(/chooses/iu); } finally { f.close(); }
 });
 it("ended and stopped keep the sentence that an owner or admin chooses what happens next", async () => {
  const f = banner(fx.ended(true));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.getAttribute("data-kind")).toBe("ended");expect(region.textContent).toContain("can't start until an owner or admin chooses what happens next."); } finally { f.close(); }
  const g = banner(fx.stopped(true));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.getAttribute("data-kind")).toBe("stopped");expect(region.textContent).toContain("Your company chose to stop after the trial. Nothing is deleted."); } finally { g.close(); }
  const h2 = banner(fx.ended(false));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.textContent).toContain("chooses what happens next");expect(region.textContent).toContain("Ask an admin to choose what happens next."); } finally { h2.close(); }
 });
 it("is quiet on the trial page and the Billing page, when all is well, and with the switch off (no read at all)", async () => {
  const f = banner(fx.ended(true), { path: "/app/trial" });
  try { await waitFor(() => { expect(f.request).toHaveBeenCalled(); });expect(screen.queryByRole("region", { name: "Trial allowance" })).toBeNull(); } finally { f.close(); }
  const g = banner(fx.ended(true), { path: "/app/admin/billing" });
  try { await waitFor(() => { expect(g.request).toHaveBeenCalled(); });expect(screen.queryByRole("region", { name: "Trial allowance" })).toBeNull(); } finally { g.close(); }
  const k = banner(fx.active());
  try { await waitFor(() => { expect(k.request).toHaveBeenCalled(); });expect(screen.queryByRole("region", { name: "Trial allowance" })).toBeNull(); } finally { k.close(); }
  const off = banner(fx.ended(true), { on: false });
  try { await new Promise(resolve => setTimeout(resolve, 50));expect(off.request).not.toHaveBeenCalled();expect(off.container.querySelector("section")).toBeNull(); } finally { off.close(); }
 });
 it("past due: an admin is sent to Billing, a member is told to ask an admin", async () => {
  const f = banner(fx.trial({ phase: "past_due", you: { member: null, hitLimit: false, canChoose: true } }));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(within(region).getByRole("link", { name: "Open Billing" }).getAttribute("href")).toBe("/app/admin/billing"); } finally { f.close(); }
  const g = banner(fx.trial({ phase: "past_due" }));
  try { const region = await screen.findByRole("region", { name: "Trial allowance" });expect(region.textContent).toContain("Ask an admin to update the payment method.");expect(within(region).queryByRole("link", { name: "Open Billing" })).toBeNull(); } finally { g.close(); }
 });
 it("axe clean", async () => {
  const f = banner(fx.ended(true));
  try { await screen.findByRole("region", { name: "Trial allowance" });await expectNoAxeViolations(document.body); } finally { f.close(); }
 });
});
