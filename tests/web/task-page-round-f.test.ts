// @vitest-environment jsdom
// Round F: the changed-head merge state has ONE "Check again" (the duplicate "Check the pull request again" is gone), the workspace menu and merge dialog close with the shared X icon,
// and the comment-only Talk composer is docked to the bottom of the sheet (the review's 1k, 3f and 1d gaps).
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
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const tracked = (state: "open" | "merged") => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: "a".repeat(40), draft: false, state, baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" });
function setup(task: Record<string, unknown>, readiness: { status: number; body: unknown }) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({}, task));
  const notFound = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/me") return { status: 200, body: { developer: { id: "a1".repeat(32), name: "Ana", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } };
    if (/\/sessions\/[^/]+$/u.test(request.path) && request.method === "GET") return { status: 200, body: { session } };
    if (/\/merge$/u.test(request.path) && request.method === "GET") return readiness;
    return notFound;
  }), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, "Fix duplicate refunds"), h(TaskPageBoundary, { children: h(Workspace, { session }) })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  const reads = () => f.request.mock.calls.map(([request]) => request).filter(request => /\/merge$/u.test(request.path) && request.method === "GET").length;
  return { ...f, ...ui, reads, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const drifted = { mayMerge: true, ready: true, risk: "low" as const, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_B }], pullRequests: [{ repositoryId: "acme/payments", number: 42, url: PR.url }] };

it("3f: the pull request changed after it was checked shows ONE Check again, and it reads again without sending a merge", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { status: 200, body: drifted });
  await screen.findByRole("button", { name: /^Merge #42/u });
  const region = screen.getByRole("region", { name: "Merge" });
  expect(region.querySelector(".rv-merge-state")!.textContent).toBe("The pull request changed after it was checked");
  expect(within(region).getAllByRole("button", { name: /^Check/u }).map(button => button.textContent)).toEqual(["Check again"]);
  expect(region.textContent).not.toContain("Check the pull request again");
  const before = f.reads();
  fireEvent.click(within(region).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(f.reads()).toBeGreaterThan(before));
  expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(0);
  f.close();
});

it("1d / 3g: the merge dialog is a shared Dialog whose close is the shared icon button, styled as the Talk sheet's X (never a text glyph)", async () => {
  const f = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] }, { status: 200, body: { ...drifted, heads: [{ repositoryId: "acme/payments", number: 42, headSha: HEAD_A }] } });
  fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.classList.contains("rv-merge-dialog")).toBe(true);
  const close = within(dialog).getByRole("button", { name: "Close dialog" });
  expect(close.classList.contains("rv-icon-button")).toBe(true);
  f.close();
});

const css = readFileSync("packages/ui/src/screens/session/task-page.css", "utf8");
it("1d: the workspace menu and merge dialog close buttons are drawn as the X icon, and the Home item shows its ring only for the keyboard", () => {
  expect(css).toMatch(/\.rv-workspace-menu \.rv-dialog-heading>\.rv-button-with-reason>button::before[^{]*\{[^}]*mask:url\("data:image\/svg\+xml,[^}]*M6 6l12 12M18 6L6 18/u);
  expect(css).toMatch(/\.rv-merge-dialog \.rv-dialog-heading>\.rv-button-with-reason>button::before/u);
  expect(css).toMatch(/\.rv-workspace-menu a:focus:not\(:focus-visible\)\{outline:none/u);
});
it("1k: the comment-only composer is docked (margin-top:auto) in the Talk sheet", () => {
  expect(css).toMatch(/\.rv-conversation-tray:has\(\.rv-talk-note\)>\.rv-talk-dock-plain>#task-talk:has\(\.rv-composer:not\(\.rv-composer-collapsed\)\)\{margin-top:auto\}/u);
});
