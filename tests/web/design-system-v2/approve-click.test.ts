// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { readDecisions } from "../../../packages/ui/src/api/decisions.js";
import { Button } from "../../../packages/ui/src/design/Button.js";
import { DecisionCard, type DecisionCardActions } from "../../../packages/ui/src/design/DecisionCard.js";
import { fakeHost } from "../support/fake-host.js";
import { h } from "../support/h.js";
import { renderUi } from "../support/render.js";

it("keeps the same button and ref through lock and busy changes, dispatching only when enabled", () => {
 const ref = createRef<HTMLButtonElement>(), send = vi.fn();
 const tree = (lockedReason?: string, busy = false) => h("div", { "data-theme": "light" }, h(Button, { ref, onClick: send, ...(lockedReason === undefined ? {} : { lockedReason }), busy }, "Approve"));
 const view = renderUi(h(Button, { ref, onClick: send, lockedReason: "Agree to the task limit." }, "Approve"));
 const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
 fireEvent.click(approve);
 expect(send).not.toHaveBeenCalled();
 view.rerender(tree());
 expect(screen.getByRole("button", { name: "Approve" })).toBe(approve);
 expect(ref.current).toBe(approve);
 expect(approve.isConnected).toBe(true);
 expect(approve.disabled).toBe(false);
 expect(approve.hasAttribute("aria-describedby")).toBe(false);
 expect(screen.queryByText(/^Locked:/u)).toBeNull();
 approve.focus();
 fireEvent.click(approve);
 expect(send).toHaveBeenCalledTimes(1);
 expect(document.activeElement).toBe(approve);
 view.rerender(tree(undefined, true));
 expect(ref.current).toBe(approve);
 expect(approve.disabled).toBe(true);
 expect(approve.getAttribute("aria-busy")).toBe("true");
 fireEvent.click(approve);
 view.rerender(tree("Read the new evidence."));
 expect(ref.current).toBe(approve);
 expect(approve.disabled).toBe(true);
 fireEvent.click(approve);
 expect(send).toHaveBeenCalledTimes(1);
});

it("unlocks the mounted plan Approve after task-limit consent and dispatches exactly once while busy", async () => {
 const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views["approve_plan_with_choices"]))[0]!;
 let finish!: () => void;
 const pending = new Promise<void>(resolve => { finish = resolve; });
 const actions = {
  onOpenEvidence: vi.fn(async () => undefined),
  onApprove: vi.fn<DecisionCardActions["onApprove"]>(async () => { await pending;return { kind: "decided", outcome: "approved" }; }),
  onReject: vi.fn<DecisionCardActions["onReject"]>(async () => ({ kind: "decided", outcome: "rejected" })),
  onStale: vi.fn(),
 } satisfies DecisionCardActions;
 const { host } = fakeHost();
 renderUi(h(MemoryRouter, null, h(AppHostProvider, { host, children: h(DecisionCard, { decision, actions, pane: {} }) })));
 const approve = screen.getByRole<HTMLButtonElement>("button", { name: "Approve" });
 expect(approve.disabled).toBe(true);
 fireEvent.click(approve);
 expect(actions.onApprove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("checkbox", { name: /I agree Rovara may spend up to \$5.00/u }));
 expect(screen.getByRole("button", { name: "Approve" })).toBe(approve);
 expect(approve.disabled).toBe(false);
 fireEvent.click(approve);
 expect(actions.onApprove).toHaveBeenCalledTimes(1);
 expect(actions.onApprove).toHaveBeenCalledWith(undefined, undefined, expect.objectContaining({ acknowledgedRunLimitUsd: 5 }));
 expect(approve.disabled).toBe(true);
 fireEvent.click(approve);
 expect(actions.onApprove).toHaveBeenCalledTimes(1);
 await act(async () => { finish();await pending; });
});
