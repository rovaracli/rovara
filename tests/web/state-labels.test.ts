// @vitest-environment jsdom
// Plain-state labels are status text, not buttons: the task page's lead state (switch `?lead=1`), the Work list's state and the new Home's state carry no border, background or padding (the look of a pressable pill),
// are not links or buttons, and show a dot plus the words (colour never carries the meaning alone).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readCssRules } from "./support/css-rules.js";
import { TaskLeadView } from "../../packages/ui/src/screens/session/TaskLead.js";
import { StatePill } from "../../packages/ui/src/screens/home/StatePill.js";
import { h } from "./support/h.js";

const sheet = (path: string) => readCssRules(readFileSync(new URL(path, import.meta.url), "utf8"));
const BUTTON_LOOK = /^(border|border-(top|right|bottom|left)(-\w+)?|background|background-color|padding|box-shadow)$/u;
const ofSelector = (rules: ReturnType<typeof sheet>, selector: string) => rules.filter(rule => rule.selector === selector);
for (const { name, path, selector } of [
 { name: "the task page lead state", path: "../../packages/ui/src/screens/session/session.css", selector: ".rv-lead-pill" },
 { name: "the Work list state", path: "../../packages/ui/src/screens/live/live.css", selector: ".rv-work-state" },
 { name: "the new Home state", path: "../../packages/ui/src/screens/home/home.css", selector: ".rv-hv2-state" },
] as const) {
 it(`${name} has no border, background or padding`, () => {
  const rules = ofSelector(sheet(path), selector);
  expect(rules.length, "the rule exists").toBeGreaterThan(0);
  expect(rules.flatMap(rule => rule.declarations).filter(([property]) => BUTTON_LOOK.test(property))).toEqual([]);
  expect(rules.flatMap(rule => rule.declarations).some(([property, value]) => property === "display" && /flex/u.test(value))).toBe(true);
 });
}
it("the lead state is plain text in a span with a dot drawn by CSS, never a button or a link", () => {
 const rules = sheet("../../packages/ui/src/screens/session/session.css");
 expect(ofSelector(rules, ".rv-lead-pill::before").length).toBeGreaterThan(0);
 for (const tone of ["info", "attention", "danger", "success"]) expect(ofSelector(rules, `.rv-lead-pill[data-tone=${tone}]::before`).length, tone).toBeGreaterThan(0);
 const view = render(h(TaskLeadView, { lead: { state: { label: "Needs a decision", tone: "attention" }, next: "Approve the plan" } as never }));
 const label = screen.getByText("Needs a decision");
 expect(label.tagName).toBe("SPAN");expect(label.className).toBe("rv-lead-pill");expect(label.getAttribute("data-tone")).toBe("attention");
 expect(label.closest("button,a,[role=button],[tabindex]")).toBeNull();
 view.unmount();
});
it("the Home state is a span with a decorative dot and the words", () => {
 const view = render(h(StatePill, { state: { label: "Building", tone: "info" } }));
 const label = screen.getByText("Building").closest(".rv-hv2-state")!;
 expect(label.tagName).toBe("SPAN");expect(label.querySelector(".rv-hv2-dot")?.getAttribute("aria-hidden")).toBe("true");expect(label.closest("button,a,[role=button]")).toBeNull();
 view.unmount();
});
