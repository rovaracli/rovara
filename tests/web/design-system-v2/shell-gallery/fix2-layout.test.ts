// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DesignSystemGallery } from "../../../../packages/ui/src/design/DesignSystemGallery.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
let styles: HTMLStyleElement;
beforeEach(() => {
 styles = document.createElement("style");
 styles.textContent = ["packages/ui/src/design/design.css", "packages/ui/src/design/parts/decision-timeline.css", "packages/ui/src/design/parts/shell-gallery.css"].map(path => readFileSync(path, "utf8")).join("\n")
  // jsdom does not resolve custom properties in padding shorthands. Expand the pinned R1 spacing for cascade checks only.
  .replace(/var\(--rv-space-([1-7])\)/g, (_, index: string) => `${String([4, 8, 12, 16, 24, 32, 48][Number(index) - 1])}px`);
 document.head.append(styles);
});
afterEach(() => { cleanup(); styles.remove(); });
function scene(id: string) {
 return renderUi(h(MemoryRouter, { initialEntries: [`/app/design-system?scene=${id}`], children: h(DesignSystemGallery) }));
}
it("gives isolated shells the viewport instead of inheriting a narrow capture container", () => {
 const ui = scene("shell-running"), shell = ui.container.querySelector<HTMLElement>(".rv-ds-gallery")!;
 expect(getComputedStyle(shell).width).toBe("100vw");
 expect(getComputedStyle(shell).position).toBe("absolute");
 const sidebar = screen.getByRole("navigation", { name: "Example workspace" });
 expect(getComputedStyle(sidebar).height).toBe("100dvh");
 expect(getComputedStyle(sidebar).position).toBe("sticky");
});
it("shows a lock beside the plan prerequisite and keeps selected evidence metadata regular", () => {
 scene("shell-plan");
 const reason = screen.getByText("Unlocks when all 3 are read for v3");
 expect(reason.querySelector("svg[aria-hidden=true]")).toBeTruthy();
 expect(getComputedStyle(screen.getByText("Not read · about 1 min")).fontWeight).toBe("400");
 const actions = screen.getByRole("button", { name: "Read the test plan" }).closest<HTMLElement>(".rv-actions")!;
 expect(getComputedStyle(actions).paddingLeft).toBe("0px");
});
it("keeps the log command and diff totals wrappable instead of clipping its tail", () => {
 scene("shell-running");
 const command = screen.getByText("Live log").closest("summary")!.querySelector("code")!;
 expect(command.textContent).toBe("edit src/refunds/handlers.py (+48 -0)");
 expect(getComputedStyle(command).whiteSpace).toBe("normal");
 expect(getComputedStyle(command).overflowX).toBe("visible");
});
it("keeps the focus chip inline and at chip height when the button row wraps", () => {
 const ui = scene("focus");
 const row = ui.container.querySelector<HTMLElement>(".rv-ds-focus-rows>.rv-selected")!;
 expect(getComputedStyle(row).flexWrap).toBe("nowrap");
 const chip = screen.getAllByText("Not started")[0]!;
 expect(getComputedStyle(chip).alignSelf).toBe("center");
});
it("keeps colour role names whole on narrow screens", () => {
 scene("colours");
 for (const label of screen.getAllByText("border-strong")) expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
});
it("aligns the unconfirmed-write body with its header and after-check strip", () => {
 const ui = scene("states-write-unconfirmed");
 const padding = [".rv-ds-write-heading", ".rv-ds-write-body", ".rv-ds-write-after"].map(selector => getComputedStyle(ui.container.querySelector<HTMLElement>(selector)!).paddingLeft);
 expect(padding).toEqual(["16px", "16px", "16px"]);
 const caption = screen.getByText("Try again appears only when the check shows the write did not apply.");
 expect(getComputedStyle(caption).marginTop).toBe("24px");
});
