// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { tableToastDialogGalleryScenes } from "../../../../packages/ui/src/design/parts/table-toast-dialog-scenes.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
for (const theme of ["light", "dark"] as const) it(`draws the ${theme} confirmation on arrival without a modal covering the other scenes`, async () => {
 expect(tableToastDialogGalleryScenes.map(scene => scene.id)).toEqual(["table", "toast", "confirmation"]);
 const view = renderUi(h("div", null, ...tableToastDialogGalleryScenes.map(scene => h("section", { key: scene.id, "aria-label": scene.title }, h(scene.render)))), { theme });
 const dialog = screen.getByRole("dialog", { name: 'Close "Add refunds endpoint"?' });
 expect(view.container.contains(dialog)).toBe(true);
 expect(dialog.getAttribute("aria-modal")).not.toBe("true");
 expect(document.querySelector(".rv-overlay")).toBeNull();
 expect(dialog.contains(document.activeElement)).toBe(false);
 expect(within(dialog).getByText("3 changed files are not in a pull request yet.").tagName).toBe("STRONG");
 expect(within(dialog).getAllByRole("button").map(button => button.textContent)).toEqual(["Keep changes and close", "Cancel", "Discard changes and close"]);
 expect(screen.getByText(/Only for destructive or money-raising actions/)).toBeTruthy();
 expect(view.container.textContent).not.toMatch(/Preview Close|Static example|fixture|Live callers|Example tasks/);
 expect(screen.getByRole("table", { name: "Tasks" })).toBeTruthy();
 await expectNoAxeViolations(document.body);
 fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
 expect(screen.queryByRole("dialog")).toBeNull();
 // The nonmodal drawing must leave the table and toast usable on the full gallery.
 fireEvent.click(screen.getByText("Add refunds endpoint")); fireEvent.keyDown(screen.getAllByRole("row")[1]!, { key: "Enter" });
 expect(screen.getByText("Opened task: Add refunds endpoint")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Undo" })); expect(screen.getByText("Following this task again.")).toBeTruthy();
});
it("closes the local confirmation after keeping or discarding and never re-dispatches it", () => {
 const Scene = tableToastDialogGalleryScenes[2].render;
 const view = renderUi(h(Scene));
 fireEvent.click(screen.getByRole("button", { name: "Keep changes and close" }));
 expect(screen.getByText("Closed with changes kept.")).toBeTruthy();
 expect(screen.queryByRole("dialog")).toBeNull();
 view.unmount(); renderUi(h(Scene));
 fireEvent.click(screen.getByRole("button", { name: "Discard changes and close" }));
 expect(screen.getByText("Closed with unpublished changes discarded.")).toBeTruthy();
 expect(screen.queryByRole("dialog")).toBeNull();
});
