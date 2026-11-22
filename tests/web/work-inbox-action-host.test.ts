// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { queueActionHost } from "../../packages/ui/src/screens/work/queue-action-host.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import "./support/render.js";
afterEach(() => { localStorage.clear();vi.restoreAllMocks(); });
function fixture(status = 200, body: unknown = { ok: true }) {
 const query = createQueryClient(), key = ["subject"], identity = meFixture();query.setQueryData(key, { allowed: true });
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: identity } : { status, body });
 let allowed = true, changed = false, active = true;
 const api = queueActionHost(f.host, query, () => active ? identity : undefined, () => [{ key, shown: { allowed: true }, read: async () => ({ allowed: !changed }), permitted: () => allowed }], () => undefined);
 return { ...f, query, key, api, refuse() { allowed = false; }, drift() { changed = true; }, inactive() { active = false; }, input: { method: "POST" as const, path: "/v1/app/test", body: { requestId: "request-1" } }, writes: () => f.request.mock.calls.filter(([input]) => input.method !== "GET") };
}
it("allows exactly one send and preserves its wire request", async () => {
 const f = fixture();await expect(f.api.transport.request(f.input)).resolves.toMatchObject({ status: 200 });
 expect(f.writes().map(([input]) => input)).toEqual([{ ...f.input, retry: "never" }]);
});
it.each(["refuse", "drift", "inactive", "stale", "missing", "storage"])("%s prevents every send", async state => {
 const f = fixture();
 if (state === "refuse") f.refuse();if (state === "drift") f.drift();if (state === "inactive") f.inactive();
 if (state === "stale") f.query.getQueryCache().find({ queryKey: f.key })!.setState({ status: "error", error: new ApiError(403, "FORBIDDEN", "No.") });
 if (state === "missing") f.query.removeQueries({ queryKey: f.key });
 if (state === "storage") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
 await expect(f.api.transport.request(f.input)).rejects.toMatchObject({ code: state === "storage" ? "ACTION_LOCKED" : "CHANGE_STALE" });expect(f.writes()).toHaveLength(0);
 if (["refuse", "stale", "missing", "inactive"].includes(state)) expect(f.request).not.toHaveBeenCalled();
});
it.each([503, 202, 408, 429])("unaccepted %s persists the lock across remount and blocks a second send", async status => {
 const f = fixture(status);await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});
it("a clear 4xx releases the lock and preserves the server answer", async () => {
 const f = fixture(409, { error: { code: "INTENT_NOT_WAITING", message: "The server refused this version." } });
 f.input.path = "/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/answers";
 expect(await f.api.transport.request(f.input)).toMatchObject({ status: 409, body: { error: { message: "The server refused this version." } } });
 await new Promise(resolve => setTimeout(resolve, 0));
 expect(await f.api.transport.request(f.input)).toMatchObject({ status: 409 });expect(f.writes()).toHaveLength(2);
});
it("unreadable success retains the lock", async () => {
 const f = fixture(200, null);await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});
it("a later success with different facts cannot authorize an already-open press", async () => {
 const f = fixture();f.query.setQueryData(f.key, { allowed: false });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(0);
});
it("an unknown action holds its subject across another host instance", async () => {
 const f = fixture(503);await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();
 const remounted = queueActionHost(f.host, f.query, () => meFixture(), () => [{ key: f.key, shown: { allowed: true }, read: async () => ({ allowed: true }), permitted: () => true }], () => undefined);
 await expect(remounted.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});
it("a changed identity at send time sends zero", async () => {
 const f = fixture();f.request.mockImplementation(async () => ({ status: 200, body: meFixture({ developer: { ...meFixture().developer, id: "b".repeat(64) } }) }));
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(0);
});
it("no allocated live source sends zero", async () => {
 const f = fixture();const host = queueActionHost(f.host, f.query, () => meFixture(), () => [], () => undefined);
 await expect(host.transport.request(f.input)).rejects.toMatchObject({ code: "CHANGE_STALE" });expect(f.writes()).toHaveLength(0);
});
it("a retry failure count withdraws authority before query status changes", async () => {
 const f = fixture();f.query.getQueryCache().find({ queryKey: f.key })!.setState({ fetchFailureCount: 1 });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(0);
});
it("a refusal arriving during the preflight read prevents the send", async () => {
 const f = fixture();const host = queueActionHost(f.host, f.query, () => meFixture(), () => [{ key: f.key, shown: { allowed: true }, read: async () => { f.query.getQueryCache().find({ queryKey: f.key })!.setState({ status: "error" });return { allowed: true }; }, permitted: () => true }], () => undefined);
 await expect(host.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(0);
});
it("a lock changed during preflight cannot send", async () => {
 const f = fixture();f.request.mockImplementation(async () => { for (const key of Object.keys(localStorage)) localStorage.setItem(key, "changed");return { status: 200, body: meFixture() }; });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(0);
});
it("a receipt rejected by the existing reader remains unknown", async () => {
 const f = fixture();const host = queueActionHost(f.host, f.query, () => meFixture(), () => [{ key: f.key, shown: { allowed: true }, read: async () => ({ allowed: true }), permitted: () => true, answer: () => false }], () => undefined);
 await expect(host.transport.request(f.input)).rejects.toBeTruthy();expect(Object.keys(localStorage)).toHaveLength(1);
});
it("a network outcome keeps its persisted lock", async () => {
 const f = fixture();f.request.mockImplementation(async input => { if (input.method !== "GET") throw new Error("dropped");return { status: 200, body: meFixture() }; });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});
it("a success-shaped error body cannot clear the unknown lock", async () => {
 const f = fixture(200, { error: { code: "ACCESS_ENDED", message: "Access ended." } });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(Object.keys(localStorage)).toHaveLength(1);
});
it("a request from another tab cannot send while this subject is in flight", async () => {
 const f = fixture();let release!: () => void;const hold = new Promise<void>(resolve => { release = resolve; });
 f.request.mockImplementation(async input => { if (input.method !== "GET") { await hold;return { status: 200, body: { ok: true } }; }return { status: 200, body: meFixture() }; });
 const first = f.api.transport.request(f.input);await new Promise(resolve => setTimeout(resolve, 0));
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();release();await first;expect(f.writes()).toHaveLength(1);
});
it.each(["missing", "corrupted"])("%s durable record forbids even asynchronous preflight work", async storage => {
 const f = fixture(), original = Storage.prototype.setItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => { if (storage === "corrupted") original(key, "corrupt"); });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.request).not.toHaveBeenCalled();
});

it("an empty 4xx sentence does not constitute a definitive refusal", async () => {
 const f = fixture(409, { error: { code: "REFUSED", message: "" } });await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});

it("the identity re-check after source.read prevents a changed person from sending", async () => {
 const f = fixture();let person = meFixture();
 f.request.mockImplementation(async () => ({ status: 200, body: person }));
 const host = queueActionHost(f.host, f.query, () => meFixture(), () => [{ key: f.key, shown: { allowed: true }, read: async () => { person = meFixture({ developer: { ...person.developer, id: "b".repeat(64) } });return { allowed: true }; }, permitted: () => true }], () => undefined);
 await expect(host.transport.request(f.input)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });expect(f.writes()).toHaveLength(0);
});
it.each(["CONFIG_INVALID", "TASK_NOT_FOUND"])("Code post-commit %s stays unknown", async code => {
 const f = fixture(400, { error: { code, message: "The round moved on." } });f.input.path = "/v1/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa/answers";
 await expect(f.api.transport.request(f.input)).rejects.toMatchObject({ code: "ACTION_UNCONFIRMED" });
 await expect(f.api.transport.request(f.input)).rejects.toBeTruthy();expect(f.writes()).toHaveLength(1);
});

it.each([202, 503, 200])("a pending reader only passes through HTTP %s correctly", async status => {
 const f = fixture(status);
 const host = queueActionHost(f.host, f.query, () => meFixture(), () => [{ key: f.key, shown: { allowed: true }, read: async () => ({ allowed: true }), permitted: () => true, pending: () => true }], () => undefined);
 if (status === 503) await expect(host.transport.request(f.input)).rejects.toMatchObject({ code: "ACTION_UNCONFIRMED" });
 else await expect(host.transport.request(f.input)).resolves.toMatchObject({ status });
 expect(Object.keys(localStorage)).toHaveLength(status === 200 ? 0 : 1);
});

it.each(["CSRF_INVALID", "CSRF_STALE", "CONFIG_INVALID"])("403 %s uses only the shared pre-dispatch CSRF path", async code => {
 const f = fixture(403, { error: { code, message: "Couldn't change that." } }), refreshed = vi.spyOn(f.query, "invalidateQueries");
 if (code === "CONFIG_INVALID") { await expect(f.api.transport.request(f.input)).rejects.toMatchObject({ code: "ACTION_UNCONFIRMED" });expect(refreshed).not.toHaveBeenCalled();expect(Object.keys(localStorage)).toHaveLength(1); }
 else { await expect(f.api.transport.request(f.input)).resolves.toMatchObject({ status: 403 });expect(refreshed).toHaveBeenCalledWith({ queryKey: ["queue", "identity"] });expect(Object.keys(localStorage)).toHaveLength(0); }
});
