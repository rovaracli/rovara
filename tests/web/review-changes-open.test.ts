// @vitest-environment jsdom
// Round 2 (R2-1): the page asks Review changes to open (`openRequest` goes up) after it moves the draft. A dialog that is disabled (the draft is not loaded, or has unsaved edits) never opens:
// opening it anyway would show a diff of a draft that is not the one the page holds, and a Publish that would be refused.
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReviewChangesDialog } from "../../packages/ui/src/screens/project/ReviewChangesDialog.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { LAYER, howWeWorkHost } from "./support/how-we-work-fixture.js";

function mount(props: { disabled: boolean; openRequest: number }) {
 const cell = howWeWorkHost(), query = createQueryClient();
 const element = (next: typeof props) => h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(ReviewChangesDialog, { project: "payments", agentId: LAYER, from: 1, revision: 3, disabled: next.disabled, openRequest: next.openRequest, onPublished: () => undefined }) }) });
 const ui = renderUi(element(props));
 return { rerender: (next: typeof props) => ui.rerender(h("div", { "data-theme": "light" }, element(next))) };
}

it("opens when asked to and enabled", async () => {
 const view = mount({ disabled: false, openRequest: 0 });
 expect(screen.queryByRole("dialog", { name: "Review changes" })).toBeNull();
 view.rerender({ disabled: false, openRequest: 1 });
 expect(await screen.findByRole("dialog", { name: "Review changes" })).toBeTruthy();
});

it("does not open when asked to while disabled, and stays closed once it is enabled again (the request is spent)", async () => {
 const view = mount({ disabled: true, openRequest: 0 });
 view.rerender({ disabled: true, openRequest: 1 });
 expect(screen.queryByRole("dialog", { name: "Review changes" })).toBeNull();
 view.rerender({ disabled: false, openRequest: 1 });
 expect(screen.queryByRole("dialog", { name: "Review changes" })).toBeNull();
});
