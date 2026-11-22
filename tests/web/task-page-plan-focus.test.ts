// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { ID, TASKS, PLAN, PROOF } from "./support/work-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("CAPTURE-FIX: Tab from the first Your decision button reaches the open-decision link on the real Plan route", async () => {
 const view = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8").replaceAll("approve_plan:plan2", `approve_plan:${ID.plan}`).replaceAll("approve_plan/plan2", `approve_plan/${ID.plan}`).replaceAll("11111111-1111-4111-8111-111111111111", ID.plan).replaceAll("plan2", ID.plan)) as { views: Record<string, unknown> };
 const f = fakeHost(async r => {
  if (r.method !== "GET") throw new Error("Focus navigation must send no writes");
  const path = r.path.split("?")[0];
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: navFixture() };
  if (path === "/v1/app/sessions") return { status: 200, body: { tasks: TASKS } };
  if (path === "/v1/app/decisions") return { status: 200, body: view.views["approve_plan_with_choices"] };
  if (path?.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (path?.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (path?.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (path?.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + ID.plan] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 try {
  await screen.findByRole("region", { name: "Spec" });
  const card = await screen.findByRole("region", { name: "Your decision" }), first = card.querySelector<HTMLButtonElement>("button")!;
  expect(first).not.toBeNull();expect(first.disabled).toBe(true);
  fireEvent.click(within(card).getByRole("checkbox", { name: /I agree Rovara may spend up to/ }));
  expect(first.disabled).toBe(false);first.focus();expect(document.activeElement).toBe(first);
  await userEvent.setup().tab();
  expect(document.activeElement).toBe(card.querySelector("a.rv-decision-open"));
  expect(within(card).getByRole("link", { name: "Open the details" }).getAttribute("href")).toContain(ID.plan);
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 } finally { ui.unmount();router.dispose();query.clear(); }
});
