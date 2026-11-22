// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { PlanCriterionCommentAvailabilityView } from "../../packages/ui/src/screens/session/PlanCriterionCommentAvailabilityView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

describe("plan criterion comment availability", () => {
 it("shows the approved inline notice only for the explicit unavailable-route answer", () => {
  renderUi(h(PlanCriterionCommentAvailabilityView, { error: new ApiError(501, "NOT_ON_CODE_YET", "private route detail"), conversationHref: "/app/sessions/ses_123" }));
  expect(screen.getByTestId("criterion-comment-unavailable").textContent).toBe("Comments on the spec are not available on this installation. The plan was not changed. Open the task conversation");
  expect(screen.getByRole("link", { name: "Open the task conversation" }).getAttribute("href")).toBe("/app/sessions/ses_123");
  expect(screen.queryByText("private route detail")).toBeNull();
 });

 it("does not infer route unavailability from network, server, or other refusal errors", () => {
  for (const error of [
   new ApiError(503, "RUNTIME_UNAVAILABLE", "service unavailable"),
   new ApiError(404, "NOT_FOUND", "missing"),
   new ApiError(403, "FORBIDDEN", "refused"),
   new Error("network failure"),
  ]) {
   const view = renderUi(h(PlanCriterionCommentAvailabilityView, { error, conversationHref: "/app/sessions/ses_123" }));
   expect(screen.queryByTestId("criterion-comment-unavailable")).toBeNull();
   view.unmount();
  }
 });

 it("does not offer a conversation destination unless the owner supplies its authorized link", () => {
  renderUi(h(PlanCriterionCommentAvailabilityView, { error: new ApiError(501, "NOT_ON_CODE_YET", "private route detail") }));
  expect(screen.getByTestId("criterion-comment-unavailable")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
 });
});
