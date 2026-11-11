import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createBrowserHost, type BrowserWindow } from "../../packages/web/src/browser-host.js";
import { fakeHost } from "./support/fake-host.js";
const ORIGIN = "https://cell.example", CSRF = "c".repeat(43);
const me = (csrf = CSRF) => ({ developer: { id: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [], csrf });
const empty = { cards: [], total: 0 };
function browser(implementation: (input: string, init: RequestInit | undefined) => Promise<Response>) {
 const local = new Map<string, string>(), session = new Map<string, string>();
 const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => implementation(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)), assign = vi.fn();
 const win = { location: { origin: ORIGIN, pathname: "/app/live", search: "", assign }, fetch,
  localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => { local.set(key, value); } },
  sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); } },
 } as unknown as BrowserWindow;
 return { win, fetch, assign, local, session };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });
describe("browser host and shared API client", () => {
 it("maps only app paths to same-origin cookie requests and keeps credentials in memory", async () => {
  const b = browser(async (path) => json(path.endsWith("/me") ? me() : empty));const host = createBrowserHost(b.win);
  expect(await createApiClient(host).get("/v1/app/home", HomeResponseReaderSchema)).toEqual(empty);
  expect(b.fetch.mock.calls[0]![0]).toBe("/v1/web/home");expect(b.fetch.mock.calls[0]![1]?.credentials).toBe("same-origin");expect(b.fetch.mock.calls[0]![1]?.redirect).toBe("error");
  await host.transport.request({ method: "GET", path: "/v1/app/me" });
  await host.transport.request({ method: "POST", path: "/v1/app/home/cards/fixture/dismiss", body: { requestId: "fixture-request" } });
  const write = b.fetch.mock.calls.at(-1)![1]!;expect(new Headers(write.headers).get("x-rovara-csrf")).toBe(CSRF);expect(new Headers(write.headers).has("authorization")).toBe(false);expect(b.local.size).toBe(0);expect(b.session.size).toBe(0);
  for (const path of ["https://evil.example/v1/app/home", "/v1/app/../admin", "/v1/app/a%2fb", "/v1/app//home"]) await expect(host.transport.request({ method: "GET", path })).rejects.toThrow();
  expect(b.fetch).toHaveBeenCalledTimes(3);
 });
 it("recovers stale CSRF once and replays the same request body and id", async () => {
  let reads = 0, writes = 0;const b = browser(async path => path.endsWith("/me") ? json(me(++reads === 1 ? CSRF : "n".repeat(43))) : json(++writes === 1 ? { error: { code: "CSRF_STALE", message: "Your sign-in changed in another tab. Trying again." } } : empty, writes === 1 ? 403 : 200));
  const host = createBrowserHost(b.win);await host.transport.request({ method: "GET", path: "/v1/app/me" });
  const response = await host.transport.request({ method: "POST", path: "/v1/app/home/cards/fixture/dismiss", body: { requestId: "same-request", value: "unchanged" } });expect(response.status).toBe(200);
  expect(reads).toBe(2);const posts = b.fetch.mock.calls.filter(([, init]) => init?.method === "POST");expect(posts).toHaveLength(2);expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);expect(new Headers(posts[1]![1]!.headers).get("x-rovara-csrf")).toBe("n".repeat(43));
 });
 it("surfaces a second stale-CSRF refusal without looping", async () => {
  const b = browser(async path => path.endsWith("/me") ? json(me()) : json({ error: { code: "CSRF_STALE", message: "Your sign-in changed in another tab. Trying again." } }, 403));
  const host = createBrowserHost(b.win);await host.transport.request({ method: "GET", path: "/v1/app/me" });
  await expect(createApiClient(host).send("POST", "/v1/app/home/cards/fixture/dismiss", { requestId: "same" }, HomeResponseReaderSchema)).rejects.toMatchObject({ code: "CSRF_STALE", status: 403 });expect(b.fetch).toHaveBeenCalledTimes(4);
 });
 it("keeps deliberate sign-in available after the automatic repeat guard", () => {
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));const b = browser(async () => json(empty));
  createBrowserHost(b.win).signIn("/app/live", { automatic: true });expect(b.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp%2Flive");
  createBrowserHost(b.win).signIn("/app/live", { automatic: true });expect(b.assign.mock.lastCall?.[0]).toBe("/app/signed-out?reason=failed");
  createBrowserHost(b.win).signIn("/app/live");expect(b.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp%2Flive");
  vi.advanceTimersByTime(60_000);createBrowserHost(b.win).signIn("/app/live", { automatic: true });expect(b.assign.mock.lastCall?.[0]).toBe("/v1/auth/browser/authorize?return_to=%2Fapp%2Flive");
 });
 it("redirects only once for parallel authentication refusals", async () => {
  const f = fakeHost(async () => ({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } } }));const client = createApiClient(f.host);
  await Promise.allSettled([client.get("/v1/app/home", HomeResponseReaderSchema), client.get("/v1/app/home", HomeResponseReaderSchema)]);expect(f.host.signIn).toHaveBeenCalledTimes(1);expect(f.host.signIn).toHaveBeenCalledWith("/app/live", { automatic: true });
 });
 it("separates confirmation and admin approval from an applied response, dropping unsafe links", async () => {
  const url = ORIGIN + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
  for (const status of ["NEEDS_CONFIRMATION", "NEEDS_OWNER_APPROVAL"]) {
   const f = fakeHost(async () => ({ status: 202, body: { status, confirmUrl: url, changes: ["A permission changes"] } }));expect(await createApiClient(f.host).send("PATCH", "/v1/app/agents/fixture", { requestId: "same" }, HomeResponseReaderSchema)).toEqual({ kind: "needs_confirmation", confirmUrl: url, changes: ["A permission changes"] });
  }
  for (const confirmUrl of ["https://evil.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", url + "?ticket=fixture", "javascript:alert(1)"]) {
   const f = fakeHost(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] } }));const result = await createApiClient(f.host).send("PATCH", "/v1/app/agents/fixture", {}, HomeResponseReaderSchema);expect(result.kind).toBe("needs_confirmation");expect("confirmUrl" in result ? result.confirmUrl : undefined).toBeUndefined();
  }
  const f = fakeHost(async () => ({ status: 202, body: { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "An owner must approve this." } }));expect(await createApiClient(f.host).send("PATCH", "/v1/app/agents/fixture", {}, HomeResponseReaderSchema)).toEqual({ kind: "needs_admin_approval", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "An owner must approve this." });
 });
 it("hands back the sole-owner field of a confirmation only when the answer carries it", async () => {
  const url = ORIGIN + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", soleOwner = { available: true, availableAt: "2026-10-30T12:00:00.000Z" };
  const withField = fakeHost(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: url, changes: ["A lock is removed"], soleOwner } }));
  expect(await createApiClient(withField.host).send("PUT", "/v1/app/org/model-selection-policy", {}, HomeResponseReaderSchema)).toEqual({ kind: "needs_confirmation", confirmUrl: url, changes: ["A lock is removed"], soleOwner });
  const without = fakeHost(async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: url, changes: [] } }));
  const result = await createApiClient(without.host).send("PUT", "/v1/app/org/model-selection-policy", {}, HomeResponseReaderSchema);
  expect("soleOwner" in result).toBe(false);
 });
 it("retries a throttled read at one, two and four seconds with one retry owner", async () => {
  vi.useFakeTimers();let calls = 0;const f = fakeHost(async () => ++calls < 4 ? { status: 429, body: { error: { code: "TOO_MANY_REQUESTS", message: "Try again later." } } } : { status: 200, body: empty });
  const pending = createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema);await vi.advanceTimersByTimeAsync(0);expect(calls).toBe(1);
  for (const [delay, count] of [[999, 1], [1, 2], [1999, 2], [1, 3], [3999, 3], [1, 4]]) { await vi.advanceTimersByTimeAsync(delay!);expect(calls).toBe(count); }
  expect(await pending).toEqual(empty);const query = createQueryClient();expect(query.getDefaultOptions().queries?.retry).toBe(false);expect(query.getDefaultOptions().queries?.staleTime).toBe(15000);expect(query.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true);query.clear();
 });
 it("does not retry a write without an id and retries an eligible network write with its original id", async () => {
  const f = fakeHost(async () => ({ status: 429, body: { error: { code: "TOO_MANY_REQUESTS", message: "Try later." } } }));await expect(createApiClient(f.host).send("POST", "/v1/app/agents", {}, HomeResponseReaderSchema)).rejects.toMatchObject({ status: 429 });expect(f.request).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();let calls = 0;const retry = fakeHost(async () => { if (++calls === 1) throw new Error("private upstream detail");return { status: 200, body: empty }; });const pending = createApiClient(retry.host).send("POST", "/v1/app/agents", { requestId: "original" }, HomeResponseReaderSchema);await vi.advanceTimersByTimeAsync(1000);expect(await pending).toEqual({ kind: "done", value: empty });expect(retry.request.mock.calls.map(([input]) => input.body)).toEqual([{ requestId: "original" }, { requestId: "original" }]);
 });
 it("keeps unknown enums and added fields through the shared reader", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { cards: [{ cardId: "offer:future", kind: "future-kind", reason: "A newer source.", buttons: [], title: "Still readable", at: "2026-10-23T12:00:00Z", future: true }], total: 1, newField: true } }));const value = await createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema);expect(value.cards[0]!.kind).toBe("unknown");expect(value.cards[0]!.future).toBe(true);expect(value.newField).toBe(true);
 });
 it("returns fixed network errors rather than upstream details", async () => {
  const f = fakeHost(async () => { throw new Error("private upstream detail"); });const error = await createApiClient(f.host).send("POST", "/v1/app/agents", {}, HomeResponseReaderSchema).catch((value: unknown) => value);expect(error).toBeInstanceOf(ApiError);expect(String(error)).not.toContain("private upstream detail");
 });
});

it("shares the sign-in guard across clients and preserves terminal host authentication errors", async () => {
 const f = fakeHost(async () => { throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue."); });
 await Promise.allSettled([createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema), createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema)]);
 expect(f.request).toHaveBeenCalledTimes(2);expect(f.host.signIn).toHaveBeenCalledTimes(1);
});
it("refuses an unrecognized pending status even when it resembles admin approval", async () => {
 const f = fakeHost(async () => ({ status: 202, body: { status: "FUTURE_APPROVAL", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "Still pending" } }));
 await expect(createApiClient(f.host).send("POST", "/v1/app/agents", {}, HomeResponseReaderSchema)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it("retries server failures twice for reads and never retries a server-refused write", async () => {
 vi.useFakeTimers();const f = fakeHost(async () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "Try later." } } }));
 const result = createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema).catch((error: unknown) => error);
 await vi.advanceTimersByTimeAsync(0);expect(f.request).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1000);expect(f.request).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(2000);expect(f.request).toHaveBeenCalledTimes(3);expect(await result).toMatchObject({ status: 503 });
 const write = fakeHost(async () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "Try later." } } }));
 const refused = createApiClient(write.host).send("POST", "/v1/app/agents", { requestId: "same" }, HomeResponseReaderSchema).catch((error: unknown) => error);
 await vi.advanceTimersByTimeAsync(4000);expect(write.request).toHaveBeenCalledTimes(1);expect(await refused).toMatchObject({ status: 503 });
});
it("adds up to thirty percent jitter to a retry delay", async () => {
 vi.useFakeTimers();vi.mocked(Math.random).mockReturnValue(1);let count = 0;
 const f = fakeHost(async () => ++count === 1 ? { status: 429, body: {} } : { status: 200, body: empty });
 const pending = createApiClient(f.host).get("/v1/app/home", HomeResponseReaderSchema);
 await vi.advanceTimersByTimeAsync(1299);expect(f.request).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(f.request).toHaveBeenCalledTimes(2);expect(await pending).toEqual(empty);
});

it("finishes sign-out when refreshing an ended session returns 401", async () => {
 const b = browser(async () => json({ error: { code: "AUTH_REQUIRED" } }, 401));
 await expect(createBrowserHost(b.win).signOut()).resolves.toBeUndefined();
 expect(b.assign).toHaveBeenCalledExactlyOnceWith("/app/signed-out?reason=ended");
 expect(b.fetch).toHaveBeenCalledTimes(1);
 expect(b.fetch.mock.calls[0]![0]).toBe("/v1/web/me");
});
it("still requires the live session CSRF token and a successful sign-out response", async () => {
 for (const status of [204, 403]) {
  const b = browser(async path => path.endsWith("/me") ? json(me()) : status === 204 ? new Response(null, { status }) : json({}, status));
  const result = createBrowserHost(b.win).signOut();
  if (status === 204) { await result;expect(b.assign).toHaveBeenCalledExactlyOnceWith("/app/signed-out?reason=ended"); }
  else { await expect(result).rejects.toMatchObject({ code: "SIGN_OUT_FAILED" });expect(b.assign).not.toHaveBeenCalled(); }
  expect(b.fetch.mock.calls.at(-1)![0]).toBe("/v1/auth/browser/sign-out");
  expect(new Headers(b.fetch.mock.calls.at(-1)![1]!.headers).get("x-rovara-csrf")).toBe(CSRF);
 }
});
it("does not claim signed out when refresh fails for another reason", async () => {
 for (const failure of ["server", "network"]) {
  const b = browser(async () => { if (failure === "network") throw new TypeError("network unavailable");return json({}, 503); });
  await expect(createBrowserHost(b.win).signOut()).rejects.toThrow();
  expect(b.assign).not.toHaveBeenCalled();
 }
});
it("navigates only app paths or the validated GitHub installation handoff",()=>{
 const b=browser(async()=>json(empty)),host=createBrowserHost(b.win),url="https://github.com/apps/rovara/installations/new?state="+"a".repeat(43);
 host.navigate(url);expect(b.assign).toHaveBeenCalledWith(url);
 for(const bad of ["https://evil.example/apps/rovara/installations/new","https://github.com.evil.example/apps/rovara/installations/new","https://github.com/acme/repo","https://github.com/apps/rovara/installations/new?redirect_uri=https://evil.example","https://github.com/apps/rovara/installations/new?next=valid","https://user@github.com/apps/rovara/installations/new","https://github.com/apps/rovara/installations/new#secret"]){expect(()=>host.navigate(bad)).toThrow("Invalid app destination.");}
});
// UX1 (24c5b71dd) added the GitHub account-link hand-off (method=github): it is a second allowed same-tab address, so it is no longer in the refused list; tests/web/ux1-first-day.test.ts covers it.
it("navigates in the same tab to the sign-in server's Slack or GitHub link only, never to another address",()=>{
 const b=browser(async()=>json(empty)),host=createBrowserHost(b.win),request="r".repeat(43),good=ORIGIN+"/v1/auth/authorize?request="+request+"&method=slack";
 host.navigate(good);expect(b.assign).toHaveBeenCalledWith(good);
 const github=ORIGIN+"/v1/auth/authorize?request="+request+"&method=github";host.navigate(github);expect(b.assign).toHaveBeenLastCalledWith(github);
 for(const bad of ["https://evil.example/v1/auth/authorize?request="+request+"&method=slack","https://evil.example/v1/auth/authorize?request="+request+"&method=github",ORIGIN+"/v1/auth/authorize?request="+request+"&method=gitlab",ORIGIN+"/v1/auth/authorize?request="+request+"&method=slack&return=x",ORIGIN+"/v1/auth/callback/slack?request="+request+"&method=slack",good+"#x"]){expect(()=>host.navigate(bad)).toThrow("Invalid app destination.");}
 expect(b.assign).toHaveBeenCalledTimes(2);
});
it("copies a private link only on explicit host bridge invocation without persisting or navigating",async()=>{const b=browser(async()=>json(empty));let copied="";const clipboard={async writeText(value:string){if(this!==clipboard)throw new Error("unbound clipboard");copied=value;}};Object.assign(b.win,{navigator:{clipboard}});const host=createBrowserHost(b.win);expect(copied).toBe("");await host.copyText?.("test-only private link");expect(copied==="test-only private link").toBe(true);expect(b.fetch.mock.calls.length).toBe(0);expect(b.assign.mock.calls.length).toBe(0);expect(b.local.size+b.session.size).toBe(0);});
it("fails copying closed with fixed text when the browser clipboard is unavailable",async()=>{const b=browser(async()=>json(empty)),host=createBrowserHost(b.win);let failed=false;try{await host.copyText?.("test-only private link");}catch(e){failed=e instanceof Error&&!e.message.includes("test-only private link");}expect(failed).toBe(true);expect(b.local.size+b.session.size).toBe(0);});

for(const failure of ["network","throttled"])it(`does not automatically retry an explicit never-retry ${failure} write`,async()=>{vi.useFakeTimers();const f=fakeHost(async()=>{if(failure==="network")throw new Error("private transport detail");return {status:429,body:{error:{code:"TOO_MANY_REQUESTS",message:"private throttle detail"}}};});const result=createApiClient(f.host).send("POST","/v1/app/projects/payments/reviewed-archive",{requestId:"retained-id"},HomeResponseReaderSchema,{retry:"never"}).catch((error:unknown)=>error);await vi.advanceTimersByTimeAsync(10000);expect(f.request).toHaveBeenCalledTimes(1);expect(await result).toMatchObject({status:failure==="network"?0:429});});
it("never-retry writes do not automatically replay on stale CSRF and do not send retry metadata",async()=>{const b=browser(async path=>path.endsWith("/me")?json(me()):json({error:{code:"CSRF_STALE",message:"private stale detail"}},403));const host=createBrowserHost(b.win);await expect(createApiClient(host).send("POST","/v1/app/projects/payments/reviewed-archive",{requestId:"retained-id"},HomeResponseReaderSchema,{retry:"never"})).rejects.toMatchObject({code:"CSRF_STALE"});const posts=b.fetch.mock.calls.filter(([,init])=>init?.method==="POST");expect(posts).toHaveLength(1);expect(new Headers(posts[0]![1]?.headers).has("retry")).toBe(false);expect(posts[0]![1]?.body).toBe(JSON.stringify({requestId:"retained-id"}));});

for(const failure of ["network","429","503"])it(`never retries an explicitly bounded GET after ${failure}`,async()=>{vi.useFakeTimers();const f=fakeHost(async()=>{if(failure==="network")throw new Error("private");return{status:Number(failure),body:{error:{code:"RUNTIME_UNAVAILABLE",message:"private"}}};});const pending=createApiClient(f.host).get("/v1/app/projects/payments/working-branches",HomeResponseReaderSchema,undefined,{retry:"never"}).catch((error:unknown)=>error);await vi.advanceTimersByTimeAsync(10000);expect(f.request).toHaveBeenCalledTimes(1);expect(await pending).toBeInstanceOf(ApiError);});
