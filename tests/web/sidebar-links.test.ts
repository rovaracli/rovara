// @vitest-environment jsdom
// The sidebar's "Agent directory" link is shown to a company owner or administrator only (owner decision 2026-11-17: the company-wide directory is theirs to read); a member never sees it.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Sidebar } from "../../packages/ui/src/shell/Sidebar.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AGENT_DIRECTORY_OFFERED } from "../../packages/ui/src/shell/agent-directory-gate.js";
import { fakeHost } from "./support/fake-host.js";
import { navFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

function mount(role: "owner" | "admin" | "member", props: { agentDirectoryOffered?: boolean } = {}) {
 const f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } })), query = createQueryClient(), base = navFixture();
 const nav = { ...base, me: { ...base.me, orgRole: role } };
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Sidebar, { nav, ...props }) }) }) }));
 return { ...f, close() { view.unmount();query.clear(); } };
}
it("the gate is on: the route is served", () => { expect(AGENT_DIRECTORY_OFFERED).toBe(true); });
for (const role of ["owner", "admin"] as const) it("shows the Agent directory link to a company " + role, async () => {
 const f = mount(role);
 expect((await screen.findByRole("link", { name: "Agent directory" })).getAttribute("href")).toBe("/app/agents");f.close();
});
it("does not show the Agent directory link to a member, but keeps the other secondary links", async () => {
 const f = mount("member");
 expect(await screen.findByRole("link", { name: "Onboard a project" })).toBeTruthy();
 expect(screen.queryByRole("link", { name: "Agent directory" })).toBeNull();f.close();
});
it("hides the link from an owner when the gate is turned off", async () => {
 const f = mount("owner", { agentDirectoryOffered: false });
 expect(await screen.findByRole("link", { name: "Onboard a project" })).toBeTruthy();
 expect(screen.queryByRole("link", { name: "Agent directory" })).toBeNull();f.close();
});
