// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DecisionFrame } from "../../../../packages/ui/src/design/DecisionFrame.js";
import { TaskTimeline } from "../../../../packages/ui/src/design/TaskTimeline.js";
import { Button } from "../../../../packages/ui/src/design/Button.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
import { expectNoAxeViolations } from "../../support/axe.js";

it("labels each decision by its heading and keeps status, meta, body and actions in reading order", () => {
 const f = renderUi(h(DecisionFrame, {
  title: "Answer 2 questions", status: { state: "needs_you" }, meta: "asked 12 min ago",
  children: h("p", null, "Rovara needs two answers before it writes the plan. Nothing has changed in acme/payments."),
  actions: h(Button, null, "Answer questions"),
 }));
 const card = screen.getByRole("article", { name: "Answer 2 questions" });
 expect(within(card).getByRole("heading", { name: "Answer 2 questions", level: 2 })).toBeTruthy();
 expect(within(card).getByText("Needs you")).toBeTruthy();
 expect(within(card).getByText("asked 12 min ago")).toBeTruthy();
 const text = f.container.textContent;
 expect(text.indexOf("Needs you")).toBeLessThan(text.indexOf("Answer 2 questions"));
 expect(text.indexOf("Nothing has changed")).toBeLessThan(text.indexOf("Answer questions"));
 expect(card.querySelector(".rv-decision-frame-actions")?.contains(screen.getByRole("button"))).toBe(true);
});

it("never adds an action, default status, evidence claims or an approve dispatcher of its own", () => {
 renderUi(h(DecisionFrame, { title: "Review the plan", actions: null, children: h("p", null, "The evidence could not be read.") }));
 expect(screen.queryByRole("button")).toBeNull();
 expect(screen.queryByText("Needs you")).toBeNull();
 expect(screen.queryByText(/ready to merge|approved|saved/iu)).toBeNull();
});

it("keeps keyboard actions isolated to their own decision and escapes supplied strings", async () => {
 const first = vi.fn(), second = vi.fn();
 const f = renderUi(h("div", null,
  h(DecisionFrame, { title: "<img src=x>", meta: "<script>bad()</script>", actions: h(Button, { onClick: first }, "Answer first"), children: "Question one" }),
  h(DecisionFrame, { title: "Second", actions: h(Button, { onClick: second }, "Answer second"), children: "Question two" }),
 ));
 expect(f.container.querySelector("img,script")).toBeNull();
 screen.getByRole("button", { name: "Answer first" }).focus();
 await userEvent.keyboard("{Enter}");
 expect(first).toHaveBeenCalledTimes(1);expect(second).not.toHaveBeenCalled();
});

for (const theme of ["light", "dark"] as const) it(`${theme}: question decision and real-log timeline have no axe violations`, async () => {
 const f = renderUi(h("main", null, h("h1", null, "Parts"),
  h(DecisionFrame, { title: "Answer 2 questions", status: { state: "needs_you" }, meta: "asked 12 min ago", actions: h(Button, null, "Answer questions"), children: h("p", null, "Nothing has changed in acme/payments.") }),
  h(TaskTimeline, { items: [{ id: "build", title: "Build", state: "running", elapsed: "6m 40s", log: h("pre", null, "edit src/refunds/handlers.py (+48 -0)") }] }),
 ), { theme });
 await expectNoAxeViolations(f.container);
});
