import { meFixture } from "./support/fixtures.js";
import { expect, it } from "vitest";
import { HomeResponseReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { acceptSessionRead, mergeSessionMessages, createSessionApi, createTaskSessionApi } from "../../packages/ui/src/api/sessions.js";
import { queryKeysFor } from "../../packages/ui/src/realtime/invalidate.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, messageFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
it("keeps Merge's body-bound session reader independent of the task-page identity reader", async () => {
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Identity unavailable" } } } : { status: 200, body: { session: sessionFixture() } });
 await expect(createSessionApi(f.host).read(SESSION_FIXTURE_ID)).resolves.toMatchObject({ title: "Fix duplicate refunds" });
 expect(f.request.mock.calls.map(([request]) => request.path)).toEqual(["/v1/app/sessions/" + SESSION_FIXTURE_ID]);
 expect(f.storage.size).toBe(0);
});
it("keeps the task-page reader locked when its identity read fails", async () => {
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Identity unavailable" } } } : { status: 200, body: { session: sessionFixture() } });
 await expect(createTaskSessionApi(f.host).read(SESSION_FIXTURE_ID)).rejects.toMatchObject({ status: 403 });
 expect(f.request.mock.calls.map(([request]) => request.path)).toEqual(["/v1/app/me"]);
});
it("passes the versioned task-view header through the shared retry owner", async () => { const f = fakeHost(async () => ({ status: 200, body: { cards: [], total: 0 } }));await createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema, { "x-agentx-task-view": "2" });expect(f.request.mock.calls[0]?.[0].headers).toEqual({ "x-agentx-task-view": "2" }); });
it("reads the canonical session wrapper and sends the task-view version", async () => { const f = fakeHost(async request => ({ status: 200, body: request.path === "/v1/app/me" ? meFixture() : { session: sessionFixture() } }));const session = await createTaskSessionApi(f.host).read(SESSION_FIXTURE_ID);expect(session.title).toBe("Fix duplicate refunds");expect(f.request.mock.calls[1]?.[0].headers).toEqual({ "x-agentx-task-view": "2" }); });
it("sends a comment delete revision in the query without a request body", async () => { const f = fakeHost(async () => ({ status: 200, body: messageFixture({ text: "Comment deleted", rev: 2, deletedAt: "2026-10-23T13:00:00.000Z" }) }));const result = await createSessionApi(f.host).deleteMessage(SESSION_FIXTURE_ID, "msg_aaaaaaaaaaaaaaaaaaaa", 1);expect(result.kind).toBe("done");expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "DELETE", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/messages/msg_aaaaaaaaaaaaaaaaaaaa?rev=1", body: undefined }); });
it("never replaces newer evidence with a lower revision or older timestamp", () => { const latest = sessionFixture({ revision: 4, updatedAt: "2026-10-23T13:00:00.000Z" });expect(acceptSessionRead(latest, sessionFixture({ revision: 3, updatedAt: "2026-10-23T14:00:00.000Z" }))).toEqual(latest);expect(acceptSessionRead(latest, sessionFixture({ revision: 5 }))).toEqual(latest);expect(acceptSessionRead(latest, sessionFixture({ revision: 5, updatedAt: "2026-10-23T14:00:00.000Z" })).revision).toBe(5); });
it("deduplicates overlapping conversation pages by identity and highest message revision", () => { const old = messageFixture(), newer = messageFixture({ rev: 2, text: "Revised evidence" }), other = messageFixture({ messageId: "msg_bbbbbbbbbbbbbbbbbbbb", text: "Same-time next message" });const result = mergeSessionMessages([[old, other], [newer, old]]);expect(result.map(item => item.text)).toEqual(["Revised evidence", "Same-time next message"]); });
it("invalidates both delivery messages and events for a session.event notice", () => { expect(queryKeysFor({ type: "session.event", sessionId: SESSION_FIXTURE_ID, eventId: "evt_" + "a".repeat(24) })).toEqual([["session", SESSION_FIXTURE_ID, "events"], ["session", SESSION_FIXTURE_ID, "messages"]]); });
it("does not replay an unconfirmed message; the owner keeps its frozen request", async () => {
 const f = fakeHost(async () => { throw new Error("Network unavailable"); });
 await expect(createSessionApi(f.host).sendMessage(SESSION_FIXTURE_ID, { kind: "comment", text: "Check refunds", requestId: "frozen-id" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
 expect(f.request).toHaveBeenCalledTimes(1);expect(f.request.mock.calls[0]?.[0].body).toMatchObject({ requestId: "frozen-id" });
});
it("sends once with the frozen request id and leaves a lost answer unknown", async () => {
 const f = fakeHost(async () => { throw new Error("Network unavailable"); });
 await expect(createSessionApi(f.host).sendMessage(SESSION_FIXTURE_ID, { kind: "comment", text: "Check refunds", requestId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
 expect(f.request).toHaveBeenCalledTimes(1);expect(f.request.mock.calls[0]?.[0].body).toEqual({ kind: "comment", text: "Check refunds", requestId: "11111111-1111-4111-8111-111111111111" });
});

it("orders loaded messages by their actual time before their id", () => {
 const later = messageFixture({ messageId: "msg_aaaaaaaaaaaaaaaaaaaa", createdAt: "2026-10-23T14:00:00.000Z", text: "Later" });
 const earlier = messageFixture({ messageId: "msg_zzzzzzzzzzzzzzzzzzzz", createdAt: "2026-10-23T12:00:00.000Z", text: "Earlier" });
 expect(mergeSessionMessages([[later], [earlier]]).map(message => message.text)).toEqual(["Earlier", "Later"]);
});
it("takes current authority from the latest successful read even when retaining newer evidence", () => {
 const previous = sessionFixture({ revision: 4, updatedAt: "2026-10-23T13:00:00.000Z" });const latest = sessionFixture({ revision: 3, you: { ...previous.you, actions: [] } });
 expect(acceptSessionRead(previous, latest).you.actions).toEqual([]);
});
