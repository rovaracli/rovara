import { describe, expect, it, vi } from "vitest";
// The built @agentx/ui package imports its stylesheets, which vitest cannot resolve from dist; the host only needs these names, so they come from the source.
vi.mock("@agentx/ui", async () => ({ ApiError: (await import("../../packages/ui/src/api/errors.js")).ApiError, createApiClient: (await import("../../packages/ui/src/api/client.js")).createApiClient, SIGN_IN_REPEAT_GUARD_MS: (await import("../../packages/ui/src/constants.js")).SIGN_IN_REPEAT_GUARD_MS, COMPANY_HEADER: (await import("../../packages/ui/src/api/company-context.js")).COMPANY_HEADER, pageCompany: (await import("../../packages/ui/src/api/company-context.js")).pageCompany, withCompanyHeader: (await import("../../packages/ui/src/api/company-context.js")).withCompanyHeader, reloadIntoActiveCompany: (await import("../../packages/ui/src/api/company-context.js")).reloadIntoActiveCompany, isCompanySwitcherOn: (await import("../../packages/ui/src/company-flags.js")).isCompanySwitcherOn }));
import { createBrowserHost, type BrowserWindow } from "../../packages/web/src/browser-host.js";
const B = "org_" + "b".repeat(20);
describe("the browser host", () => {
 const win = (headers: Record<string, string>, local = new Map<string, string>()) => ({ location: { origin: "https://cell.example", pathname: "/app", search: "", assign: () => undefined }, fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...headers } }), localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => { local.set(key, value); }, removeItem: (key: string) => { local.delete(key); }, key: (index: number) => [...local.keys()][index] ?? null, get length() { return local.size; } }, sessionStorage: { getItem: () => null, setItem: () => undefined } }) as unknown as BrowserWindow;
 it("hands the echoed company header to the client, and nothing when the server sent none", async () => {
  expect(await createBrowserHost(win({ "x-rovara-company": B })).transport.request({ method: "GET", path: "/v1/app/home" })).toMatchObject({ status: 200, company: B });
  expect(await createBrowserHost(win({})).transport.request({ method: "GET", path: "/v1/app/home" })).not.toHaveProperty("company");
 });
 it("names the page's company on every request once the device switch is on, the sign-in refresh included, and not at all while it is off", async () => {
  const A = "org_" + "a".repeat(20), seen: Array<{ path: string; company: string | null }> = [];
  const make = (on: boolean) => {
   const local = new Map<string, string>(on ? [["rovara.companies", "v2"]] : []);
   const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;seen.push({ path, company: new Headers(init?.headers).get("x-rovara-company") });
    const body = path === "/v1/web/companies" ? { activeCompanyId: A, companies: [] } : path === "/v1/web/me" ? { developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: A, name: "Acme", plan: "team" }, identities: [], csrf: "c".repeat(43) } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
   };
   return createBrowserHost({ ...win({}, local), fetch });
  };
  const on = make(true);await on.transport.request({ method: "GET", path: "/v1/app/home" });await on.transport.request({ method: "POST", path: "/v1/app/home/cards/x/dismiss", body: { requestId: "r" } });
  expect(seen.map(entry => entry.path)).toEqual(["/v1/web/companies", "/v1/web/home", "/v1/web/me", "/v1/web/home/cards/x/dismiss"]);
  // The companies read is the one request that cannot say; everything after it does, including the csrf refresh the first write needs.
  expect(seen.map(entry => entry.company)).toEqual([null, A, A, A]);
  seen.length = 0;const off = make(false);await off.transport.request({ method: "GET", path: "/v1/app/home" });
  expect(seen).toEqual([{ path: "/v1/web/home", company: null }]);
 });
 it("lists and removes its storage keys, so a switch can clear per-company drafts", () => {
  const local = new Map([["a", "1"], ["b", "2"]]), host = createBrowserHost(win({}, local));
  expect(host.storage.keys?.()).toEqual(["a", "b"]);host.storage.remove?.("a");expect(host.storage.keys?.()).toEqual(["b"]);
 });
 it("copes with a window whose storage cannot list or remove", () => {
  const plain = { location: { origin: "https://cell.example", pathname: "/app", search: "", assign: () => undefined }, fetch: async () => new Response("{}"), localStorage: { getItem: () => null, setItem: () => undefined }, sessionStorage: { getItem: () => null, setItem: () => undefined } } as unknown as BrowserWindow;
  const host = createBrowserHost(plain);expect(host.storage.keys?.()).toEqual([]);expect(() => host.storage.remove?.("a")).not.toThrow();
 });
});
