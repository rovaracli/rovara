// @vitest-environment jsdom
// UX2 slice 2 item 5: the account page's "How you're notified": Slack, email or both, email offered as unavailable where the install has no sender, and the email's stop link asks once.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AccountScreen } from "../../packages/ui/src/screens/account/AccountScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const view = (extra: Record<string, unknown> = {}) => ({ channel: "slack", chosen: false, slackLinked: true, emailAvailable: true, emailUnsubscribed: false, effective: { slack: true, email: false }, ...extra });
function setup(first: Record<string, unknown>, path = "/app/account") {
 const f = fakeHost(async request => request.method === "PUT" ? { status: 200, body: view({ channel: (request.body as { channel?: string }).channel ?? "email", chosen: true, effective: { slack: false, email: true }, ...((request.body as { emailUnsubscribed?: boolean }).emailUnsubscribed === true ? { emailUnsubscribed: true, effective: { slack: true, email: false } } : {}) }) } : { status: 200, body: first });
 f.host.currentPath = () => path;
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(AccountScreen, {}) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}

it("shows the choice and saves a new one", async () => {
 const f = setup(view());
 expect(await screen.findByLabelText("Slack direct message")).toHaveProperty("checked", true);
 expect(screen.getByText("Messages go to Slack.")).toBeTruthy();
 fireEvent.click(screen.getByLabelText("Email"));
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "PUT")).toBe(true));
 expect(f.request.mock.calls.find(([request]) => request.method === "PUT")![0]).toMatchObject({ path: "/v1/app/me/notifications", body: { channel: "email" } });
 expect(await screen.findByText("Messages go to email.")).toBeTruthy();
 f.close();
});

it("offers email as unavailable where the install has no sender: Slack is used", async () => {
 const f = setup(view({ emailAvailable: false }));
 expect(await screen.findByText("Email isn't set up here; we'll use Slack.")).toBeTruthy();
 expect(screen.getByLabelText("Email (unavailable)")).toHaveProperty("disabled", true);
 f.close();
});

it("asks once before the email's stop link stops the emails (opening the link changes nothing)", async () => {
 const f = setup(view({ channel: "email", effective: { slack: false, email: true } }), "/app/account?notify=unsubscribe#notifications");
 const stop = await screen.findByRole("button", { name: "Stop these emails" });
 expect(f.request.mock.calls.some(([request]) => request.method === "PUT")).toBe(false);
 fireEvent.click(stop);
 await waitFor(() => expect(f.request.mock.calls.find(([request]) => request.method === "PUT")?.[0]).toMatchObject({ body: { emailUnsubscribed: true } }));
 f.close();
});
