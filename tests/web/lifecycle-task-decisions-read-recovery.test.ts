// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TaskDecisionsReadRecoveryView } from "../../packages/ui/src/screens/session/TaskDecisionsReadRecoveryView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

describe("task decisions read recovery", () => {
  it("shows only the failed history notice, keeps other task sections, and retries the existing read", () => {
    const retry = vi.fn();
    renderUi(h("main", {},
      h(TaskDecisionsReadRecoveryView, { onRetry: retry }),
      h("section", { "aria-label": "Plan" }, "The task plan remains available."),
    ));

    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain("The task's decisions could not be loaded. No answer or approval was sent.");
    expect(screen.getByRole("region", { name: "Plan" }).textContent).toContain("The task plan remains available.");
    expect(screen.queryByText("Decision: the plan, approved.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reload decisions" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
