import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("packages/ui/src/design/parts/shell-gallery.css", "utf8");

it("keeps phone state titles 24px from their metadata and error recovery compact at 320px", () => {
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-state-rows li:has\(\.rv-ds-row-time\)\{row-gap:var\(--rv-space-1\)\}/);
 expect(css).toMatch(/@media\(max-width:359px\)[^{]*\{[^}]*\.rv-ds-state-error \.rv-ds-recovery\{row-gap:0\}/);
});

it("uses consistent phone delivery row spacing", () => {
 expect(css).toContain(".rv-ds-gallery #delivery .rv-delivery-scene{display:grid;gap:var(--rv-space-3)}");
});

it("spaces the shell gaps missing-results box 40px below its subtitle", () => {
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-gaps-frame \.rv-ds-blockers\{margin-top:calc\(var\(--rv-space-6\) \+ var\(--rv-space-2\)\)\}/);
});

it("keeps the keyboard focus outline inside its list card", () => {
 expect(css).toMatch(/\.rv-ds-gallery \.rv-ds-focus-rows\{[^}]*overflow:hidden/);
});

it("renders the type scene mono sample without ligatures", () => {
 expect(css).toMatch(/\.rv-ds-gallery #type \.rv-ds-type-list code\{font-variant-ligatures:none\}/);
});
