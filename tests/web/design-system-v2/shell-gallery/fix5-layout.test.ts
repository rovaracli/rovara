import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("packages/ui/src/design/parts/shell-gallery.css", "utf8");

it("keeps the keyboard focus ring fully inside the focus row and aligns both row labels", () => {
 expect(css).toMatch(/\.rv-ds-focus-rows>button\.is-focus-demo\{[^}]*outline-offset:-2px/);
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-focus-rows>\.rv-selected\{border-inline-start-width:var\(--rv-space-1\)/);
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-focus-rows>\.rv-selected\{[^}]*padding-inline:var\(--rv-space-3\)/);
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-focus-rows>button\{[^}]*border-inline-start:var\(--rv-space-1\) solid transparent[^}]*padding-inline:var\(--rv-space-3\)/);
});

it("matches the reviewed focus-adjacent shell and error details", () => {
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-plan-step \.rv-ds-plan-lock\{[^}]*font-size:var\(--rv-font-md\)/);
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-state-error \.rv-ds-state-content>p\{[^}]*color:var\(--rv-text\)/);
 expect(css).toMatch(/@media\(max-width:359px\)\{[^}]*\.rv-ds-gallery \.rv-ds-state-error \.rv-ds-recovery\{row-gap:0\}/);
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-shell-menu \.rv-button\{[^}]*font-weight:400/);
});
