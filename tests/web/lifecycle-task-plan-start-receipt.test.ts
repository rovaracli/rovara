// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { PlanStartReceiptView } from "../../packages/ui/src/screens/session/PlanStartReceiptView.js";

const confirmed = {
  currentVersion: 3,
  currentRevision: 8,
  decision: { kind: "confirmed" as const, version: 3, actor: "Ana", actorRole: "owner", revision: 8, at: "2026-11-20T14:12:04Z" },
  build: { state: "starting" as const },
};
const mount = (props: Parameters<typeof PlanStartReceiptView>[0]) => render(createElement(PlanStartReceiptView, props));
afterEach(cleanup);

it("shows the server-confirmed approval for the same plan revision and says the build is still starting", () => {
  mount(confirmed);
  expect(screen.getByRole("heading", { name: "Plan v3 approved" })).toBeTruthy();
  expect(screen.getByText(/Ana, owner/u)).toBeTruthy();
  expect(screen.getByText(/revision 8/u)).toBeTruthy();
  expect(screen.getByText("Build starting")).toBeTruthy();
  expect(screen.getByText(/first command hasn't been observed yet/u)).toBeTruthy();
  expect(screen.queryByText(/running/u)).toBeNull();
});

it("shows another person's recorded decision without saying you approved it", () => {
  mount({ ...confirmed, decision: { ...confirmed.decision, kind: "recorded" } });
  expect(screen.getByText(/Recorded by Ana/u)).toBeTruthy();
  expect(screen.queryByText(/You approved/u)).toBeNull();
});

it("keeps an unknown approval honest and renders only supplied task and check links", () => {
  mount({ currentVersion: 3, currentRevision: 8, decision: { kind: "unknown", version: 3 }, build: { state: "starting" }, taskHref: "/app/tasks/task_1", checkHref: "/app/tasks/task_1#status" });
  expect(screen.getByText("Rovara didn't confirm this yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/tasks/task_1");
  expect(screen.getByRole("link", { name: "Check" }).getAttribute("href")).toBe("/app/tasks/task_1#status");
});

it("does not render owner links when they were not supplied", () => {
  mount(confirmed);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it("does not call a decision current when its plan version differs", () => {
  mount({ ...confirmed, decision: { ...confirmed.decision, version: 2 } });
  expect(screen.getByText(/approval is not confirmed for the current plan/i)).toBeTruthy();
  expect(screen.queryAllByRole("heading", { name: "Plan v3 approved" })).toHaveLength(0);
});
