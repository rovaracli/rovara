// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { h } from "./support/h.js";
// The v2 sheet is constant, so ThemeProvider must build the style text once (when the module loads), not on every render, with the look off or on.
vi.mock("@agentx/design-tokens", async importOriginal => {
 const original = await importOriginal<typeof import("../../packages/design-tokens/src/index.js")>();
 return { ...original, tokensCss: vi.fn(original.tokensCss), lookV2Css: vi.fn(original.lookV2Css) };
});
it("builds the theme sheet once however often the provider renders", async () => {
 const tokens = await import("@agentx/design-tokens"), { ThemeProvider } = await import("../../packages/ui/src/theme.js");
 const host = { storage: { get: () => undefined, set: () => undefined } };
 const baseline = [vi.mocked(tokens.tokensCss).mock.calls.length, vi.mocked(tokens.lookV2Css).mock.calls.length];
 const ui = render(h(ThemeProvider, { host, children: h("p", null, "a") }));
 for (let count = 0; count < 4; count++) ui.rerender(h(ThemeProvider, { host, children: h("p", null, String(count)) }));
 expect([vi.mocked(tokens.tokensCss).mock.calls.length, vi.mocked(tokens.lookV2Css).mock.calls.length]).toEqual(baseline);
 expect(baseline).toEqual([1, 1]);
 expect(ui.container.ownerDocument.querySelector("style")?.textContent).toContain(':root[data-look="v2"]');
 cleanup();
});
