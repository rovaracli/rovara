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
