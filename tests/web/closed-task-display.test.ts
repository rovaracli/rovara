// @vitest-environment jsdom
// 058-stop-close (QA6-07): a task its owner closed reads "Closed" in the header and in the pipeline, not the state of its last step ("Failed", "Finished", "Building", "Needs you").
// UX2 slice 2 (e6e8aebc1): the words are the one status model's (`taskStatusText`), so an open task that waits on a person reads "Needs you: ..." and a failed one "Failed: <cause>".
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/cloud-contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { SessionHeader } from "../../packages/ui/src/screens/session/SessionHeader.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

function pipeline(value: unknown) {
 const session = SessionViewReaderSchema.parse(value), f = fakeHost();
 const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + "#pipeline"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...ui, close() { ui.unmount();router.dispose(); } };
}

it("an open task waiting for a decision still says so, with its current stage marked", async () => {
 const f = pipeline(fixture({ status: "needs_person" }));
 expect(await screen.findByText(/^Needs you: /)).toBeTruthy();
 expect(document.querySelector('[aria-current="step"]')).not.toBeNull();
 f.close();
});

it("a closed task says Closed in the pipeline and marks no stage as current", async () => {
 const f = pipeline(fixture({ status: "cancelled" }, { status: "CLOSED" }));
 expect(await screen.findByText("Closed")).toBeTruthy();
 expect(screen.queryByText(/^Needs you/)).toBeNull();
 expect(screen.queryByText("Building")).toBeNull();
 expect(document.querySelector('[aria-current="step"]')).toBeNull();
 f.close();
});

it("a closed task says Closed in the header, not Cancelled, Failed or Finished", () => {
 for (const status of ["cancelled", "failed", "succeeded"] as const) {
  const session = SessionViewReaderSchema.parse(fixture({ status }, { status: "CLOSED" }));
  const f = renderUi(h(SessionHeader, { session, onAction: () => undefined }));
  expect(screen.getByText("Closed")).toBeTruthy();
  expect(screen.queryByText(/^Failed/)).toBeNull();
  expect(screen.queryByText(/^Finished/)).toBeNull();
  f.unmount();
 }
 const open = renderUi(h(SessionHeader, { session: SessionViewReaderSchema.parse(fixture({ status: "failed" })), onAction: () => undefined }));
 expect(screen.getByText(/^Failed: /)).toBeTruthy();
 open.unmount();
});
