// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { screen, fireEvent } from "@testing-library/react";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { TaskCloseProgressStatusView } from "../../packages/ui/src/screens/session/TaskCloseProgressStatusView.js";
import { renderUi } from "./support/render.js";
import { sessionFixture } from "./support/session-fixture.js";

const SESSION = SessionViewReaderSchema.parse(sessionFixture());
const COPY = {
 slow: "Closing is taking longer than usual. The operation may still be running; leaving this window does not confirm closure. Check this task's close status.",
 pending: "Closing is waiting for confirmation. Its result is not yet known. Open this task to check the close status.",
 unconfirmed: "Closing this task was not confirmed. Its workspace may still be held. Check the task's close status.",
} as const;

it.each(Object.entries(COPY))("shows only the approved uncertain %s state and a read-only Check", (state, copy) => {
 const onCheck = vi.fn();
 renderUi(h(TaskCloseProgressStatusView, { taskId: SESSION.sessionId, state: state as keyof typeof COPY, onCheck }));

 expect(screen.getByRole("status").textContent).toContain(copy);
 expect(screen.getByRole("status").getAttribute("data-task-id")).toBe(SESSION.sessionId);
 expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: /close|discard|release/i })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Check" }));
 expect(onCheck).toHaveBeenCalledTimes(1);
});

it.each([
 "The task is closed.",
 "The workspace has been released.",
 "Your task is now closed.",
])("does not infer closure or release while outcome is unknown (%s)", forbidden => {
 const onCheck = vi.fn();
 renderUi(h(TaskCloseProgressStatusView, { taskId: SESSION.sessionId, state: "unconfirmed", onCheck }));

 expect(screen.getByRole("status").textContent).not.toContain(forbidden);
});
