// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { TaskContinuationRefusalView } from "../../packages/ui/src/screens/session/TaskContinuationRefusalView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

describe("task continuation refusal", () => {
  it("shows a closed task refusal with the exact catalogue facts and only its supplied start link", () => {
    renderUi(h(TaskContinuationRefusalView, { reason: "closed", taskTitle: "Fix duplicate refunds", startHref: "/app/work/new" }));

    expect(screen.getByText("Fix duplicate refunds")).toBeTruthy();
    expect(screen.getByText("This task is closed and cannot accept another round. Its recorded work is kept.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start a new task." }).getAttribute("href")).toBe("/app/work/new");
    expect(screen.queryByRole("link", { name: "Open the current decision." })).toBeNull();
  });

  it("shows the released-before-start refusal without claiming that the task ran", () => {
    renderUi(h(TaskContinuationRefusalView, { reason: "released", taskTitle: "Fix duplicate refunds" }));

    expect(screen.getByText("This task never started and no longer holds a workspace slot. Its request is kept.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the approval refusal and links only to the decision destination supplied by its owner", () => {
    renderUi(h(TaskContinuationRefusalView, { reason: "approval", taskTitle: "Fix duplicate refunds", decisionHref: "/review/task/decision" }));

    expect(screen.getByText("Approve the plan first. This task is waiting for an approval decision. No new round was started.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the current decision." }).getAttribute("href")).toBe("/review/task/decision");
    expect(screen.queryByRole("link", { name: "Start a new task." })).toBeNull();
  });

  it("does not infer a destination or add an action when the owning surface supplied no href", () => {
    renderUi(h(TaskContinuationRefusalView, { reason: "approval" }));

    expect(screen.getByText("Approve the plan first. This task is waiting for an approval decision. No new round was started.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
