// @vitest-environment jsdom
// WIRING-1B: the rebuilt company money / AI pages (G2) own the REAL report, feature, AI, source-order and Product AI addresses, lazily, and nothing old is mounted there.
// The G2 journeys themselves run on the real router too: G2_REAL_ROUTES=1 npx vitest run tests/web/read-only/company-money-ai-read (harness.ts mountReal).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RouteObject } from "react-router";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { mountReal } from "./read-only/company-money-ai-read/harness.js";
import { FEATURE, reply, scope } from "./read-only/company-money-ai-read/fixtures.js";
import type { AdminContext } from "../../packages/ui/src/screens/admin/admin-context.js";

beforeEach(() => localStorage.clear());
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false } as const;
const walk = (routes: RouteObject[], found = new Map<string, RouteObject>()): Map<string, RouteObject> => { for (const route of routes) { if (route.path !== undefined) found.set(route.path, route); if (route.children) walk(route.children, found); } return found; };
const REAL = [
 ["/app/admin/money/report?range=all", "Money", "Refunds"],
 [`/app/admin/money/report/features/${FEATURE}?range=all`, "Manage features", "Handle duplicate refunds"],
 ["/app/admin/ai-spending", "AI and spending", "fixture-model"],
 ["/app/admin/ai-spending/order", "Order of AI sources", "Your Anthropic key"],
 ["/app/admin/product-ai", "Product AI keys", "Key connected"],
] as const;
describe("the real router mounts the rebuilt company money / AI pages", () => {
 it.each(["owner", "admin"] as const)("renders every rebuilt page at its real address for an %s, through the shell and the admin layout", async role => {
  for (const [path, heading, fact] of REAL) {
   const f = mountReal(path, async request => reply(request), { ...scope, role });
   try {
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
    expect((await screen.findAllByText(fact, { exact: true })).length).toBeGreaterThan(0);
    // The rebuilt pages sit in the G2 entry (access check, action host), inside the real admin layout and the real shell.
    expect(document.querySelector("section.rv-company-money-ai-read")).not.toBeNull();
    expect(document.querySelector(".rv-app-shell")).not.toBeNull();
    expect(f.router.state.location.pathname + f.router.state.location.search).toBe(path);
   } finally { f.view.unmount(); f.router.dispose(); f.client.clear(); }
  }
 });
 it("mounts no old screen at those addresses: no stat tiles, no old report title, no old AI settings stack (the editors live in dialogs)", async () => {
  const seen: Array<[string, () => void]> = [
   ["/app/admin/money/report?range=all", () => { expect(screen.queryByTestId("report-error")).toBeNull(); expect(screen.queryByRole("group", { name: "Cost and time in this range" })).toBeNull(); }],
   [`/app/admin/money/report/features/${FEATURE}?range=all`, () => { expect(screen.queryByTestId("report-error")).toBeNull(); expect(screen.queryByRole("heading", { name: "Cost and time", level: 1 })).toBeNull(); }],
   ["/app/admin/ai-spending", () => { expect(screen.queryByTestId("ai-spend-step")).toBeNull(); expect(screen.queryByRole("region", { name: "Company AI connections" })).toBeNull(); expect(screen.queryByLabelText(/Company monthly limit/u)).toBeNull(); }],
   ["/app/admin/product-ai", () => expect(screen.queryByRole("heading", { name: "Product AI keys", level: 1 })).not.toBeNull()],
  ];
  for (const [path, absent] of seen) {
   const f = mountReal(path, async request => reply(request));
   try { await screen.findByRole("heading", { level: 1 }); await waitFor(() => expect(document.querySelector("section.rv-company-money-ai-read")).not.toBeNull()); absent(); } finally { f.view.unmount(); f.router.dispose(); f.client.clear(); }
  }
 });
 it("old model and agent addresses redirect to the AI page section they moved to, keeping the query", async () => {
  const cases: Array<[string, string, string]> = [["/app/admin/models/sources?from=old", "?from=old", "#ai-connections"], ["/app/admin/models/available?from=old", "?from=old", "#ai-models"], ["/app/admin/agent-ai?x=1", "?x=1", "#ai-connections"], ["/app/admin/learning-ai?x=1", "?x=1", "#ai-connections"], ["/app/admin/second-review", "", "#ai-models"], ["/app/agents/new?x=1", "?x=1", "#ai-models"]];
  for (const [from, search, hash] of cases) {
   const f = mountReal(from, async request => reply(request));
   try {
    await screen.findByRole("heading", { name: "AI and spending", level: 1 });
    expect(f.router.state.location).toMatchObject({ pathname: "/app/admin/ai-spending", search, hash });
   } finally { f.view.unmount(); f.router.dispose(); f.client.clear(); }
  }
 });
 it("every rebuilt address is a lazy route with no element, and the router source imports none of the screens statically", () => {
  const routes = walk(appRoutes(features));
  for (const path of ["admin/ai-spending", "money/report", "money/report/features/:id", "ai-spending/order", "product-ai"]) {
   const route = routes.get(path);
   expect(route, path).toBeDefined();
   expect(typeof route?.lazy, path).toBe("function");
   expect(route?.element, path).toBeUndefined();
  }
  const source = readFileSync("packages/ui/src/routes.tsx", "utf8") + readFileSync("packages/ui/src/routes/company-money-ai-read-routes.tsx", "utf8");
  expect(source).not.toMatch(/^import (?!type)[^\n]*screens\/(company-money-ai-read|admin\/(report|ai-spending|product-ai))/mu);
  for (const old of ["CostReportScreen", "FeatureDetailScreen", "AiSpendingScreen", "ProductAiScreen"]) expect(source).not.toContain(old);
 });
 it("a company member reads the existing read-only AI page and sees no write control or report read", async () => {
  const member: AdminContext = { ...scope, role: "member" };
  const f = mountReal("/app/admin/ai-spending", async request => reply(request), member);
  try {
   expect(await screen.findByRole("heading", { name: "AI and spending", level: 1 })).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Change order" })).toBeNull();
   expect(screen.queryByRole("button", { name: "Change a model" })).toBeNull();
   expect(f.requests.some(request => request.method !== "GET")).toBe(false);
   expect(f.requests.some(request => request.path.startsWith("/v1/app/org/report"))).toBe(false);
  } finally { f.view.unmount(); f.router.dispose(); f.client.clear(); }
 });
 it("the admin navigation still links the money and AI pages, and an admin reaches the report from it", async () => {
  const f = mountReal("/app/admin/money/report?range=all", async request => reply(request));
  try {
   await screen.findByRole("heading", { name: "Money", level: 1 });
   const nav = screen.getByRole("navigation", { name: "Administration" });
   const hrefs = Array.from(nav.querySelectorAll("a")).map(link => link.getAttribute("href"));
   for (const href of ["/app/admin/money/report", "/app/admin/ai-spending", "/app/admin/product-ai"]) expect(hrefs).toContain(href);
  } finally { f.view.unmount(); f.router.dispose(); f.client.clear(); }
 });

 // Found by the browser spec on the real route: a refusal re-reads the report, and while that read ran the page unmounted the action (its open confirm and Cloud's sentence with it).
 it.each(["report", "feature"] as const)("a refused %s change keeps its confirm open with the server's sentence while the page reads again", async area => {
  let release: (() => void) | undefined, reads = 0, writes = 0;
  void reads;
  const sentence = "A feature with that name already exists.";
  const f = mountReal(area === "report" ? "/app/admin/money/report?range=all" : `/app/admin/money/report/features/${FEATURE}?range=all`, async request => {
   if (request.method !== "GET") { writes++; return { status: 400, body: { error: { code: "CONFIG_INVALID", message: sentence } } }; }
   // The action host reads before it sends; only the reads after the refusal are held.
   if (request.path.startsWith("/v1/app/org/report") && writes > 0) { reads++; await new Promise<void>(resolve => { release = resolve; }); }
   return reply(request);
  });
  try {
   fireEvent.click(await screen.findByRole("button", { name: area === "report" ? "New feature" : "Rename" }));
   const dialog = await screen.findByRole("dialog");
   fireEvent.change(within(dialog).getByLabelText("Feature name"), { target: { value: "Search" } });
   fireEvent.click(within(dialog).getByRole("button", { name: area === "report" ? "Make feature" : "Rename" }));
   // The report is read again after the refusal and that read is still running: the confirm and the sentence stay.
   await waitFor(() => expect(release).toBeDefined());
   expect((await within(screen.getByRole("dialog")).findByTestId("report-action-error")).textContent).toBe(sentence);
   expect(writes).toBe(1);
   release?.();
   await waitFor(() => expect(within(screen.getByRole("dialog")).getByTestId("report-action-error").textContent).toBe(sentence));
  } finally { release?.(); f.view.unmount(); f.router.dispose(); f.client.clear(); }
 });
});
