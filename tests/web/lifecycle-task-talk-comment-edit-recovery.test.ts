// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionMessageReaderSchema } from "@agentx/contracts/web";
import { TalkCommentEditRecoveryView } from "../../packages/ui/src/screens/session/TalkCommentEditRecoveryView.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { messageFixture } from "./support/session-fixture.js";

const draft = "My unsent explanation for the review";
const messageId = SessionMessageReaderSchema.parse(messageFixture({ text: draft })).messageId;
afterEach(cleanup);

function renderRecovery(state: "conflict" | "missing" | "reload-failed") {
  const onReload = vi.fn();
  const onCopyDraft = vi.fn();
  const view = render(createElement(TalkCommentEditRecoveryView, { state, messageId, draft, onReload, onCopyDraft }));
  return { ...view, onReload, onCopyDraft };
}

it("keeps the exact local draft and comment identity after a revision conflict", async () => {
  const f = renderRecovery("conflict");
  expect(screen.getByText("The comment could not be changed. Your edit is still on this page. Load the current comment before saving again.")).toBeTruthy();
  expect(screen.getByText(draft)).toBeTruthy();
  expect(f.container.querySelector(`[data-message-id="${messageId}"]`)).toBeTruthy();
  expect(screen.queryByText("Stale server comment text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load current comment" }));
  expect(f.onReload).toHaveBeenCalledTimes(1);
  await expectNoAxeViolations(f.container);
});

it("shows the missing-comment state and offers only draft copy", async () => {
  const f = renderRecovery("missing");
  expect(screen.getByText("This comment is no longer available to edit. Your draft is still on this page. Copy your draft.")).toBeTruthy();
  expect(screen.getByText(draft)).toBeTruthy();
  expect(f.container.querySelector(`[data-message-id="${messageId}"]`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy your draft" }));
  expect(f.onCopyDraft).toHaveBeenCalledWith(draft);
  await expectNoAxeViolations(f.container);
});

it("does not present stale comment text after the current-comment read fails", async () => {
  const f = renderRecovery("reload-failed");
  expect(screen.getByText("The current comment could not be loaded. Your draft is still on this page. Reload the comment.")).toBeTruthy();
  expect(screen.getByText(draft)).toBeTruthy();
  expect(screen.queryByText("Stale server comment text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reload the comment" }));
  expect(f.onReload).toHaveBeenCalledTimes(1);
  await expectNoAxeViolations(f.container);
});
