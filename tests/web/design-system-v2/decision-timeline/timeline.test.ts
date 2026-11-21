// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { TaskTimeline } from "../../../../packages/ui/src/design/TaskTimeline.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
import { expectNoAxeViolations } from "../../support/axe.js";

const items = [
 { id: "setup", title: "Set up workspace", detail: "Cloned acme/payments at a3f9c1e", state: "done", elapsed: "1m 12s", log: h("p", null, "Old setup log") },
 { id: "build", title: "Build", detail: "Writing the POST /refunds handler · last heard 20 s ago", state: "running", elapsed: "6m 40s", log: h("pre", null, "edit src/refunds/handlers.py (+48 -0)") },
 { id: "checks", title: "Checks", state: "next", log: h("p", null, "Checks have not run") },
] as const;

it("marks only the supplied running row as current, with named done and next states and real elapsed times", () => {
 const { container } = renderUi(h(TaskTimeline, { items }));
 const list = screen.getByRole("list", { name: "Where this task is" });
 const rows = within(list).getAllByRole("listitem");
 expect(rows).toHaveLength(3);
 expect(rows.map(row => row.getAttribute("data-state"))).toEqual(["done", "running", "next"]);
 expect(rows.map(row => row.getAttribute("aria-current"))).toEqual([null, "step", null]);
 expect(within(rows[0]!).getByText("Done")).toBeTruthy();
 expect(within(rows[1]!).getByText("Running")).toBeTruthy();
 expect(within(rows[2]!).getByText("Next")).toBeTruthy();
 expect(within(rows[0]!).getByText("1m 12s")).toBeTruthy();
 expect(within(rows[1]!).getByText("6m 40s")).toBeTruthy();
 expect(rows[2]!.querySelector(".rv-task-timeline-elapsed")).toBeNull();
 expect(screen.queryByRole("progressbar")).toBeNull();
 expect(container.textContent).not.toContain("%");
 expect(rows.every(row => row.querySelector('svg[aria-hidden="true"]'))).toBe(true);
});

it("folds only the current real log under its row, without another log or an invented default", () => {
 renderUi(h(TaskTimeline, { items }));
 const list = screen.getByRole("list", { name: "Where this task is" });
 const rows = within(list).getAllByRole("listitem");
 const log = within(rows[1]!).getByText("Live log");
 const fold = log.closest("details")!;
 expect(fold.open).toBe(false);
 fireEvent.click(log);
 expect(fold.open).toBe(true);
 expect(fold.textContent).toContain("edit src/refunds/handlers.py (+48 -0)");
 expect(rows[0]!.querySelector("details")).toBeNull();
 expect(rows[2]!.querySelector("details")).toBeNull();
});

it("does not invent a current row, elapsed duration or log when the caller supplies none", () => {
 const { container } = renderUi(h(TaskTimeline, { items: [{ id: "checks", title: "Checks", state: "next" }] }));
 expect(container.querySelector("[aria-current]")).toBeNull();
 expect(container.querySelector("details")).toBeNull();
 expect(container.querySelector(".rv-task-timeline-elapsed")).toBeNull();
});

it("escapes step text and renders no steps when the confirmed list is empty", () => {
 const f = renderUi(h(TaskTimeline, { items: [{ id: "unsafe", title: "<img src=x>", detail: "<script>bad()</script>", state: "next" }] }));
 expect(f.container.querySelector("img,script")).toBeNull();
 expect(screen.getByText("<img src=x>")).toBeTruthy();
 f.rerender(h(TaskTimeline, { items: [] }));
 expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});

for (const theme of ["light", "dark"] as const) it(`${theme}: timeline has no axe violations`, async () => {
 const f = renderUi(h(TaskTimeline, { items }), { theme });
 await expectNoAxeViolations(f.container);
});
