// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskStartReceiptView } from "../../packages/ui/src/screens/session/TaskStartReceiptView.js";
import { taskFixture } from "./support/session-fixture.js";

afterEach(cleanup);

const task = taskFixture();
const accepted = {
 kind: "confirmed" as const,
 request: { id: "req-91f3", text: "Add a refunds endpoint. Repeated requests must not refund twice." },
 taskLink: { href: `/t/${task.taskId}`, label: "Open the task" },
 currentPhase: "waiting-machine" as const,
 phases: [
  { kind: "accepted" as const, observedAt: "14:32:02" },
  { kind: "waiting-machine" as const, observedAt: "14:32:03" },
 ],
};

it("keeps an accepted request separate from machine readiness and the first command", () => {
 render(createElement(TaskStartReceiptView, { outcome: accepted }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("Starting: waiting for a machine")).toBeTruthy();
 expect(within(receipt).getByText(accepted.request.text)).toBeTruthy();
 expect(within(receipt).getByRole("link", { name: "Open the task" }).getAttribute("href")).toBe(accepted.taskLink.href);
 expect(within(receipt).queryByText("Machine ready")).toBeNull();
 expect(within(receipt).queryByText("First command")).toBeNull();
 expect(within(receipt).queryByText(/Running|spent|slot|verified/i)).toBeNull();
});

it("shows ready and first command only when those phases were explicitly observed", () => {
 const outcome = { ...accepted, currentPhase: "first-command" as const, phases: [
  { kind: "accepted" as const, observedAt: "14:32:02" },
  { kind: "ready" as const, observedAt: "14:32:20" },
  { kind: "first-command" as const, observedAt: "14:32:48" },
 ] };
 render(createElement(TaskStartReceiptView, { outcome }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("Machine ready")).toBeTruthy();
 expect(within(receipt).getByText("First command")).toBeTruthy();
 expect(within(receipt).getByText("14:32:20")).toBeTruthy();
 expect(within(receipt).getByText("14:32:48")).toBeTruthy();
});

it("renders an already-accepted request with the exact task link", () => {
 render(createElement(TaskStartReceiptView, { outcome: { ...accepted, alreadyAccepted: true } }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("This request already started a task.")).toBeTruthy();
 expect(within(receipt).getByRole("link", { name: "Open the task" }).getAttribute("href")).toBe(accepted.taskLink.href);
});

it("does not turn request acceptance alone into a waiting-machine status", () => {
 render(createElement(TaskStartReceiptView, { outcome: { ...accepted, currentPhase: "accepted", phases: [{ kind: "accepted", observedAt: "14:32:02" }] } }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("Request accepted")).toBeTruthy();
 expect(within(receipt).queryByText("Starting: waiting for a machine")).toBeNull();
 expect(within(receipt).queryByText(/Running|spent|slot|verified/i)).toBeNull();
});

it("keeps an unconfirmed send honest and renders only the owner's Check control", () => {
 const check = createElement("button", { type: "button" }, "Check whether the task was created");
 render(createElement(TaskStartReceiptView, { outcome: { kind: "unknown", check } }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("Rovara didn't confirm this yet")).toBeTruthy();
 expect(within(receipt).getByText(/start request was sent.*readable confirmation/i)).toBeTruthy();
 expect(within(receipt).getByText(/No second start is sent from this receipt/i)).toBeTruthy();
 expect(within(receipt).getByRole("button", { name: "Check whether the task was created" })).toBeTruthy();
 expect(within(receipt).queryByText(/Running|spent|slot|verified/i)).toBeNull();
});

it("says plainly that only the task title is shown, never that the full request is missing", () => {
 render(createElement(TaskStartReceiptView, { outcome: { ...accepted, request: { id: "req-91f3", text: "Add a refunds endpoint", textKind: "task-title" as const } } }));
 const receipt = screen.getByRole("region", { name: "Task start receipt" });
 expect(within(receipt).getByText("Showing the task title.")).toBeTruthy();
 expect(within(receipt).queryByText(/not available/iu)).toBeNull();
});
