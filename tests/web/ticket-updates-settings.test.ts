// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { TICKET_UPDATE_LEVEL_WORDS } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { TicketUpdatesSettings } from "../../packages/ui/src/screens/project/TicketUpdatesSettings.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const view = (canEdit: boolean, level?: "status_only" | "decisions" | "plan_decisions" | "full") => ({ settings: { comments: true, changeStatus: false, statuses: { started: "In Progress" }, ...(level === undefined ? {} : { level }) }, canEdit, access: [] });
function mount(canEdit = true, saved: (request: ApiRequest) => void = () => {}, response?: ApiResponse) {
 const f = fakeHost(async request => {
  if (request.path.endsWith("/intake/updates") && request.method === "GET") return { status: 200, body: view(canEdit) };
  if (request.path.endsWith("/intake/updates") && request.method === "PUT") { saved(request);return response ?? { status: 200, body: view(canEdit, "decisions") }; }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TicketUpdatesSettings, { project: "web" }) }) }) }), { theme: "light" });
 return { ...f, close() { ui.unmount();query.clear(); } };
}

describe("Linear ticket sharing settings", () => {
 it("shows the four exact explanations and defaults missing levels to status-only", async () => {
  const f = mount();
  const section = await screen.findByTestId("ticket-updates-settings");
  for (const wording of Object.values(TICKET_UPDATE_LEVEL_WORDS)) expect(section.textContent).toContain(wording);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Status only/ }).checked).toBe(true);
  expect(section.textContent).toContain("Tasks only their owner can see always stay at status-only on Linear.");
  f.close();
 });

 it("lets only Code-authorized editors save and passes settings through unchanged", async () => {
  let put: ApiRequest | undefined;
  const f = mount(true, request => { put = request; });
  fireEvent.click(await screen.findByRole("radio", { name: /Decisions/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save sharing settings" }));
  await waitFor(() => expect(put).toBeDefined());
  expect(put!.method).toBe("PUT");
  expect(put!.path).toBe("/v1/app/projects/web/intake/updates");
  expect(put!.body).toMatchObject({ settings: { comments: true, changeStatus: false, level: "decisions", statuses: { started: "In Progress" } } });
  expect((put!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/iu);
  f.close();

  const readOnly = mount(false);
  await screen.findByTestId("ticket-updates-settings");
  expect(screen.queryByRole("button", { name: "Save sharing settings" })).toBeNull();
  expect((screen.getByRole("radio", { name: /Decisions/ }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  readOnly.close();
 });
});
