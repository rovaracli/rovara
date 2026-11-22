// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { PlanRevisionView, type PlanRevisionViewProps } from "../../packages/ui/src/screens/session/PlanRevisionView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const props: PlanRevisionViewProps = {
 readState: "ready",
 comparison: {
  status: "compared",
  previous: { revision: 3, content: "Earlier plan" },
  current: { revision: 4, content: "Current plan" },
  rows: [
   { id: "same", label: "Request handling", status: "unchanged", before: "POST /refunds", after: "POST /refunds" },
   { id: "changed", label: "Retry behavior", status: "changed", before: "Reject repeats", after: "Return the first result for repeats" },
   { id: "added", label: "Idempotency test", status: "added", after: "Test duplicate requests" },
  ],
  evidence: [{ id: "ev1", label: "Retry notes", href: "/app/evidence/ev1?revision=4", pinnedRevision: 4 }],
 },
};

it("shows only supplied classifications, exact evidence link and pinned revision", () => {
 const view = renderUi(h(PlanRevisionView, props));
 expect(screen.getByRole("heading", { name: "Plan v4 replaces v3" })).toBeTruthy();
 expect(screen.getAllByText("POST /refunds")).toHaveLength(2);
 expect(screen.getByText("Reject repeats")).toBeTruthy();
 expect(screen.getByText("Return the first result for repeats")).toBeTruthy();
 expect(screen.getByText("Test duplicate requests")).toBeTruthy();
 expect(screen.getByText("Added")).toBeTruthy();
 expect(screen.getByText("Changed")).toBeTruthy();
 expect(screen.getByText("Unchanged")).toBeTruthy();
 const link = screen.getByRole<HTMLAnchorElement>("link", { name: "Retry notes" });
 expect(link.getAttribute("href")).toBe("/app/evidence/ev1?revision=4");
 expect(screen.getByText(/Pinned to revision 4/u)).toBeTruthy();
 view.unmount();
});

it("drops cached comparison content when the latest read fails", () => {
 const view = renderUi(h(PlanRevisionView, { ...props, readState: "failed" }));
 expect(screen.getByRole("alert").textContent).toMatch(/couldn't load the latest plan comparison/i);
 expect(screen.queryByText("Current plan")).toBeNull();
 expect(screen.queryByText("POST /refunds")).toBeNull();
 view.unmount();
});

it("does not derive a diff when revisions match", () => {
 const view = renderUi(h(PlanRevisionView, { ...props, comparison: { status: "same", current: { revision: 4, content: "Current plan" } } }));
 expect(screen.getByText("This is still plan v4. There is no newer revision to compare.")).toBeTruthy();
 expect(screen.queryByText("Changed")).toBeNull();
 view.unmount();
});

it("explains unavailable and superseded comparisons without claiming a historical diff", () => {
 for (const status of ["unavailable", "superseded"] as const) {
  const view = renderUi(h(PlanRevisionView, { ...props, comparison: { status, current: { revision: 4, content: "Current plan" } } }));
  expect(screen.getByRole("status").textContent).toMatch(status === "unavailable" ? /comparison isn't available/i : /newer plan is now current/i);
  expect(screen.queryByText("Changed")).toBeNull();
  view.unmount();
 }
});

it("uses the read-failed state for loading data rather than showing old revisions", () => {
 const view = renderUi(h(PlanRevisionView, { ...props, readState: "loading" }));
 expect(screen.getByRole("status").textContent).toMatch(/loading the latest plan comparison/i);
 expect(screen.queryByText("Current plan")).toBeNull();
 view.unmount();
});
