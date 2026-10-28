import { describe, expect, it } from "vitest";
import { TOKENS, TEXT_PAIRS, UI_PAIRS, contrastRatio, tokensCss, serverPageCss } from "../../packages/design-tokens/src/index.js";
describe("design tokens", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`${theme} meets text and interface contrast`, () => {
      for (const [front, back] of TEXT_PAIRS) expect(contrastRatio(TOKENS[theme][front], TOKENS[theme][back])).toBeGreaterThanOrEqual(4.5);
      for (const [front, back] of UI_PAIRS) expect(contrastRatio(TOKENS[theme][front], TOKENS[theme][back])).toBeGreaterThanOrEqual(3);
    });
  }
  it("has identical theme keys and declares every color in all three rules", () => {
    expect(Object.keys(TOKENS.light)).toEqual(Object.keys(TOKENS.dark));
    for (const key of Object.keys(TOKENS.light)) {
      const cssKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      expect(tokensCss().split(`--rv-${cssKey}:`).length - 1).toBe(3);
    }
    expect(tokensCss()).toContain(':root:not([data-theme="light"])');
    expect(tokensCss()).toContain(':root[data-theme="dark"]');
    expect(tokensCss()).toContain("color-scheme");
    expect(serverPageCss()).not.toMatch(/url\(|@import|—/);
    expect(TOKENS.motionMs).toEqual({ fast: 120, normal: 200 });
  });
  it("leaves out the global pre rule for a page that styles its own code blocks", () => {
    expect(serverPageCss()).toMatch(/(?:^|})pre\{white-space:pre-wrap/);
    expect(serverPageCss({ pre: false })).not.toMatch(/(?:^|})pre\{/);
    expect(serverPageCss({ pre: false })).toContain("dd{margin:0");
  });
  it("calculates the WCAG reference ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.478, 2);
  });
});
