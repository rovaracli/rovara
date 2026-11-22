// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { useWorkReads } from "../../packages/ui/src/api/work-read.js";
import { useDecisions as useLiveDecisions } from "../../packages/ui/src/api/decisions.js";
import { createReadClient } from "../../packages/ui/src/api/read-client.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { sceneReplies, unitScenes } from "./support/work-inbox-scenes.js";
import { ID } from "./support/work-fixture.js";
import { meFixture } from "./support/fixtures.js";
const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).forEach(close => close()); });
function mount(name: string, pendingLesson = false, extra: Record<string, ApiResponse> = {}) {
 const replies: Record<string, ApiResponse> = sceneReplies(unitScenes.find(scene => scene.id === "work-all")!);
 replies["/v1/app/org/spend"] = { status: 200, body: { remainingUsd: 100 } };
 // The shared TaskPane (WIRING-2) offers a sender only once the signed-in person is read.
 replies["/v1/app/me"] = { status: 200, body: meFixture() };Object.assign(replies, extra);
 const f = fakeHost(async input => pendingLesson && input.path === "/v1/app/lessons/inbox" ? new Promise(() => undefined) : replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 const query = createQueryClient(), nav = AppNavReaderSchema.parse(replies["/v1/app/nav"]!.body);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [(name === "work" ? "/app/live" : "/app/inbox") + (name === "work" ? "?task=" : "?item=") + ID.plan] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 closes.push(() => { view.unmount();router.dispose();query.clear(); });return { ...f, replies, query, view };
}
it.each([{ error: { code: "ACCESS_ENDED" } }, { private: "detail", error: { code: "FORBIDDEN", message: "Access ended." } }])("read transport preserves explicit access signal before schema parsing: %j", async body => {
 const f = fakeHost(async () => ({ status: 200, body }));
 await expect(createReadClient(f.host).get("/read", { parse: () => "private" })).rejects.toMatchObject({ code: body.error.code });expect(f.host.signIn).not.toHaveBeenCalled();
});
it("access-ended auth redirects once even in an unreadable success envelope", async () => {
 const f = fakeHost(async () => ({ status: 200, body: { error: { code: "SESSION_EXPIRED" } } }));
 const api = createReadClient(f.host);
 await expect(api.get("/read", { parse: () => "private" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
 await expect(api.get("/read", { parse: () => "private" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
 expect(f.host.signIn).toHaveBeenCalledTimes(1);
});
it.each(["work", "inbox"])("%s retains last facts on failed refresh, marks stale, and erases on access ended", async name => {
 const f = mount(name);
 await waitFor(() => expect(f.query.getQueryState(["work", "tasks"])?.status).toBe("success"));
 await waitFor(() => expect(f.query.isFetching()).toBe(0));
 expect(screen.queryByText(/Updated .* · Reconnecting/u)).toBeNull();
 f.replies["/v1/app/sessions"] = { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Refresh failed." } } };
 // Reject at the transport boundary to avoid the client's bounded backoff in this mounted regression.
 f.request.mockImplementation(async input => { if (input.path === "/v1/app/sessions") throw new (await import("../../packages/ui/src/api/errors.js")).ApiError(503, "INTERNAL_ERROR", "Refresh failed.");return f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }; });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
 expect(f.view.container.querySelector("[data-task-id], [data-attention-id]")).toBeTruthy();
 await waitFor(() => expect(screen.getAllByText(/Updated .* · Reconnecting/u)).toHaveLength(1));
 if (name === "work") { expect(f.view.container.querySelector("fieldset[disabled]")).toBeTruthy();expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull(); }
 f.replies["/v1/app/sessions"] = { status: 200, body: { error: { code: "ACCESS_ENDED" } } };
 f.request.mockImplementation(async input => f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
 expect(f.query.getQueryData(["work", "tasks"])).toBeUndefined();
 await waitFor(() => expect(f.view.container.querySelector("[data-task-id], [data-attention-id]")).toBeNull());
});
it.each(["/v1/app/decisions", "/v1/app/involved", "/v1/app/org/spend"])("optional read %s never swallows an access-ended 404", async path => {
 const f = mount("work");await waitFor(() => expect(f.query.getQueryState(["work", "org-spend"])?.status).toBe("success"));await waitFor(() => expect(f.query.isFetching()).toBe(0));
 f.replies[path] = { status: 404, body: { error: { code: "ACCESS_ENDED", message: "Decision access ended." } } };
 await act(async () => { await f.query.invalidateQueries(); });
 const key = path.endsWith("decisions") ? ["decisions"] : path.endsWith("involved") ? ["work", "involved"] : ["work", "org-spend"];
 await waitFor(() => expect(f.query.getQueryState(key)?.status).toBe("error"));expect(f.query.getQueryData(key)).toBeUndefined();
});
it("Needs you has no numeric count until lessons complete", async () => {
 const f = mount("inbox", true);await screen.findByRole("region", { name: "Inbox attention" });
 await waitFor(() => { expect(f.query.getQueryState(["work", "tasks"])?.status).toBe("success");expect(f.query.getQueryState(["decisions"])?.status).toBe("success"); });
 await waitFor(() => expect(screen.getByRole("button", { name: /^Needs you/u }).textContent).toBe("Needs you"));
});
it("independent plan refresh retains spec facts, removes answers and contributes one reconnecting line", async () => {
 const f = mount("work");await screen.findByRole("button", { name: "Yes, behind a flag" });
 await waitFor(() => expect(f.query.isFetching()).toBe(0));
 f.request.mockImplementation(async input => { if (input.path.endsWith("/documents/plan")) throw new (await import("../../packages/ui/src/api/errors.js")).ApiError(503, "INTERNAL_ERROR", "Plan refresh failed.");return f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }; });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "plan", ID.plan] }); });
 await waitFor(() => expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull());
 expect(screen.getByRole("region", { name: "Spec" }).textContent).toContain("WHEN");
 expect(screen.getAllByText(/Updated .* · Reconnecting/u)).toHaveLength(1);
});

it("the shared live decision reader does not swallow an access-ended 404", async () => {
 const f = mount("work");await waitFor(() => expect(f.query.getQueryState(["decisions"])?.status).toBe("success"));
 f.replies["/v1/app/decisions"] = { status: 404, body: { error: { code: "ACCESS_ENDED", message: "Decision access ended." } } };
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["decisions"] }); });
 expect(f.query.getQueryState(["decisions"])?.status).toBe("error");expect(f.query.getQueryData(["decisions"])).toBeUndefined();
});

// The live decision reader (the task page, Home and the old screens) keeps WIRING-2's identity fences and the rebuild's access-ended rule: only a plain NOT_FOUND 404 is "no cards".
it.each([["NOT_FOUND", "resolves to no cards"], ["ACCESS_ENDED", "is an error"], ["FORBIDDEN", "is an error"]] as const)("the live decision reader: a 404 %s %s", async (code, outcome) => {
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : { status: 404, body: { error: { code, message: "Decision access ended." } } });
 let read!: ReturnType<typeof useLiveDecisions>;
 function Harness() { read = useLiveDecisions();return null; }
 const query = createQueryClient(), view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Harness) }) }));closes.push(() => { view.unmount();query.clear(); });
 await waitFor(() => expect(read.isPending).toBe(false));
 if (outcome === "is an error") { expect(read.isError).toBe(true);expect(read.data).toBeUndefined(); }
 else { expect(read.isError).toBe(false);expect(read.data).toEqual([]); }
});

it.each([404, 501])("optional Work readers preserve the documented unsupported-route %s", async status => {
 const f = fakeHost(async () => ({ status, body: { error: { code: status === 404 ? "NOT_FOUND" : "NOT_ON_CODE_YET", message: "route not found" } } }));
 let reads!: ReturnType<typeof useWorkReads>;
 function Harness() { reads = useWorkReads();return null; }
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(Harness) }));closes.push(() => view.unmount());
 await expect(reads.involved()).resolves.toEqual([]);await expect(reads.remainingUsd()).resolves.toBeUndefined();
});

it("independent lesson refresh retains facts with disabled feedback and one reconnecting line", async () => {
 const path = "/v1/app/projects/web/tasks/" + ID.plan + "/lessons";
 const f = mount("work", false, { [path]: { status: 200, body: { lessons: [{ lessonId: "les_logs0001", version: 1, visible: true, canMark: true, title: "Log request ids", stage: "IMPLEMENT", round: 1, why: "scope", citation: "valid" }] } } });
 const mark = await screen.findByRole("button", { name: "Not helpful: Log request ids" });
 await waitFor(() => expect(mark.closest("fieldset")?.disabled).toBe(false));
 f.request.mockImplementation(async input => { if (input.path === path) throw new (await import("../../packages/ui/src/api/errors.js")).ApiError(503, "INTERNAL_ERROR", "Lesson refresh failed.");return f.replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } }; });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["learned", "project", "web", "task", ID.plan] }); });
 await waitFor(() => expect(f.view.container.querySelector("[data-testid=lessons-used] fieldset[disabled]")).toBeTruthy());
 expect(screen.getByTestId("lessons-used").textContent).toContain("Log request ids");expect(screen.getAllByText(/Updated .* · Reconnecting/u)).toHaveLength(1);
});
