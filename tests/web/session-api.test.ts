import { expect, it, vi } from "vitest";
import { HomeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { acceptSessionRead, mergeSessionMessages, createSessionApi } from "../../packages/ui/src/api/sessions.js";
import { queryKeysFor } from "../../packages/ui/src/realtime/invalidate.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, messageFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
it("passes the versioned task-view header through the shared retry owner", async () => { const f = fakeHost(async () => ({ status: 200, body: { cards: [], total: 0 } }));await createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema, { "x-agentx-task-view": "2" });expect(f.request.mock.calls[0]?.[0].headers).toEqual({ "x-agentx-task-view": "2" }); });
it("reads the canonical session wrapper and sends the task-view version", async () => { const f = fakeHost(async () => ({ status: 200, body: { session: sessionFixture() } }));const session = await createSessionApi(f.host).read(SESSION_FIXTURE_ID);expect(session.title).toBe("Fix duplicate refunds");expect(f.request.mock.calls[0]?.[0].headers).toEqual({ "x-agentx-task-view": "2" }); });
it("never replaces newer evidence with a lower revision or older timestamp", () => { const latest = sessionFixture({ revision: 4, updatedAt: "2026-10-23T13:00:00.000Z" });expect(acceptSessionRead(latest, sessionFixture({ revision: 3, updatedAt: "2026-10-23T14:00:00.000Z" }))).toBe(latest);expect(acceptSessionRead(latest, sessionFixture({ revision: 5 }))).toBe(latest);expect(acceptSessionRead(latest, sessionFixture({ revision: 5, updatedAt: "2026-10-23T14:00:00.000Z" })).revision).toBe(5); });
it("deduplicates overlapping conversation pages by identity and highest message revision", () => { const old = messageFixture(), newer = messageFixture({ rev: 2, text: "Revised evidence" }), other = messageFixture({ messageId: "msg_bbbbbbbbbbbbbbbbbbbb", text: "Same-time next message" });const result = mergeSessionMessages([[old, other], [newer, old]]);expect(result.map(item => item.text)).toEqual(["Revised evidence", "Same-time next message"]); });
it("invalidates both delivery messages and events for a session.event notice", () => { expect(queryKeysFor({ type: "session.event", sessionId: SESSION_FIXTURE_ID, eventId: "evt_" + "a".repeat(24) })).toEqual([["session", SESSION_FIXTURE_ID, "events"], ["session", SESSION_FIXTURE_ID, "messages"]]); });
it("keeps one request id through message retries and parses the canonical returned message", async () => {
 vi.useFakeTimers();let calls = 0;
 try {
 const f = fakeHost(async () => { if (++calls === 1) throw new Error("Network unavailable");return { status: 200, body: messageFixture() }; });
 const pending = createSessionApi(f.host).sendMessage(SESSION_FIXTURE_ID, { kind: "comment", text: "Check refunds" });await vi.runAllTimersAsync();const result = await pending;
 expect(result.kind).toBe("done");expect(f.request).toHaveBeenCalledTimes(2);expect(f.request.mock.calls[0]?.[0].path).toBe("/v1/app/sessions/" + SESSION_FIXTURE_ID + "/messages");expect(f.request.mock.calls[0]?.[0].body).toMatchObject({ kind: "comment", text: "Check refunds", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown });expect(f.request.mock.calls[1]?.[0].body).toEqual(f.request.mock.calls[0]?.[0].body);
 } finally { vi.useRealTimers(); }
});

it("orders loaded messages by their actual time before their id", () => {
 const later = messageFixture({ messageId: "msg_aaaaaaaaaaaaaaaaaaaa", createdAt: "2026-10-23T14:00:00.000Z", text: "Later" });
 const earlier = messageFixture({ messageId: "msg_zzzzzzzzzzzzzzzzzzzz", createdAt: "2026-10-23T12:00:00.000Z", text: "Earlier" });
 expect(mergeSessionMessages([[later], [earlier]]).map(message => message.text)).toEqual(["Earlier", "Later"]);
});
