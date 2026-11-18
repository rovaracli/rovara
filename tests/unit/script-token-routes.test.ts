import { expect, it, vi } from "vitest";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { token, secret } from "../web/support/script-token-fixture.js";

const now = Date.UTC(2026, 10, 17, 18);
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const body = { requestId, name: "Nightly CI", projects: ["web"], permissions: ["read"], days: 30 };
function setup(method = "GET", path = "/script-tokens", reply: unknown = { tokens: [token] }, fresh = true, input: unknown = body) {
 const json = vi.fn(async () => { if (reply instanceof Error) throw reply; return reply; });
 const route = ROUTES.find(row => row.method === method && row.path.test(path));
 const ctx = {
  client: { json }, session: { accessToken: fresh ? `e30.${Buffer.from(JSON.stringify({ step_up_at: now / 1000 - 20, step_up_amr: "passkey" })).toString("base64url")}.sig` : "none", access: { developerId: "person", company: { companyId: "org", role: "member" } } },
  now: () => new Date(now), body: input, params: route?.path.exec(path)?.slice(1) ?? [], query: new URLSearchParams(),
 } as unknown as RouteContext;
 return { json, answer: async () => { expect(route, `${method} ${path}`).toBeDefined(); return route!.answer(ctx); } };
}

it("registers metadata-only list at the Code app route, retaining wiki and canCreate but dropping secrets", async () => {
 const f = setup("GET", "/script-tokens", { tokens: [{ ...token, secret }], secret, canCreate: true });
 expect(await f.answer()).toEqual({ status: 200, body: { tokens: [token], canCreate: true } });
 expect(f.json).toHaveBeenCalledWith(expect.anything(), "/v1/app/script-tokens", expect.anything());
});
it.each([false, undefined])("preserves a false or absent canCreate signal (%s)", async canCreate => {
 const fields = canCreate === undefined ? {} : { canCreate };
 const f = setup("GET", "/script-tokens", { tokens: [token], ...fields });
 expect(await f.answer()).toEqual({ status: 200, body: { tokens: [token], ...fields } });
});
it.each(["true", 1, null])("refuses a non-boolean canCreate signal (%s)", async canCreate => {
 expect(await setup("GET", "/script-tokens", { tokens: [token], canCreate }).answer()).toMatchObject({ status: 502 });
});
it("requires fresh session step-up before forwarding create", async () => {
 const f = setup("POST", "/script-tokens", { token, secret }, false);
 expect(await f.answer()).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED" } } });
 expect(f.json).not.toHaveBeenCalled();
});
it("returns create secret only in its 201 and never in a later list", async () => {
 const f = setup("POST", "/script-tokens", { token, secret, extra: secret });
 expect(await f.answer()).toEqual({ status: 201, body: { token, secret } });
 expect(f.json).toHaveBeenCalledWith(expect.anything(), "/v1/app/script-tokens", { method: "POST", body });
 expect(JSON.stringify(await setup().answer())).not.toContain(secret);
});
it.each([
 { ...body, unexpected: secret }, { ...body, permissions: ["admin"] }, { ...body, projects: [] }, { ...body, projects: ["web", "web"] },
 { ...body, name: "\n" }, { ...body, days: 91 }, { ...body, requestId: "bad" }, { ...body, permissions: ["read", "read"] },
])("rejects malformed create bodies before asking Code (%j)", async input => {
 const f = setup("POST", "/script-tokens", {}, true, input);
 expect(await f.answer()).toMatchObject({ status: 400 }); expect(f.json).not.toHaveBeenCalled();
});
it("forwards confirmed revoke with no browser body and metadata-only answer", async () => {
 const f = setup("POST", "/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", { token: { ...token, status: "revoked" }, secret }, false, {});
 expect(await f.answer()).toEqual({ status: 200, body: { token: { ...token, status: "revoked" } } });
 expect(f.json).toHaveBeenCalledWith(expect.anything(), "/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", { method: "POST" });
});
it.each([
 [501, "NOT_AVAILABLE_HERE", "anything", 501, "Automation keys are not available yet."],
 [404, "NOT_FOUND", "route not found", 501, "Automation keys are not available yet."],
 [403, "FORBIDDEN", secret, 403, "You can't manage these automation keys."],
 [403, "REAUTH_REQUIRED", secret, 403, "Confirm it's you again, then try once more."],
 [500, "INTERNAL", secret, 503, "Couldn't finish that automation key request. Try again."],
])("replaces Code refusal %s/%s with fixed words", async (status, code, message, expected, words) => {
 const f = setup("GET", "/script-tokens", new CodeError(status, { error: { code, message } }));
 expect(await f.answer()).toEqual({ status: expected, body: { error: { code: expected === 501 ? "NOT_ON_CODE_YET" : code === "INTERNAL" ? "RUNTIME_UNAVAILABLE" : code, message: words } } });
});
it("refuses malformed successful answers with fixed words and never echoes a secret", async () => {
 const f = setup("POST", "/script-tokens", { token, secret: "bad" });
 expect(await f.answer()).toMatchObject({ status: 502 });
 const list = setup("GET", "/script-tokens", { tokens: [{ ...token, tokenId: secret }] });
 expect(await list.answer()).toMatchObject({ status: 502 });
});
