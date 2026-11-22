// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { sceneReplies, unitScenes, validateSceneReplies } from "./support/work-inbox-scenes.js";

import { NOW } from "./support/work-fixture.js";

beforeEach(() => { vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });
for (const scene of unitScenes) it("serves capture state on the production route: " + scene.id, async () => {
 const replies = sceneReplies(scene);validateSceneReplies(replies);validateSceneReplies(scene.later ?? {});
 const f = fakeHost(async request => scene.pending?.includes(request.path.split("?")[0]!) ? new Promise(() => undefined) : replies[request.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "not served" } } });
 const nav = AppNavReaderSchema.parse(replies["/v1/app/nav"]!.body), query = createQueryClient();
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [scene.route] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 try {
  if (scene.later !== undefined) {
   await waitFor(() => expect(view.container.querySelector("[data-testid=pane-title], [data-testid=inbox-attention]")).toBeTruthy());
   await waitFor(() => expect(query.isFetching()).toBe(0));Object.assign(replies, scene.later);
   await act(async () => { await query.invalidateQueries({ queryKey: scene.invalidate ?? [] }); });
  }
  await waitFor(() => expect(view.container.querySelector(scene.selector)?.textContent).toContain(scene.text));
  for (const forbidden of scene.forbidden ?? []) expect(view.container.querySelector(scene.route.startsWith("/app/inbox") ? "[data-testid=inbox-attention]" : "[data-testid=work]")?.textContent).not.toContain(forbidden);
  // Merely reading a served scene never sends. Action-complete tests press each live action separately.
  expect(router.state.location.pathname + router.state.location.search).toBe(scene.route);
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 } finally { view.unmount();router.dispose();query.clear(); }
});
