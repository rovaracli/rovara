// @vitest-environment jsdom
// L4-TA5: Cloud has no Merge press (no /merge route, Code's hosted root does not wire the merge core), so the session page shows no Merge button and
// never calls `/merge`: each open pull request is a "Merge on GitHub" link instead.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";

type Pull = { repository: string; number: number; url: string; state: "open" | "closed" | "merged" };
const PR: Pull = { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" };
function setup(task: Record<string, unknown>) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({}, task));
  const f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } })), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, "Fix duplicate refunds"), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return { ...f, ...ui, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const mergeCalls = (f: ReturnType<typeof setup>) => f.request.mock.calls.map(([request]) => request).filter(request => /\/merge$/u.test(request.path));

it("has no Merge button and links the open pull request on GitHub, even when Code's view says it is ready", async () => {
  const f = setup({ pullRequests: [PR], merge: { ready: true } });
  const region = screen.getByRole("region", { name: "Merge" });
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  const link = screen.getByRole("link", { name: /Merge on GitHub: acme\/payments #42/u });
  expect(link.getAttribute("href")).toBe(PR.url);
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(region.textContent).toContain("Ready to merge");
  expect(mergeCalls(f)).toHaveLength(0);
  await expectNoAxeViolations(f.container);
  f.close();
});

it("shows the section for a hosted task whose view carries no merge field at all (the case today) and names the not-ready words when Code sends them", () => {
  const a = setup({ pullRequests: [PR] });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Merge it on GitHub");
  expect(screen.getByRole("link", { name: /Merge on GitHub/u })).toBeTruthy();
  a.close();
  const b = setup({ pullRequests: [PR], merge: { ready: false, message: "Checks haven't passed on the latest code." } });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Not ready to merge.");
  expect(screen.getByText("Checks haven't passed on the latest code.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  b.close();
});

it("offers one link per open pull request, none for merged or closed ones, and no section at all when nothing is open", () => {
  const a = setup({ pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }, { ...PR, number: 9, url: "https://github.com/acme/payments/pull/9", state: "merged" }, { ...PR, number: 10, url: "https://github.com/acme/payments/pull/10", state: "closed" }] });
  expect(screen.getAllByRole("link", { name: /Merge on GitHub/u }).map(link => link.getAttribute("href"))).toEqual([PR.url, "https://github.com/acme/web/pull/7"]);
  a.close();
  const b = setup({ pullRequests: [{ ...PR, state: "merged" }] });
  expect(screen.queryByRole("region", { name: "Merge" })).toBeNull();
  b.close();
  const c = setup({ pullRequests: [] });
  expect(screen.queryByRole("region", { name: "Merge" })).toBeNull();
  c.close();
});

const tracked = (state: "open" | "merged") => ({ orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: "a".repeat(40), draft: false, state, baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" });

it("says Merged, and offers no link, once Code's own tracking shows every pull request merged; an open tracked one keeps its words and link", () => {
  const done = setup({ pullRequests: [PR], mergeTracking: [tracked("merged")] });
  expect(screen.getByRole("region", { name: "Merge" }).querySelector(".rv-merge-state")!.textContent).toBe("Merged");
  expect(screen.queryByRole("link", { name: /Merge on GitHub/u })).toBeNull();
  done.close();
  const open = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Checks passing. Approved. Head aaaaaaa. Branch up to date.");
  expect(screen.getByRole("link", { name: /Merge on GitHub/u }).getAttribute("href")).toBe(PR.url);
  open.close();
});

it("never makes a link of an address that is not github.com (a pull request url Code sent that is something else shows as text)", () => {
  const f = setup({ pullRequests: [{ ...PR, url: "https://evil.example/acme/payments/pull/42" }] });
  expect(screen.queryByRole("link", { name: /Merge on GitHub/u })).toBeNull();
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("acme/payments #42");
  f.close();
});
