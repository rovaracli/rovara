// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { DesignSystemGallery } from "../../../../packages/ui/src/design/DesignSystemGallery.js";
import { galleryScenes } from "../../../../packages/ui/src/design/design-system-gallery-data.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
let styles: HTMLStyleElement;
beforeEach(() => {
 styles = document.createElement("style");
 // Expand pinned R1 roles: jsdom does not resolve custom properties in shorthands.
 styles.textContent = ["packages/ui/src/design/design.css", "packages/ui/src/design/parts/chips-buttons.css", "packages/ui/src/design/parts/decision-timeline.css", "packages/ui/src/design/parts/shell-gallery.css"].map(path => readFileSync(path, "utf8")).join("\n")
  .replace(/var\(--rv-space-([1-7])\)/g, (_, index: string) => `${String([4, 8, 12, 16, 24, 32, 48][Number(index) - 1])}px`)
  .replace(/var\(--rv-font-(md|lg)\)/g, (_, size: string) => size === "md" ? "14px" : "16px")
  .replace(/var\(--rv-border\)/g, "#dde1e6");
 document.head.append(styles);
});
afterEach(() => { cleanup(); styles.remove(); });
function scene(id: string) {
 return renderUi(h(MemoryRouter, { initialEntries: [`/app/design-system?scene=${id}`], children: h(DesignSystemGallery) }));
}
it("gives every isolated non-shell scene the same viewport gutters as colours", () => {
 for (const { id } of galleryScenes.filter(entry => !entry.id.startsWith("shell-"))) {
  const ui = scene(id);
  expect(ui.container.querySelector(".rv-ds-gallery")?.classList.contains("rv-ds-viewport-gutters"), id).toBe(true);
  ui.unmount();
 }
});
it("keeps the command sample whole with scrolling confined to the code", () => {
 scene("type");
 const style = getComputedStyle(screen.getByText(/poetry install --no-interaction/));
 expect(style.whiteSpace).toBe("nowrap");expect(style.overflowX).toBe("auto");
});
it("aligns the focus nav with the top of the list card", () => {
 scene("focus");
 for (const nav of screen.getAllByRole("group", { name: /Selection example/ })) expect(Number.parseFloat(getComputedStyle(nav).marginTop)).toBe(0);
});
it("uses the standalone plan hierarchy and indents evidence to its step title", () => {
 const ui = scene("shell-plan"), risk = screen.getByRole("heading", { name: "Risks to know before you decide" });
 expect(getComputedStyle(risk).fontSize).toBe("14px");
 expect(getComputedStyle(risk).marginBottom).toBe("0px");
 expect(getComputedStyle(screen.getByText("Review evidence")).fontSize).toBe("16px");
 expect(getComputedStyle(ui.container.querySelector(".rv-ds-evidence")!).marginInlineStart).toBe("calc(36px)");
});
it("keeps reference punctuation and Copy in one compact run beside recovery", () => {
 for (const id of ["states-error", "states-first-load-failed"]) {
  const ui = scene(id), copy = screen.getByRole("button", { name: "Copy reference" });
  const ref = copy.closest(".rv-ds-reference")!;
  expect(getComputedStyle(ref).flexWrap).toBe("nowrap");
  expect(Number.parseFloat(getComputedStyle(copy).paddingInline)).toBe(0);
  expect(ref.querySelector(".rv-ds-reference-label")?.textContent).toMatch(/^Ref LIST-/);
  expect(ref.closest(".rv-ds-recovery")).toBeTruthy();
  expect(getComputedStyle(ref.closest(".rv-ds-recovery")!).gap).toBe("8px 12px");
  ui.unmount();
 }
});
it("gives the stale note the row inset and a divider", () => {
 scene("states-stale");const note = screen.getByText(/A task that was running when the connection dropped/);
 expect(getComputedStyle(note).paddingLeft).toBe("16px");
 expect(getComputedStyle(note).borderTopStyle).toBe("solid");
});
it("offers a local workspace menu in every shell and returns focus to its trigger", async () => {
 // jsdom has no layout viewport: apply the real 768px media rules in source order.
 const flatten = (rules: CSSRuleList): string => Array.from(rules).map(rule => {
  if (rule.type !== CSSRule.MEDIA_RULE) return rule.cssText;
  const media = rule as CSSMediaRule;
  const max = /max-width:\s*(\d+)px/.exec(media.conditionText), min = /min-width:\s*(\d+)px/.exec(media.conditionText);
  return (!max || 768 <= Number(max[1])) && (!min || 768 >= Number(min[1])) ? flatten(media.cssRules) : "";
 }).join("\n");
 styles.textContent = flatten(styles.sheet!.cssRules);
 const user = userEvent.setup();
 for (const id of ["shell-running", "shell-plan", "shell-gaps"]) {
  const ui = scene(id), trigger = screen.getByRole("button", { name: "Open task navigation" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Workspace" });
  expect(within(dialog).getByRole("button", { name: /^Work$/ })).toBeTruthy();
  await user.keyboard("{Escape}");expect(document.activeElement).toBe(trigger);ui.unmount();
 }
});
it("names the merge prerequisite with the mock wording and a mono checked sha", () => {
 scene("shell-gaps");const merge = screen.getByRole("button", { name: "Merge #42 into main" });
 expect(merge.hasAttribute("disabled")).toBe(true);
 const reason = document.getElementById(merge.getAttribute("aria-describedby")!)!;
 expect(reason.textContent).toBe("Unlocks when both results above are in for 5b81d0c. Rovara rechecks by itself.");
 expect(reason.querySelector("code")?.textContent).toBe("5b81d0c");
});
