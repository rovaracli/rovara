// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { tableToastDialogGalleryScenes } from "../../../../packages/ui/src/design/parts/table-toast-dialog-scenes.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
for (const theme of ["light", "dark"] as const) it(`renders interactive ${theme} gallery scenes for P5 without claiming a live write`, async () => {
 expect(tableToastDialogGalleryScenes.map(scene => scene.id)).toEqual(["table", "toast", "confirmation"]);
 renderUi(h("div", null, ...tableToastDialogGalleryScenes.map(scene => h("section", { key: scene.id, "aria-label": scene.title }, h(scene.render)))), { theme });
 expect(screen.getByRole("table", { name: "Example tasks" })).toBeTruthy();
 fireEvent.click(screen.getByText("Add refunds endpoint")); fireEvent.keyDown(screen.getAllByRole("row")[1]!, { key: "Enter" });
 expect(screen.getByText("Opened example task: Add refunds endpoint")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Undo" })); expect(screen.getByText("Following this example task again.")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Preview Close confirmation" }));
 expect(await screen.findByRole("dialog", { name: 'Close "Add refunds endpoint"?' })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
});
