// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SessionAnchorRefSchema, SessionMessagePageReaderSchema, type SessionAnchorRef } from "@agentx/contracts/web";
import { TalkTimelineReadRecoveryView } from "../../packages/ui/src/screens/session/TalkTimelineReadRecoveryView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { messageFixture } from "./support/session-fixture.js";

const anchor: SessionAnchorRef = SessionAnchorRefSchema.parse({ target: "plan_block", targetId: "item-3", revision: "v3" });
const cachedMessages = SessionMessagePageReaderSchema.parse({ messages: [messageFixture()] }).messages;

it("shows the F737 read recovery and reloads the same selected session anchor", async () => {
 const reload = vi.fn(async (receivedAnchor: SessionAnchorRef | undefined) => { expect(receivedAnchor).toEqual(anchor); });
 renderUi(h(TalkTimelineReadRecoveryView, { anchor, onReload: reload }));

 expect(screen.getByRole("alert").textContent).toContain("The conversation could not be loaded.");
 expect(screen.getByText(/Your unsent text remains while this page stays open\./)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Reload the conversation" }));
 expect(reload).toHaveBeenCalledWith(anchor);
});

it("hides cached timeline content when the current read is refused", () => {
 renderUi(h(TalkTimelineReadRecoveryView, {
  anchor,
  errorKind: "refused" as const,
  cachedMessages: h("p", {}, cachedMessages[0]!.text),
  onReload: vi.fn(async () => undefined),
 }));

 expect(screen.queryByText(cachedMessages[0]!.text)).toBeNull();
 expect(screen.getByRole("alert")).toBeTruthy();
});

it("keeps cached messages available after a failed refresh", () => {
 renderUi(h(TalkTimelineReadRecoveryView, {
  errorKind: "refresh",
  cachedMessages: h("p", {}, cachedMessages[0]!.text),
  onReload: vi.fn(async () => undefined),
 }));

 expect(screen.getByText(cachedMessages[0]!.text)).toBeTruthy();
 expect(screen.getByRole("alert").textContent).toContain("The conversation could not be loaded.");
});
