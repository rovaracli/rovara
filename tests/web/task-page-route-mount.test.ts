// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { navFixture } from "./support/fixtures.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const routes = () => appRoutes(navFixture().features);
it.each(["/app/sessions/:id", "/s/:id"])("%s mounts the rebuilt task page lazy leaf", async path => {
 const tree = routes();
 const leaf = path === "/s/:id" ? tree.find(route => route.path === path)!.children![0]! : tree.find(route => route.path === "/app")!.children!.find(route => route.path === "sessions/:id")!;
 const resolved = await (leaf.lazy as () => Promise<{ Component: unknown }>)();
 expect(resolved.Component).toBe(SessionScreen);
});
it("retires the preview by replacing its address with the real share route, preserving URL context", async () => {
 const preview = routes().find(route => route.path === "/app")!.children!.find(route => route.path === "task-preview/:id")!;
 const id = "ses_aaaaaaaaaaaaaaaaaaaa";
 const router = createMemoryRouter([
  { path: "/app/live", element: h("p", {}, "Work") },
  { ...preview, path: "/app/task-preview/:id" },
  { path: "/s/:id", element: h("p", {}, "Real task route") },
 ], { initialEntries: ["/app/live", `/app/task-preview/${id}?source=old#task-talk`] });
 const ui = renderUi(h(RouterProvider, { router }));
 try {
  await screen.findByText("Real task route");
  expect(router.state.location.pathname).toBe("/s/" + id);
  expect(router.state.location.search).toBe("?source=old");
  expect(router.state.location.hash).toBe("#task-talk");
  await act(async () => { await router.navigate(-1); });
  await waitFor(() => expect(router.state.location.pathname).toBe("/app/live"));
 } finally { ui.unmount();router.dispose(); }
});
