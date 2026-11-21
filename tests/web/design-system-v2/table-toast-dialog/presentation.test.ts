// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { LOOK_COLORS, lookV2Css } from "@agentx/design-tokens";
import { Toast } from "../../../../packages/ui/src/design/Toast.js";
import { tableToastDialogGalleryScenes } from "../../../../packages/ui/src/design/parts/table-toast-dialog-scenes.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";

const style = document.createElement("style");
afterEach(() => style.remove());
// jsdom does not resolve custom properties. Substitute the real palette and
// component-local aliases, then exercise the stylesheet's selectors/cascade.
function applyStyles(theme: "light" | "dark", width?: number) {
 const vars = new Map([...lookV2Css().matchAll(/(--rv-[\w-]+):([^;{}]+);/g)].map(match => [match[1]!, match[2]!]));
 for (const [key, value] of Object.entries(LOOK_COLORS[theme])) vars.set(`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value);
 document.querySelectorAll<HTMLElement>("[style]").forEach(element => {
  for (const name of element.style) if (name.startsWith("--rv-")) vars.set(name, element.style.getPropertyValue(name));
 });
 let css = readFileSync("packages/ui/src/design/parts/table-toast-dialog.css", "utf8");
 for (let pass = 0; pass < 3; pass++) css = css.replace(/var\((--rv-[\w-]+)\)/g, (original: string, name: string) => vars.get(name) ?? original);
 style.textContent = css;
 document.head.append(style);
 // jsdom does not evaluate viewport media queries. Activate only the real
 // width rules for this viewport; painted geometry still needs Chromium.
 if (width !== undefined) style.textContent = [...style.sheet!.cssRules].map(rule => {
  if (!(rule instanceof CSSMediaRule)) return rule.cssText;
  const bounds = [...rule.conditionText.matchAll(/(min|max)-width:\s*(\d+)px/g)];
  return bounds.length && bounds.every(([, bound, pixels]) => bound === "min" ? width >= Number(pixels) : width <= Number(pixels))
   ? [...rule.cssRules].map(child => child.cssText).join("\n") : rule.cssText;
 }).join("\n");
}
for (const width of [320, 390]) for (const theme of ["light", "dark"] as const) it(`uses the phone title and chip layout at ${width}px in ${theme}`, () => {
 renderUi(h(tableToastDialogGalleryScenes[0].render), { theme });
 applyStyles(theme, width);
 const table = screen.getByRole("table", { name: "Tasks" });
 // One grid row per task: title with meta under it, chip on the right (inline on the meta line below 360px), no inner divider, no header.
 expect(getComputedStyle(table.querySelector("thead")!).display).toBe("none");
 const tableDisplay = getComputedStyle(table).display; expect(tableDisplay).toBe("block");
 const body = table.querySelector("tbody")!;
 const rows = [...body.querySelectorAll("tr")]; expect(rows).toHaveLength(2);
 for (const row of rows) {
  const style = getComputedStyle(row);
  expect(style.display).toBe("grid");
  expect(style.height).toBe("auto");
  expect(style.minHeight).toBe("48px");
  expect(style.paddingLeft).toBe("16px"); expect(style.paddingRight).toBe("16px");
  expect(row.children[2] && getComputedStyle(row.children[2]).display).toBe("none");
  expect(getComputedStyle(row.children[0]!).display).toBe("contents");
  for (const cell of [row.children[0]!, row.children[1]!]) {
   expect(getComputedStyle(cell).borderBottomWidth === "" || getComputedStyle(cell).borderBottomWidth === "0px").toBe(true);
   expect(getComputedStyle(cell).textAlign).toBe("left");
  }
  const chipCell = getComputedStyle(row.children[1]!);
  expect(chipCell.gridColumn).toBe("2");
  expect(chipCell.gridRow).toBe(width < 360 ? "2" : "1 / span 2");
 }
 expect(getComputedStyle(rows[0]!).borderBottomWidth).toBe("thin");
 expect(getComputedStyle(rows[1]!).borderBottomWidth).toBe("0px");
 const selected = rows[1]!; expect(selected.getAttribute("aria-current")).toBe("true");
 expect(getComputedStyle(selected).boxShadow).toContain("inset");
 expect(getComputedStyle(selected.querySelector("strong")!).gridColumn).toBe(width < 360 ? "1 / -1" : "1");
 expect(getComputedStyle(selected.querySelector(".rv-p3-phone-detail")!).gridRow).toBe("2");
 expect(screen.getByText(/on phone, two lines with the owner and time under the title/i)).toBeTruthy();
});
for (const theme of ["light", "dark"] as const) {
 it(`uses a visible ok-green check and 16px text on the ${theme} inverse toast`, () => {
  renderUi(h(Toast, { message: "Stopped following this task.", onUndo: vi.fn(), onDismiss: vi.fn() }), { theme });
  applyStyles(theme);
  const toast = screen.getByRole("complementary", { name: "Notification" });
  expect(getComputedStyle(toast).fontSize).toBe("16px");
  expect(getComputedStyle(toast.querySelector(".rv-toast-v2-tick")!).color).toBe(theme === "light" ? "rgb(126, 214, 156)" : "rgb(20, 102, 58)");
 });
 it(`keeps ${theme} task titles at 16 semibold and the gallery table within a reading column`, () => {
  renderUi(h(tableToastDialogGalleryScenes[0].render), { theme });
  applyStyles(theme, 1440);
  const title = screen.getByText("Add refunds endpoint");
  expect(getComputedStyle(title).fontSize).toBe("16px");
  expect(getComputedStyle(title).fontWeight).toBe("600");
  expect(getComputedStyle(document.querySelector(".rv-p3-table-scene")!).maxWidth).toBe("760px");
  expect(getComputedStyle(title.closest("tr")!).display).toBe("table-row");
  expect(getComputedStyle(title.closest("tr")!.children[2]!).display).toBe("table-cell");
 });
}
