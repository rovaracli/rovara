// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { outcomeDeliveryHeldGalleryScenes } from "../../../../packages/ui/src/design/parts/outcome-delivery-held-scenes.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";

it("exports the three P4 scenes for P5 to mount", () => {
 expect(outcomeDeliveryHeldGalleryScenes.map(scene => scene.id)).toEqual(["outcome", "delivery", "held"]);
});
it("starts the outcome example unconfirmed and reveals only the explicit demonstration read", () => {
 const scene = outcomeDeliveryHeldGalleryScenes.find(item => item.id === "outcome")!;
 renderUi(h("main", {}, scene.render()));
 expect(screen.getByText(/Example/)).toBeTruthy();
 expect(screen.queryByText(/After the check:/)).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Check current limit" }));
 expect(screen.getByText("After the check: the limit is $600. Your change was saved at 14:06.")).toBeTruthy();
 expect(screen.queryByRole("button", { name: /save|retry|try again/i })).toBeNull();
});
it("shows six explicit presentation receipts and no invented seventh missing-receipt label", () => {
 renderUi(h("main", {}, outcomeDeliveryHeldGalleryScenes.find(item => item.id === "delivery")!.render()));
 expect(screen.getAllByRole("status")).toHaveLength(6);
 expect(screen.getByText("Applied")).toBeTruthy(); expect(screen.getByText("Not applied: outside the plan")).toBeTruthy();
 expect(screen.getByText(/Presentation examples/)).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull();
});
it.each(["light", "dark"] as const)("keeps all P4 gallery scenes accessible in %s", async theme => {
 for (const scene of outcomeDeliveryHeldGalleryScenes) {
  const f = renderUi(h("main", {}, h("h1", {}, scene.title), scene.render()), { theme });
  await expectNoAxeViolations(f.container); f.unmount();
 }
});
