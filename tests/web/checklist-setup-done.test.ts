// @vitest-environment jsdom
// L4-T2 (setup review D1, G1, G6, D10): the Setup run row says what Code says. Done only with an approved setup whose check is ready (with the date it was approved); Needs you while a proposal waits or the
// approved setup's check failed (with Code's reason) or was never run on a fresh machine; Running while its check goes. The project's "AI and spend limit" row is gone: the AI row shows only when no AI can
// be called, says what to do, and links an admin to AI for your agents (a member is told to ask one). Reads are faked; the page's words and links are watched.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AI_NEEDS_YOU, ProjectChecklist } from "../../packages/ui/src/screens/setup/ProjectChecklist.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { navFixture } from "./support/fixtures.js";

afterEach(cleanup);
const ME = "a".repeat(64);
type Plain = Record<string, unknown>;

const checklist = (setupRun: Plain, over: Plain = {}) => ({
  project: "web", viewer: { companyRole: "owner", projectAdmin: false, canSkip: true }, progress: { done: 3, total: 8, percent: 38, nextRequired: "evalConfirm" },
  repos: { state: "done", count: 1, items: [{ name: "web", fullName: "acme/web", defaultBranch: "main" }] },
  setupRun: { status: "ready", startedAt: "2026-11-17T10:00:00.000Z", elapsedMs: 300000, costCents: 31, commandsRun: 4, commandsFound: { setup: 1, tests: 1 }, testOutcome: "passed", ...setupRun },
  evalConfirm: { state: "needs_you", report: "none" }, aiAndSpend: { state: "done", source: "default", companyModelSaved: false, modelBudgetUsd: null },
  slackChannel: { state: "optional", channels: [] }, linear: { state: "optional", team: null }, invites: { state: "optional" }, firstTask: { state: "needs_you", hasTask: false, canStart: false },
  ...over,
});

function mount(read: unknown) {
  const f = fakeHost(async request => {
    if (request.path === "/v1/app/projects/web/setup-status") return { status: 200, body: read };
    // No setup run read for the review cards: nothing waits there, the row says what the checklist says.
    if (request.path === "/v1/app/projects/web/setup-agent" && request.method === "GET") return { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
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

describe("the Setup run row (L4-T2)", () => {
  it("approved and its check ready: Done, with the day it was approved", async () => {
    const f = mount(checklist({ state: "done", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z" }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("done");
    expect((await within(item).findByTestId("setup-run-approved")).textContent).toBe("Setup approved on Nov 12. Checked on a fresh machine.");
    await expectNoAxeViolations(document.body);
    f.close();
  });

  it("approved and checked but a newer run's proposal is unused: Needs you, and the row never says the setup is approved and checked", async () => {
    const f = mount(checklist({ state: "needs_you", approval: "approved", check: { status: "ready" }, approvedAt: "2026-11-12T10:00:00.000Z" }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("needs_you");
    expect(within(item).queryByTestId("setup-run-approved")).toBeNull();
    f.close();
  });

  it("a proposal nobody approved: Needs you, never Done, and no link to the old Setup step", async () => {
    const f = mount(checklist({ state: "needs_you", approval: "none" }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("needs_you");
    expect(within(item).queryByTestId("setup-run-approved")).toBeNull();
    expect(document.body.innerHTML).not.toContain("step=setup");
    f.close();
  });

  it("approved but its check failed: Needs you, with Code's reason", async () => {
    const f = mount(checklist({ state: "needs_you", approval: "approved", check: { status: "failed", failedStep: "test: npm test - exited with 1" }, approvedAt: "2026-11-12T10:00:00.000Z" }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("needs_you");
    const line = await within(item).findByTestId("setup-run-approved-failed");
    expect(line.textContent).toContain("Needs you: the approved setup failed its check.");
    expect(line.textContent).toContain("test: npm test - exited with 1");
    f.close();
  });

  it("approved but never checked on a fresh machine (or stale): Needs you, says so", async () => {
    for (const status of ["unchecked", "outdated"]) {
      const f = mount(checklist({ state: "needs_you", approval: "approved", check: { status } }));
      const item = await row();
      expect(item.getAttribute("data-state")).toBe("needs_you");
      expect((await within(item).findByTestId("setup-run-approved-unchecked")).textContent).toBe("Needs you: the approved setup has not been checked on a fresh machine.");
      f.close(); cleanup();
    }
  });

  it("approved and its check going on a fresh machine: Running", async () => {
    const f = mount(checklist({ state: "running", approval: "approved", check: { status: "checking" } }));
    const item = await row();
    expect(item.getAttribute("data-state")).toBe("running");
    expect(within(item).getByTestId("setup-run-approved-checking").textContent).toContain("Checking on a fresh machine");
    f.close();
  });
});

describe("the AI row (L4-T2, D10)", () => {
  it("is not shown while an AI can be called: the project's 'AI and spend limit' row is gone", async () => {
    const f = mount(checklist({ state: "done", approval: "approved", check: { status: "ready" } }));
    await row();
    expect(screen.queryByTestId("checklist-row-aiAndSpend")).toBeNull();
    expect(document.body.textContent).not.toContain("AI and spend limit");
    f.close();
  });

  it("shows when no AI can be called, with the words to act on, and an admin gets the link to AI for your agents", async () => {
    const f = mount(checklist({ state: "done", approval: "approved", check: { status: "ready" } }, { aiAndSpend: { state: "needs_you", source: "default", companyModelSaved: false, modelBudgetUsd: null, modelCall: "none" }, progress: { done: 3, total: 8, percent: 38, nextRequired: "aiAndSpend" } }));
    await row();
    const ai = screen.getByTestId("checklist-row-aiAndSpend");
    expect(ai.getAttribute("data-state")).toBe("needs_you");
    expect(within(ai).getByTestId("checklist-ai-needs-you").textContent).toBe(AI_NEEDS_YOU);
    expect(AI_NEEDS_YOU).toBe("Needs you: connect an AI key or choose Rovara's AI");
    expect(within(ai).getByRole("link", { name: "Connect an AI" }).getAttribute("href")).toBe("/app/admin/agent-ai");
    f.close();
  });

  it("a member is told to ask the company's admins, with no link to a page they cannot use", async () => {
    const f = mount(checklist({ state: "done", approval: "approved", check: { status: "ready" } }, {
      viewer: { companyRole: "member", projectAdmin: false, canSkip: false },
      aiAndSpend: { state: "needs_you", source: "default", companyModelSaved: false, modelBudgetUsd: null, modelCall: "none" }, progress: { done: 3, total: 8, percent: 38, nextRequired: "aiAndSpend" },
    }));
    await row();
    const ai = screen.getByTestId("checklist-row-aiAndSpend");
    expect(within(ai).queryByRole("link", { name: "Connect an AI" })).toBeNull();
    expect(ai.textContent).toContain("Ask your company's admins to connect an AI key or choose Rovara's AI.");
    f.close();
  });
});
