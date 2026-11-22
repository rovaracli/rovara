// @vitest-environment jsdom
import { createElement } from "react";
import { act, screen } from "@testing-library/react";
import { renderUi } from "./support/render.js";
import { expect, it } from "vitest";
import { taskActionRecords } from "../../packages/ui/src/api/task-action.js";
import type { AppHost } from "../../packages/ui/src/host.js";
function freezeSessionRequest(host: AppHost, scope: string, action: string, body: Record<string, unknown> & { requestId: string }, stateScope = scope): FrozenSessionRequest {
 const request = { requestId: body.requestId, action, body, startedAt: Date.now(), fence: 0 };
 const records = taskActionRecords(host);
 const claimed = records.claimPending({ requestId: request.requestId, startedAt: new Date(request.startedAt).toISOString(), scope, request }, () => undefined, "Storage unavailable");
 if (claimed.stop) throw new Error("Unresolved request");
 markSessionWrite(host, stateScope);return request;
}
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { createTaskSessionApi } from "../../packages/ui/src/api/sessions.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { readSessionIdentity, sessionScope, beginSessionRead, finishSessionRead, markSessionWrite, type FrozenSessionRequest, useSessionRequest, readFrozenSessionRequest, clearSessionRequest } from "../../packages/ui/src/api/session-safety.js";

it("F2/R3/R6d: persists the exact request before sending and keeps it across owners", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() }));
 const identity = await readSessionIdentity(f.host), scope = sessionScope(identity, SESSION_FIXTURE_ID);
 const frozen = freezeSessionRequest(f.host, scope, "stop", { requestId: crypto.randomUUID() });
 expect(readFrozenSessionRequest(f.host, scope)).toEqual(frozen);
 expect(() => freezeSessionRequest(f.host, scope, "stop", { requestId: crypto.randomUUID() })).toThrow();
 f.host.storage.set = () => undefined;
 expect(() => clearSessionRequest(f.host, scope, frozen.requestId)).toThrow();
});

it("R6g: a second person cannot see another person's pending request", async () => {
 const f = fakeHost(), a = { companyId: "company-a", personId: "person-a" }, b = { ...a, personId: "person-b" };
 freezeSessionRequest(f.host, sessionScope(a, SESSION_FIXTURE_ID), "stop", { requestId: crypto.randomUUID() });
 expect(readFrozenSessionRequest(f.host, sessionScope(b, SESSION_FIXTURE_ID))).toBeUndefined();
});

it("F6/R6b/e: an older in-flight session read cannot restore authority after a newer refusal", async () => {
 let finish!: (reply: { status: number; body: unknown }) => void, reads = 0;
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : { status: 403, body: { error: { code: "FORBIDDEN", message: "Access refused" } } });
 const api = createTaskSessionApi(f.host), older = api.read(SESSION_FIXTURE_ID);
 await new Promise(resolve => setTimeout(resolve, 0));
 await expect(api.read(SESSION_FIXTURE_ID)).rejects.toMatchObject({ status: 403 });
 finish({ status: 200, body: { session: sessionFixture() } });
 await expect(older).rejects.toMatchObject({ code: "READ_SUPERSEDED" });
});

it("R6b: a session read issued before a frozen write cannot resolve it", async () => {
 let finish!: (reply: { status: number; body: unknown }) => void;
 const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: meFixture() } : new Promise(resolve => { finish = resolve; }));
 const identity = await readSessionIdentity(f.host), scope = sessionScope(identity, SESSION_FIXTURE_ID), older = createTaskSessionApi(f.host).read(SESSION_FIXTURE_ID);
 await new Promise(resolve => setTimeout(resolve, 0));
 freezeSessionRequest(f.host, scope, "stop", { requestId: crypto.randomUUID() });
 finish({ status: 200, body: { session: sessionFixture() } });
 await expect(older).rejects.toMatchObject({ code: "READ_SUPERSEDED" });
 expect(readFrozenSessionRequest(f.host, scope)?.action).toBe("stop");
});

it("B4/R6b-e: clarification's independent lock advances its session read fence only for that identity and session", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() })), identity = await readSessionIdentity(f.host);
 const session = sessionScope(identity, SESSION_FIXTURE_ID), otherSession = sessionScope(identity, "ses_bbbbbbbbbbbbbbbbbbbb");
 const older = beginSessionRead(f.host, session), independent = beginSessionRead(f.host, otherSession);
 const answerLock = sessionScope(identity, SESSION_FIXTURE_ID + ":answers:1");
 freezeSessionRequest(f.host, answerLock, "answers", { requestId: crypto.randomUUID(), round: 1, revision: 3, answers: [] }, session);
 expect(() => finishSessionRead(f.host, session, older)).toThrowError(/newer task check/u);
 expect(() => finishSessionRead(f.host, otherSession, independent)).not.toThrow();
 expect(readFrozenSessionRequest(f.host, answerLock)?.action).toBe("answers");
});

it("R6a: all 5xx, throttling and unknown refusals stay unresolved", async () => {
 const { isFinalSessionRefusal } = await import("../../packages/ui/src/api/session-safety.js");
 const { ApiError } = await import("../../packages/ui/src/api/errors.js");
 for (const status of [0, 202, 408, 429, 500, 501, 503]) expect(isFinalSessionRefusal(new ApiError(status, "UNRECOGNISED", "Unknown outcome"))).toBe(false);
 expect(isFinalSessionRefusal(new ApiError(403, "UNRECOGNISED", "Unknown outcome"))).toBe(false);
 expect(isFinalSessionRefusal(new ApiError(501, "NOT_ON_CODE_YET", "This conversation action isn't connected yet."))).toBe(true);
});

it("R3: a read-only resolution notifies another mounted request reader in this tab", async () => {
 const f = fakeHost(async () => ({ status: 200, body: meFixture() })), identity = await readSessionIdentity(f.host), scope = sessionScope(identity, SESSION_FIXTURE_ID);
 const request = freezeSessionRequest(f.host, scope, "stop", { requestId: crypto.randomUUID() });
 function Probe() { const saved = useSessionRequest(f.host, identity, SESSION_FIXTURE_ID);return createElement("span", {}, saved.request === undefined ? "Resolved request" : "Pending request"); }
 const ui = renderUi(createElement(Probe));await screen.findByText("Pending request");
 act(() => clearSessionRequest(f.host, scope, request.requestId));
 expect(await screen.findByText("Resolved request")).toBeTruthy();ui.unmount();
});
