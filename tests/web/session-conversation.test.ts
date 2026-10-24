// @vitest-environment jsdom
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { Composer } from "../../packages/ui/src/screens/session/Composer.js";
import { Conversation } from "../../packages/ui/src/screens/session/Conversation.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { messageFixture } from "./support/session-fixture.js";
it("keeps comment text inert and labels delivery separately from completion", () => {
 const messages = [messageFixture({ text: "<img src=x onerror=alert(1)>" }), messageFixture({ messageId: "msg_bbbbbbbbbbbbbbbbbbbb", kind: "steer", text: "Check the idempotency key", delivery: { state: "queued", at: "2026-10-23T12:00:00.000Z" } })];
 const f = renderUi(h(Conversation, { agent: "Payments expert", messages, events: [] }));expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();expect(f.container.querySelector("img")).toBeNull();expect(screen.getByText("Queued")).toBeTruthy();expect(screen.queryByText("Done")).toBeNull();expect(screen.getByText("Message to Payments expert")).toBeTruthy();f.unmount();
});
it("shows the server delivery refusal verbatim", () => { const f = renderUi(h(Conversation, { agent: "Payments expert", messages: [messageFixture({ kind: "steer", delivery: { state: "not_delivered", reason: "This session has ended.", at: "2026-10-23T12:00:00.000Z" } })], events: [] }));expect(screen.getByText("Not delivered: This session has ended.")).toBeTruthy();f.unmount(); });
it("uses only the visible kind for a gone anchor and explains outdated context", () => { const f = renderUi(h(Conversation, { agent: "Payments expert", messages: [messageFixture({ anchor: { target: "plan_block" }, anchorState: "gone" }), messageFixture({ messageId: "msg_bbbbbbbbbbbbbbbbbbbb", anchor: { target: "step", targetId: "step-1", revision: "running", excerpt: "Prior evidence" }, anchorState: "outdated" })], events: [] }));expect(screen.getByText("This part of the plan is no longer available.")).toBeTruthy();expect(screen.getByText("Refers to an earlier version")).toBeTruthy();expect(f.container.textContent).not.toContain("undefined");f.unmount(); });
it("keeps comments and steering distinct and gates steering on capability", () => { const f = renderUi(h(Composer, { agent: "Payments expert", actions: ["comment"], onSend: async () => undefined }));expect(screen.queryByRole("button", { name: "Message the agent" })).toBeNull();expect(screen.getByText("Comments are for people. Payments expert doesn't read them.")).toBeTruthy();f.unmount();const other = renderUi(h(Composer, { agent: "Payments expert", actions: ["comment", "steer"], onSend: async () => undefined }));fireEvent.click(screen.getByRole("button", { name: "Message the agent" }));expect(screen.getByText("Payments expert reads this as information, not as instructions. Approvals still need you.")).toBeTruthy();other.unmount(); });
it("rejects blank and over-limit input, then sends once while pending", async () => {
 let finish!: () => void;const onSend = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));const f = renderUi(h(Composer, { agent: "Payments expert", actions: ["comment"], onSend }));
 fireEvent.click(screen.getByRole("button", { name: "Send comment" }));expect(onSend).not.toHaveBeenCalled();fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "a".repeat(2001) } });fireEvent.click(screen.getByRole("button", { name: "Send comment" }));expect(onSend).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Check duplicate requests" } });fireEvent.click(screen.getByRole("button", { name: "Send comment" }));fireEvent.click(screen.getByRole("button", { name: "Send comment" }));expect(onSend).toHaveBeenCalledTimes(1);finish();await waitFor(() => expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe(""));f.unmount();
});
it("preserves a refused draft and displays the refusal as text", async () => { const f = renderUi(h(Composer, { agent: "Payments expert", actions: ["comment"], onSend: async () => { throw new ApiError(429, "RATE_LIMITED", "You've posted a lot in the last 10 minutes. Try again in a few minutes."); } }));fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Keep this question" } });fireEvent.click(screen.getByRole("button", { name: "Send comment" }));expect(await screen.findByText("You've posted a lot in the last 10 minutes. Try again in a few minutes.")).toBeTruthy();expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Keep this question");f.unmount(); });

it("retains an edited draft on conflict and reloads server text before retrying its new revision", async () => {
 const revisions: number[] = [];
 function Example() {
 const [message, setMessage] = useState(messageFixture());
 return h(Conversation, { agent: "Payments expert", messages: [message], events: [], meId: "a".repeat(64), onEdit: async (_id: string, rev: number, _text: string) => { revisions.push(rev);if (rev === 1) throw new ApiError(409, "SESSION_REVISION_CONFLICT", "This session changed since you loaded it. Reload it and try again."); }, onReload: async () => { setMessage(messageFixture({ rev: 2, text: "New server evidence" })); } });
 }
 const f = renderUi(h(Example, {}));fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Keep my unsaved explanation" } });fireEvent.click(screen.getByRole("button", { name: "Save changes" }));await screen.findByText("This session changed since you loaded it. Reload it and try again.");expect((screen.getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement).value).toBe("Keep my unsaved explanation");fireEvent.click(screen.getByRole("button", { name: "Reload" }));await screen.findByText("New server evidence");expect((screen.getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement).value).toBe("Keep my unsaved explanation");fireEvent.click(screen.getByRole("button", { name: "Save changes" }));await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull());expect(revisions).toEqual([1, 2]);f.unmount();
});
it("offers editing only for one's own editable app message", () => {
 const onEdit = async () => undefined;
 for (const message of [messageFixture({ author: { developerId: "b".repeat(64), name: "Arjun" } }), messageFixture({ source: "page" }), messageFixture({ deletedAt: "2026-10-23T13:00:00.000Z" }), messageFixture({ kind: "steer", delivery: { state: "queued", at: "2026-10-23T13:00:00.000Z" } }), messageFixture({ kind: "steer", delivery: { state: "delivered", at: "2026-10-23T13:00:00.000Z" } })]) {
 const f = renderUi(h(Conversation, { agent: "Payments expert", messages: [message], events: [], meId: "a".repeat(64), onEdit }));expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();f.unmount();
 }
 const f = renderUi(h(Conversation, { agent: "Payments expert", messages: [messageFixture()], events: [], meId: "a".repeat(64), onEdit }));expect(screen.getByRole("button", { name: "Edit comment" })).toBeTruthy();f.unmount();
});

it("keeps comment and agent-message drafts separate when switching mode", () => {
 const f = renderUi(h(Composer, { agent: "Payments expert", actions: ["comment", "steer"], onSend: async () => undefined }));
 fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "For the team only" } });
 fireEvent.click(screen.getByRole("button", { name: "Message the agent" }));
 expect((screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement).value).toBe("");
 fireEvent.change(screen.getByRole("textbox", { name: "Message the agent" }), { target: { value: "Investigate the retry" } });
 fireEvent.click(screen.getByRole("button", { name: "Comment" }));
 expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("For the team only");f.unmount();
});
it("asks before deleting one's own comment and sends its current revision once", async () => {
 const remove = vi.fn(async () => undefined);
 const f = renderUi(h(Conversation, { agent: "Payments expert", messages: [messageFixture()], events: [], meId: "a".repeat(64), onDelete: remove }));
 fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));expect(remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Keep comment" }));expect(remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
 await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("msg_aaaaaaaaaaaaaaaaaaaa", 1));f.unmount();
});
