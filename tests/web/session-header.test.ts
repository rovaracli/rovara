// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SessionHeader } from "../../packages/ui/src/screens/session/SessionHeader.js";
import { MoneyBanners } from "../../packages/ui/src/screens/session/MoneyBanners.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { sessionFixture, sessionPerson } from "./support/session-fixture.js";
it("shows stable task identity, real status, money and execution location", () => {
 const view = sessionFixture();const f = renderUi(h(SessionHeader, { session: view, onAction: () => undefined }));
 expect(screen.getByRole("heading", { name: "Fix duplicate refunds", level: 1 })).toBeTruthy();expect(screen.getByText("Payments expert")).toBeTruthy();expect(screen.getByText("on Priya's MacBook")).toBeTruthy();expect(screen.getByText("offline")).toBeTruthy();expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();expect(screen.getByText("$1.20")).toBeTruthy();expect(screen.getByText("$4.00")).toBeTruthy();f.unmount();
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
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session }) }));expect(screen.getByText("Paused: payments needs more budget")).toBeTruthy();for (const button of screen.getAllByRole("button", { name: "Open" })) fireEvent.click(button);expect(f.host.openExternal).toHaveBeenCalledTimes(2);expect(f.host.openExternal).toHaveBeenCalledWith(confirmUrl);ui.unmount();
});
it("never opens an approval with an invalid origin, query or scheme", () => { const f = fakeHost();for (const confirmUrl of ["http://cell.example/v1/app/approve/x", "https://foreign.example/v1/app/approve/x", "https://cell.example/v1/app/approve/x?ticket=private"]) { const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(MoneyBanners, { session: sessionFixture({ approvals: [{ approvalId: "approval", title: "Approval", confirmUrl }] }) }) }));expect(screen.queryByRole("button", { name: "Open" })).toBeNull();ui.unmount(); }expect(f.host.openExternal).not.toHaveBeenCalled(); });
for (const theme of ["light", "dark"] as const) it("keeps the task header accessible in " + theme, async () => { const f = renderUi(h(SessionHeader, { session: sessionFixture(), onAction: () => undefined }), { theme });await expectNoAxeViolations(f.container);f.unmount(); });
