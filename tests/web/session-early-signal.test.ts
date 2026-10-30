// @vitest-environment jsdom
// Track record (v1.2 slice 1): the task page shows the owner's early "PR risk low" score, with its sample count and the "early, few samples" label below ten; a task without the field (any other viewer, or a
// task not published with risk low) shows nothing, and the shared How we work card and the pull request tab never name it otherwise.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { workspaceFixture as fixture } from "./support/workspace-fixture.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

function setup(value: unknown) {
 const session = SessionViewReaderSchema.parse(value), f = fakeHost();const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + "#pull-request"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...ui, close() { ui.unmount();router.dispose(); } };
}
const withSignal = (signal?: Record<string, unknown>) => fixture({ body: { kind: "task", task: taskFixture({ pullRequests: [{ repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }], ...(signal === undefined ? {} : { earlyRiskSignal: signal }) }) } });
const SIGNAL = { held: 5, notHeld: 1, windowDays: 30, capped: false, enough: false };

it("shows the early score to the owner, with the count of samples and the early, few samples label", async () => {
 const f = setup(withSignal(SIGNAL));
 const region = screen.getByRole("region", { name: "Early signal, only you can see this" });
 expect(region.textContent).toContain("Only you can see this.");
 expect(region.textContent).toContain("Early signal, few samples: PRs this project rated low risk were merged with no changes requested by a person 5 of 6 times (last 30 days). Reverts after merge aren't tracked yet.");
 await expectNoAxeViolations(f.container);
 f.close();
});

it("drops the few-samples words from ten samples on, and keeps the count", () => {
 const f = setup(withSignal({ ...SIGNAL, held: 11, notHeld: 2, enough: true }));
 const text = screen.getByRole("region", { name: "Early signal, only you can see this" }).textContent;
 expect(text).toContain("Early signal: PRs this project rated low risk were merged with no changes requested by a person 11 of 13 times");
 expect(text).not.toContain("few samples");
 f.close();
});

it("shows nothing when the view has no early score (a viewer who is not the owner, or a task not published with risk low)", () => {
 for (const value of [undefined]) {
  const f = setup(withSignal(value));
  expect(screen.queryByRole("region", { name: /Early signal/u })).toBeNull();
  expect(document.body.textContent).not.toMatch(/rated low risk/u);
  f.close();
 }
});
