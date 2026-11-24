import { describe, expect, it } from "vitest";
import { httpWorld, preview, previewInput, codeResponse } from "../support/server-read-http.js";
const path = "/v1/web/github/disconnect-preview";
describe("local GitHub policy preview through the browser mount", () => {
  it("forwards one strict input as the live caller and keeps real dependency totals unknown", async () => {
    const w = await httpWorld(preview); const r = await w.call(path, "POST", previewInput);
    expect(r.status).toBe(200); expect(r.body).toEqual(preview); expect(r.headers["cache-control"]).toContain("no-store");
    expect(w.calls.map(c => [c.method,c.path])).toEqual([["POST","/v1/dev/company/connections/impact"]]);
    expect(w.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer old" }); const forwarded = w.calls[0]?.init?.body;
    if (typeof forwarded !== "string") throw new Error("missing JSON input");
    expect(JSON.parse(forwarded)).toEqual(previewInput);
  });
  it("refuses bad CSRF before Code is called", async () => {
    const w = await httpWorld(preview); expect((await w.call(path,"POST",previewInput,"bad")).status).toBe(403); expect(w.calls).toHaveLength(0);
  });
  it.each([{}, { ...previewInput, actor: "other" }, { ...previewInput, provider: "slack" }, { ...previewInput, target: { installationId: 0 } }, { ...previewInput, target: { installationId: Number.MAX_SAFE_INTEGER + 1 } }, { ...previewInput, target: { installationId: 7, company: "other" } }])("refuses invalid body %j before forwarding", async body => {
    const w = await httpWorld(preview); expect((await w.call(path,"POST",body)).status).toBe(400); expect(w.calls).toHaveLength(0);
  });
  it("refuses query selectors before forwarding", async () => {
    const w = await httpWorld(preview); expect((await w.call(path+"?company=other","POST",previewInput)).status).toBe(400); expect(w.calls).toHaveLength(0);
  });
  it.each([
    { ...preview, target: { installationId: 8 } }, { ...preview, provider: "slack" }, { ...preview, operation: "delete" }, { ...preview, checkedAt: "bad" }, { ...preview, extra: true },
    { ...preview, disconnectBlockers: { kind: "exact", count: 0, projects: ["payments"] } }, { ...preview, disconnectBlockers: { kind: "exact", count: 2, projects: ["payments","payments"] } },
    { ...preview, disconnectBlockers: { kind: "exact", count: 1, projects: ["unsafe/name"] } }, { ...preview, disconnectBlockers: { kind: "exact", count: 401, projects: Array.from({length:401},(_,i)=>`p${String(i)}`) } },
    { ...preview, runningTasks: { kind: "exact", count: 0 } }, { ...preview, target: { installationId: 7, account: "extra" } },
  ])("rejects invalid/ambiguous success %j", async body => {
    const w = await httpWorld(body); expect((await w.call(path,"POST",previewInput)).status).toBe(502);
  });
  it.each(["read_bound", "read_unavailable"])("retains unknown %s without a partial list", async reason => {
    const body = { ...preview, disconnectBlockers: { kind: "unknown", reason } }; const w = await httpWorld(body);
    expect((await w.call(path,"POST",previewInput)).body).toEqual(body);
  });
  it.each([[404,"NOT_FOUND","route not found",503],[404,"NOT_FOUND","That GitHub connection was not found.",404],[405,"NOT_FOUND","old",503],[501,"NOT_ON_CODE_YET","old",503],[403,"FORBIDDEN","Only a company owner can disconnect GitHub.",403],[202,"ignored","ignored",502]])("maps %i %s without leaking failures", async(status,code,message,want)=>{
    const w = await httpWorld(Number(status) === 202 ? preview : {error:{code,message}},Number(status)); expect((await w.call(path,"POST",previewInput)).status).toBe(want);
  });
  it.each([
    ["extra envelope fields on a known 404", 404, { error: { code: "NOT_FOUND", message: "That GitHub connection was not found.", reason: "gone", writes: "none", future: { a: 1 } }, extra: true }, 404, "NOT_FOUND"],
    ["extra envelope fields on a known 403", 403, { error: { code: "FORBIDDEN", message: "Only a company owner can disconnect GitHub.", reason: "x" } }, 403, "FORBIDDEN"],
    ["unknown code on 404 falls back", 404, { error: { code: "SOME_FUTURE_CODE", message: "That GitHub connection was not found.", reason: "r" } }, 503, "RUNTIME_UNAVAILABLE"],
    ["unknown code on 403 keeps the status mapping", 403, { error: { code: "SOME_FUTURE_CODE", message: "private backend text", writes: "done" } }, 403, "FORBIDDEN"],
    ["unknown code on 429 keeps the status mapping", 429, { error: { code: "SOME_FUTURE_CODE", message: "private backend text" } }, 429, "RATE_LIMITED"],
  ])("tolerates a newer Code envelope: %s", async (_name, status, body, wantStatus, wantCode) => {
    const w = await httpWorld(body, status); const r = await w.call(path,"POST",previewInput);
    expect(r.status).toBe(wantStatus); expect(r.body).toMatchObject({ error: { code: wantCode } });
    expect(JSON.stringify(r.body)).not.toContain("private backend text"); expect(JSON.stringify(r.body)).not.toContain("future");
  });
  it("never resends the preview POST after a 401 refresh", async () => {
    const w = await httpWorld(preview,200, async input => new URL(input instanceof Request ? input.url : input).pathname === "/v1/auth/token" ? codeResponse(200,{access_token:"fresh",refresh_token:"refresh-fresh"}) : codeResponse(401,{}));
    expect((await w.call(path,"POST",previewInput)).status).toBe(503);
    expect(w.calls.map(c=>c.path)).toEqual(["/v1/dev/company/connections/impact","/v1/auth/token"]);
  });
});


it("rejects an unexpected requestId instead of stripping it from the strict preview", async () => {
  const w = await httpWorld({ ...preview, requestId: "unexpected" });
  expect((await w.call(path, "POST", previewInput)).status).toBe(502);
});
it("refuses HTTP redirects before the transport can replay a preview POST", async () => {
  let replayed = 0;
  const w = await httpWorld(preview, 200, async (_input, init) => {
    if (init?.redirect !== "error") { replayed += 1; return codeResponse(200, preview); }
    throw new TypeError("redirect refused");
  });
  expect((await w.call(path, "POST", previewInput)).status).toBe(503);
  expect(replayed).toBe(0);
});
