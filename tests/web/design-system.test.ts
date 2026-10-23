// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../../packages/ui/src/design/Button.js";
import { IconButton } from "../../packages/ui/src/design/IconButton.js";
import { Dialog } from "../../packages/ui/src/design/Dialog.js";
import { Menu } from "../../packages/ui/src/design/Menu.js";
import { Tabs } from "../../packages/ui/src/design/Tabs.js";
import { StatusDot } from "../../packages/ui/src/design/StatusDot.js";
import { AvatarStack } from "../../packages/ui/src/design/AvatarStack.js";
import { Announcer, useAnnounce } from "../../packages/ui/src/design/Announcer.js";
import { SecretField } from "../../packages/ui/src/design/SecretField.js";
import { ThemeProvider, useTheme } from "../../packages/ui/src/theme.js";
import { Money } from "../../packages/ui/src/design/Money.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
afterEach(() => { cleanup(); vi.useRealTimers(); document.documentElement.removeAttribute("data-theme"); });
// @ts-expect-error An icon alone cannot provide an accessible action name.
h(IconButton, { children: "x" });
for (const theme of ["light", "dark"] as const) {
 describe(`${theme} design system`, () => {
  it("traps dialog focus, closes with Escape and returns to the opener", async () => {
   const user = userEvent.setup();
   renderUi(h(Dialog, { title: "Discuss this task", trigger: h(Button, null, "Open discussion"), children: h("label", null, "Comment", h("input", { name: "comment" })) }), { theme });
   const opener = screen.getByRole("button", { name: "Open discussion" });
   await user.click(opener);
   const dialog = await screen.findByRole("dialog", { name: "Discuss this task" });
   for (let n = 0; n < 6; n++) { await user.tab(); expect(dialog.contains(document.activeElement)).toBe(true); }
   await expectNoAxeViolations(document.body);
   await user.keyboard("{Escape}");
   await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
   expect(document.activeElement).toBe(opener);
  });
  it("supports menu arrows, Home and End", async () => {
   const user = userEvent.setup();
   renderUi(h(Menu, { trigger: h(Button, null, "Task actions"), items: ["First", "Second", "Third"].map(label => ({ label, onSelect: vi.fn() })) }), { theme });
   await user.click(screen.getByRole("button", { name: "Task actions" }));
   await user.keyboard("{Home}"); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
   await user.keyboard("{ArrowDown}"); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Second" }));
   await user.keyboard("{End}"); expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Third" }));
   await expectNoAxeViolations(document.body);
  });
  it("supports tab arrows, Home and End with a named active panel", async () => {
   const user = userEvent.setup();
   renderUi(h(Tabs, { label: "Task evidence", defaultValue: "plan", items: ["Plan", "Tests", "Changes"].map(label => ({ value: label.toLowerCase(), label, content: h("p", null, `${label} evidence`) })) }), { theme });
   screen.getByRole("tab", { name: "Plan" }).focus();
   await user.keyboard("{ArrowRight}"); expect(screen.getByRole("tab", { name: "Tests" }).getAttribute("aria-selected")).toBe("true");
   await user.keyboard("{End}"); expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true");
   await user.keyboard("{Home}"); expect(screen.getByRole("tabpanel").textContent).toBe("Plan evidence");
   await expectNoAxeViolations(document.body);
  });
  it("names statuses, exposes busy state and limits the participant stack", async () => {
   renderUi(h("section", null, h(Button, { busy: true }, "Saving"), h(StatusDot, { status: "needs_person", words: "Needs your decision" }), h(AvatarStack, { people: Array.from({ length: 8 }, (_, index) => ({ name: `Person ${String(index)}`, developerId: String(index) })), total: 8 })), { theme });
   expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
   expect(screen.getByRole("status", { name: "Needs your decision" })).toBeTruthy();
   expect(document.querySelectorAll("[data-avatar]")).toHaveLength(5);
   expect(screen.getByText("+3")).toBeTruthy();
   await expectNoAxeViolations(document.body);
  });
 });
}
it("coalesces announcements and enforces the five-second quiet interval", async () => {
 vi.useFakeTimers();
 function Sender() { const announce = useAnnounce(); return h(Button, { onClick: () => { announce("Task updated"); announce("Comment sent"); announce("Review ready"); } }, "Send updates"); }
 renderUi(h(Announcer, null, h(Sender)));
 screen.getByRole("button").click();
 await act(() => vi.advanceTimersByTimeAsync(1000));
 expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
 const region = document.querySelector('[aria-live="polite"]')!;
 expect(region.textContent).toContain("Review ready");
 screen.getByRole("button").click();
 await act(() => vi.advanceTimersByTimeAsync(1000));
 expect(region.textContent).toContain("Review ready");
});
it("stores the explicit theme through the host and updates the root", async () => {
 const storage = { get: vi.fn(() => undefined), set: vi.fn() };
 function Chooser() { const { setPreference } = useTheme(); return h(Button, { onClick: () => setPreference("dark") }, "Dark theme"); }
 renderUi(h(ThemeProvider, { host: { storage }, children: h(Chooser) }));
 await userEvent.setup().click(screen.getByRole("button", { name: "Dark theme" }));
 expect(document.documentElement.dataset.theme).toBe("dark");
 expect(storage.set).toHaveBeenCalledWith("rovara.theme", "dark");
});
it("clears secret input after submission without displaying or persisting its value", async () => {
 const submit = vi.fn(async () => undefined);
 renderUi(h(SecretField, { label: "Provider key", onSubmit: submit, submitLabel: "Save key" }));
 const input = screen.getByLabelText("Provider key") as HTMLInputElement;
 const user = userEvent.setup(); await user.type(input, "test-only-private-value"); await user.click(screen.getByRole("button", { name: "Save key" }));
 await waitFor(() => expect(input.value).toBe(""));
 expect(input.type).toBe("password"); expect(document.body.textContent).not.toContain("test-only-private-value");
 expect(submit).toHaveBeenCalledTimes(1);
});
it("formats only finite actual amounts and identifies estimated usage", () => {
 renderUi(h("div", null, h(Money, { usd: 12.5 }), h(Money, { usd: 1, estimated: true }), h(Money, { usd: NaN })));
 expect(screen.getByText("$12.50")).toBeTruthy(); expect(screen.getByText(/Estimated/)).toBeTruthy(); expect(screen.getByText("Unavailable")).toBeTruthy();
});
