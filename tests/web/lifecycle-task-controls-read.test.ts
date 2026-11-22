// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TaskControlsReadRecoveryView } from "../../packages/ui/src/screens/session/TaskControlsReadRecoveryView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { taskFixture } from "./support/session-fixture.js";

for (const theme of ["light", "dark"] as const) it(`keeps readable task content and hides failed controls in ${theme} (R1)`, async () => {
 const task = taskFixture(), reloadControls = vi.fn();
 const view = renderUi(h(TaskControlsReadRecoveryView, { reloadControls, children: h("article", { "data-testid": "task-content" }, h("h1", {}, task.title)) }), { theme });

 expect(screen.getByRole("alert").textContent).toContain("Stop, Share and Conversation could not be loaded. The displayed task is still available, but its controls are not current.");
 expect(screen.getByRole("heading", { name: task.title })).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Talk to this session" })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Reload the controls" }));
 expect(reloadControls).toHaveBeenCalledTimes(1);
 await expectNoAxeViolations(view.container);
 view.unmount();
});
