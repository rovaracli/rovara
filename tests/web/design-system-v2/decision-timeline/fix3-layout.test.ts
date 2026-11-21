// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { lookV2Css } from "../../../../packages/design-tokens/src/look.js";
import { DesignSystemGallery } from "../../../../packages/ui/src/design/DesignSystemGallery.js";
import { TaskTimeline } from "../../../../packages/ui/src/design/TaskTimeline.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";

let styles: HTMLStyleElement;
beforeEach(() => {
 // jsdom has no custom-property layout resolution. Resolve the real R1 tokens
 // before checking the cascade, including P5's later shell overrides.
 const tokens = new Map([...lookV2Css().matchAll(/(--rv-[\w-]+):([^;}]+)/gu)].map(match => [match[1]!, match[2]!]));
 let css = ["packages/ui/src/design/design.css", "packages/ui/src/design/parts/decision-timeline.css", "packages/ui/src/design/parts/shell-gallery.css"].map(path => readFileSync(path, "utf8")).join("\n");
 for (let pass = 0; pass < 3; pass++) css = css.replace(/var\((--rv-[\w-]+)\)/gu, (original: string, name: string) => tokens.get(name) ?? original);
 styles = document.createElement("style");
 styles.textContent = css;
 document.head.append(styles);
});
afterEach(() => { styles.remove(); });

function scene(id: string, theme: "light" | "dark") {
 return renderUi(h(MemoryRouter, { initialEntries: [`/app/design-system?scene=${id}`], children: h(DesignSystemGallery) }), { theme });
}

for (const theme of ["light", "dark"] as const) {
 it(`${theme}: makes the standalone plan decision title 20px semibold`, () => {
  scene("decisions", theme);
  const title = screen.getByRole("heading", { name: "Approve plan v3?" });
  expect(getComputedStyle(title).fontSize).toBe("20px");
  expect(getComputedStyle(title).fontWeight).toBe("600");
 });

 it(`${theme}: keeps the shell risk heading at 14px with one 16px gap to its list`, () => {
  scene("shell-plan", theme);
  const title = screen.getByRole("heading", { name: "Risks to know before you decide" });
  expect(getComputedStyle(title).fontSize).toBe("14px");
  expect(getComputedStyle(title).fontWeight).toBe("600");
  expect(getComputedStyle(title).marginBottom).toBe("0px");
  expect(getComputedStyle(title.parentElement!).gap).toBe("16px");
  expect(getComputedStyle(title.nextElementSibling!).marginTop).toBe("0px");
 });

 it(`${theme}: makes both shell plan step titles 16px semibold`, () => {
  scene("shell-plan", theme);
  const plan = screen.getByRole("article", { name: "Approve plan v3?" });
  for (const text of ["Review evidence", "Approve plan v3"]) {
   const style = getComputedStyle(within(plan).getByText(text, { exact: true }));
   expect(style.fontSize).toBe("16px");
   expect(style.fontWeight).toBe("600");
  }
 });

 it(`${theme}: indents the shell evidence box past the number circle and its gap`, () => {
  const ui = scene("shell-plan", theme);
  const evidence = ui.container.querySelector<HTMLElement>(".rv-ds-plan-frame .rv-ds-evidence")!;
  expect(getComputedStyle(evidence).marginInlineStart).toBe("calc(36px)");
  expect(getComputedStyle(evidence).marginInlineEnd).toBe("0px");
 });

 it(`${theme}: shows timeline notes as 14px muted sans text while durations stay mono`, () => {
  renderUi(h(TaskTimeline, { items: [
   { id: "build", title: "Build", state: "running", elapsed: "6m 40s" },
   { id: "review", title: "Review", state: "next", note: "may need you" },
   { id: "merge", title: "Merge", state: "next", note: "needs you" },
  ] }), { theme });
  for (const text of ["may need you", "needs you"]) {
   const style = getComputedStyle(screen.getByText(text, { exact: true }));
   expect(style.fontSize).toBe("14px");
   expect(style.fontWeight).toBe("400");
   expect(style.fontFamily).toContain("Inter");
   expect(style.fontFamily).not.toContain("Mono");
  }
  const duration = getComputedStyle(screen.getByText("6m 40s"));
  expect(duration.fontSize).toBe("12px");
  expect(duration.fontFamily).toContain("JetBrains Mono");
 });
}
