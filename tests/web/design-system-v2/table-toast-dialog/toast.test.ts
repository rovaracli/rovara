// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Announcer } from "../../../../packages/ui/src/design/Announcer.js";
import { Toast } from "../../../../packages/ui/src/design/Toast.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
afterEach(() => vi.useRealTimers());
for (const theme of ["light", "dark"] as const) describe(`${theme} toast`, () => {
 it("offers Undo only for a reversible action and invokes it once", async () => {
  const onUndo = vi.fn(), onDismiss = vi.fn();
  renderUi(h(Announcer, null, h(Toast, { message: "Stopped following this task.", onUndo, onDismiss })), { theme });
  const undo = screen.getByRole("button", { name: "Undo" }); fireEvent.click(undo); fireEvent.click(undo);
  expect(onUndo).toHaveBeenCalledTimes(1); expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  await expectNoAxeViolations(document.body);
 });
 it("renders the legacy receipt inline without toast chrome or an invented Undo", async () => {
  const onDismiss = vi.fn(); renderUi(h(Announcer, null, h(Toast, { message: "Draft saved", onDismiss })), { theme });
  expect(screen.getByText("Draft saved")).toBeTruthy(); expect(document.querySelector(".rv-toast")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" })); expect(onDismiss).toHaveBeenCalledOnce();
  await expectNoAxeViolations(document.body);
 });
});
it("uses the existing delayed, coalesced polite channel without a duplicate live region", async () => {
 vi.useFakeTimers(); renderUi(h(Announcer, null, h(Toast, { message: "Stopped following this task.", onUndo: vi.fn(), onDismiss: vi.fn() })));
 const region = document.querySelector('[aria-live="polite"]')!; expect(region.textContent).toBe("");
 await act(() => vi.advanceTimersByTimeAsync(1000)); expect(region.textContent).toBe("Stopped following this task.");
 expect(document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(1);
});
