// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Select, Checkbox, Switch, TextField, TextArea, Tooltip, Card, Banner, EmptyState, Skeleton, DataTable, RelativeTime, Toast, VisuallyHidden } from "../../packages/ui/src/index.js";
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
  it("provides named form controls, readable tables and quiet feedback", async () => {
   const onChoice = vi.fn(), onChecked = vi.fn(), onSwitch = vi.fn();
   renderUi(h(Announcer, { children: h("section", { "aria-label": "Shared controls" },
    h(TextField, { label: "Workflow name", defaultValue: "Payments expert", hint: "Name the shared method" }),
    h(TextArea, { label: "Instructions", defaultValue: "Use the existing tests" }),
    h(Select, { label: "Project", options: [{ value: "payments", label: "Payments" }], onValueChange: onChoice }),
    h(Checkbox, { label: "Ask before external writes", checked: false, onCheckedChange: onChecked }),
    h(Switch, { label: "Allow comments", checked: false, onCheckedChange: onSwitch }),
    h(Tooltip, { text: "Permission details", children: h(Button, null, "More information") }),
    h(Card, null, h("p", null, "A scoped work surface")), h(Banner, { title: "Waiting for review" }),
    h(EmptyState, { title: "No work needs you", description: "You can return when a decision is needed" }),
    h(Skeleton, { label: "Loading session" }),
    h(DataTable<{ name: string }>, { caption: "Shared workflows", columns: [{ key: "name", title: "Name", render: row => row.name }], rows: [{ name: "Payments expert" }], rowKey: row => row.name }),
    h(RelativeTime, { at: "2026-10-23T12:00:00Z" }), h(Toast, { message: "Draft saved", onDismiss: vi.fn() }), h(VisuallyHidden, null, "Additional context")
   ) }), { theme });
   const user = userEvent.setup();
   await user.click(screen.getByRole("checkbox", { name: "Ask before external writes" }));expect(onChecked).toHaveBeenCalledWith(true);
   await user.click(screen.getByRole("switch", { name: "Allow comments" }));expect(onSwitch).toHaveBeenCalledWith(true);
   await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "payments");expect(onChoice).toHaveBeenCalledWith("payments");
   expect(screen.getByRole("table", { name: "Shared workflows" })).toBeTruthy();
   expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
   await expectNoAxeViolations(document.body);
  });
  it("names statuses, exposes busy state and limits the participant stack", async () => {
   renderUi(h("section", null, h(Button, { busy: true }, "Saving"), h(StatusDot, { status: "needs_person", words: "Needs your decision" }), h(AvatarStack, { people: Array.from({ length: 8 }, (_, index) => ({ name: `Person ${String(index)}`, developerId: String(index) })), total: 8 })), { theme });
   expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
   expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
   expect(screen.getByRole("img", { name: "Needs your decision" })).toBeTruthy();
   expect(document.querySelectorAll("[data-avatar]")).toHaveLength(5);
   expect(screen.getByText("+3")).toBeTruthy();
   await expectNoAxeViolations(document.body);
  });
 });
}
it("coalesces announcements and enforces the five-second quiet interval", async () => {
 vi.useFakeTimers();
 let burst = 0;
 function Sender() { const announce = useAnnounce(); return h(Button, { onClick: () => { burst++; announce(`Task updated ${String(burst)}`); announce(`Comment sent ${String(burst)}`); announce(`Review ready ${String(burst)}`); } }, "Send updates"); }
 renderUi(h(Announcer, null, h(Sender)));
 screen.getByRole("button").click();
 await act(() => vi.advanceTimersByTimeAsync(1000));
 expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
 const region = document.querySelector('[aria-live="polite"]')!;
 expect(region.textContent).toContain("Review ready 1");
 screen.getByRole("button").click();
 await act(() => vi.advanceTimersByTimeAsync(1000));
 expect(region.textContent).toContain("Review ready 1");
 expect(region.textContent).not.toContain("Review ready 2");
 await act(() => vi.advanceTimersByTimeAsync(4000));
 expect(region.textContent).toContain("Review ready 2");
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
 const input = screen.getByLabelText<HTMLInputElement>("Provider key");
 const user = userEvent.setup(); await user.type(input, "test-only-private-value"); await user.click(screen.getByRole("button", { name: "Save key" }));
 await waitFor(() => expect(input.value).toBe(""));
 expect(input.type).toBe("password"); expect(document.body.textContent).not.toContain("test-only-private-value");
 expect(submit).toHaveBeenCalledTimes(1);
});
it("formats only finite actual amounts and identifies estimated usage", () => {
 renderUi(h("div", null, h(Money, { usd: 12.5 }), h(Money, { usd: 1, estimated: true }), h(Money, { usd: NaN })));
 expect(screen.getByText("$12.50")).toBeTruthy(); expect(screen.getByText(/Estimated/)).toBeTruthy(); expect(screen.getByText("Unavailable")).toBeTruthy();
});

it("restores a saved theme and ignores malformed stored preferences", () => {
 const storage = { get: () => "dark", set: vi.fn() };
 renderUi(h(ThemeProvider, { host: { storage }, children: h("p", null, "Stored theme") }));
 expect(document.documentElement.dataset.theme).toBe("dark");cleanup();
 renderUi(h(ThemeProvider, { host: { storage: { get: () => "invalid", set: vi.fn() } }, children: h("p", null, "System theme") }));
 expect(document.documentElement.dataset.theme).toBeUndefined();
});
it("also clears a secret after a rejected submission and hides internal errors", async () => {
 renderUi(h(SecretField, { label: "Secret value", onSubmit: async () => { throw new Error("internal details"); } }));
 const input = screen.getByLabelText<HTMLInputElement>("Secret value");const user = userEvent.setup();
 await user.type(input, "test-only-value");await user.click(screen.getByRole("button", { name: "Save" }));
 await waitFor(() => expect(input.value).toBe(""));expect(screen.getByRole("alert").textContent).not.toContain("internal details");
});
it("makes invisible controls visible in page headings and descriptions", async () => {
 const { PageHeader } = await import("../../packages/ui/src/design/PageHeader.js");renderUi(h(PageHeader, { title: "Workflow\u202E", description: "Details\u0001" }));expect(screen.getByRole("heading", { name: "Workflow[U+202E]" })).toBeTruthy();expect(screen.getByText("Details[U+0001]")).toBeTruthy();
});
it("makes invisible controls visible in dialog identity and description", async () => {
 renderUi(h(Dialog, { title: "Workflow\u202E", description: "Details\u0001", trigger: h(Button, null, "Inspect"), children: h("p", null, "Method") }));await userEvent.click(screen.getByRole("button", { name: "Inspect" }));expect(await screen.findByRole("dialog", { name: "Workflow[U+202E]" })).toBeTruthy();expect(screen.getByText("Details[U+0001]")).toBeTruthy();
});
it("prints invisible controls in native choice labels without changing their values", () => {
 renderUi(h(Select, { label: "Owner\u202E", placeholder: "Choose\u0001", options: [{ value: "member-a", label: "Priya\u202E" }] }));expect(screen.getByRole("combobox", { name: "Owner[U+202E]" })).toBeTruthy();expect(screen.getByRole<HTMLOptionElement>("option", { name: "Priya[U+202E]" }).value).toBe("member-a");expect(screen.getByRole("option", { name: "Choose[U+0001]" })).toBeTruthy();
});
