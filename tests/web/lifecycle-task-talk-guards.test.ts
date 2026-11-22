// @vitest-environment jsdom
import "./support/render.js";
import { expect, it } from "vitest";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { createSessionApi } from "../../packages/ui/src/api/sessions.js";
import { talkQuestion, talkQuestionRefused, talkRead, talkScope, talkWritable, talkWrite, reconcileTalkMessages } from "../../packages/ui/src/screens/session/talk-lifecycle.js";
import { fakeHost } from "./support/fake-host.js";
import { messageFixture, sessionFixture } from "./support/session-fixture.js";
const scope = talkScope("org_one", "person_one", "ses_aaaaaaaaaaaaaaaaaaaa");
const resources = ["session", "messages:all", "events"];
async function ready(f: ReturnType<typeof fakeHost>) { await talkRead(f.host, scope, "session", async () => sessionFixture());await talkRead(f.host, scope, "messages:all", async () => []);await talkRead(f.host, scope, "events", async () => []); }
it.each([0, 202, 408, 429, 500, 503])("R3/R6a keeps status %s unknown, frozen and locked after a later empty read", async status => {
 const f = fakeHost();await ready(f);let sends = 0;
 const send = () => talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Exact retained body" }, async () => { sends++;throw new ApiError(status, "UNLISTED", "No definitive answer"); });
 await expect(send()).rejects.toBeTruthy();await talkRead(f.host, scope, "messages:all", async () => []);reconcileTalkMessages(f.host, scope, "messages:all", []);
 await expect(send()).rejects.toBeTruthy();expect(sends).toBe(1);expect(f.storage.get(scope)).toContain("Exact retained body");expect(talkWritable(f.host, scope, resources)).toBe(false);
});
it("R6a treats 202 with a readable message body as unknown in the actual API", async () => {
 const f = fakeHost(async () => ({ status: 202, body: messageFixture() }));await expect(createSessionApi(f.host).sendMessage("ses_aaaaaaaaaaaaaaaaaaaa", { kind: "comment", text: "hello" })).rejects.toMatchObject({ status: 202 });
});
it("R6b/R6e rejects an older read completing after a newer refusal, including for a new host with the same storage", async () => {
 const f = fakeHost();await ready(f);let resolve!: () => void;
 const older = talkRead(f.host, scope, "messages:all", () => new Promise<void>(done => { resolve = done; }));
 await expect(talkRead(f.host, scope, "messages:all", async () => { throw new ApiError(403, "FORBIDDEN", "No access"); })).rejects.toBeTruthy();resolve();await expect(older).rejects.toMatchObject({ code: "READ_SUPERSEDED" });
 const other = fakeHost();other.host.storage = f.host.storage;expect(talkWritable(other.host, scope, resources)).toBe(false);
});
it("F5 keeps an unsaved refused comment read authoritative through unrelated reads and recovers only on a newer owning read", async () => {
 const f = fakeHost();await ready(f);const resource = "message:msg_aaaaaaaaaaaaaaaaaaaa";await talkRead(f.host, scope, resource, async () => messageFixture());
 const originalSet = f.host.storage.set.bind(f.host.storage);let refuseSave = true;
 f.host.storage.set = (key, value) => { const parsed = JSON.parse(value) as { reads?: Record<string, { health?: string }> };if (refuseSave && parsed.reads?.[resource]?.health === "refused") throw new Error("simulated health-save failure");originalSet(key, value); };
 await expect(talkRead(f.host, scope, resource, async () => { throw new ApiError(403, "FORBIDDEN", "No longer readable"); })).rejects.toMatchObject({ status: 403 });
 refuseSave = false;const durable = JSON.parse(f.storage.get(scope)!) as { sequence: number; reads: Record<string, { sequence: number; health: string }> };durable.sequence++;durable.reads.session = { sequence: durable.sequence, health: "current" };originalSet(scope, JSON.stringify(durable));
 await talkRead(f.host, scope, "session", async () => sessionFixture());
 expect(talkWritable(f.host, scope, resources)).toBe(false);
 await talkRead(f.host, scope, resource, async () => messageFixture());expect(talkWritable(f.host, scope, resources)).toBe(true);
});
it("R6c rejects an already-open sender after the latest session drops its action", async () => {
 const f = fakeHost();await ready(f);const base = sessionFixture();await talkRead(f.host, scope, "session", async () => sessionFixture({ you: { ...base.you, actions: [] } }));let sent = false;
 await expect(talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Earlier draft" }, async () => { sent = true;return messageFixture(); })).rejects.toMatchObject({ code: "FORBIDDEN" });expect(sent).toBe(false);
});
it("R6g makes an unknown request invisible to a different company or person", async () => {
 const f = fakeHost();await ready(f);await expect(talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Private draft" }, async () => { throw new ApiError(503, "UNKNOWN", "Unknown"); })).rejects.toBeTruthy();
 expect(f.storage.get(talkScope("org_one", "person_two", "ses_aaaaaaaaaaaaaaaaaaaa"))).toBeUndefined();expect(f.storage.get(talkScope("org_two", "person_one", "ses_aaaaaaaaaaaaaaaaaaaa"))).toBeUndefined();
});
it.each(["CSRF_INVALID", "CSRF_STALE"])("R6h clears a documented %s pre-write rejection without recording an authority refusal", async code => {
 const f = fakeHost();await ready(f);await expect(talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Draft" }, async () => { throw new ApiError(403, code, "Stale token"); })).rejects.toBeTruthy();expect(talkWritable(f.host, scope, resources)).toBe(true);
});
it("R2 replaces an accepted receipt with a later observed read, without attributing another person's change", async () => {
 const f = fakeHost();await ready(f);await talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Requested text" }, async () => messageFixture({ text: "Returned text" }));expect(f.storage.get(scope)).toContain("Returned text");
 const changed = messageFixture({ text: "New observed text", rev: 2 });await talkRead(f.host, scope, "messages:all", async () => [changed]);reconcileTalkMessages(f.host, scope, "messages:all", [changed]);expect(f.storage.get(scope)).toContain("New observed text");expect(f.storage.get(scope)).not.toContain("Returned text");
});

it.each(["CSRF_INVALID", "CSRF_STALE"])("R6a keeps 500/%s unknown, frozen and unavailable for a second dispatch", async code => {
 const f = fakeHost();await ready(f);let sends = 0;
 const send = () => talkWrite(f.host, scope, resources, "send", { kind: "comment", text: "Frozen after server error" }, async () => { sends++;throw new ApiError(500, code, "Server error"); });
 await expect(send()).rejects.toMatchObject({ status: 500, code });await expect(send()).rejects.toMatchObject({ code: "READ_REQUIRED" });
 expect(sends).toBe(1);expect(talkWritable(f.host, scope, resources)).toBe(false);expect(f.storage.get(scope)).toContain("Frozen after server error");
});

it("F4 persists an answer authority refusal and only a newer owning project read restores Ask", async () => {
 const f = fakeHost();await ready(f);let sends = 0, finishOlder!: (value: { ok: true }) => void;
 const olderAuthorityRead = talkRead(f.host, scope, "question-authority", () => new Promise<{ ok: true }>(resolve => { finishOlder = resolve; }));
 await expect(talkQuestion(f.host, scope, resources, { question: "Keep access closed" }, async () => { sends++;throw new ApiError(403, "FORBIDDEN", "No access"); })).rejects.toMatchObject({ status: 403 });
 expect(talkQuestionRefused(f.host, scope)).toBe(true);
 const reloaded = fakeHost();reloaded.host.storage = f.host.storage;expect(talkQuestionRefused(reloaded.host, scope)).toBe(true);
 finishOlder({ ok: true });await olderAuthorityRead;expect(talkQuestionRefused(f.host, scope)).toBe(true);
 await talkRead(f.host, scope, "session", async () => sessionFixture());
 expect(talkQuestionRefused(f.host, scope)).toBe(true);
 await expect(talkQuestion(f.host, scope, resources, { question: "Retry" }, async () => { sends++;return {}; })).rejects.toMatchObject({ code: "FORBIDDEN" });
 expect(sends).toBe(1);
 await talkRead(f.host, scope, "question-authority", async () => ({ ok: true }));
 expect(talkQuestionRefused(f.host, scope)).toBe(false);
});

for (const operation of ["send", "steer", "edit", "delete", "question"] as const) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a ${operation}: 500/${code} retains its exact unknown request`, async () => {
 const f = fakeHost();await ready(f);let posts = 0;
 const body = { messageId: messageFixture().messageId, rev: 1, kind: operation === "steer" ? "steer" : "comment", text: "Retained action", question: "Why?" };
 const send = async () => { posts++;throw new ApiError(500, code, "Unknown result"); };
 const press = () => operation === "question" ? talkQuestion(f.host, scope, resources, body, send) : talkWrite(f.host, scope, resources, operation === "steer" ? "send" : operation, body, send);
 await expect(press()).rejects.toMatchObject({ status: 500, code });
 const before = f.storage.get(scope);await ready(f);await expect(press()).rejects.toBeTruthy();
 expect(posts).toBe(1);expect(f.storage.get(scope)).toContain("Retained action");
 expect((JSON.parse(before!) as { lock: { requestId: string } }).lock.requestId).toBe((JSON.parse(f.storage.get(scope)!) as { lock: { requestId: string } }).lock.requestId);
});
