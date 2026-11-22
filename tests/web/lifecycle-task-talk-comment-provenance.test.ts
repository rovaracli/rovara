// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SessionEventReaderSchema, SessionMessageReaderSchema } from "@agentx/contracts/web";
import { TalkCommentProvenanceView } from "../../packages/ui/src/screens/session/TalkCommentProvenanceView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { messageFixture, sessionPerson } from "./support/session-fixture.js";

const comment = (source: "slack" | "app" | "page" | undefined) => SessionMessageReaderSchema.parse({
 ...messageFixture(),
 ...(source === undefined ? {} : { source }),
});

it("shows a known Slack comment as a human comment without channel or instruction controls", () => {
 const message = comment("slack");
 const event = SessionEventReaderSchema.parse({ eventId: "evt_aaaaaaaaaaaaaaaaaaaaaaaa", at: message.createdAt, type: "comment", source: "slack", messageId: message.messageId, actor: { kind: "member", ...sessionPerson }, text: message.text });
 expect(event.source).toBe(message.source);
 const f = renderUi(h(TalkCommentProvenanceView, { message, event }));
 expect(screen.getByText("Priya")).toBeTruthy();
 expect(screen.getByText(/from Slack/u)).toBeTruthy();
 expect(screen.getByText("Comment")).toBeTruthy();
 expect(f.container.textContent).not.toMatch(/#payments|instructions|steer|Message the agent/u);
 expect(f.container.querySelector("button")).toBeNull();
 f.unmount();
});

it("labels an app or task-page comment as from the web", () => {
 for (const source of ["app", "page"] as const) {
  const message = comment(source);
  const event = SessionEventReaderSchema.parse({ eventId: "evt_aaaaaaaaaaaaaaaaaaaaaaaa", at: message.createdAt, type: "comment", source, messageId: message.messageId, actor: { kind: "member", ...sessionPerson }, text: message.text });
  const f = renderUi(h(TalkCommentProvenanceView, { message, event }));
  expect(screen.getByText(/from the web/u)).toBeTruthy();
  f.unmount();
 }
});

it("keeps absent event provenance unknown instead of inferring a channel", () => {
 const message = comment("app");
 const event = SessionEventReaderSchema.parse({ eventId: "evt_bbbbbbbbbbbbbbbbbbbbbbbb", at: message.createdAt, type: "comment", messageId: message.messageId, actor: { kind: "member", ...sessionPerson }, text: message.text });
 expect(event.source).toBeUndefined();
 const f = renderUi(h(TalkCommentProvenanceView, { message, event }));
 expect(screen.getByText(/Source unavailable/u)).toBeTruthy();
 expect(f.container.textContent).not.toMatch(/#|channel|instructions|steer/u);
 f.unmount();
});

it("does not render instruction messages as human comment attribution", () => {
 const message = SessionMessageReaderSchema.parse({ ...messageFixture(), kind: "steer", source: "slack" });
 const event = SessionEventReaderSchema.parse({ eventId: "evt_cccccccccccccccccccccccc", at: message.createdAt, type: "comment", source: "slack", messageId: message.messageId, actor: { kind: "member", ...sessionPerson }, text: message.text });
 const f = renderUi(h(TalkCommentProvenanceView, { message, event }));
 expect(screen.queryByTestId("talk-comment-provenance")).toBeNull();
 f.unmount();
});

it("does not attribute a mismatched message and event", () => {
 const message = comment("slack");
 const event = SessionEventReaderSchema.parse({ eventId: "evt_dddddddddddddddddddddddd", at: message.createdAt, type: "comment", source: "slack", messageId: "msg_bbbbbbbbbbbbbbbbbbbb", actor: { kind: "member", ...sessionPerson }, text: message.text });
 const f = renderUi(h(TalkCommentProvenanceView, { message, event }));
 expect(screen.queryByTestId("talk-comment-provenance")).toBeNull();
 f.unmount();
});
