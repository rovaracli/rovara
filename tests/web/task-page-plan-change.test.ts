// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { PlanChangeTable } from "../../packages/ui/src/screens/session/PlanChangeFrame.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { projectFixture } from "./support/project-fixture.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { messageFixture, sessionFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { readFileSync } from "node:fs";
const decisionFixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: { approve_plan_with_choices: { cards: Array<{ id: string }> } } };
afterEach(cleanup);

/** A pending plan decision on the task page, with or without a delivered instruction in the conversation. */
function setup(delivery?: { state: "delivered" | "not_delivered"; reason?: string }) {
 const taskId = taskFixture().taskId;
 const card = JSON.parse(JSON.stringify(decisionFixture.views.approve_plan_with_choices.cards[0]).replaceAll("plan1", taskId)) as { id: string };
 const decisions = DecisionCardsViewReaderSchema.parse({ cards: [card], total: 1, digests: { [card.id]: "a".repeat(64) } });
 const messages = delivery === undefined ? [] : [messageFixture({ kind: "steer", text: "Also allow refunds before they settle.", delivery: { state: delivery.state, at: "2026-10-23T12:00:00.000Z", ...(delivery.reason === undefined ? {} : { reason: delivery.reason }) } })];
 const f = fakeHost(async (r: ApiRequest) => {
  if (r.path === "/v1/app/decisions") return { status: 200, body: decisions };
  if (r.path.endsWith("/overview")) return { status: 200, body: projectFixture() };
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.path.includes("/messages")) return { status: 200, body: { messages } };
  if (r.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (r.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (r.path.endsWith("/documents/plan")) return { status: 200, body: { version: 3, approved: false, summary: { headline: "Retry failed payments safely", checks: ["Retry behavior is covered"] }, estimate: "12 to 25 minutes", requirements: [], tasks: [{ id: "T1", title: "Add retry handling", status: "todo", criterionIds: [] }], questions: [] } };
  if (r.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: sessionFixture({ kind: "task", body: { kind: "task", task: taskFixture() } }) } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const query = createQueryClient();query.setQueryData(["nav"], navFixture());
 const mount = () => { const router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });return renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) })).unmount; };
 return { ...f, mount };
}
const heldIn = (element: HTMLElement) => within(element).queryAllByRole("img", { name: "Unknown" });

it("draws the plan-change frame when an instruction was delivered beside a pending plan, and holds what changed", async () => {
 const close = setup({ state: "delivered" }).mount();
 const frame = await waitFor(() => { const found = document.querySelector<HTMLElement>(".rv-plan-change");expect(found).not.toBeNull();return found!; });
 expect(within(frame).getByRole("heading", { name: "Plan change needs approval" })).toBeTruthy();
 const table = within(frame).getByRole("table");
 // The earlier plan is not served: one Unknown line above the table, and the proposed plan shows what the plan document served.
 expect(heldIn(table)).toHaveLength(0);expect(heldIn(frame.querySelector<HTMLElement>(".rv-plan-change-earlier")!)).toHaveLength(1);expect(table.textContent).toContain("Retry failed payments safely");expect(table.textContent).toContain("Retry behavior is covered");
 expect(within(frame).getByRole<HTMLButtonElement>("button", { name: "Keep the earlier plan" }).disabled).toBe(true);
 expect(within(frame).getByRole("button", { name: "Approve plan v3" })).toBeTruthy();
 expect(within(frame).getByText(/does not approve a plan/)).toBeTruthy();
 const rail = document.querySelector<HTMLElement>(".rv-plan-change-rail")!;
 expect(rail.textContent).toContain("What happens after you decide");
 expect(rail.textContent).toContain("An approval receipt is not available here yet.");
 expect(within(rail).getByRole("heading", { name: "Earlier plan · unavailable" })).toBeTruthy();
 expect(rail.textContent).not.toContain("You get a receipt");
 close();
});
it("keeps the ordinary plan card when no instruction was delivered", async () => {
 const close = setup().mount();
 await screen.findByRole("button", { name: "Approve plan v3" });
 expect(document.querySelector(".rv-plan-change")).toBeNull();expect(document.querySelector(".rv-plan-change-rail")).toBeNull();
 close();
});
it("shows the plan-change card and a Review plan bar in the Talk sheet", async () => {
 const close = setup({ state: "delivered" }).mount();
 await waitFor(() => expect(document.querySelector(".rv-plan-change")).not.toBeNull());
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 const sheet = await waitFor(() => { const found = document.querySelector<HTMLElement>(".rv-plan-change-sheet");expect(found).not.toBeNull();return found!; });
 expect(sheet.textContent).toContain("Plan change needs approval");expect(sheet.textContent).toContain("Retry failed payments safely");
 expect(document.querySelector(".rv-plan-change-bar")?.textContent).toContain("Review plan v3");
 expect(screen.getByRole("button", { name: "Back to the task" })).toBeTruthy();
 close();
});
it("closes the thread with a reference footer after an instruction was not delivered, and brings the composer back for a comment", async () => {
 const close = setup({ state: "not_delivered", reason: "This session has ended." }).mount();
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 const footer = await screen.findByTestId("talk-ref-footer");
 expect(footer.textContent).toContain("TALK-BUILD-ENDED");expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
 fireEvent.click(await screen.findByRole("button", { name: "Post it as a comment instead" }));
 await screen.findByRole("textbox", { name: "Comment" });expect(screen.queryByTestId("talk-ref-footer")).toBeNull();
 close();
});

it("P1: with no served version the proposed plan header never invents one", () => {
 renderUi(h(PlanChangeTable, { facts: { version: undefined, headline: "Retry safely", checks: [], estimate: undefined, taskCount: 0 } }));
 expect(screen.getByRole("columnheader", { name: "Plan · proposed" }).textContent).toBe("Plan · proposed");
});
