import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST, TIME, confirmed, httpWorld, clientFor, usingSession, codeResponse } from "../support/server-read-http.js";
import { SERVER_READ_CALL_MS, SERVER_READ_MAX_BYTES } from "../../packages/cloud-server/src/code-client.js";
const path = `/v1/web/task-start-requests/${REQUEST}`;
afterEach(() => vi.useRealTimers());
describe("original start Cloud reader through the real client and browser mount", () => {
  it.each([confirmed, { requestId: REQUEST, operation: "start", checkedAt: TIME, outcome: "unknown" }])("preserves the original domain ID and strict acceptance %j", async body => {
    const w = await httpWorld(body); const r = await w.call(path);
    expect(r.status).toBe(200); expect(r.body).toEqual(body); expect(r.headers["cache-control"]).toContain("no-store");
    expect(w.calls.map(c => [c.method, c.path])).toEqual([["GET", `/v1/dev/tasks/start-requests/${REQUEST}`]]);
    expect(w.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer old" });
    expect(w.calls[0]?.init?.body).toBeUndefined();
  });
  it("keeps stripping trace IDs on unrelated DEV calls", async () => {
    const client = clientFor(async () => codeResponse(200, { value: true, requestId: "trace" }));
    expect(await client.json(usingSession(), "/v1/dev/other")).toEqual({ value: true });
  });
  it.each(["bad", `%31${REQUEST.slice(1)}`, REQUEST + "/extra", ""])('rejects raw alias/invalid segment %s before decoding or forwarding', async id => {
    const w = await httpWorld(confirmed); expect((await w.call(`/v1/web/task-start-requests/${id}`)).status).toBe(400); expect(w.calls).toHaveLength(0);
  });
  it.each(["query", "body"])('rejects %s selectors without contacting Code', async kind => {
    const w = await httpWorld(confirmed); expect((await w.call(path + (kind === "query" ? "?actor=other" : ""), "GET", kind === "body" ? {} : undefined)).status).toBe(400); expect(w.calls).toHaveLength(0);
  });
  it.each([
    { ...confirmed, requestId: "33333333-3333-4333-8333-333333333333" }, { ...confirmed, checkedAt: "yesterday" }, { ...confirmed, session: "invented" },
    { ...confirmed, task: { ...confirmed.task, prompt: "private" } }, { ...confirmed, outcome: "refused" }, { ...confirmed, task: { ...confirmed.task, project: "unsafe/name" } },
  ])("rejects invalid success without reconstructing facts %j", async body => {
    const w = await httpWorld(body); expect(await w.call(path)).toMatchObject({ status: 502, body: { error: { code: "INVALID_RESPONSE", message: "Start status is unavailable." } } });
  });
  it.each([202, 201])("rejects unexpected success status %i even with a valid body", async status => {
    const w = await httpWorld(confirmed, status); expect((await w.call(path)).status).toBe(502);
  });
  it.each([[404,"NOT_FOUND","route not found",503],[404,"TASK_NOT_FOUND","That task is unavailable.",404],[404,"TASK_NOT_FOUND","private backend text",503],[405,"NOT_FOUND","old",503],[501,"NOT_ON_CODE_YET","old",503],[500,"INTERNAL","private backend text",503],[429,"RATE_LIMITED","private backend text",429],[403,"FORBIDDEN","private backend text",403]])("maps safe failure %i %s", async (status, code, message, want) => {
    const w = await httpWorld({ error: { code, message } }, Number(status)); const r = await w.call(path);
    expect(r.status).toBe(want); expect(JSON.stringify(r.body)).not.toContain("private backend text"); expect(w.calls).toHaveLength(1);
  });
  it("refreshes only the GET, with the same original ID", async () => {
    const w = await httpWorld(confirmed, 200, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/v1/auth/token") return codeResponse(200, { access_token: "fresh", refresh_token: "refresh-fresh" });
      return (init?.headers as Record<string,string>).authorization === "Bearer old" ? codeResponse(401, {}) : codeResponse(200, confirmed);
    });
    expect((await w.call(path)).body).toEqual(confirmed);
    expect(w.calls.map(c => c.path)).toEqual([`/v1/dev/tasks/start-requests/${REQUEST}`, "/v1/auth/token", `/v1/dev/tasks/start-requests/${REQUEST}`]);
  });
  it.each(["fetch", "body", "refresh", "oversize", "error-body"])("bounds %s using the same request deadline and streamed byte ceiling", async kind => {
    vi.useFakeTimers();
    const client = clientFor(async input => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (kind === "fetch" || (kind === "refresh" && url.pathname === "/v1/auth/token")) return new Promise<Response>(() => undefined);
      if (kind === "refresh") return codeResponse(401, {});
      if (kind === "oversize") return codeResponse(200, { data: "x".repeat(300) });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), { status: kind === "error-body" ? 503 : 200 });
    });
    const result = client.json(usingSession(), `/v1/dev/tasks/start-requests/${REQUEST}`, { expectedStatus: 200, boundedRead: { deadlineMs: 100, maxBytes: 256 } });
    const failure = expect(result).rejects.toThrow(); await vi.advanceTimersByTimeAsync(101); await failure;
  });
});


it("keeps the original deadline when the handler recovers a concurrently refreshed session", async () => {
  vi.useFakeTimers(); let sends = 0;
  const w = await httpWorld(confirmed, 200, async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/v1/auth/token") {
      // A different server acquired the expired lease and kept its rotated tokens.
      await w.store.delete("cookie");
      await w.store.create("cookie", { ...usingSession(), accessToken: "parallel", refreshToken: "parallel-refresh" });
      return codeResponse(400, { error: "invalid_grant" });
    }
    sends += 1;
    if (sends === 1) { await new Promise(resolve => setTimeout(resolve, 20_000)); return codeResponse(401, {}); }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
  });
  let status: number | undefined;
  const pending = w.call(path).then(result => { status = result.status; });
  try {
    await vi.advanceTimersByTimeAsync(25_001);
    expect(status).toBe(503);
    expect(sends).toBe(2);
  } finally { await vi.advanceTimersByTimeAsync(30_000); await pending; }
}, 3_000);

it("pins the shared non-merge server-read limits", () => {
  expect(SERVER_READ_CALL_MS).toBe(25_000);
  expect(SERVER_READ_MAX_BYTES).toBe(262_144);
});
