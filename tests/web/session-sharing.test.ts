// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ShareDialog } from "../../packages/ui/src/screens/session/ShareDialog.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID, sessionPerson } from "./support/session-fixture.js";
const sharedAt = "2026-10-23T12:00:00.000Z", arjun = { developerId: "b".repeat(64), name: "Arjun", role: "member", joinedAt: sharedAt, identities: ["cloud"] };
it("removes only the selected canonical principal and waits for server refetch", async () => {
 let shares = [{ principal: { kind: "member", developerId: arjun.developerId }, level: "use", sharedBy: sessionPerson, sharedAt }];
 const f = fakeHost(async request => { if (request.method === "DELETE") { shares = [];return { status: 200, body: { removed: true } }; }return { status: 200, body: request.path.endsWith("/org/members") ? { members: [arjun] } : { shares } }; });const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole("button", { name: "Share" }));fireEvent.click(await screen.findByRole("button", { name: "Remove Arjun" }));await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Arjun" })).toBeNull());expect(f.request.mock.calls.find(([request]) => request.method === "DELETE")?.[0].path).toBe("/v1/app/sessions/" + SESSION_FIXTURE_ID + "/shares/MEMBER%23" + arjun.developerId);ui.unmount();query.clear();
});
it("treats company sharing as pending until the actual selected level is fetched", async () => {
 let shares = [{ principal: { kind: "org" }, level: "view", sharedBy: sessionPerson, sharedAt }];const query = createQueryClient();
 const f = fakeHost(async request => request.method === "PUT" ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["Everyone in Acme can use this session."] } } : { status: 200, body: request.path.endsWith("/org/members") ? { members: [arjun] } : { shares } });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole("button", { name: "Share" }));await screen.findByRole("button", { name: "Arjun" });fireEvent.change(screen.getByRole("combobox", { name: "Share with" }), { target: { value: "org" } });fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "use" } });fireEvent.click(screen.getByRole("button", { name: "Add share" }));await screen.findByText("Waiting for you to confirm in your browser");expect(screen.queryByText("Shared")).toBeNull();
 await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "shares"] });expect(screen.queryByText("Done")).toBeNull();shares = [{ ...shares[0]!, level: "use" }];await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "shares"] });expect(await screen.findByText("Done")).toBeTruthy();ui.unmount();query.clear();
});
