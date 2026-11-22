// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { TaskSessionControlOutcomeView } from "../../packages/ui/src/screens/session/TaskSessionControlOutcomeView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const copy = {
	"follow-unconfirmed": "Your follow change is not confirmed. It may have applied. Check the current follow status.",
	"action-unconfirmed": "This session action was not confirmed. The session may have changed. Check its current status before acting again.",
	"ownership-unavailable": "Ownership could not be checked. This does not confirm whether takeover applied. Check the current owner.",
} as const;

for (const [kind, message] of Object.entries(copy) as [keyof typeof copy, string][]) {
	it(`shows only the approved ${kind} result and the host Check slot`, () => {
		const rendered = renderUi(h(TaskSessionControlOutcomeView, { kind, check: h("button", { type: "button" }, "Check") }));
		expect(screen.getByRole("alert").textContent).toBe(message);
		expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
		for (const claim of ["You now own this session.", "Stop requested.", "Retry started.", "Your follow change was applied.", "Following hasn't changed.", "Following"]) {
			expect(rendered.container.textContent).not.toContain(claim);
		}
		rendered.unmount();
	});
}

it("does not manufacture a Check action when the host has no read-only slot", () => {
	const rendered = renderUi(h(TaskSessionControlOutcomeView, { kind: "action-unconfirmed" }));
	expect(screen.getByRole("alert").textContent).toBe(copy["action-unconfirmed"]);
	expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
	rendered.unmount();
});
