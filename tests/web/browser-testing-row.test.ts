// @vitest-environment jsdom
// Browser testing's row of the project's setup checklist (the approved mock: checklist-none / -waiting / -on): optional, not counted in the progress, words from the page's own read, absent while Code does not serve it.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { BrowserTestingRow } from "../../packages/ui/src/screens/setup/browser-testing/BrowserTestingRow.js";
import { BT } from "../../packages/ui/src/screens/setup/browser-testing/browser-testing-text.js";
import { btView, candidate, draft, found } from "./support/browser-testing-fixtures.js";
import { PATH, fail, ok } from "./support/browser-testing-world.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);
const checklist = (percent = 38) => ({
  project: "payments", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: percent >= 100 ? 8 : 3, total: 8, percent, nextRequired: percent >= 100 ? null : "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "payments", fullName: "acme/payments", defaultBranch: "main" }] },
  setupRun: { state: "done", status: "ready", approval: "approved", check: { status: "ready" }, startedAt: "2026-11-18T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed" },
  evalConfirm: percent >= 100 ? { state: "done", report: "confirmed", confirmedSelection: "npm test" } : { state: "needs_you", report: "none" },
  aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: percent >= 100 ? { state: "done", hasTask: true, canStart: false } : { state: "needs_you", hasTask: false, canStart: false },
});
function mount(read: () => ReturnType<typeof ok>, percent = 38) {
  const f = fakeHost(async (request) => {
    if (request.path === "/v1/app/projects/payments/setup-status") return ok(checklist(percent));
    if (request.path === PATH) return read();
    return fail(404, "NOT_FOUND", "route not found");
  });
  const query = createQueryClient();
  renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(ProjectChecklist, { project: "payments" }) }) }) }), { theme: "light" });
  return f;
}
const row = async () => {
  const one = await screen.findByTestId("checklist-row-browserTesting");
  await waitFor(() => expect(screen.getByTestId("checklist-row-browserTesting").textContent).not.toContain(BT.reading), { timeout: 5000 });
  return one;
};

describe("the row", () => {
  it.each([
    ["not set up", btView("not-set-up"), "Optional", BT.rowNone, BT.rowSetUp],
    ["waiting for approval", btView("waiting"), "Waiting for approval", "Waiting for an owner or admin to approve.", BT.rowReview],
    ["on", btView("on"), "On", "Rovara signs in as admin and viewer, with a fresh test login for each check.", BT.rowOpen],
    ["on with a change waiting", btView("on", { newerChange: { kind: "repo", found: found(), newUserKinds: ["editor"], removedUserKinds: [], proof: { screenshotMode: "failed", video: false }, runTimeoutMs: 600_000 }, draft: draft(), candidate: candidate() }), "Change waiting", "A change is waiting for approval.", BT.rowReviewChange],
    ["paused", btView("paused"), "Paused", "Tasks started from now on get no browser checks.", BT.rowOpen],
    ["a fault", btView("on", { faults: ["accounts-refresh-failed"] }), "Needs attention", BT.rowFault, BT.rowOpen],
  ])("%s: the pill, the sentence and the one link to the page", async (_name, view, pill, text, link) => {
    const f = mount(() => ok(view));
    const one = await row();
    expect(one.querySelector(".rv-status-pill")?.textContent).toBe(pill);
    expect(within(one).getByTestId("browser-testing-row-text").textContent).toContain(text);
    const anchor = within(one).getByRole("link", { name: link });
    expect(anchor.getAttribute("href")).toBe("/app/projects/payments/browser-testing");
    expect(within(one).queryAllByRole("button")).toHaveLength(0);
    expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
  });
  it("a person who may not change it is offered to open the page, never to set it up or approve", async () => {
    mount(() => ok(btView("waiting", { canManage: false, viewerRole: "member" })));
    const one = await row();
    expect(within(one).getByRole("link", { name: BT.rowOpen })).toBeTruthy();
    expect(within(one).queryByRole("link", { name: BT.rowReview })).toBeNull();
  });
  it("is not counted in the progress (Code's number is shown as served) and is absent while Code does not serve the page", async () => {
    mount(() => ok(btView("on")));
    await row();
    expect(screen.getByTestId("checklist-progress").textContent).toContain("38% done (3 of 8)");
    cleanup();
    mount(() => fail(501, "NOT_ON_CODE_YET", "Browser testing isn't available on this Rovara yet."));
    await screen.findByTestId("project-checklist");
    await waitFor(() => expect(screen.queryByTestId("checklist-row-browserTesting")).toBeNull());
  });
  it("stays reachable once the checklist is finished (on its own), for people who may change the project", async () => {
    mount(() => ok(btView("on")), 100);
    expect(await screen.findByTestId("project-browser-testing-only")).toBeTruthy();
  });
  it("a read that fails says so and offers to try again; the row is not hidden by a transient failure", async () => {
    mount(() => fail(503, "RUNTIME_UNAVAILABLE", "Browser testing could not be read just now. Try again."));
    const one = await screen.findByTestId("checklist-row-browserTesting");
    await waitFor(() => expect(within(one).getByTestId("browser-testing-row-error")).toBeTruthy());
  });
  it("the standalone row is exported with a production importer", () => {
    expect(BrowserTestingRow).toBeTypeOf("function");
  });
});
