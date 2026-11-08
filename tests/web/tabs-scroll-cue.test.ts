// @vitest-environment jsdom
// A tab strip that scrolls says so: the Tabs component marks the strip while tabs are hidden past an edge (design.css fades that edge) and scrolls the selected tab into view. jsdom has no layout, so the
// measurements are stubbed here; real scrolling and the fade itself are asserted in the Chromium/Firefox/WebKit journey (tests/web-e2e/saved-env-setting.e2e.ts).
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Tabs, TAB_FADE_PX, hiddenEdges, scrollToTab } from "../../packages/ui/src/design/Tabs.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
afterEach(() => { cleanup(); });
const items = ["Overview", "How we work", "Lessons", "Sources"].map(label => ({ value: label, label, content: h("p", null, label + " panel") }));
/** A 300px strip holding 500px of tabs; each tab is 125px wide at `left = index * 125 - scrollLeft`. */
function stubLayout(strip: HTMLElement) {
 Object.defineProperty(strip, "clientWidth", { configurable: true, value: 300 });
 Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 500 });
 strip.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 44, width: 300, height: 44, x: 0, y: 0, toJSON: () => ({}) });
 strip.querySelectorAll<HTMLElement>("[role=tab]").forEach((tab, index) => { tab.getBoundingClientRect = () => ({ left: index * 125 - strip.scrollLeft, right: index * 125 + 125 - strip.scrollLeft, top: 0, bottom: 44, width: 125, height: 44, x: 0, y: 0, toJSON: () => ({}) }); });
}
describe("hiddenEdges", () => {
 it("is true only for the edge that has tabs past it, with a pixel of slack", () => {
  expect(hiddenEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: false, end: true });
  expect(hiddenEdges({ scrollLeft: 100, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: true, end: true });
  expect(hiddenEdges({ scrollLeft: 200, clientWidth: 300, scrollWidth: 500 })).toEqual({ start: true, end: false });
  expect(hiddenEdges({ scrollLeft: 199.5, clientWidth: 300, scrollWidth: 500 }).end).toBe(false);
  expect(hiddenEdges({ scrollLeft: 0.5, clientWidth: 300, scrollWidth: 500 }).start).toBe(false);
  expect(hiddenEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toEqual({ start: false, end: false });
 });
});
describe("scrollToTab", () => {
 const strip = { left: 10, right: 310, scrollLeft: 0, scrollWidth: 500, clientWidth: 300 };
 it("leaves a tab that is already in view, clear of the fades, where it is", () => { expect(scrollToTab(strip, { left: 10 + TAB_FADE_PX, right: 150 })).toBe(0); });
 it("scrolls a tab past the end in with room for the fade, and no further than the end of the strip", () => {
  expect(scrollToTab(strip, { left: 260, right: 330 })).toBe(330 - 310 + TAB_FADE_PX);
  expect(scrollToTab(strip, { left: 400, right: 520 })).toBe(200);
 });
 it("scrolls a tab before the start in with room for the fade, and no further than the start", () => {
  expect(scrollToTab({ ...strip, scrollLeft: 150 }, { left: -20, right: 60 })).toBe(150 + -20 - 10 - TAB_FADE_PX);
  expect(scrollToTab({ ...strip, scrollLeft: 20 }, { left: -90, right: 0 })).toBe(0);
 });
});
describe("Tabs", () => {
 it("keeps the roles and arrow keys, and marks the strip while tabs are hidden past an edge", async () => {
  const user = userEvent.setup();
  const saved = { clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth"), scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth") };
  // jsdom measures nothing: every element is 300px wide with 500px of content, which is read on the strip's first paint.
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true, get: () => 500 });
  try {
   renderUi(h(Tabs, { label: "Project", defaultValue: "Overview", items }));
   const strip = screen.getByRole("tablist", { name: "Project" });
   expect(strip.hasAttribute("data-more-end")).toBe(true);
   expect(strip.hasAttribute("data-more-start")).toBe(false);
   strip.scrollLeft = 200;
   act(() => { strip.dispatchEvent(new Event("scroll")); });
   expect(strip.hasAttribute("data-more-end")).toBe(false);
   expect(strip.hasAttribute("data-more-start")).toBe(true);
   screen.getByRole("tab", { name: "Overview" }).focus();
   await user.keyboard("{ArrowRight}");
   expect(screen.getByRole("tab", { name: "How we work" }).getAttribute("aria-selected")).toBe("true");
   expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
   expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
   expect(screen.queryAllByRole("status")).toHaveLength(0);
  } finally {
   for (const [name, descriptor] of Object.entries(saved)) { if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name); else Object.defineProperty(Element.prototype, name, descriptor); }
  }
 });
 it("scrolls the selected tab into view when the selection changes", async () => {
  const user = userEvent.setup();
  renderUi(h(Tabs, { label: "Project", defaultValue: "Overview", items }));
  const strip = screen.getByRole("tablist", { name: "Project" });
  stubLayout(strip);
  strip.scrollLeft = 0;
  await user.click(screen.getByRole("tab", { name: "Sources" }));
  await act(async () => { await Promise.resolve(); });
  expect(strip.scrollLeft).toBe(200);
  await user.click(screen.getByRole("tab", { name: "Overview" }));
  await act(async () => { await Promise.resolve(); });
  expect(strip.scrollLeft).toBe(0);
 });
});
