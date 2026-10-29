// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
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
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }));fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Remove Arjun" }));await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Arjun" })).toBeNull());expect(f.request.mock.calls.find(([request]) => request.method === "DELETE")?.[0].path).toBe("/v1/app/sessions/" + SESSION_FIXTURE_ID + "/shares/MEMBER%23" + arjun.developerId);ui.unmount();query.clear();
});
it("treats company sharing as pending until the actual selected level is fetched", async () => {
 let shares = [{ principal: { kind: "org" }, level: "view", sharedBy: sessionPerson, sharedAt }];const query = createQueryClient();
 const f = fakeHost(async request => request.method === "PUT" ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["Everyone in Acme can use this session."] } } : { status: 200, body: request.path.endsWith("/org/members") ? { members: [arjun] } : { shares } });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }));await screen.findByRole<HTMLButtonElement>("button", { name: "Arjun" });fireEvent.change(screen.getByRole("combobox", { name: "Share with" }), { target: { value: "org" } });fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "use" } });fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Add share" }));await screen.findByText("Waiting for you to confirm in your browser");expect(screen.queryByText("Shared")).toBeNull();
 await act(async () => { await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "shares"] }); });expect(screen.queryByText("Done")).toBeNull();shares = [{ ...shares[0]!, level: "use" }];await act(async () => { await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "shares"] }); });expect(await screen.findByText("Done")).toBeTruthy();
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }));
 fireEvent.change(screen.getByRole("combobox", { name: "Share with" }), { target: { value: "member" } });
 expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Arjun" })).disabled).toBe(false);ui.unmount();query.clear();
});

it("shows a refused project lookup as text and offers no invented project", async () => {
 const refusal = "You don't have access to projects in this company.";
 const f = fakeHost(async request => request.path.endsWith("/projects") ? { status: 403, body: { error: { code: "FORBIDDEN", message: refusal } } } : { status: 200, body: request.path.endsWith("/org/members") ? { members: [arjun] } : { shares: [] } });
 const query = createQueryClient();const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }));await screen.findByRole<HTMLButtonElement>("button", { name: "Arjun" });
 fireEvent.change(screen.getByRole("combobox", { name: "Share with" }), { target: { value: "project" } });
 expect(await screen.findByRole("alert")).toHaveProperty("textContent", refusal);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add share" }).disabled).toBe(true);ui.unmount();query.clear();
});

it("hides cached people when a refetch refuses access to the member list", async () => {
 let refused = false;const refusal = "Your access to this list ended.";
 const f = fakeHost(async request => request.path.endsWith("/org/members") ? refused ? { status: 403, body: { error: { code: "FORBIDDEN", message: refusal } } } : { status: 200, body: { members: [arjun] } } : { status: 200, body: { shares: [] } });
 const query = createQueryClient();const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Share" }));await screen.findByRole<HTMLButtonElement>("button", { name: "Arjun" });refused = true;
 await act(async () => { await query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "share-people"] }); });
 expect((await screen.findByRole("alert")).textContent).toBe(refusal);expect(screen.queryByRole("button", { name: "Arjun" })).toBeNull();ui.unmount();query.clear();
});

it("finds a colleague by exact email on the server without caching emails", async () => {
 const f = fakeHost(async request => request.path.endsWith("/org/members") ? { status: 200, body: { members: [{ developerId: arjun.developerId, name: "Arjun", role: "member" }] } } : request.path.endsWith("/lookup") ? { status: 200, body: { match: { developerId: arjun.developerId, name: "Arjun" }, requestId: "wire-fixture" } } : { status: 200, body: { shares: [] } });const query = createQueryClient();const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole("button", { name: "Share" }));await screen.findByRole("button", { name: "Arjun" });fireEvent.change(screen.getByRole("textbox", { name: "Find a person" }), { target: { value: "arjun@example.test" } });expect(screen.queryByRole("button", { name: "Arjun" })).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Find by exact email" }));fireEvent.click(await screen.findByRole("button", { name: "Arjun" }));expect(f.request.mock.calls.find(([r]) => r.path.endsWith("/lookup"))?.[0]).toMatchObject({ method: "POST", body: { email: "arjun@example.test" } });expect(JSON.stringify(query.getQueriesData({}))).not.toContain("arjun@example.test");fireEvent.change(screen.getByRole("textbox", { name: "Find a person" }), { target: { value: "near@example.test" } });expect(screen.queryByRole("button", { name: "Arjun" })).toBeNull();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add share" }).disabled).toBe(true);ui.unmount();query.clear();
});

it("ignores a late exact-email response after input changes or the dialog closes", async () => {
 let resolve!: (value: { status: number; body: unknown }) => void;const delayed = new Promise<{ status: number; body: unknown }>(r => { resolve = r; });
 const f = fakeHost(async request => request.path.endsWith("/lookup") ? delayed : { status: 200, body: request.path.endsWith("/org/members") ? { members: [arjun] } : { shares: [] } });const query = createQueryClient();const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole("button", { name: "Share" }));await screen.findByRole("button", { name: "Arjun" });fireEvent.change(screen.getByRole("textbox", { name: "Find a person" }), { target: { value: "arjun@example.test" } });fireEvent.click(screen.getByRole("button", { name: "Find by exact email" }));await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/lookup"))).toBe(true));fireEvent.change(screen.getByRole("textbox", { name: "Find a person" }), { target: { value: "different@example.test" } });await act(async () => resolve({ status: 200, body: { match: { developerId: arjun.developerId, name: "Arjun" } } }));expect(screen.queryByRole("button", { name: "Arjun" })).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));fireEvent.click(screen.getByRole("button", { name: "Share" }));expect(screen.getByRole("textbox", { name: "Find a person" })).toHaveProperty("value", "");ui.unmount();query.clear();
});
it("uses the same no-match message for an exact-email miss", async () => { const f = fakeHost(async request => ({ status: 200, body: request.path.endsWith("/lookup") ? { match: null } : request.path.endsWith("/org/members") ? { members: [arjun] } : { shares: [] } }));const query = createQueryClient();const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ShareDialog, { id: SESSION_FIXTURE_ID, orgName: "Acme" }) }) }));fireEvent.click(screen.getByRole("button", { name: "Share" }));await screen.findByRole("button", { name: "Arjun" });fireEvent.change(screen.getByRole("textbox", { name: "Find a person" }), { target: { value: "nobody@example.test" } });fireEvent.click(screen.getByRole("button", { name: "Find by exact email" }));expect(await screen.findByText("No matching colleague.")).toBeTruthy();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add share" }).disabled).toBe(true);ui.unmount();query.clear(); });
