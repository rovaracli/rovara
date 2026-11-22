// @vitest-environment jsdom
import { createElement as h } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { ReadSection } from "../../packages/ui/src/screens/admin/models/read.js";

it("kept facts do not leave inline or already-open portal write controls usable", async () => {
 const client = createQueryClient(), key = ["read-section-authority"];
 client.setQueryData(key, { details: "Private facts" });
 const observer = new QueryObserver<{ details: string }>(client, { queryKey: key, queryFn: async () => { throw new ApiError(502, "INVALID_RESPONSE", "Unreadable"); } });
 let sends = 0;
 const children = (data: { details: string }) => h("div", null, data.details,
  h("button", { onClick: () => { sends++; } }, "Save inline"),
  h("a", { href: "#editor", onClick: () => { sends++; } }, "Open editor"),
  createPortal(h("form", { onSubmit: event => { event.preventDefault();sends++; } }, h("button", { type: "submit" }, "Confirm open change")), document.body));
 const view = render(h(ReadSection<{ details: string }>, { read: observer.getCurrentResult(), label: "details", children }));
 try {
  fireEvent.click(screen.getByRole("button", { name: "Save inline" }));expect(sends).toBe(1);
  await observer.refetch();
  view.rerender(h(ReadSection<{ details: string }>, { read: observer.getCurrentResult(), label: "details", children }));
  expect(screen.getByText("Private facts")).toBeTruthy();
  expect(screen.getByText(/Updated .*Reconnecting/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save inline" }));
  fireEvent.click(screen.getByRole("link", { name: "Open editor" }));
  fireEvent.submit(screen.getByRole("button", { name: "Confirm open change" }).closest("form")!);
  expect(sends).toBe(1);
 } finally { view.unmount();observer.destroy();client.clear(); }
});
