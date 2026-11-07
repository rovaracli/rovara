// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionHeader } from "../../packages/ui/src/screens/session/SessionHeader.js";
import { MoneyBanners } from "../../packages/ui/src/screens/session/MoneyBanners.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { sessionFixture, sessionPerson, taskFixture } from "./support/session-fixture.js";
it("shows stable task identity, real status, money and execution location", () => {
 const view = sessionFixture();const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("heading", { name: "Fix duplicate refunds", level: 1 })).toBeTruthy();expect(screen.getByText("Payments expert")).toBeTruthy();expect(screen.getByText("on Priya's MacBook")).toBeTruthy();expect(screen.getByText("offline")).toBeTruthy();expect(screen.getByRole("img", { name: "Building" })).toBeTruthy();expect(screen.getByText("$1.20")).toBeTruthy();expect(screen.getByText("$4.00")).toBeTruthy();f.unmount();
});
it("offers follow and sharing only from explicit server actions", () => {
 const view = sessionFixture({ you: { level: "view", owner: false, following: false, actions: ["watch"] } });const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();f.unmount();
 const other = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }));expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();other.unmount();
});
it("shows at most five named viewers and the remaining count", () => { const session = sessionFixture({ viewingNow: Array.from({ length: 7 }, (_, i) => ({ developerId: String(i).repeat(64), name: "Viewer " + i })) });const f = renderUi(h(SessionHeader, { session, onAction: () => undefined }));expect(screen.getByRole("group", { name: "7 people viewing" }).querySelectorAll('[data-avatar]')).toHaveLength(5);expect(screen.getByText("+2")).toBeTruthy();f.unmount(); });
it("opens only the bare caller confirmation link for approvals and paused budget", () => {
 const f = fakeHost(), confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const session = sessionFixture({ approvals: [{ approvalId: "approval", title: "Approve a refund investigation", confirmUrl }], cost: { spentUsd: 1, payer: { kind: "member", name: sessionPerson.name }, paused: { scope: "payments", confirmUrl } } });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session }) }));expect(screen.getByText("Paused: needs more budget")).toBeTruthy();expect(screen.getByText(/^It reached a spending limit\. /u)).toBeTruthy();for (const button of screen.getAllByRole("button", { name: "Open" })) fireEvent.click(button);expect(f.host.openExternal).toHaveBeenCalledTimes(2);expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);ui.unmount();
});
it("never opens an approval with an invalid origin, query or scheme", () => { const f = fakeHost();for (const confirmUrl of ["http://cell.example/v1/app/approve/x", "https://foreign.example/v1/app/approve/x", "https://cell.example/v1/app/approve/x?ticket=private"]) { const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session: sessionFixture({ approvals: [{ approvalId: "approval", title: "Approval", confirmUrl }] }) }) }));expect(screen.queryByRole("button", { name: "Open" })).toBeNull();ui.unmount(); }expect(f.host.openExternal).not.toHaveBeenCalled(); });
for (const theme of ["light", "dark"] as const) it("keeps the task header accessible in " + theme, async () => { const f = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }), { theme });await expectNoAxeViolations(f.container);f.unmount(); });

it("shows stopped planning evidence as safe Markdown with no raw HTML", async () => {
 const f = fakeHost(), session = sessionFixture({ body: { kind: "task", task: taskFixture({ planningSoFar: "# Evidence found\n\nThe refund key is reused.\n\n<script>privateScript()</script><iframe src='https://foreign.example'></iframe>" }) } });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session }) }));expect(await screen.findByText("Planning stopped at its limit. Here's what it found so far:")).toBeTruthy();expect(await screen.findByRole("heading", { name: "Evidence found" })).toBeTruthy();expect(ui.container.querySelector("script,iframe")).toBeNull();ui.unmount();
});
it("continues an owner's capped test once and navigates only to the canonical returned session", async () => {
 let finish!: (value: { status: number; body: unknown }) => void;
 const nextId = "ses_bbbbbbbbbbbbbbbbbbbb", f = fakeHost(() => new Promise(resolve => { finish = resolve; }));const session = sessionFixture({ body: { kind: "task", task: taskFixture({ testOffer: { capUsd: 0.5 } }) } });
 const navigate = vi.spyOn(f.host, "navigate");const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session }) }));expect(screen.getByText("This test run reached its $0.50 limit.")).toBeTruthy();fireEvent.click(screen.getByRole("button", { name: "Continue as a normal task" }));fireEvent.click(screen.getByRole("button", { name: "Continue as a normal task" }));expect(f.request).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();finish({ status: 200, body: { task: taskFixture({ sessionId: nextId }) } });await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + nextId));expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", path: "/v1/app/tasks/11111111-1111-4111-8111-111111111111/continue-as-task", body: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown } });ui.unmount();
});
it("does not grant test continuation to a viewer", () => { const f = fakeHost(), session = sessionFixture({ you: { level: "view", owner: false, following: false, actions: ["watch"] }, body: { kind: "task", task: taskFixture({ testOffer: { capUsd: 0.5 } }) } });const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session }) }));expect(screen.getByText("This test run reached its $0.50 limit.")).toBeTruthy();expect(screen.queryByRole("button", { name: "Continue as a normal task" })).toBeNull();ui.unmount(); });
it("says why the task stopped and the next step from the one status model, with no raw code (UX2 slice 2)", () => {
 const view = sessionFixture({ status: "needs_person", step: "Checks", display: { state: "needs_you", reason: "The checks didn't pass or couldn't run", next: "Send it back to coding, retry the checks, or close the task in Rovara." } } as never);
 const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("img", { name: "Needs you: the checks didn't pass or couldn't run" })).toBeTruthy();
 expect(screen.getByLabelText("Next step").textContent).toBe("Next: Send it back to coding, retry the checks, or close the task in Rovara.");
 expect(f.container.textContent).not.toMatch(/needs_person|BLOCKED|Needs a person/u);
 f.unmount();
});
it("reads Closed for a closed task even when its session ended failed", () => {
 const view = sessionFixture({ status: "failed", display: { state: "closed", next: "Nothing; this task is closed." } } as never);
 const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("img", { name: "Closed" })).toBeTruthy();expect(f.container.textContent).not.toMatch(/Failed|Cancelled/u);
 f.unmount();
});
