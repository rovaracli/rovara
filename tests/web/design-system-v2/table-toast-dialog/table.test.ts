// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DataTable, type Column } from "../../../../packages/ui/src/design/DataTable.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { expectNoAxeViolations } from "../../support/axe.js";
const rows = [{ id: "a", title: "Add refunds endpoint" }, { id: "b", title: "Fix webhook retry backoff" }];
const columns: readonly Column<(typeof rows)[number]>[] = [{ key: "task", title: "Task", render: row => row.title }];
function fixture(selectedKey = "a", extra: readonly Column<(typeof rows)[number]>[] = []) {
 const onSelect = vi.fn(), onOpen = vi.fn();
 function Table() {
  const [selected, setSelected] = useState(selectedKey);
  return h(DataTable<(typeof rows)[number]>, { caption: "Tasks", rows, columns: [...columns, ...extra], rowKey: row => row.id, selection: { selectedKey: selected, onSelect: key => { onSelect(key); setSelected(key); }, onOpen } });
 }
 return { Table, onSelect, onOpen };
}
for (const theme of ["light", "dark"] as const) describe(`${theme} table`, () => {
 it("moves the row focus and peek with J/K and arrows, clamps, and opens once on Enter", async () => {
  const { Table, onSelect, onOpen } = fixture(); renderUi(h(Table), { theme });
  const [first, second] = within(screen.getByRole("table", { name: "Tasks" })).getAllByRole("row").slice(1);
  expect(first?.tabIndex).toBe(0); expect(second?.tabIndex).toBe(-1);
  first?.focus(); const user = userEvent.setup(); await user.keyboard("j");
  expect(document.activeElement).toBe(second); expect(second?.getAttribute("aria-current")).toBe("true");
  expect(first?.tabIndex).toBe(-1); expect(second?.tabIndex).toBe(0); expect(onSelect).toHaveBeenLastCalledWith("b");
  await user.keyboard("j"); expect(document.activeElement).toBe(second);
  await user.keyboard("k{ArrowUp}"); expect(document.activeElement).toBe(first);
  await user.keyboard("{ArrowDown}{Enter}"); expect(onOpen).toHaveBeenCalledExactlyOnceWith("b");
  fireEvent.keyDown(second!, { key: "Enter", repeat: true }); expect(onOpen).toHaveBeenCalledTimes(1);
  await expectNoAxeViolations(document.body);
 });
 it("selects on row click and leaves the read-only table noninteractive", async () => {
  const { Table, onSelect } = fixture(); const view = renderUi(h(Table), { theme });
  await userEvent.click(screen.getByText("Fix webhook retry backoff")); expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  view.rerender(h(DataTable<(typeof rows)[number]>, { caption: "Tasks", columns, rows, rowKey: row => row.id }));
  for (const row of screen.getAllByRole("row")) { expect(row.hasAttribute("tabindex")).toBe(false); expect(row.hasAttribute("aria-current")).toBe(false); }
 });
});
it("does not consume keys or clicks from embedded controls, editing regions, modifiers or outside the table", () => {
 const { Table, onSelect, onOpen } = fixture("a", [{ key: "edit", title: "Edit", render: () => h("div", null,
  h("input", { "aria-label": "Name" }), h("select", { "aria-label": "Owner" }, h("option", null, "Ana")), h("textarea", { "aria-label": "Notes" }),
  h("div", { contentEditable: true, suppressContentEditableWarning: true }, h("span", null, "Editable")), h("button", null, "Action"), h("a", { href: "#task" }, "Open link")) }]);
 renderUi(h("div", null, h(Table), h("button", null, "Outside")));
 const row = screen.getAllByRole("row")[1]!;
 const targets = [...row.querySelectorAll("input,select,textarea,button,a,[contenteditable] span"), screen.getByRole("button", { name: "Outside" })];
 for (const target of targets) for (const key of ["j", "k", "ArrowDown", "ArrowUp", "Enter"]) expect(fireEvent.keyDown(target, { key })).toBe(true);
 for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing"]) for (const key of ["j", "ArrowDown", "Enter"]) expect(fireEvent.keyDown(row, { key, [modifier]: true })).toBe(true);
 fireEvent.click(row.querySelector("button")!);
 expect(onSelect).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled();
});
it("handles empty rows and a removed selection without phantom opens or losing the tab stop", () => {
 const onOpen = vi.fn(), onSelect = vi.fn(); const selection = { selectedKey: "missing", onOpen, onSelect };
 const view = renderUi(h(DataTable<(typeof rows)[number]>, { caption: "Tasks", columns, rows: [], rowKey: row => row.id, selection }));
 expect(screen.getAllByRole("row")).toHaveLength(1); fireEvent.keyDown(screen.getByRole("table"), { key: "Enter" }); expect(onOpen).not.toHaveBeenCalled();
 view.rerender(h(DataTable<(typeof rows)[number]>, { caption: "Tasks", columns, rows, rowKey: row => row.id, selection }));
 expect(screen.getAllByRole("row")[1]?.tabIndex).toBe(0);
 expect(document.querySelector('[aria-current="true"]')).toBeNull();
});
