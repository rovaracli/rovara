// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { WorkPreviewList } from "../../packages/ui/src/screens/work/WorkPreviewList.js";
import { readTaskList, workRows } from "../../packages/ui/src/api/work-read.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { ID, NOW, task } from "./support/work-fixture.js";
function fixture(selectedId: string) {
 const onOpen = vi.fn<(id: string) => void>();
 const rows = workRows(readTaskList({ tasks: [task(ID.plan, "Selected task")] }), [], NOW);
 const view = renderUi(h(MemoryRouter, { children: h(WorkPreviewList, { rows, selectedId, onSelect: () => undefined, onOpen, now: NOW.getTime() }) }));
 const row = view.container.querySelector("tbody tr")!;return { ...view, onOpen, row };
}
it("O opens the selected task exactly once and ignores modifiers and text fields", () => {
 const f = fixture(ID.plan);
 for (const modifier of ["metaKey", "ctrlKey", "altKey"]) fireEvent.keyDown(f.row, { key: "o", [modifier]: true });
 const input = document.createElement("input");f.row.querySelector("td")!.append(input);fireEvent.keyDown(input, { key: "o" });
 expect(f.onOpen).not.toHaveBeenCalled();fireEvent.keyDown(f.row, { key: "o" });expect(f.onOpen.mock.calls).toEqual([[ID.plan]]);
});
it("O never opens a lesson batch as a task", () => { const f = fixture("lessons:web");fireEvent.keyDown(f.row, { key: "o" });expect(f.onOpen).not.toHaveBeenCalled(); });
