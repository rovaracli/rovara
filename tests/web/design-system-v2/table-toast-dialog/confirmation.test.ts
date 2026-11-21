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
function fixture(requestKey: string) {
 const confirm = vi.fn(), discard = vi.fn();
 function Demo() { const [open, setOpen] = useState(false); return h("div", null, h("button", { onClick: () => setOpen(true) }, "Close task"), h(ConfirmationDialog, { requestKey, kind: "close", title, consequence, open, onOpenChange: setOpen, confirm: { label: confirmLabel, onConfirm: confirm }, discard: { label: "Discard changes and close", consequence: "Deletes the 3 unpublished files. This can't be undone.", onDiscard: discard } })); }
 return { Demo, confirm, discard };
}
for (const theme of ["light", "dark"] as const) describe(`${theme} confirmation`, () => {
 it("names the consequence, focuses Cancel, traps focus and restores the opener after Escape", async () => {
  const { Demo, confirm, discard } = fixture(`${theme}-focus`); renderUi(h(Demo), { theme }); const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "Close task" }); await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: title }); expect(dialog.getAttribute("aria-describedby")).toBeTruthy(); expect(screen.getByText(consequence)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  for (let n = 0; n < 8; n++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
  await expectNoAxeViolations(document.body); await user.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(opener);
  expect(confirm).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
 });
 it("keeps Discard inside Close, repeats the supplied verb, and prevents double or competing dispatch", async () => {
  const { Demo, confirm, discard } = fixture(`${theme}-competing`); renderUi(h(Demo), { theme }); await userEvent.click(screen.getByRole("button", { name: "Close task" }));
  const action = screen.getByRole("button", { name: confirmLabel }); fireEvent.click(action); fireEvent.click(action); fireEvent.click(screen.getByRole("button", { name: "Discard changes and close" }));
  expect(confirm).toHaveBeenCalledTimes(1); expect(discard).not.toHaveBeenCalled();
 });
});
it("busy suppresses both actions while Cancel closes without executing either", async () => {
 const confirm = vi.fn(), discard = vi.fn(), close = vi.fn();
 renderUi(h(ConfirmationDialog, { requestKey: "busy-actions", kind: "close", title, consequence, open: true, busy: true, onOpenChange: close, confirm: { label: confirmLabel, onConfirm: confirm }, discard: { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard: discard } }));
 fireEvent.click(screen.getByRole("button", { name: confirmLabel })); fireEvent.click(screen.getByRole("button", { name: "Discard changes and close" }));
 await userEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(close).toHaveBeenCalledWith(false); expect(confirm).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
});
it("keeps an unknown confirm outcome locked after busy clears", async () => {
 const onConfirm = vi.fn(), onOpenChange = vi.fn();
 const props = { requestKey: "unknown-busy-remount", kind: "destructive" as const, title: "Remove Sam?", consequence: "Sam loses project access.", open: true, preview: true, onOpenChange, confirm: { label: "Remove Sam", onConfirm } };
 const view = renderUi(h(ConfirmationDialog, { ...props, busy: false }));
 fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
 expect(onConfirm).toHaveBeenCalledTimes(1);
 view.rerender(h(ConfirmationDialog, { ...props, busy: true }));
 view.rerender(h(ConfirmationDialog, { ...props, busy: false }));
 fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
 expect(onConfirm).toHaveBeenCalledTimes(1);
});
it("keeps confirm and discard locked through busy, close and action remounts until a new request identity", () => {
 const onConfirm = vi.fn(), onDiscard = vi.fn();
 const props = { requestKey: "close-first-request", kind: "close" as const, title, consequence, open: true, preview: true, onOpenChange: vi.fn(), confirm: { label: confirmLabel, onConfirm }, discard: { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard } };
 // Preserve renderUi's wrapper so this also tests updates without remounting the dialog.
 const element = (overrides: Partial<typeof props> & { busy?: boolean } = {}) => h("div", { "data-theme": "light" }, h(ConfirmationDialog, { ...props, ...overrides }));
 const view = renderUi(h(ConfirmationDialog, props));
 fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
 view.rerender(element({ busy: true }));
 view.rerender(element({ busy: false, open: false }));
 view.rerender(element());
 fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
 fireEvent.click(screen.getByRole("button", { name: props.discard.label }));
 expect(onConfirm).toHaveBeenCalledTimes(1); expect(onDiscard).not.toHaveBeenCalled();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: confirmLabel }).disabled).toBe(true);
 // Switching preview remounts the actions; it must retain the same request's lock.
 view.rerender(element({ preview: false }));
 expect(screen.getByRole<HTMLButtonElement>("button", { name: confirmLabel }).disabled).toBe(true);
 view.rerender(element({ requestKey: "close-second-request" }));
 fireEvent.click(screen.getByRole("button", { name: props.discard.label }));
 fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
 expect(onDiscard).toHaveBeenCalledTimes(1); expect(onConfirm).toHaveBeenCalledTimes(1);
 // A previously sent identity never becomes fresh again.
 view.rerender(element());
 expect(screen.getByRole<HTMLButtonElement>("button", { name: confirmLabel }).disabled).toBe(true);
});
it("retains an unknown discard lock across a complete dialog unmount", () => {
 const onConfirm = vi.fn(), onDiscard = vi.fn();
 const props = { requestKey: "discard-remount", kind: "close" as const, title, consequence, open: true, preview: true, onOpenChange: vi.fn(), confirm: { label: confirmLabel, onConfirm }, discard: { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard } };
 const first = renderUi(h(ConfirmationDialog, props));
 fireEvent.click(screen.getByRole("button", { name: props.discard.label }));
 first.unmount();
 renderUi(h(ConfirmationDialog, props));
 fireEvent.click(screen.getByRole("button", { name: props.discard.label }));
 fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
 expect(onDiscard).toHaveBeenCalledTimes(1); expect(onConfirm).not.toHaveBeenCalled();
 expect(screen.getByRole<HTMLButtonElement>("button", { name: props.discard.label }).disabled).toBe(true);
});
it("shows and sends the same typed raise-money amount", () => {
 const amountCents = 1234;
 const onConfirm = vi.fn();
 renderUi(h(ConfirmationDialog, { requestKey: "typed-money", kind: "raise_money", amountCents, title: "Raise funds?", consequence: "The company will request additional funding.", open: true, onOpenChange: vi.fn(), confirm: { label: "Raise funds", onConfirm } }));
 expect(document.querySelector(".rv-confirmation-amount")?.textContent).toBe("Amount: $12.34");
 fireEvent.click(screen.getByRole("button", { name: "Raise funds" }));
 expect(onConfirm).toHaveBeenCalledWith(amountCents);
});
it("dispatches Discard once and renders no discard for non-Close kinds even at the runtime boundary", () => {
 const onDiscard = vi.fn(); const common = { requestKey: "discard-runtime", title: "Remove Sam?", consequence: "Sam loses project access.", open: true, onOpenChange: vi.fn(), confirm: { label: "Remove Sam", onConfirm: vi.fn() } };
 const discard = { label: "Discard changes and close", consequence: "Deletes unpublished files.", onDiscard };
 const view = renderUi(h(ConfirmationDialog, { ...common, kind: "close", discard }));
 const action = screen.getByRole("button", { name: discard.label }); fireEvent.click(action); fireEvent.click(action); expect(onDiscard).toHaveBeenCalledTimes(1);
 view.rerender(h(ConfirmationDialog, { ...common, kind: "destructive", ...{ discard } } as unknown as ConfirmationDialogProps));
 expect(screen.queryByRole("button", { name: discard.label })).toBeNull();
});
// @ts-expect-error Discard is only valid inside the Close composition.
const invalid: ConfirmationDialogProps = { requestKey: "invalid", kind: "raise_money", amountCents: 100, open: false, onOpenChange: () => undefined, title, consequence, confirm: { label: confirmLabel, onConfirm: () => undefined }, discard: { label: "Discard", consequence: "Deletes files", onDiscard: () => undefined } };
void invalid;
