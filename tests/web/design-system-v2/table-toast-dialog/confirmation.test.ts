// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ConfirmationDialog, type ConfirmationDialogProps } from "../../../../packages/ui/src/design/ConfirmationDialog.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
const title = 'Close "Add refunds endpoint"?';
const consequence = "3 changed files are not in a pull request yet. Closing keeps them for the served retention period unless you discard them.";
const confirmLabel = "Keep changes and close";
function fixture() {
 const confirm = vi.fn(), discard = vi.fn();
 function Demo() { const [open, setOpen] = useState(false); return h("div", null, h("button", { onClick: () => setOpen(true) }, "Close task"), h(ConfirmationDialog, { kind: "close", title, consequence, open, onOpenChange: setOpen, confirm: { label: confirmLabel, onConfirm: confirm }, discard: { label: "Discard changes and close", consequence: "Deletes the 3 unpublished files. This can't be undone.", onDiscard: discard } })); }
 return { Demo, confirm, discard };
}
for (const theme of ["light", "dark"] as const) describe(`${theme} confirmation`, () => {
 it("names the consequence, focuses Cancel, traps focus and restores the opener after Escape", async () => {
  const { Demo, confirm, discard } = fixture(); renderUi(h(Demo), { theme }); const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "Close task" }); await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: title }); expect(dialog.getAttribute("aria-describedby")).toBeTruthy(); expect(screen.getByText(consequence)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  for (let n = 0; n < 8; n++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
  await expectNoAxeViolations(document.body); await user.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(opener);
  expect(confirm).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
 });
 it("keeps Discard inside Close, repeats the supplied verb, and prevents double or competing dispatch", async () => {
  const { Demo, confirm, discard } = fixture(); renderUi(h(Demo), { theme }); await userEvent.click(screen.getByRole("button", { name: "Close task" }));
  const action = screen.getByRole("button", { name: confirmLabel }); fireEvent.click(action); fireEvent.click(action); fireEvent.click(screen.getByRole("button", { name: "Discard changes and close" }));
  expect(confirm).toHaveBeenCalledTimes(1); expect(discard).not.toHaveBeenCalled();
 });
});
it("busy suppresses both actions while Cancel closes without executing either", async () => {
 const confirm = vi.fn(), discard = vi.fn(), close = vi.fn();
 renderUi(h(ConfirmationDialog, { kind: "close", title, consequence, open: true, busy: true, onOpenChange: close, confirm: { label: confirmLabel, onConfirm: confirm }, discard: { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard: discard } }));
 fireEvent.click(screen.getByRole("button", { name: confirmLabel })); fireEvent.click(screen.getByRole("button", { name: "Discard changes and close" }));
 await userEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(close).toHaveBeenCalledWith(false); expect(confirm).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
});
it("dispatches Discard once and renders no discard for non-Close kinds even at the runtime boundary", () => {
 const onDiscard = vi.fn(); const common = { title: "Remove Sam?", consequence: "Sam loses project access.", open: true, onOpenChange: vi.fn(), confirm: { label: "Remove Sam", onConfirm: vi.fn() } };
 const discard = { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard };
 const view = renderUi(h(ConfirmationDialog, { ...common, kind: "close", discard }));
 const action = screen.getByRole("button", { name: discard.label }); fireEvent.click(action); fireEvent.click(action); expect(onDiscard).toHaveBeenCalledTimes(1);
 view.rerender(h(ConfirmationDialog, { ...common, kind: "destructive", ...{ discard } } as unknown as ConfirmationDialogProps));
 expect(screen.queryByRole("button", { name: discard.label })).toBeNull();
});
// @ts-expect-error Discard is only valid inside the Close composition.
const invalid: ConfirmationDialogProps = { kind: "raise_money", open: false, onOpenChange: () => undefined, title, consequence, confirm: { label: confirmLabel, onConfirm: () => undefined }, discard: { label: "Discard", consequence: "Deletes files", onDiscard: () => undefined } };
void invalid;
