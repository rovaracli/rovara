// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
afterEach(cleanup);
for (const theme of ["light", "dark"] as const) it(`${theme}: gallery exports the full vocabulary, dark strip and four buttons with a lock`, async () => {
 const { chipsButtonsGalleryScenes } = await import("../../../../packages/ui/src/design/parts/chips-buttons-scenes.js");
 expect(chipsButtonsGalleryScenes.map(scene => scene.id)).toEqual(["statuses", "buttons"]);
 renderUi(h("main", null, ...chipsButtonsGalleryScenes.map(scene => h("section", { key: scene.id, "aria-label": scene.title }, scene.render()))), { theme });
 const statuses = screen.getByRole("region", { name: "Status chips: the only vocabulary" });
 expect(within(statuses).getAllByRole("img")).toHaveLength(30);
 expect(within(statuses).getAllByRole("img", { name: "Not run" })).toHaveLength(2);
 expect(within(statuses).getAllByRole("img", { name: "Waiting for Ana" })).toHaveLength(2);
 expect(statuses.querySelector("dl")?.children).toHaveLength(15);
 const buttons = screen.getByRole("region", { name: "Buttons" });
 expect(within(buttons).getAllByRole("button")).toHaveLength(5);
 expect(buttons.querySelectorAll(".rv-button-primary")).toHaveLength(1);
 expect(within(buttons).getByText("Locked: a required check couldn't run.")).toBeTruthy();
 await expectNoAxeViolations(document.body);
});
