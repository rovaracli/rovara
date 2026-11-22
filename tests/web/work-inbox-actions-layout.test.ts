// @vitest-environment jsdom
// ACTIONS-LAYOUT round: where the restored live controls sit. Layout pins only; the send, lock and authority rules stay in work-inbox-action-complete.test.ts.
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture } from "./support/fixtures.js";
import { sceneReplies, unitScenes } from "./support/work-inbox-scenes.js";
import { ID } from "./support/work-fixture.js";
const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).forEach(close => close());localStorage.clear(); });
function mount(route: string, scene = "work-all", outcome: ApiResponse = { status: 200, body: {} }) {
 const replies: Record<string, ApiResponse> = { ...sceneReplies(unitScenes.find(item => item.id === scene)!), "/v1/app/me": { status: 200, body: meFixture() } };
 const f = fakeHost(async input => input.method !== "GET" ? outcome : replies[input.path.split("?")[0]!] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 const query = createQueryClient(), nav = AppNavReaderSchema.parse(replies["/v1/app/nav"]!.body);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [route] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 closes.push(() => { view.unmount();router.dispose();query.clear(); });
 return { ...f, view };
}
const precedes = (first: Element, second: Element) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

it("the decision controls sit flat inside the peek: Approve, Not now and the evidence row, with no card of their own", async () => {
 mount("/app/live?task=" + ID.plan);
 const peek = await screen.findByLabelText("Selected task");
 const approve = await within(peek).findByRole("button", { name: "Approve plan v1" });
 expect(approve.closest(".rv-decision-actions")).not.toBeNull();
 expect(within(peek).getByText("Not now", { selector: "summary" }).closest("details")?.className).toContain("rv-decision-reject");
 expect(peek.querySelector(".rv-decision-pane .rv-card")).toBeNull();
 expect(peek.querySelectorAll(".rv-decision-pane").length).toBe(1);
});
it("the medium-risk merge card puts the evidence disclosure before its locked Merge button", async () => {
 mount("/app/live?task=" + ID.merge);
 const peek = await screen.findByLabelText("Selected task");
 const evidence = await within(peek).findByText("Open the evidence to approve", { selector: "summary" });
 const merge = within(peek).getByRole("button", { name: /Merge/u });
 expect(evidence.closest("details")?.className).toContain("rv-decision-panel");
 expect(precedes(evidence, merge)).toBe(true);
});
it("a task that asks nothing shows its quiet step above the lessons used, never after them", async () => {
 mount("/app/live?filter=running&task=" + ID.running);
 const peek = await screen.findByLabelText("Selected task");
 const quiet = await within(peek).findByTestId("decision-quiet");
 const lessons = await within(peek).findByTestId("lessons-used");
 expect(precedes(quiet, lessons)).toBe(true);
});
it("the lesson batch asks for the wide peek, and an ordinary task does not", async () => {
 mount("/app/live?task=lessons%3Aweb", "work-lessons-batch");
 await screen.findByTestId("lesson-batch");
 expect(screen.getByTestId("work").getAttribute("data-peek-wide")).toBe("true");
 closes.splice(0).forEach(close => close());
 mount("/app/live?task=" + ID.plan);
 await screen.findByRole("button", { name: "Approve plan v1" });
 expect(screen.getByTestId("work").getAttribute("data-peek-wide")).toBe("false");
});
it("each lesson's Keep, Edit and Drop are one radio group in one row, with Undo after a choice and Send at the foot", async () => {
 mount("/app/live?task=lessons%3Aweb", "work-lessons-batch");
 const batch = await screen.findByTestId("lesson-batch");
 const choice = batch.querySelector("fieldset.rv-lesson-choice")!;
 expect(within(choice as HTMLElement).getAllByRole("radio").map(radio => radio.getAttribute("name"))).toEqual(["lesson-les_pend0001", "lesson-les_pend0001", "lesson-les_pend0001"]);
 expect(within(choice as HTMLElement).queryByRole("button", { name: "Undo" })).toBeNull();
 fireEvent.click(within(batch).getByRole("radio", { name: /Keep/u }));
 expect(within(choice as HTMLElement).getByRole("button", { name: "Undo" })).toBeTruthy();
 const send = batch.querySelector(".rv-lesson-send")!;
 expect(within(send as HTMLElement).getByRole("button", { name: "Send decision" })).toBeTruthy();
 expect(precedes(choice, send)).toBe(true);
});
it("Mark all as read stays in the header actions; an unlisted refusal stays unknown in a failure line under it", async () => {
 const f = mount("/app/inbox", "inbox-updates-populated", { status: 409, body: { error: { code: "REFUSED", message: "The server refused this request." } } });
 const button = await screen.findByRole("button", { name: "Mark all as read" });
 expect(button.closest(".rv-page-header .rv-actions")).not.toBeNull();
 fireEvent.click(button);
 const failure = await screen.findByText("Rovara didn't confirm this yet. Check its outcome before another change.");
 expect(failure.closest("p")?.className).toContain("rv-qp-failure");
 expect(failure.closest("[role=alert]")).not.toBeNull();
 await waitFor(() => expect(f.request.mock.calls.filter(([input]) => input.method !== "GET")).toHaveLength(1));
});
it.each(["/app/live?task=" + ID.plan, "/app/inbox"])("the checking notice and its exit line sit before the page, as the sibling rule that keeps the phone peek from covering them expects: %s", async route => {
 const person = meFixture(), subject = route.includes("inbox") ? "inbox" : "task:" + ID.plan;
 localStorage.setItem("rovara:queue-action:" + JSON.stringify([person.org.orgId, person.developer.id, subject]), JSON.stringify({ request: { method: "POST", path: "/v1/app/inbox/read", body: { ids: ["x"], requestId: "held" } }, startedAt: new Date(Date.now() - 600001).toISOString() }));
 mount(route, route.includes("inbox") ? "inbox-updates-populated" : "work-all");
 const link = await screen.findByRole("link", { name: "Open the task to check" });
 const notice = document.querySelector(".rv-outcome")!, exit = link.closest("p")!, page = document.querySelector(".rv-qp")!;
 expect(notice.parentElement).toBe(page.parentElement);expect(exit.parentElement).toBe(page.parentElement);
 expect(precedes(notice, exit)).toBe(true);expect(precedes(exit, page)).toBe(true);
 const css = readFileSync("packages/ui/src/screens/work/work-preview.css", "utf8");
 expect(css).toContain(".rv-outcome~.rv-qp .rv-qp-peek");expect(css).toContain(".rv-outcome~p[role=status]~.rv-qp .rv-qp-peek{margin-top:0}");
});
