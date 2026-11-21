// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Button } from "../../../../packages/ui/src/design/Button.js";
import { IconButton } from "../../../../packages/ui/src/design/IconButton.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
afterEach(cleanup);
it.each(["locked", "busy", "disabled"] as const)("%s buttons suppress click, Enter and Space", async mode => {
 const send = vi.fn(), user = userEvent.setup();
 renderUi(h(Button, { onClick: send, ...(mode === "locked" ? { lockedReason: "A required check couldn't run." } : {}), busy: mode === "busy", disabled: mode === "disabled" }, "Merge #42"));
 const button = screen.getByRole<HTMLButtonElement>("button", { name: "Merge #42" });
 expect(button.disabled).toBe(true);
 await user.click(button);
 button.focus();
 await user.keyboard("{Enter} ");
 button.click();
 expect(send).not.toHaveBeenCalled();
 expect(button.getAttribute("aria-busy")).toBe(mode === "busy" ? "true" : null);
 if (mode === "locked") {
  const reason = screen.getByText("Locked: A required check couldn't run.");
  expect(button.nextElementSibling).toBe(reason);
  expect(button.getAttribute("aria-describedby")?.split(" ")).toContain(reason.id);
  expect(button.querySelector("svg[aria-hidden=true]")).toBeTruthy();
 }
});
it("merges descriptions, forwards the ref and normal button props, and responds when the owner unlocks", async () => {
 const ref = createRef<HTMLButtonElement>(), send = vi.fn(), user = userEvent.setup();
 const view = renderUi(h("div", null, h("p", { id: "evidence" }, "Evidence for this version"), h(Button, { ref, id: "merge", name: "decision", value: "merge", type: "submit", "aria-describedby": "evidence", className: "caller-class", lockedReason: "Waiting for a review", onClick: send }, "Merge #42")));
 const button = screen.getByRole<HTMLButtonElement>("button", { name: "Merge #42" });
 expect(ref.current).toBe(button);
 expect(button.id).toBe("merge");expect(button.type).toBe("submit");expect(button.name).toBe("decision");expect(button.value).toBe("merge");
 expect(button.classList.contains("caller-class")).toBe(true);
 const descriptions = button.getAttribute("aria-describedby")?.split(" ") ?? [];
 expect(descriptions).toHaveLength(2);
 expect(descriptions.map(id => document.getElementById(id)?.textContent)).toEqual(["Evidence for this version", "Locked: Waiting for a review"]);
 view.rerender(h(Button, { ref, onClick: send }, "Merge #42"));
 expect(screen.queryByText(/Locked:/)).toBeNull();
 await user.click(screen.getByRole("button"));expect(send).toHaveBeenCalledTimes(1);
});
it("keeps reason ids unique and exposes locked icon-button names", () => {
 renderUi(h("div", null, h(Button, { lockedReason: "First reason" }, "Merge first"), h(IconButton, { label: "Remove Sam", lockedReason: "Only an admin can remove Sam" }, "×")));
 const buttons = screen.getAllByRole("button");
 expect(new Set(buttons.map(button => button.getAttribute("aria-describedby"))).size).toBe(2);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove Sam" }).disabled).toBe(true);
 expect(screen.getByText("Locked: Only an admin can remove Sam")).toBeTruthy();
});
it("renders quiet underlines, outlined danger, dashed missing results and token-only sizing", async () => {
 const { StatusChip } = await import("../../../../packages/ui/src/design/StatusChip.js");
 const style = document.createElement("style");
 // jsdom does not resolve custom properties in colours; supply the surface role for this cascade check.
 style.textContent = (readFileSync("packages/ui/src/design/design.css", "utf8") + readFileSync("packages/ui/src/design/parts/chips-buttons.css", "utf8")).replaceAll("var(--rv-bg-raised)", "#ffffff");
 document.head.append(style);
 try {
  renderUi(h("div", null, h(Button, { variant: "quiet" }, "Other choices"), h(Button, { variant: "danger" }, "Remove Sam"), h(StatusChip, { state: "could_not_run" }), h(StatusChip, { state: "not_run" })));
  expect(getComputedStyle(screen.getByRole("button", { name: "Other choices" })).textDecorationLine).toBe("underline");
  expect(getComputedStyle(screen.getByRole("button", { name: "Remove Sam" })).backgroundColor).toBe("rgb(255, 255, 255)");
  for (const name of ["Could not run", "Not run"]) {
   const css = getComputedStyle(screen.getByRole("img", { name }));
   expect(css.borderStyle).toBe("dashed");expect(css.backgroundColor).toBe("rgb(255, 255, 255)");
  }
 } finally { style.remove(); }
});
for (const theme of ["light", "dark"] as const) it(`${theme}: four variants and a visible locked reason pass axe`, async () => {
 renderUi(h("section", { "aria-label": "Buttons" }, h(Button, { variant: "primary" }, "Review evidence"), h(Button, null, "Request changes"), h(Button, { variant: "quiet" }, "Other choices"), h(Button, { variant: "danger" }, "Remove Sam"), h(Button, { lockedReason: "A required check couldn't run." }, "Merge #42")), { theme });
 await expectNoAxeViolations(document.body);
});
