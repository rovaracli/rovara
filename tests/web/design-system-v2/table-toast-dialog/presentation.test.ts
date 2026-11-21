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
function applyStyles(theme: "light" | "dark") {
 const vars = new Map([...lookV2Css().matchAll(/(--rv-[\w-]+):([^;{}]+);/g)].map(match => [match[1]!, match[2]!]));
 for (const [key, value] of Object.entries(LOOK_COLORS[theme])) vars.set(`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value);
 document.querySelectorAll<HTMLElement>("[style]").forEach(element => {
  for (const name of element.style) if (name.startsWith("--rv-")) vars.set(name, element.style.getPropertyValue(name));
 });
 let css = readFileSync("packages/ui/src/design/parts/table-toast-dialog.css", "utf8");
 for (let pass = 0; pass < 3; pass++) css = css.replace(/var\((--rv-[\w-]+)\)/g, (original: string, name: string) => vars.get(name) ?? original);
 style.textContent = css;
 document.head.append(style);
}
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
  applyStyles(theme);
  const title = screen.getByText("Add refunds endpoint");
  expect(getComputedStyle(title).fontSize).toBe("16px");
  expect(getComputedStyle(title).fontWeight).toBe("600");
  expect(getComputedStyle(document.querySelector(".rv-p3-table-scene")!).maxWidth).toBe("760px");
 });
}
