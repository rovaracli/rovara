import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { Announcer } from "../../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import PublishRequestsScreen from "../../../packages/ui/src/screens/agents/PublishRequestsScreen.js";
import { AGENT_PUBLISH_STORAGE_KEY } from "../../../packages/ui/src/screens/agents/publish-flags.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";
import { fakeHost } from "./fake-host.js";
import { navFixture } from "./fixtures.js";
import { errorBody } from "./publish-data.js";
export { uuid, approvalId, person, me, other, summary, publishRequest, agentCard, myAgents, errorBody } from "./publish-data.js";
export const ON = { [AGENT_PUBLISH_STORAGE_KEY]: "v2" };
export const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

/** The publish requests screen on its own address, with its own routes answered by `reply`. */
export function renderRequests(reply: (request: ApiRequest) => Promise<ApiResponse> | ApiResponse | undefined, options: { on?: boolean; theme?: "light" | "dark"; role?: "member" | "admin" } = {}) {
 const f = fakeHost(async request => (await reply(request)) ?? { status: 404, body: errorBody("NOT_FOUND", "Not found.") });
 if (options.on !== false) f.storage.set(AGENT_PUBLISH_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], navFixture());
 const router = createMemoryRouter([{ path: "/app/agents/requests", element: h(PublishRequestsScreen, {}) }], { initialEntries: ["/app/agents/requests"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, router, close() { ui.unmount();router.dispose();query.clear(); } };
}
