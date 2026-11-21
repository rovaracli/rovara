// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { decisionTimelineGalleryScenes } from "../../../../packages/ui/src/design/parts/decision-timeline-scenes.js";
import { userEvent } from "@testing-library/user-event";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
import { expectNoAxeViolations } from "../../support/axe.js";

it("registers the exact P5 scene ids and shows questions, outcome-first plan/evidence and two missing merge results", () => {
 expect(decisionTimelineGalleryScenes.map(scene => scene.id)).toEqual(["decisions", "timeline"]);
 const decisions = decisionTimelineGalleryScenes[0];
 renderUi(h(decisions.render));
 expect(screen.getByRole("article", { name: "Answer 2 questions" })).toBeTruthy();
 const plan = screen.getByRole("article", { name: "Approve plan v3?" });
 expect(plan.textContent.indexOf("Outcome:")).toBeLessThan(plan.textContent.indexOf("Review evidence"));
 expect(within(plan).getByRole<HTMLButtonElement>("button", { name: "Approve plan v3" }).disabled).toBe(true);
 const merge = screen.getByRole("article", { name: "Merge #42 into main?" });
 expect(within(merge).getByText("Could not run")).toBeTruthy();
 expect(within(merge).getByText("Not run")).toBeTruthy();
 expect(within(merge).getByRole<HTMLButtonElement>("button", { name: "Merge #42" }).disabled).toBe(true);
 expect(merge.textContent).not.toContain("Ready to merge");
 expect(within(merge).getByText(/Locked:/u)).toBeTruthy();
});

for (const theme of ["light", "dark"] as const) it(`${theme}: all registered examples have no axe violations`, async () => {
 const f = renderUi(h("main", null, h("h1", null, "Decision and timeline examples"), ...decisionTimelineGalleryScenes.map(scene => h(scene.render, { key: scene.id }))), { theme });
 await expectNoAxeViolations(f.container);
});

it("gives enabled gallery actions local feedback and uses native locks with an adjacent reason", async () => {
 renderUi(h(decisionTimelineGalleryScenes[0].render));
 for (const name of ["Answer questions", "Ask Sam instead", "Request changes", "Design first"]) {
  await userEvent.click(screen.getByRole("button", { name }));
  expect(screen.getByRole("status").textContent).toContain(name);
  expect(screen.getByRole("status").textContent).toContain("Example only");
 }
 const merge = screen.getByRole<HTMLButtonElement>("button", { name: "Merge #42" });
 expect(merge.disabled).toBe(true);
 expect(merge.querySelector("svg[aria-hidden=true]")).toBeTruthy();
 expect(merge.getAttribute("aria-describedby")).toBeTruthy();
});
