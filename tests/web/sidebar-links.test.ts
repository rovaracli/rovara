// @vitest-environment jsdom
// The sidebar offers only screens whose routes are served: "Agent directory" (/app/agents reads /v1/app/agents, which neither Cloud nor Rovara Code serves yet) is not shown until the gate is turned on.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Sidebar } from "../../packages/ui/src/shell/Sidebar.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { navFixture } from "./support/fixtures.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";

function mount(props: { agentDirectoryOffered?: boolean } = {}) {
 const f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } })), query = createQueryClient();
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Sidebar, { nav: navFixture(), ...props }) }) }) }));
 return { ...f, close() { view.unmount();query.clear(); } };
}
it("does not show the Agent directory link (no route serves it yet) but keeps the other secondary links", async () => {
 const f = mount();
 expect(await screen.findByRole("link", { name: "Onboard a project" })).toBeTruthy();
 expect(screen.queryByRole("link", { name: "Agent directory" })).toBeNull();f.close();
});
it("shows the Agent directory link once the gate is turned on", async () => {
 const f = mount({ agentDirectoryOffered: true });
 expect((await screen.findByRole("link", { name: "Agent directory" })).getAttribute("href")).toBe("/app/agents");f.close();
});
