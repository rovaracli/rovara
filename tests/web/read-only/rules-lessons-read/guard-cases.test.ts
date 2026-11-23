// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { ReadState } from "../../../../packages/ui/src/screens/rules-lessons-read/ReadState.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
import { mount } from "./mount.js";
import { bodies, responder } from "./fixtures.js";

it("prioritizes explicit access-ended over an unsupported-install status", () => {
 renderUi(h(ReadState<string>, { read: { data: undefined, dataUpdatedAt: 0, isPending: false, isFetching: false, isError: true, failureCount: 1, error: new ApiError(501, "ACCESS_ENDED", "Ended"), refetch: vi.fn() }, children: data => h("p", null, data) }));
 expect(screen.getByRole("alert").getAttribute("data-kind")).toBe("denied");
});
it("keeps the page header above a first identity failure", async () => {
 mount("/app/admin/how-we-work/recipes", async () => ({ status: 400, body: {} }));
 await screen.findByRole("alert");expect(screen.getAllByRole("heading", { name: "Setup recipes", level: 1 })).toHaveLength(1);
});
for (const [route, queryPart, fact] of [
 ["/app/admin/how-we-work/recipes", "recipes", "1 recipe"],
 ["/app/projects/payments?tab=lessons", "weekly", "New"],
 ["/app/projects/payments?tab=how-we-work", "playbook", "On for new tasks"],
] as const) {
 it("hides " + queryPart + " metadata immediately on a refusal during retry", async () => {
  const data = bodies();data.weekly.weekly.picks = [{ lessonId: data.page.lessons[0]!.id, title: "A new pick" }];
  const view = mount(route, responder(data));await screen.findByText(fact);
  const query = view.query.getQueryCache().getAll().find(query => query.queryKey.includes(queryPart))!;
  await act(async () => { query.setState({ fetchFailureCount: 1, fetchFailureReason: new ApiError(403, "FORBIDDEN", "Ended"), fetchStatus: "fetching" }); });
  await waitFor(() => expect(screen.queryByText(fact)).toBeNull());
  if (queryPart === "playbook") expect(await screen.findByText("We can’t tell yet. The current setting could not be read.")).toBeTruthy();
 });
}
