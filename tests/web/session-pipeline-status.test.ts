// @vitest-environment jsdom
// Rovara-cloud#17: the Pipeline tab says when Code is still setting up the workspace (no stage marked), and why a stopped task stopped.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { SETTING_UP } from "../../packages/ui/src/screens/session/PipelineTab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

function setup(raw: unknown) {
 const session = SessionViewReaderSchema.parse(raw), f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } })), query = createQueryClient();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { close() { ui.unmount(); router.dispose(); query.clear(); } };
}

it("says the workspace is being set up while the session is starting, and marks no stage", async () => {
 const s = setup(workspaceFixture({ status: "starting" }, { workflow: { ...workspaceWorkflow(), stage: "PLAN", state: "RUNNING" } }));
 expect((await screen.findByRole("list", { name: "Task stages" })).querySelector("[aria-current]")).toBeNull();
 expect(screen.getByText(SETTING_UP)).toBeTruthy();
 expect(screen.queryByText("Working")).toBeNull();
 s.close();
});

it("says why a stopped task stopped, in Code's words, and marks its stage", async () => {
 const s = setup(workspaceFixture({ status: "needs_person" }, { workflow: { ...workspaceWorkflow(), stage: "PLAN", state: "BLOCKED", blockReason: "the plan couldn't be read" } }));
 expect((await screen.findByRole("list", { name: "Task stages" })).querySelector("[aria-current]")?.textContent).toBe("Plan");
 expect(screen.getByText("Stopped: the plan couldn't be read")).toBeTruthy();
 s.close();
});
