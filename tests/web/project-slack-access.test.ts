// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { ProjectSlackLinks } from "../../packages/ui/src/screens/admin/projects/ProjectSlackLinks.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { meFixture, FIXTURE_ORG, FIXTURE_DEVELOPER } from "./support/fixtures.js";
const inventory = { orgId: FIXTURE_ORG, project: "payments", workspaces: [], bindings: [], continuation: null, partial: false, limitReached: false, inspected: 0, botMembership: "not_verified" };
it("checks fresh owner identity on open and tears down on live role loss", async () => {
 let role: "owner" | "member" = "owner";const f = fakeHost(async input => ({ status: 200, body: input.path === "/v1/app/me" ? meFixture({ developer: { id: FIXTURE_DEVELOPER, name: "Priya", orgRole: role } }) : inventory }));
 renderUi(h(AppHostProvider, { host: f.host, children: h(ProjectSlackLinks, { orgId: FIXTURE_ORG, project: "payments", available: true }) }));expect(f.request).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button", { name: "Manage recorded Slack links" }));await screen.findByRole("region", { name: "Slack links editor" });expect(f.request.mock.calls[0]?.[0].path).toBe("/v1/app/me");
 role = "member";await act(async () => { window.dispatchEvent(new Event("focus")); });await screen.findByText(/Slack linking access could not be verified/);expect(screen.queryByRole("region", { name: "Slack links editor" })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
for (const role of ["member", "unknown"]) it(`does not open management for fresh ${role} data`, async () => {
 const f = fakeHost(async () => ({ status: 200, body: { ...meFixture(), developer: { id: FIXTURE_DEVELOPER, name: "Priya", orgRole: role } } }));renderUi(h(AppHostProvider, { host: f.host, children: h(ProjectSlackLinks, { orgId: FIXTURE_ORG, project: "payments", available: true }) }));fireEvent.click(screen.getByRole("button", { name: "Manage recorded Slack links" }));await screen.findByText(/Slack linking access could not be verified/);expect(f.request).toHaveBeenCalledTimes(1);
});
it("refuses a switched company before reading a same-named project's links", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture({ org: { orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Other", plan: "team" } }) }));renderUi(h(AppHostProvider, { host: f.host, children: h(ProjectSlackLinks, { orgId: FIXTURE_ORG, project: "payments", available: true }) }));fireEvent.click(screen.getByRole("button", { name: "Manage recorded Slack links" }));await screen.findByText(/Slack linking access could not be verified/);expect(f.request).toHaveBeenCalledTimes(1);
});
