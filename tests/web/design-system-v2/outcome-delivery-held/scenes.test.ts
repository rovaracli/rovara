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
it("includes the mock's supplied after-check strip on first render without offering a repeat write", () => {
 const scene = outcomeDeliveryHeldGalleryScenes.find(item => item.id === "outcome")!;
 renderUi(h("main", {}, scene.render()));
 expect(screen.getByText(/^Three parts, one button\./)).toBeTruthy();
 expect(screen.getByText("After the check: the limit is $600. Your change was saved at 14:06.").closest(".rv-outcome-after")).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Check current limit" }));
 expect(screen.getByText("After the check: the limit is $600. Your change was saved at 14:06.")).toBeTruthy();
 expect(screen.queryByRole("button", { name: /save|retry|try again/i })).toBeNull();
});
it("shows six explicit presentation receipts and no invented seventh missing-receipt label", () => {
 renderUi(h("main", {}, outcomeDeliveryHeldGalleryScenes.find(item => item.id === "delivery")!.render()));
 expect(screen.getAllByRole("status")).toHaveLength(6);
 expect(screen.getByText("Applied")).toBeTruthy(); expect(screen.getByText("Not applied: outside the plan")).toBeTruthy();
 expect(screen.getByText(/A second, smaller vocabulary/)).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull();
 expect(screen.getAllByRole("status")[4]?.textContent).toBe("Not delivered refused, with the reason and the text kept");
});
it("shows the held example's known heading, consequence and shared source line with only one Unknown", () => {
 const f = renderUi(h("main", {}, outcomeDeliveryHeldGalleryScenes.find(item => item.id === "held")!.render()));
 expect(screen.getByRole("heading", { name: "Integration tests" })).toBeTruthy();
 expect(screen.getByText("The runner disconnected before the first test.")).toBeTruthy();
 expect(screen.getByText("acme/payments · 4 min ago · head 5b81d0c")).toBeTruthy();
 expect(screen.getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 expect(screen.queryByText("Rovara can't confirm this yet. It is checking.")).toBeNull();
 expect(screen.queryByRole("tooltip")).toBeNull();
 expect(f.container.querySelector("ul,ol,button,a")).toBeNull();
});
it.each(["outcome", "delivery", "held"])("keeps developer captions out of the %s scene", id => {
 const f = renderUi(h("main", {}, outcomeDeliveryHeldGalleryScenes.find(item => item.id === id)!.render()));
 expect(f.container.textContent).not.toMatch(/example|presentation|fixture|live caller|local only/i);
});
it.each(["light", "dark"] as const)("keeps all P4 gallery scenes accessible in %s", async theme => {
 for (const scene of outcomeDeliveryHeldGalleryScenes) {
  const f = renderUi(h("main", {}, h("h1", {}, scene.title), scene.render()), { theme });
  await expectNoAxeViolations(f.container); f.unmount();
 }
});
