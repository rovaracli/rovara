// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TaskDiagnosisResultStatusView } from "../../packages/ui/src/screens/session/TaskDiagnosisResultStatusView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

it("shows the read-failed state instead of cached empty suggestions", () => {
 const view = renderUi(h(TaskDiagnosisResultStatusView, { state: "unavailable", onCheck: () => undefined }));
 expect(screen.getByRole("alert").textContent).toContain("The diagnosis could not be read.");
 expect(screen.getByRole("button", { name: "Check this diagnosis" })).toBeTruthy();
 expect(screen.queryByText(/found no suggested repair/u)).toBeNull();
 view.unmount();
});

it("checks the same request when diagnosis start was not confirmed", () => {
 const onCheck = vi.fn();
 const view = renderUi(h(TaskDiagnosisResultStatusView, { state: "unconfirmed", onCheck }));
 expect(screen.getByRole("status").textContent).toContain("The diagnosis was not confirmed.");
 fireEvent.click(screen.getByRole("button", { name: "Check this diagnosis request" }));
 expect(onCheck).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole("button", { name: /repair/u })).toBeNull();
 view.unmount();
});

it("shows no-suggestion support guidance only with a supplied safe reference", () => {
 const withoutReference = renderUi(h(TaskDiagnosisResultStatusView, { state: "empty" }));
 expect(screen.getByRole("status").textContent).toContain("Rovara found no suggested repair.");
 expect(screen.queryByRole("link", { name: /support/u })).toBeNull();
 withoutReference.unmount();

 const withReference = renderUi(h(TaskDiagnosisResultStatusView, { state: "empty", safeReference: "CHECK-123" }));
 expect(screen.getByText(/CHECK-123/u)).toBeTruthy();
 expect(screen.getByText(/Contact support/u)).toBeTruthy();
 withReference.unmount();

 const unsafeReference = renderUi(h(TaskDiagnosisResultStatusView, { state: "empty", safeReference: "private person@example.com" }));
 expect(screen.queryByText(/Contact support/u)).toBeNull();
 unsafeReference.unmount();
});
