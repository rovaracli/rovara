// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { OutcomeNotConfirmed } from "../../../../packages/ui/src/design/OutcomeNotConfirmed.js";
import { MessageDelivery } from "../../../../packages/ui/src/design/MessageDelivery.js";
import { HeldState } from "../../../../packages/ui/src/design/HeldState.js";
import { Conversation } from "../../../../packages/ui/src/screens/session/Conversation.js";
import { SessionMessageReaderSchema } from "@agentx/contracts/web";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
import { messageFixture } from "../../support/session-fixture.js";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
 vi.restoreAllMocks(); vi.unstubAllGlobals();
 if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
 else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
});
const context = {
 title: "Rovara didn't hear back about the monthly limit.",
 happened: "The save was sent, but no reply came back. The limit may be $400 or $600.",
 safe: "Your $600 is kept in the field. Don't save again yet.",
 next: "Read the current limit before doing anything else.",
 refCode: "MONEY-SAVE-NO-REPLY",
};
const check = { label: "Check current limit", onCheck: () => undefined };

it("keeps the supplied draft context, three explanations and one domain Check without claiming success", () => {
 renderUi(h(OutcomeNotConfirmed, { ...context, check }));
 for (const heading of ["What happened", "What is safe", "What to do"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
 expect(screen.getByText(context.happened)).toBeTruthy();
 expect(screen.getByText(context.safe)).toBeTruthy();
 expect(screen.getByText(context.next)).toBeTruthy();
 expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Check current limit", "Copy"]);
 expect(screen.queryByText(/saved|charged|After the check/)).toBeNull();
 expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
});
it("blocks checks while busy and never invokes a write or resend", () => {
 const onCheck = vi.fn();
 const f = renderUi(h(OutcomeNotConfirmed, { ...context, check: { ...check, onCheck }, busy: true }));
 const button = screen.getByRole<HTMLButtonElement>("button", { name: check.label });
 expect(button.disabled).toBe(true); fireEvent.click(button); fireEvent.click(button); expect(onCheck).not.toHaveBeenCalled();
 f.rerender(h(OutcomeNotConfirmed, { ...context, check: { ...check, onCheck } }));
 fireEvent.click(screen.getByRole("button", { name: check.label })); expect(onCheck).toHaveBeenCalledTimes(1);
});
it("copies only the reference code and reports success after the clipboard accepts it", async () => {
 const writeText = vi.fn(async () => undefined);
 Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
 renderUi(h(OutcomeNotConfirmed, { ...context, check }));
 fireEvent.click(screen.getByRole("button", { name: "Copy" }));
 await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(context.refCode));
 expect(await screen.findByText("Copied")).toBeTruthy();
});
it("does not claim a successful copy when clipboard access fails", async () => {
 const writeText = vi.fn(async () => { throw new Error("Clipboard refused"); });
 Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
 renderUi(h(OutcomeNotConfirmed, { ...context, check })); fireEvent.click(screen.getByRole("button", { name: "Copy" }));
 expect(await screen.findByRole("status")).toHaveProperty("textContent", "Couldn't copy the reference.");
 expect(screen.queryByText("Copied")).toBeNull();
});
it("shows an after-check fact only when explicitly supplied, and removes it when withdrawn", () => {
 const afterCheck = "After the check: the limit now reads $600.";
 const f = renderUi(h(OutcomeNotConfirmed, { ...context, check })); expect(screen.queryByText(afterCheck)).toBeNull();
 f.rerender(h(OutcomeNotConfirmed, { ...context, check, afterCheck })); expect(screen.getByText(afterCheck)).toBeTruthy();
 f.rerender(h(OutcomeNotConfirmed, { ...context, check })); expect(screen.queryByText(afterCheck)).toBeNull();
});
it.each([
 ["queued", "Queued for this build"], ["delivered", "Delivered"], ["applied", "Applied"],
 ["checking", "Checking delivery"], ["not_delivered", "Not delivered"], ["outside_plan", "Not applied: outside the plan"],
] as const)("renders the explicit %s receipt without inferring another state", (state, label) => {
 const f = renderUi(h(MessageDelivery, { receipt: { state } }));
 expect(screen.getByRole("status").textContent).toBe(label);
 expect(f.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
 expect(screen.queryByRole("button")).toBeNull();
 if (state === "delivered") expect(screen.queryByText("Applied")).toBeNull();
});
it("keeps missing delivery absent rather than fabricating Applied", () => {
 const f = renderUi(h(MessageDelivery, {})); expect(f.container.textContent).toBe(""); expect(screen.queryByRole("status")).toBeNull();
});
it("keeps a refused message's served detail inert", () => {
 const f = renderUi(h(MessageDelivery, { receipt: { state: "not_delivered", detail: "<img src=x onerror=alert(1)>" } }));
 expect(screen.getByRole("status").textContent).toBe("Not delivered: <img src=x onerror=alert(1)>"); expect(f.container.querySelector("img")).toBeNull();
});
it("renders exactly one Unknown chip by default, without a line, list, clock or action", () => {
 const f = renderUi(h(HeldState, {})); expect(screen.getAllByText("Unknown")).toHaveLength(1);
 expect(screen.queryByText("Rovara can't confirm this yet. It is checking.")).toBeNull();
 expect(f.container.querySelector("ul,ol,time,button,a")).toBeNull();
});
it("renders exactly one quiet held line instead of a chip", () => {
 const f = renderUi(h(HeldState, { presentation: "line" }));
 expect(screen.getAllByText("Rovara can't confirm this yet. It is checking.")).toHaveLength(1); expect(screen.queryByText("Unknown")).toBeNull();
 expect(f.container.querySelector("ul,ol,button,a")).toBeNull();
});
it("falls back to Unknown for an unsupported presentation receipt", () => {
 const receipt = { state: "future_observation" } as unknown as NonNullable<Parameters<typeof MessageDelivery>[0]["receipt"]>;
 renderUi(h(MessageDelivery, { receipt })); expect(screen.getByText("Unknown")).toBeTruthy(); expect(screen.queryByText("Applied")).toBeNull();
});
it.each([
 ["queued", "Queued for this build"], ["delivered", "Delivered"], ["not_delivered", "Not delivered: This session has ended."],
] as const)("maps only the served %s state in Conversation (R2/R4)", (state, label) => {
 const message = SessionMessageReaderSchema.parse(messageFixture({ kind: "steer", delivery: { state, at: "2026-10-23T12:00:00.000Z", ...(state === "not_delivered" ? { reason: "This session has ended." } : {}) } }));
 renderUi(h(Conversation, { agent: "Payments expert", messages: [message], events: [] }));
 expect(screen.getByRole("status").textContent).toBe(label); expect(screen.queryByText("Applied")).toBeNull();
 expect(screen.queryByText("Checking delivery")).toBeNull(); expect(screen.queryByText("Not applied: outside the plan")).toBeNull();
});
it("does not attach instruction delivery to a comment, even if a reader supplies a receipt (R4)", () => {
 const message = SessionMessageReaderSchema.parse(messageFixture({ kind: "comment", delivery: { state: "delivered", at: "2026-10-23T12:00:00.000Z" } }));
 renderUi(h(Conversation, { agent: "Payments expert", messages: [message], events: [] })); expect(screen.queryByRole("status")).toBeNull();
});
it("keeps a steer with no receipt free of delivery claims", () => {
 renderUi(h(Conversation, { agent: "Payments expert", messages: [SessionMessageReaderSchema.parse(messageFixture({ kind: "steer" }))], events: [] }));
 expect(screen.queryByRole("status")).toBeNull();
});
it("keeps an unsupported server receipt Unknown rather than inferring delivery (R2/R4)", () => {
 const message = SessionMessageReaderSchema.parse({ ...messageFixture({ kind: "steer" }), delivery: { state: "future_observation", at: "2026-10-23T12:00:00.000Z" } });
 renderUi(h(Conversation, { agent: "Payments expert", messages: [message], events: [] }));
 expect(screen.getByText("Unknown")).toBeTruthy(); expect(screen.queryByRole("status")).toBeNull();
 expect(screen.queryByText("Applied")).toBeNull();
});
it.each(["light", "dark"] as const)("passes axe for outcome, delivery and both held forms in %s", async theme => {
 const f = renderUi(h("main", {}, h(OutcomeNotConfirmed, { ...context, check }), h(MessageDelivery, { receipt: { state: "checking" } }), h(HeldState, {}), h(HeldState, { presentation: "line" })), { theme });
 expect(within(f.container).getByRole("button", { name: check.label })).toBeTruthy(); await expectNoAxeViolations(f.container);
});
