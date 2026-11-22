// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { meFixture } from "./support/fixtures.js";
import type { TaskMoneyV1 } from "../../packages/contracts/src/task-money.js";
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionHeader } from "../../packages/ui/src/screens/session/SessionHeader.js";
import { MoneyBanners } from "../../packages/ui/src/screens/session/MoneyBanners.js";
import { AppHostProvider, type AppHost } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { sessionFixture, sessionPerson, taskFixture } from "./support/session-fixture.js";
const renderMoney = (host: AppHost, session: Parameters<typeof MoneyBanners>[0]["session"]) => renderUi(h(AppHostProvider, { host, children: h(QueryClientProvider, { client: createQueryClient(), children: h(MoneyBanners, { session }) }) }));
it("shows stable task identity, real status, money and execution location", () => {
 const view = sessionFixture();const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("heading", { name: "Fix duplicate refunds", level: 1 })).toBeTruthy();expect(screen.getByText("Payments expert")).toBeTruthy();expect(screen.getByText("on Priya's MacBook")).toBeTruthy();expect(screen.getByText("offline")).toBeTruthy();expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();expect(screen.getByText("Cost unavailable")).toBeTruthy();expect(screen.queryByText("$1.20")).toBeNull();expect(screen.queryByText("Paid by payments")).toBeNull();f.unmount();
});
it("offers follow and sharing only from explicit server actions", () => {
 const view = sessionFixture({ you: { level: "view", owner: false, following: false, actions: ["watch"] } });const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();f.unmount();
 const other = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }));expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();other.unmount();
});
it("shows at most five named viewers and the remaining count", () => { const session = sessionFixture({ viewingNow: Array.from({ length: 7 }, (_, i) => ({ developerId: String(i).repeat(64), name: "Viewer " + i })) });const f = renderUi(h(SessionHeader, { session, onAction: () => undefined }));expect(screen.getByRole("group", { name: "7 people viewing" }).querySelectorAll('[data-avatar]')).toHaveLength(5);expect(screen.getByText("+2")).toBeTruthy();f.unmount(); });
it("opens only the bare caller confirmation link for approvals and paused budget", () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() })), confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const session = sessionFixture({ approvals: [{ approvalId: "approval", title: "Approve a refund investigation", confirmUrl }], cost: { spentUsd: 1, payer: { kind: "member", name: sessionPerson.name }, paused: { scope: "payments", confirmUrl } } });
 const ui = renderMoney(f.host, session);expect(screen.getByText("Task paused")).toBeTruthy();for (const button of screen.getAllByRole("button", { name: "Open" })) fireEvent.click(button);expect(f.host.openExternal).toHaveBeenCalledTimes(2);expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);ui.unmount();
});
it("never opens an approval with an invalid origin, query or scheme", () => { const f = fakeHost(async () => ({ status: 200, body: meFixture() }));for (const confirmUrl of ["http://cell.example/v1/app/approve/x", "https://foreign.example/v1/app/approve/x", "https://cell.example/v1/app/approve/x?ticket=private"]) { const ui = renderMoney(f.host, sessionFixture({ approvals: [{ approvalId: "approval", title: "Approval", confirmUrl }] }));expect(screen.queryByRole("button", { name: "Open" })).toBeNull();ui.unmount(); }expect(f.host.openExternal).not.toHaveBeenCalled(); });
for (const theme of ["light", "dark"] as const) it("keeps the task header accessible in " + theme, async () => { const f = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }), { theme });await expectNoAxeViolations(f.container);f.unmount(); });

it("shows stopped planning evidence as safe Markdown with no raw HTML", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() })), session = sessionFixture({ body: { kind: "task", task: taskFixture({ planningSoFar: "# Evidence found\n\nThe refund key is reused.\n\n<script>privateScript()</script><iframe src='https://foreign.example'></iframe>" }) } });
 const ui = renderMoney(f.host, session);expect(await screen.findByText("Planning stopped at its limit. Here's what it found so far:")).toBeTruthy();expect(await screen.findByRole("heading", { name: "Evidence found" })).toBeTruthy();expect(ui.container.querySelector("script,iframe")).toBeNull();ui.unmount();
});
it("continues an owner's capped test once after checking identity and ownership", async () => {
 let finish!: (value: { status: number; body: unknown }) => void;
 const nextId = "ses_bbbbbbbbbbbbbbbbbbbb", session = sessionFixture({ body: { kind: "task", task: taskFixture({ testOffer: { capUsd: 0.5 } }) } });
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : request.method === "GET" ? { status: 200, body: { session } } : new Promise(resolve => { finish = resolve; }));
 const navigate = vi.spyOn(f.host, "navigate"), ui = renderMoney(f.host, session), button = screen.getByRole<HTMLButtonElement>("button", { name: "Continue as a normal task" });
 await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);fireEvent.click(button);
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));expect(navigate).not.toHaveBeenCalled();
 finish({ status: 200, body: { task: taskFixture({ sessionId: nextId }) } });await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + nextId));
 expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0]).toMatchObject({ path: "/v1/app/tasks/11111111-1111-4111-8111-111111111111/continue-as-task" });ui.unmount();
});

it("does not grant test continuation to a viewer", () => { const f = fakeHost(async () => ({ status: 200, body: meFixture() })), session = sessionFixture({ you: { level: "view", owner: false, following: false, actions: ["watch"] }, body: { kind: "task", task: taskFixture({ testOffer: { capUsd: 0.5 } }) } });const ui = renderMoney(f.host, session);expect(screen.getByText("This test run reached its $0.50 limit.")).toBeTruthy();expect(screen.queryByRole("button", { name: "Continue as a normal task" })).toBeNull();ui.unmount(); });

it("renders provisional task money instead of legacy spend and inferred payer", async () => {
 const { readFileSync } = await import("node:fs");
 const money = (JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: TaskMoneyV1[] }).examples[0]!;
 const f = renderUi(h(SessionHeader, { session: sessionFixture({ money }), onAction: () => undefined }));
 expect(screen.getByText("under $0.01 (not yet confirmed)")).toBeTruthy();
 expect(screen.queryByText("$1.20")).toBeNull();
 f.unmount();
});
it("absent money never displays legacy dollars", () => {
 const view = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }));
 expect(screen.queryByText("$1.20")).toBeNull();
 expect(screen.queryByText("Cost unavailable")).not.toBeNull();
 view.unmount();
});

it("shows the money stop limit only when supplied, independently of legacy limits", async () => {
 const { readFileSync } = await import("node:fs");
 for (const limit of [12_000_000, 0, undefined]) {
  const money = (JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: TaskMoneyV1[] }).examples[0]!;
  money.stop.taskMaximumMicros = limit === undefined ? { state: "unavailable", reason: "not_measured" } : { state: "available", value: limit };
  const view = renderUi(h(SessionHeader, { session: sessionFixture({ money, cost: { spentUsd: 999, runLimitUsd: 999, payer: { kind: "member", name: "Legacy" } } }), onAction: () => undefined }));
  expect(view.container.textContent).not.toContain("$999.00");
  if (limit === undefined) expect(view.container.textContent).not.toContain(" of ");
  else expect(view.container.textContent).toContain(limit === 0 ? " · Task limit $0.00" : " · Task limit $12.00");
  view.unmount();
 }
});
