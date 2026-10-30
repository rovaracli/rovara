// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SlackLinksEditor } from "../../packages/ui/src/screens/admin/projects/SlackLinksEditor.js";
import { retainSlackRequest } from "../../packages/ui/src/screens/admin/projects/project-slack-history.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" }, teamId = "T0123456789", channelId = "C0123456789";
const inventory = { orgId: scope.orgId, project: scope.project, workspaces: [teamId], bindings: [{ teamId, channelId, updatedAt: "2026-10-01T00:00:00Z" }], continuation: null, partial: false, limitReached: false, inspected: 1, botMembership: "not_verified" };
const review = { orgId: scope.orgId, project: scope.project, teamId, channelId, state: "linked", updatedAt: "2026-10-01T00:00:00Z", projectStatus: "active", contextDigest: "b".repeat(64), botMembership: "not_verified" };
it("reviews stored access effects and retains a UUID before one explicit unlink POST", async () => {
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: input.path.includes("/review?") ? review : inventory };
  const body = input.body as { requestId: string };expect(f.storage.size).toBe(1);expect([...f.storage.values()][0]).toContain(body.requestId);
  return { status: 200, body: { kind: "receipt", orgId: scope.orgId, project: scope.project, receipt: { requestId: body.requestId, operation: "unbind", outcome: { teamId, channelId, removed: true }, receiptExpiresAt: new Date(Date.now() + 86400000).toISOString() } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: `Review unlink ${teamId} / ${channelId}` }));
 const send = await screen.findByRole("button", { name: "Unlink reviewed channel" });expect(screen.getByText(/fail their next access check/)).toBeTruthy();expect(screen.getByText(/New mentions in this channel will be ignored/)).toBeTruthy();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);send.focus();fireEvent.click(send);await screen.findByText(/Receipt confirmed/);expect(document.activeElement).toBe(send);expect(send.getAttribute("aria-disabled")).toBe("true");fireEvent.click(send);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 expect(screen.queryByRole("button", { name: /Bind|Link replacement/ })).toBeNull();
});
it("checks ambiguous outcomes without automatically resending and reuses the same reviewed body only on a click", async () => {
 const f = fakeHost(async input => input.method === "POST" ? { status: 503, body: {} } : input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: input.path.includes("/review?") ? review : inventory });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: `Review unlink ${teamId} / ${channelId}` }));fireEvent.click(await screen.findByRole("button", { name: "Unlink reviewed channel" }));await screen.findByText(/outcome is unconfirmed/);
 fireEvent.click(screen.getByRole("button", { name: "Check Slack request status" }));await screen.findByRole("button", { name: "Resend same Slack request" });expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 fireEvent.click(screen.getByRole("button", { name: "Resend same Slack request" }));await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(2));const bodies = f.request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => r.body);expect(bodies[0]).toEqual(bodies[1]);
});
it("expired retained history remains status-only after a 404", async () => {
 const f = fakeHost(async input => input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: inventory });
 retainSlackRequest(f.host.storage, scope, { reviewedAt: new Date(Date.now() - 86400001).toISOString(), body: { expectedOrgId: scope.orgId, requestId: "11111111-1111-4111-8111-111111111111", teamId, channelId, expectedContextDigest: review.contextDigest } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Check Slack request status" }));await screen.findByText(/retention window has ended/);expect(screen.queryByRole("button", { name: "Resend same Slack request" })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("scope teardown removes controls and drops a late mutation response", async () => {
 let finish!: (value: { status: number; body: unknown }) => void;
 const f = fakeHost(async input => input.method === "POST" ? new Promise(resolve => { finish = resolve; }) : { status: 200, body: input.path.includes("/review?") ? review : inventory });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: `Review unlink ${teamId} / ${channelId}` }));fireEvent.click(await screen.findByRole("button", { name: "Unlink reviewed channel" }));
 view.rerender(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: false }) }));finish({ status: 401, body: {} });await Promise.resolve();expect(screen.queryByRole("region", { name: "Slack links editor" })).toBeNull();expect(f.host.signIn).not.toHaveBeenCalled();
});
it("saved request selection is status-only and never sends a stored body", async () => {
 const f = fakeHost(async input => input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: inventory });
 const ids = ["11111111-1111-4111-8111-111111111111", "22222222-1111-4111-8111-111111111111"];
 for (const requestId of ids) retainSlackRequest(f.host.storage, scope, { reviewedAt: new Date().toISOString(), body: { expectedOrgId: scope.orgId, requestId, teamId, channelId, expectedContextDigest: review.contextDigest } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.change(await screen.findByRole("combobox", { name: "Earlier Slack request" }), { target: { value: "0" } });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);fireEvent.click(screen.getByRole("button", { name: "Check Slack request status" }));await screen.findByRole("button", { name: "Resend same Slack request" });expect(f.request.mock.calls.some(([r]) => r.path.includes(`/requests/${ids[0]}`))).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("storage failure prevents a reviewed unlink from being sent", async () => {
 const f = fakeHost(async input => ({ status: 200, body: input.path.includes("/review?") ? review : inventory }));f.host.storage.set = () => { throw new Error("Storage unavailable"); };
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: `Review unlink ${teamId} / ${channelId}` }));await screen.findByText(/could not be reviewed or retained/);expect(screen.queryByRole("button", { name: "Unlink reviewed channel" })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("stored-link and review states have accessible controls and one live announcement", async () => {
 const { expectNoAxeViolations } = await import("./support/axe.js"), f = fakeHost(async input => ({ status: 200, body: input.path.includes("/review?") ? review : inventory }));
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));const button = await screen.findByRole("button", { name: `Review unlink ${teamId} / ${channelId}` });expect(screen.getAllByRole("status")).toHaveLength(1);await expectNoAxeViolations(view.container);fireEvent.click(button);await screen.findByRole("button", { name: "Unlink reviewed channel" });await expectNoAxeViolations(view.container);
});
