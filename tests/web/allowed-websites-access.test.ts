// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { AllowedWebsites } from "../../packages/ui/src/screens/admin/projects/AllowedWebsites.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { meFixture, FIXTURE_ORG } from "./support/fixtures.js";
const review = { kind: "review", status: "review", orgId: FIXTURE_ORG, project: "payments", baseRevision: 1, contextDigest: "b".repeat(64), allowedDomains: [], defaultDomains: ["github.com"], staffDomains: [], liveProposal: null };
it("checks fresh identity on explicit open and hides controls during focus revalidation", async () => {
 let denied = false;
 const f = fakeHost(async input => input.path === "/v1/app/me" ? { status: denied ? 403 : 200, body: denied ? {} : meFixture() } : { status: 200, body: review });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsites, { project: "payments", orgId: FIXTURE_ORG, available: true }) }));
 expect(f.request).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button", { name: "Edit allowed websites" }));
 await screen.findByRole("button", { name: "Review website change" });expect(f.request.mock.calls[0]?.[0].path).toBe("/v1/app/me");
 denied = true;await act(async () => { window.dispatchEvent(new Event("focus")); });
 await screen.findByText(/Website editing access could not be verified/);
 expect(screen.queryByRole("button", { name: "Review website change" })).toBeNull();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("a switched company cannot open the same-named project under an old page scope", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture({ org: { orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Other", plan: "team" } }) }));
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsites, { project: "payments", orgId: FIXTURE_ORG, available: true }) }));
 fireEvent.click(screen.getByRole("button", { name: "Edit allowed websites" }));await screen.findByText(/Website editing access could not be verified/);
 await waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));expect(screen.queryByRole("textbox")).toBeNull();
});
