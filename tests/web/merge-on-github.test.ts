// @vitest-environment jsdom
// L4-TA5 + DEC 254zzz94: each open pull request keeps an "Open on GitHub" link. The Merge button shows only when Code says this person may merge (the readiness read); with no readiness (a Code
// without the route, the default fake below) there is no button and nothing is ever pressed.
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
type Answer = { status: number; body: unknown };
function setup(task: Record<string, unknown>, answers: { readiness?: Answer; press?: Answer | (() => Promise<Answer>) } = {}) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({}, task));
  const notFound = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  const f = fakeHost(async (request) => {
    if (/\/merge$/u.test(request.path) && request.method === "GET") return answers.readiness ?? notFound;
    if (/\/merge$/u.test(request.path) && request.method === "POST") return typeof answers.press === "function" ? answers.press() : answers.press ?? notFound;
    return notFound;
  }), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, "Fix duplicate refunds"), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return { ...f, ...ui, close() { ui.unmount(); router.dispose(); query.clear(); } };
}
const mergeCalls = (f: ReturnType<typeof setup>) => f.request.mock.calls.map(([request]) => request).filter(request => /\/merge$/u.test(request.path) && request.method === "POST");

it("with no readiness from Code: no Merge button, the open pull request linked on GitHub, even when Code's view says it is ready", async () => {
  const f = setup({ pullRequests: [PR], merge: { ready: true } });
  const region = screen.getByRole("region", { name: "Merge" });
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  const link = screen.getByRole("link", { name: /Open on GitHub: acme\/payments #42/u });
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
  expect(screen.getByRole("link", { name: /Open on GitHub/u })).toBeTruthy();
  a.close();
  const b = setup({ pullRequests: [PR], merge: { ready: false, message: "Checks haven't passed on the latest code." } });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Not ready to merge.");
  expect(screen.getByText("Checks haven't passed on the latest code.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /merge/iu })).toBeNull();
  b.close();
});

it("offers one link per open pull request, none for merged or closed ones, and no section at all when nothing is open", () => {
  const a = setup({ pullRequests: [PR, { ...PR, repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }, { ...PR, number: 9, url: "https://github.com/acme/payments/pull/9", state: "merged" }, { ...PR, number: 10, url: "https://github.com/acme/payments/pull/10", state: "closed" }] });
  expect(screen.getAllByRole("link", { name: /Open on GitHub/u }).map(link => link.getAttribute("href"))).toEqual([PR.url, "https://github.com/acme/web/pull/7"]);
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
  expect(screen.queryByRole("link", { name: /Open on GitHub/u })).toBeNull();
  done.close();
  const open = setup({ pullRequests: [PR], mergeTracking: [tracked("open")] });
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("Checks passing. Approved. Head aaaaaaa. Branch up to date.");
  expect(screen.getByRole("link", { name: /Open on GitHub/u }).getAttribute("href")).toBe(PR.url);
  open.close();
});

it("never makes a link of an address that is not github.com (a pull request url Code sent that is something else shows as text)", () => {
  const f = setup({ pullRequests: [{ ...PR, url: "https://evil.example/acme/payments/pull/42" }] });
  expect(screen.queryByRole("link", { name: /Open on GitHub/u })).toBeNull();
  expect(screen.getByRole("region", { name: "Merge" }).textContent).toContain("acme/payments #42");
  f.close();
});

// DEC 254zzz94: the Merge button.
const READY = { mayMerge: true, ready: true, pullRequests: [{ repositoryId: "payments", number: 42, url: PR.url }] };

it("a person who may merge sees an enabled Merge button when Code says ready; pressing asks once and sends one request with one request id", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY }, press: { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 42 }] } } });
  const button = await screen.findByRole("button", { name: "Merge" });
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("link", { name: /Open on GitHub: acme\/payments #42/u })).toBeTruthy();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Press Merge" });
  fireEvent.click(confirm);fireEvent.click(confirm);
  expect(await screen.findByText("Merged payments #42.")).toBeTruthy();
  const presses = mergeCalls(f);
  expect(presses).toHaveLength(1);
  expect(Object.keys(presses[0]!.body as object)).toEqual(["requestId"]);
  expect((presses[0]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("not ready: the button is there but disabled, with Code's words; nothing is pressed", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { ...READY, ready: false, message: "Checks haven't passed on the latest code." } } });
  const button = await screen.findByRole("button", { name: "Merge" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Checks haven't passed on the latest code.")).toBeTruthy();
  expect(mergeCalls(f)).toHaveLength(0);
  f.close();
});

it("a person who may not merge sees no button, only the GitHub link", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { mayMerge: false, ready: false, pullRequests: READY.pullRequests } } });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => /\/merge$/u.test(request.path))).toBe(true));
  // Let the answer render before looking for the button.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  expect(screen.getByRole("link", { name: /Open on GitHub/u })).toBeTruthy();
  f.close();
});

it("a refused press shows Code's words and the next press uses a fresh request id", async () => {
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: READY }, press: { status: 409, body: { error: { code: "MERGE_NOT_READY", message: "GitHub isn't allowing this merge yet." } } } });
  for (let round = 0; round < 2; round += 1) {
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(mergeCalls(f)).toHaveLength(round + 1));
  }
  expect(screen.getByRole("alert").textContent).toContain("GitHub isn't allowing this merge yet.");
  const ids = mergeCalls(f).map(call => (call.body as { requestId: string }).requestId);
  expect(new Set(ids).size).toBe(2);
  f.close();
});

it("the press carries the heads and risk Code showed; a lost answer keeps the request id, so pressing again is the same press", async () => {
  const HEAD = { repositoryId: "payments", number: 42, headSha: "a".repeat(40) };
  let first = true;
  const f = setup({ pullRequests: [PR] }, { readiness: { status: 200, body: { ...READY, risk: "medium", heads: [HEAD] } }, press: async () => {
    if (first) { first = false; return { status: 503, body: { error: { code: "MERGE_FAILED", message: "We couldn't confirm the result yet; checking GitHub. Reload this page in a moment." } } }; }
    return { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "payments", number: 42 }] } };
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }));
  expect(await screen.findByText("Merged payments #42.")).toBeTruthy();
  const bodies = mergeCalls(f).map(call => call.body as { requestId: string; expectedHeads?: unknown; risk?: string });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual({ requestId: bodies[0]!.requestId, expectedHeads: [HEAD], risk: "medium" });
  expect(bodies[1]!.requestId).toBe(bodies[0]!.requestId);
  f.close();
});
