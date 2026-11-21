// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { lookV2Css } from "@agentx/design-tokens";
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

it("separates the dark sample card and keeps its title and subtitle together above the chips", async () => {
 const { chipsButtonsGalleryScenes } = await import("../../../../packages/ui/src/design/parts/chips-buttons-scenes.js");
 const style = document.createElement("style");
 // Resolve spacing roles for jsdom; Chromium captures own painted geometry.
 const roles = new Map([...lookV2Css().matchAll(/(--rv-space-\d+):([^;]+);/g)].map(match => [match[1], match[2]]));
 style.textContent = readFileSync("packages/ui/src/design/parts/chips-buttons.css", "utf8")
  .replace(/var\((--rv-space-\d+)\)/g, (source, name: string) => roles.get(name) ?? source);
 document.head.append(style);
 try {
  renderUi(h("main", null, chipsButtonsGalleryScenes[0].render()));
  const title = screen.getByRole("heading", { name: "The same parts in dark" });
  const subtitle = screen.getByText("Only the role values change. Names, sizes and layout stay.");
  expect(title.parentElement).toBe(subtitle.parentElement);
  const heading = title.parentElement!;
  expect(getComputedStyle(heading).display).toBe("flex");
  expect(getComputedStyle(heading).alignItems).toBe("baseline");
  expect(getComputedStyle(heading).flexWrap).toBe("wrap");
  const darkCard = heading.parentElement!;
  const separation = parseFloat(getComputedStyle(darkCard).marginBlockStart);
  expect(separation).toBeGreaterThanOrEqual(24);
  expect(separation).toBeLessThanOrEqual(32);
  const strip = darkCard.querySelector(".rv-ds-chip-strip")!;
  expect(getComputedStyle(strip).marginBlockStart).toBe("16px");
  expect(strip.querySelectorAll("[role=img]")).toHaveLength(15);
 } finally { style.remove(); }
});

it("gives the status sheet its own full-width budget and a tight 12px heading gap", async () => {
 const { chipsButtonsGalleryScenes } = await import("../../../../packages/ui/src/design/parts/chips-buttons-scenes.js");
 const style = document.createElement("style");
 const roles = new Map([...lookV2Css().matchAll(/(--rv-(?:space-\d+|font-(?:sm|md)|table-width)):([^;]+);/g)].map(match => [match[1], match[2]]));
 style.textContent = ["packages/ui/src/design/design.css", "packages/ui/src/design/parts/shell-gallery.css", "packages/ui/src/design/parts/chips-buttons.css"]
  .map(path => readFileSync(path, "utf8")).join("\n")
  .replace(/var\((--rv-(?:space-\d+|font-(?:sm|md)|table-width))\)/g, (source, name: string) => roles.get(name) ?? source);
 document.head.append(style);
 try {
  renderUi(h("div", { className: "rv-ds-gallery rv-ds-isolated" }, h("section", { "data-gallery-scene": "statuses" }, chipsButtonsGalleryScenes[0].render())));
  const heading = screen.getByRole("heading", { name: "Status chips: the only vocabulary" });
  const intro = screen.getByText(/^Fifteen states/);
  expect(heading.parentElement).toBe(intro.parentElement);
  expect(getComputedStyle(heading.parentElement!).gap).toBe("12px");
  expect(getComputedStyle(heading).marginBottom).toBe("0px");
  expect(getComputedStyle(intro).marginBlockStart).toBe("0");
  const sheet = document.querySelector("[data-gallery-scene=statuses]")!;
  expect(getComputedStyle(sheet).width).toBe("var(--rv-chip-sheet-width)");
  expect(getComputedStyle(sheet).getPropertyValue("--rv-chip-sheet-width")).toContain("100vw");
  const row = sheet.querySelector(".rv-ds-chip-row")!;
  expect(getComputedStyle(row).gridTemplateColumns).toBe("calc(48px*3) minmax(0,1fr)");
  expect(getComputedStyle(row).gap).toBe("8px");
  expect(getComputedStyle(sheet.querySelector("dl")!).columnGap).toBe("16px");
  expect(readFileSync("packages/ui/src/design/parts/chips-buttons.css", "utf8"))
   .toContain("font-size:calc(var(--rv-font-sm) + var(--rv-space-1)/4)");
  // Descriptions remain natural wrapping text; no clipping/ellipsis/nowrap to fake a fit.
  const description = sheet.querySelector("dd")!;
  expect(getComputedStyle(description).whiteSpace).not.toBe("nowrap");
  expect(getComputedStyle(description).overflow).not.toBe("hidden");
 } finally { style.remove(); }
});
