// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SessionResponseReaderSchema } from "@agentx/contracts/web";
import { TaskSessionEntryReadRecoveryView } from "../../packages/ui/src/screens/session/TaskSessionEntryReadRecoveryView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { sessionFixture } from "./support/session-fixture.js";

const copy = "This page could not be loaded, so it can't say whether the task is running.";
const cachedSession = SessionResponseReaderSchema.parse({ session: sessionFixture() }).session;

it("shows the F736 recovery before any session content and retries the existing entry", () => {
 const retry = vi.fn();
 renderUi(h(TaskSessionEntryReadRecoveryView, { onRetry: retry }));

 expect(screen.getByRole("alert").textContent).toBe(copy);
 expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
 expect(screen.queryByText(cachedSession.title)).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Check again" }));
 expect(retry).toHaveBeenCalledOnce();
});

it("keeps the recovery copy and single retry for a Slack-link Talk entry", () => {
 renderUi(h(TaskSessionEntryReadRecoveryView, { onRetry: vi.fn() }));

 expect(screen.getByRole("alert").textContent).toBe(copy);
 expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
 expect(screen.queryByRole("dialog")).toBeNull();
});
