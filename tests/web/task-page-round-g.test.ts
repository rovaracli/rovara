// @vitest-environment jsdom
// Round G: the merge receipt's Plan row shows the plan version the plan document serves (or one Unknown when it is not served); the receipt says when GitHub confirmed the merge once;
// the open merge panel labels its two different times differently; and the 1e keyboard-open and 768 tab-row rules exist.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });
const PR = { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" as const };
const HEAD_A = "a".repeat(40);
const tracked = (state: "open" | "merged") => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: "a".repeat(40), draft: false, state, baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" });
function setup(task: Record<string, unknown>, readiness: { status: number; body: unknown }, plan: { status: number; body: unknown } = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } }) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({}, task));
  const notFound = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: { developer: { id: "a1".repeat(32), name: "Ana", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } };
    if (/\/sessions\/[^/]+$/u.test(request.path) && request.method === "GET") return { status: 200, body: { session } };
    if (/\/merge$/u.test(request.path) && request.method === "GET") return readiness;
    if (request.path.endsWith("/documents/plan")) return plan;
    return notFound;
  }), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, "Fix duplicate refunds"), h(TaskPageBoundary, { children: h(Workspace, { session }) })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  const reads = () => f.request.mock.calls.map(([request]) => request).filter(request => /\/merge$/u.test(request.path) && request.method === "GET").length;
  return { ...f, ...ui, reads, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const merged = { status: "SUCCEEDED", pullRequests: [{ ...PR, state: "merged" as const }], mergeTracking: [tracked("merged")], merge: { ready: true } };
const PLAN = { status: 200, body: { taskId: "11111111-1111-4111-8111-111111111111", document: "plan", current: true, version: 4, requirements: [], tasks: [], questions: [] } };
const noReadiness = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
const factRow = (region: HTMLElement, label: string) => [...region.querySelectorAll(".rv-merge-facts > div")].find(row => row.querySelector("dt")!.textContent === label);

it("3h: the receipt's Plan row shows the served plan version, never Unknown beside a known version", async () => {
  const f = setup(merged, noReadiness, PLAN);
  const region = await screen.findByRole("region", { name: "Merge" });
  await waitFor(() => expect(factRow(region, "Plan")?.querySelector("dd")?.textContent).toBe("v4"));
  f.close();
});
it("3h: with no plan served the Plan row is one Unknown", async () => {
  const f = setup(merged, noReadiness);
  const region = await screen.findByRole("region", { name: "Merge" });
  await waitFor(() => expect(factRow(region, "Merge commit")).toBeDefined());
  expect(within(factRow(region, "Plan") as HTMLElement).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
  f.close();
});
it("3h: GitHub's confirmation time is said once on the receipt (no second Confirmed at row)", async () => {
  const f = setup(merged, noReadiness, PLAN);
  const region = await screen.findByRole("region", { name: "Merge" });
  await waitFor(() => expect(factRow(region, "Merge commit")).toBeDefined());
  expect(factRow(region, "Confirmed at")).toBeUndefined();
  const instant = new Date("2026-10-23T12:00:00.000Z");
  const localDate = instant.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const localTime = instant.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  expect(region.textContent).toContain("Confirmed by GitHub at " + localDate + ", " + localTime);
  f.close();
});
it("3g: the two different times carry two different labels (merge check read vs last seen on GitHub)", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { status: 200, body: { mayMerge: true, ready: true, risk: "low", heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }], pullRequests: [{ repositoryId: "acme/payments", number: 42, url: PR.url }] } });
  await screen.findByRole("button", { name: /^Merge #42/u });
  const region = () => screen.getByRole("region", { name: "Merge" });
  await waitFor(() => expect(region().textContent).toMatch(/Merge check read at \d/u));
  expect(factRow(region(), "Last seen on GitHub")).toBeDefined();
  // The base branch is served, so the Base row names it (no Unknown beside "Merge #42 into main").
  expect(factRow(region(), "Base")?.querySelector("dd")?.textContent).toBe("main");
  expect(within(factRow(region(), "Base") as HTMLElement).queryAllByRole("img", { name: "Unknown" })).toHaveLength(0);
  expect(region().textContent).not.toContain("Looked at");
  expect(region().textContent).not.toContain("Read by Rovara at");
  f.close();
});

const css = readFileSync("packages/ui/src/screens/session/task-page.css", "utf8");
it("1e: a phone with the keyboard open (short window) tightens the docked composer: counter beside Send, one Earlier line, no held row", () => {
  expect(css).toMatch(/@media\(max-width:639px\) and \(max-height:560px\)\{/u);
  const block = css.slice(css.indexOf("@media(max-width:639px) and (max-height:560px){"));
  expect(block).toMatch(/\.rv-composer-footer\{flex-wrap:nowrap/u);
  expect(block).toMatch(/>\.rv-task-held\{display:none\}/u);
});
it("768: the Talk tab row does not wrap on a wide screen", () => {
  expect(css).toMatch(/@media\(min-width:640px\)\{\s*\.rv-task-rebuild-conversation \.rv-composer-modes \.rv-button\{white-space:nowrap/u);
});
it("320: the date line in a message card may wrap, so it never runs under the kind chip", () => {
  expect(css).toMatch(/@media\(max-width:359px\)\{\s*\.rv-task-rebuild-conversation \.rv-message-top>\[data-testid=talk-comment-provenance\]>span[^{]*\{white-space:normal/u);
});

it("M4: unserved Merged by and Checks and reviews stay Unknown on the merge receipt", async () => {
 const f = setup(merged, noReadiness);
 const region = await screen.findByRole("region", { name: "Merge" });
 await waitFor(() => expect(factRow(region, "Merge commit")).toBeDefined());
 for (const label of ["Merged by", "Checks and reviews"]) {
  const row = factRow(region, label)!;
  expect(row.querySelector("dd")?.textContent).toContain("Unknown");
  expect(within(row as HTMLElement).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 }
 f.close();
});
it.each(["unknown", "accepted"] as const)("%s merge with blocked results shows ONE Check again which only reads", async kind => {
 const subject = "org_aaaaaaaaaaaaaaaaaaaa|" + "a1".repeat(32) + "|" + SESSION_FIXTURE_ID;
 const heads = [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }];
 if (kind === "unknown") localStorage.setItem("rovara.merge.pending.v1:" + subject, JSON.stringify({ v: 1, sessionId: subject, requestId: "33333333-3333-4333-8333-333333333333", startedAt: new Date().toISOString(), heads, risk: "low", sent: [] }));
 else localStorage.setItem("rovara.merge.accepted.v1:" + subject, JSON.stringify({ v: 1, subject, requestId: "66666666-6666-4666-8666-666666666666", acceptedAt: new Date().toISOString(), words: "Merged acme/payments #42.", keys: ["acme/payments#42"], heads }));
 const f = setup({ pullRequests: [PR], mergeTracking: [{ ...tracked("open"), ci: "failing", failingChecks: ["refund test"] }] }, { status: 200, body: { mayMerge: true, ready: false, risk: "low", heads, pullRequests: [{ repositoryId: "acme/payments", number: 42, url: PR.url }] } });
 const region = await waitFor(() => { const current = screen.getByRole("region", { name: "Merge" });expect(current.getAttribute("data-state")).toBe(kind);return current; });
 expect(within(region).getAllByRole("button", { name: "Check again" })).toHaveLength(1);
 const before = f.reads(), sessionReads = () => f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith("/sessions/" + SESSION_FIXTURE_ID)).length, beforeSession = sessionReads();
 fireEvent.click(within(region).getByRole("button", { name: "Check again" }));
 await waitFor(() => { if (kind === "unknown") expect(f.reads()).toBeGreaterThan(before);expect(sessionReads()).toBeGreaterThan(beforeSession); });
 expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
 expect(within(region).getAllByRole("button", { name: "Check again" })).toHaveLength(1);
 f.close();
});
