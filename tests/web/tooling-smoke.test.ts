// @vitest-environment jsdom
import { it } from "vitest";
import { Probe } from "../../packages/ui/src/index.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
it("renders a TSX component through the browser test harness", async () => {
  const result = renderUi(h(Probe));
  await expectNoAxeViolations(result.container);
});
