// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { OpenTaskScreen } from "../../packages/ui/src/screens/session/OpenTaskScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const TASK = "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
function setUp(reply: (request: ApiRequest) => Promise<ApiResponse>) {
 const f = fakeHost(reply), navigate = vi.spyOn(f.host, "navigate"), router = createMemoryRouter([{ path: "/t/:taskId", element: h(OpenTaskScreen, {}) }], { initialEntries: ["/t/" + TASK] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(RouterProvider, { router }) }));
 return { ...f, navigate, close() { ui.unmount();router.dispose(); } };
}

it("asks Cloud to open the task by its id (one POST, no body) and goes to the session it answers", async () => {
 const f = setUp(async () => ({ status: 200, body: { sessionId: SESSION, sessionUrl: "https://cell.example/s/" + SESSION } }));
 await waitFor(() => expect(f.navigate).toHaveBeenCalledWith("/s/" + SESSION));
 expect(f.request).toHaveBeenCalledTimes(1);
 expect(f.request.mock.calls[0]![0]).toMatchObject({ method: "POST", path: "/v1/app/tasks/" + TASK + "/open" });
 expect(f.request.mock.calls[0]![0].body).toBeUndefined();
 f.close();
});

it("a refusal, a missing task and an unreadable answer all read as not found, and nothing is opened", async () => {
 for (const reply of [
  async () => ({ status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } }),
  async () => ({ status: 200, body: { sessionId: "ses_short", sessionUrl: "x" } }),
 ] as Array<(request: ApiRequest) => Promise<ApiResponse>>) {
  const f = setUp(reply);
  expect(await screen.findByTestId("not-found")).toBeTruthy();
  expect(f.navigate).not.toHaveBeenCalled();
  f.close();
 }
});
