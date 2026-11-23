// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
import { StatusDot, StatusPill, ToneDot } from "../../../../packages/ui/src/design/StatusDot.js";
import type { StatusChipProps } from "../../../../packages/ui/src/design/StatusChip.js";
afterEach(cleanup);
const cases = [
 ["queued", "Queued", "idle", "clock", "Accepted. Starts when a runner is free."],
 ["setting_up", "Setting up", "running", "setup", "Preparing the workspace. No code changed yet."],
 ["needs_you", "Needs you", "attention", "alert", "Waiting for your decision or answer."],
 ["waiting_for", "Waiting for Ana", "idle", "person", "Someone else has to act. Quiet grey: amber is only for work you can resolve."],
 ["running", "Running", "running", "activity", "Working. Nothing needed from you."],
 ["checking", "Checking", "running", "search", "Running checks and reviews on the change."],
 ["ready_to_merge", "Ready to merge", "ok", "tick", "Every required check and review is in for this version."],
 ["done", "Done", "ok", "circle-tick", "Finished without a merge: an answer, or no change needed."],
 ["merged", "Merged", "ok", "merge", "The change is in the base branch. Deploying is separate."],
 ["stopped", "Stopped", "idle", "stop", "Stopped by a person. Files are kept."],
 ["failed", "Failed", "bad", "cross", "The task's own work failed, for example a test."],
 ["blocked", "Blocked", "bad", "prohibited", "Can't continue until something changes, such as a limit."],
 ["could_not_run", "Could not run", "idle", "dash", "A check or step never ran. Not a pass and not a fail."],
 ["not_run", "Not run", "idle", "dash", "A required review that hasn't happened. Says who can run it."],
 ["unknown", "Unknown", "idle", "question", "Rovara can't confirm the state yet. It is checking."],
 ["didnt_finish", "Didn't finish", "idle", "dash", "A step started but stopped before it finished. It may have cost money. Not a pass and not a fail."],
 ["not_confirmed", "Not confirmed", "idle", "question", "Rovara didn't hear back about a request. Check asks what was recorded; nothing is sent again."],
] as const;
for (const [state, label, hue, icon, description] of cases) it(`${label}: names the state, icon and meaning without relying on colour`, async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 renderUi(h(StatusChip, state === "waiting_for" ? { state, waitingFor: "Ana" } : { state }));
 const chip = screen.getByRole("img", { name: label });
 expect(chip.textContent).toBe(label);
 expect(chip.getAttribute("data-hue")).toBe(hue);
 expect(chip.querySelector("svg")?.getAttribute("data-icon")).toBe(icon);
 expect(chip.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
 expect(document.getElementById(chip.getAttribute("aria-describedby") ?? "")?.textContent).toBe(description);
 expect(chip.tabIndex).toBe(0);
});
it("escapes recipient markup and makes invisible name characters visible", async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 renderUi(h(StatusChip, { state: "waiting_for", waitingFor: "<img src=x> Ana\u202E" }));
 expect(screen.getByRole("img", { name: "Waiting for <img src=x> Ana[U+202E]" }).textContent).toContain("<img src=x>");
 expect(document.querySelector("img")).toBeNull();
});
it.each(["future_state", "toString", "constructor", "__proto__", "", undefined])("unrecognised state %s stays Unknown", async state => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 renderUi(h(StatusChip, { state } as unknown as StatusChipProps));
 expect(screen.getByRole("img", { name: "Unknown" }).getAttribute("data-hue")).toBe("idle");
});
it.each([undefined, "", "   "])("a waiting recipient missing at runtime (%s) stays Unknown", async waitingFor => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 renderUi(h(StatusChip, { state: "waiting_for", waitingFor } as unknown as StatusChipProps));
 expect(screen.getByRole("img", { name: "Unknown" })).toBeTruthy();
});
it("keeps the meaning accessible on focus without opening an overlay over adjacent rows", async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 const user = userEvent.setup();
 renderUi(h(StatusChip, { state: "could_not_run" }));
 const chip = screen.getByRole("img", { name: "Could not run" });
 expect(screen.queryByRole("tooltip")).toBeNull();
 await user.tab();
 expect(document.activeElement).toBe(chip);
 expect(screen.queryByRole("tooltip")).toBeNull();
 expect(screen.getByRole("img", { name: "Could not run", description: "A check or step never ran. Not a pass and not a fail." })).toBe(chip);
 const description = document.getElementById(chip.getAttribute("aria-describedby") ?? "");
 expect(description?.textContent).toBe("A check or step never ran. Not a pass and not a fail.");
 expect(description?.hidden).toBe(true);
 // The browser owns hover placement, so clipped cards cannot clip the explanation.
 expect(chip.title).toBe(description?.textContent);
 await user.keyboard("{Escape}");
 expect(screen.queryByRole("tooltip")).toBeNull();
 expect(document.getElementById(chip.getAttribute("aria-describedby") ?? "")?.textContent).toContain("Not a pass");
});
it("keeps chip labels on one line even inside narrow cells that allow word breaks", async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 const style = document.createElement("style");
 style.textContent = readFileSync("packages/ui/src/design/parts/chips-buttons.css", "utf8");
 document.head.append(style);
 try {
  renderUi(h("div", { style: { width: "40px", overflowWrap: "anywhere" } },
   h(StatusChip, { state: "running" }), h(StatusChip, { state: "waiting_for", waitingFor: "Ana" }),
   h(StatusChip, { state: "ready_to_merge" }), h(StatusChip, { state: "could_not_run" }), h(StatusChip, { state: "didnt_finish" }), h(StatusChip, { state: "not_confirmed" })));
  for (const chip of screen.getAllByRole("img")) {
   const css = getComputedStyle(chip);
   expect(css.whiteSpace).toBe("nowrap");
   expect(css.overflowWrap).toBe("normal");
   expect(getComputedStyle(chip.parentElement!).flexShrink).toBe("0");
  }
 } finally { style.remove(); }
});
it("keeps legacy free-text metadata and aggregate tones separate from canonical task states", () => {
 renderUi(h("div", null,
  h(StatusDot, { status: "running", words: "Running" }),
  h(StatusDot, { status: "succeeded", words: "3 checks passed" }),
  h(StatusDot, { status: "future", words: "Source status unavailable" }),
  h(StatusPill, { tone: "ok", label: "PR #42" }),
  h(ToneDot, { tone: "ok", words: "2 agents available" })));
 expect(screen.getByRole("img", { name: "Running" }).className).toContain("rv-status-chip");
 expect(screen.getByRole("img", { name: "3 checks passed" }).className).toBe("rv-status");
 expect(screen.getByRole("img", { name: "Source status unavailable" }).querySelector("[data-status=unknown]")).toBeTruthy();
 expect(screen.getByText("PR #42")).toBeTruthy();
 expect(screen.getByRole("img", { name: "2 agents available" })).toBeTruthy();
 expect(screen.queryByText("Ready to merge")).toBeNull();
 expect(screen.queryByText("Merged")).toBeNull();
});
for (const theme of ["light", "dark"] as const) it(`${theme}: all seventeen statuses pass axe`, async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 renderUi(h("section", { "aria-label": "Task statuses" }, ...cases.map(([state]) => h(StatusChip, { key: state, ...(state === "waiting_for" ? { state, waitingFor: "Ana" } : { state }) }))), { theme });
 await expectNoAxeViolations(document.body);
});
