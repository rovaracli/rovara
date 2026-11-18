// @vitest-environment jsdom
// L4-T2c (pairs with Code #1063): the Setup run row of a project whose setup was approved earlier. A re-run's proposal that waits, is being checked or was rejected never takes the approval away: the row stays Done
// (the approved setup's own check), says so in Cloud's fixed words, and a waiting proposal gets the same approve card a first proposal gets. A Code that sends no `newerProposal` reads as before.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { NEWER_PROPOSAL_WORDS } from "../../packages/ui/src/screens/setup/SetupRunRow.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture } from "./support/fixtures.js";

afterEach(cleanup);
const ME = "a".repeat(64), DIGEST = "ab12".repeat(16);
type Plain = Record<string, unknown>;
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const apply = (over: Plain = {}) => ({
  candidateRevision: 4, baseRevision: 3, setup: ["npm ci"], readiness: ["npm test"], check: { status: "ready" }, risk: "low",
  changes: [{ area: "setup_commands", risk: "low" }, { area: "test_commands", risk: "low" }], approver: "maintainer", canApprove: true, canReject: true,
  approval: { requestId: `setup-${DIGEST.slice(0, 40)}-4`, revision: 4, artifactDigest: DIGEST, kind: "setup", risk: "low" }, ...over,
});
const agent = (over: Plain = {}) => ({ status: "ready", basedOnRevision: 3, limits: LIMITS, canManage: true, stop: "proposed", ...over });
/** The checklist of a project whose approved setup is Done. */
const checklist = (setupRun: Plain, percent = 62) => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: percent >= 100 ? 5 : 3, total: 8, percent, nextRequired: percent >= 100 ? null : "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { state: "done", status: "ready", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z", startedAt: "2026-11-17T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed", ...setupRun },
  evalConfirm: { state: "done", report: "no_evals", noEvals: { confirmedAt: "2026-11-12T10:00:00.000Z" } }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "done", hasTask: true, canStart: true },
});

function mount(list: unknown, read?: unknown) {
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-status") return { status: 200, body: list };
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return read === undefined ? { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } } : { status: 200, body: { ...(read as object), requestId: "gw" } };
    if (request.path === "/v1/app/projects/web/setup-agent/journal") return { status: 200, body: { status: "ready", entries: [], hostAsks: [], requestId: "gw" } };
    if (request.path === "/v1/app/nav") return { status: 200, body: { ...navFixture(), projects: [{ name: "web", agents: [] }] } };
    if (request.path === "/v1/app/projects/web/slack/channel") return { status: 200, body: { connected: false, channels: [] } };
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
  });
  const query = createQueryClient();
  query.setQueryData(["nav"], { me: { developerId: ME, name: "Maya", orgRole: "owner" } });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/web"], children: h(ProjectChecklist, { project: "web" }) }) }) }), { theme: "light" });
  return { ...f, close() { ui.unmount(); query.clear(); } };
}
const row = async () => { await screen.findByTestId("project-checklist"); return screen.getByTestId("checklist-row-setupRun"); };

describe("a newer setup proposal beside the approved setup (L4-T2c)", () => {
  it("the fixed words are exactly these three", () => {
    expect(NEWER_PROPOSAL_WORDS).toEqual({
      needs_you: "A newer setup proposal is waiting for review",
      checking: "A newer setup proposal is being checked on a fresh machine",
      rejected: "A newer setup proposal was rejected; the approved setup is still in use",
    });
  });

  it("waiting for review: the row stays Done, says a newer proposal waits, and shows the same approve card", async () => {
    const f = mount(checklist({ newerProposal: "needs_you" }), agent({ apply: apply() }));
    const item = await row();
    const line = await within(item).findByTestId("setup-run-newer-proposal");
    expect(line.textContent).toBe("A newer setup proposal is waiting for review");
    expect(item.getAttribute("data-state")).toBe("done");
    const card = await within(item).findByTestId("setup-approval");
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeTruthy();
    // The approved setup is still told, and the first-proposal line is not said twice.
    expect(within(item).getByTestId("setup-run-approved").textContent).toBe("Setup approved on Nov 12. Checked on a fresh machine.");
    expect(within(item).queryByTestId("setup-run-needs-you")).toBeNull();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("rejected: the row stays Done and says the approved setup is still in use, with no decision card", async () => {
    const f = mount(checklist({ newerProposal: "rejected" }));
    const item = await row();
    expect((await within(item).findByTestId("setup-run-newer-proposal")).textContent).toBe("A newer setup proposal was rejected; the approved setup is still in use");
    expect(item.getAttribute("data-state")).toBe("done");
    expect(within(item).queryByTestId("setup-approval")).toBeNull();
    expect(within(item).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(item).getByTestId("setup-run-approved")).toBeTruthy();
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("its check going: the row stays Done and says it is being checked", async () => {
    const f = mount(checklist({ newerProposal: "checking" }), agent({ apply: apply({ check: { status: "checking" }, canApprove: false, canReject: false, approval: undefined }) }));
    const item = await row();
    expect((await within(item).findByTestId("setup-run-newer-proposal")).textContent).toBe("A newer setup proposal is being checked on a fresh machine");
    expect(item.getAttribute("data-state")).toBe("done");
    expect(within(item).queryByRole("button", { name: "Approve" })).toBeNull();
    f.close();
  });

  it("a project that is otherwise 100% done keeps its checklist for a waiting proposal (its card must stay reachable), but not for a rejected one or none", async () => {
    const waiting = mount(checklist({ newerProposal: "needs_you" }, 100), agent({ apply: apply() }));
    const item = await row();
    expect(within(item).getByTestId("setup-run-newer-proposal").textContent).toBe(NEWER_PROPOSAL_WORDS.needs_you);
    expect(await within(item).findByTestId("setup-approval")).toBeTruthy();
    expect(item.getAttribute("data-state")).toBe("done");
    waiting.close(); cleanup();
    for (const newerProposal of ["rejected", undefined]) {
      const f = mount(checklist(newerProposal === undefined ? {} : { newerProposal }, 100));
      await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/projects/web/setup-status")).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.queryByTestId("project-checklist")).toBeNull();
      f.close(); cleanup();
    }
  });

  it("no newerProposal (an older Code): the row reads as before, with no newer-proposal line", async () => {
    const f = mount(checklist({}));
    const item = await row();
    expect(await within(item).findByTestId("setup-run-approved")).toBeTruthy();
    expect(item.getAttribute("data-state")).toBe("done");
    expect(within(item).queryByTestId("setup-run-newer-proposal")).toBeNull();
    expect(document.body.textContent).not.toContain("newer setup proposal");
    f.close();
  });

  it("an approved setup whose own check failed is still Needs you beside a rejected newer one: the newer proposal never hides the approved setup's trouble", async () => {
    const f = mount(checklist({ state: "needs_you", check: { status: "failed", failedStep: "test: npm test - exited with 1" }, newerProposal: "rejected" }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("needs_you");
    expect((await within(item).findByTestId("setup-run-approved-failed")).textContent).toContain("test: npm test - exited with 1");
    expect(within(item).getByTestId("setup-run-newer-proposal").textContent).toBe(NEWER_PROPOSAL_WORDS.rejected);
    f.close();
  });
});
