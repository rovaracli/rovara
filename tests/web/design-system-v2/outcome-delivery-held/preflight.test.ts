// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { DesignSystemGallery } from "../../../../packages/ui/src/design/DesignSystemGallery.js";
import { renderUi } from "../../support/render.js";

function runHeldPreflight(input: { text: string; unknownCount: number }) {
 return execFileSync(process.execPath, ["--input-type=module", "-e", `import { assertHeldPreflight } from './scripts/capture-design-system-v2.mjs'; assertHeldPreflight(${JSON.stringify(input)});`], { stdio: "pipe" });
}

it("accepts the visible held route using the capture preflight expectations", () => {
 const f = renderUi(h(MemoryRouter, { initialEntries: ["/app/design-system?scene=held"], children: h(DesignSystemGallery) }));
 const root = f.container.querySelector('[data-gallery-scene="held"]');
 expect(root).not.toBeNull();
 const visible = root!.cloneNode(true) as HTMLElement;
 visible.querySelectorAll("[hidden]").forEach(node => node.remove());
 const input = {
  text: (visible.textContent ?? "").replace(/\s+/g, " ").trim(),
  unknownCount: root!.querySelectorAll('[role="img"][aria-label="Unknown"]').length,
 };
 expect(() => runHeldPreflight(input)).not.toThrow();
 expect(input.text).not.toMatch(/checking/i);
 expect(root!.querySelector("[hidden]")?.textContent).toContain("It is checking.");
});

it("rejects a missing source line and any held chip count other than one", () => {
 const text = "Integration tests The runner disconnected before the first test.";
 expect(() => runHeldPreflight({ text, unknownCount: 1 })).toThrow();
 const complete = `${text} acme/payments · 4 min ago · head 5b81d0c`;
 expect(() => runHeldPreflight({ text: complete, unknownCount: 0 })).toThrow();
 expect(() => runHeldPreflight({ text: complete, unknownCount: 2 })).toThrow();
});
