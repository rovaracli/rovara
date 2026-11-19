import { logResponseShapeFailure } from "../../ui/src/api/response-shape.js";
import { AppMeResponseReaderSchema, INVITE_LINK_TOKEN, RealtimeTokenResponseReaderSchema, SessionIdSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse, AppHost, RealtimeSocket } from "@agentx/ui";
import { ApiError, createApiClient, SIGN_IN_REPEAT_GUARD_MS } from "@agentx/ui";
import { safeExternalUrl, isGithubAuthorizeUrl, isGithubInstallationUrl, isLinearAuthorizeUrl, isSlackAuthorizeUrl } from "../../ui/src/text/links.js";
export interface BrowserWindow {
 // Lane A: optional on hosts without clipboard support; never falls back to storage.
 navigator?: Pick<Navigator, "clipboard">;
 innerWidth?: number;
 addEventListener?: (type: "resize", listener: () => void) => void;
 removeEventListener?: (type: "resize", listener: () => void) => void;
 location: Pick<Location, "origin" | "pathname" | "search" | "assign"> & Partial<Pick<Location, "hash">>;
 /** The join page drops the invite link's token from the address once read (DEC 253z). Optional: a host without it keeps the address. */
 history?: Pick<History, "replaceState">;
 fetch: typeof fetch;localStorage: Pick<Storage, "getItem" | "setItem">;sessionStorage: Pick<Storage, "getItem" | "setItem">;
 document: Pick<Document, "createElement" | "body" | "title">;URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;WebSocket: typeof WebSocket;
 open(url: string, target: string, features: string): unknown;
}
function apiPath(path: string): string {
 const pathname = path.split("?", 1)[0]!;
 if (!pathname.startsWith("/v1/app/") || /[\p{Cc}\p{Cf}\\#]/u.test(path) || /%2e|%2f|%5c/i.test(pathname) || pathname.includes("//") || pathname.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid app request path.");
 return "/v1/web/" + path.slice("/v1/app/".length);
}
function returnPath(value: string): string {
 const path = value.split("#", 1)[0]!;
 if (path.startsWith("/s/") && SessionIdSchema.safeParse(path.slice(3)).success) return path;
 if (path.startsWith("/t/") && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(path.slice(3))) return path;
 return /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/.test(path) && !path.includes("..") && !path.includes("//") && !/%2e|%2f|%5c/i.test(path) && !path.split("?", 1)[0]!.split("/").includes(".") ? path : "/app";
}
/**
 * Behind CloudFront, Cloud's function URL takes only requests CloudFront signed for it (origin access control), and Lambda takes no
 * unsigned payload: a write carries its body's SHA-256 (hex) in x-amz-content-sha256, which CloudFront passes on and signs. Elsewhere
 * the header is unused. Without Web Crypto (a page outside a secure context) it is left out.
 */
export const PAYLOAD_HASH_HEADER = "x-amz-content-sha256";
export async function payloadHash(body: string | undefined): Promise<string | undefined> {
 const subtle = globalThis.crypto?.subtle;
 if (subtle === undefined) return undefined;
 const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(body ?? "")));
 return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** DEC 253z: a person with no company yet gets /me's refusal with the sign-in's CSRF value, for the onboarding pages' one change. */
function noCompanyCsrf(response: ApiResponse): string | undefined {
 const body = response.body as { error?: { code?: unknown }; csrf?: unknown } | undefined;
 return response.status === 403 && body?.error?.code === "NO_COMPANY" && typeof body.csrf === "string" && /^[A-Za-z0-9_-]{43}$/u.test(body.csrf) ? body.csrf : undefined;
}
/**
 * L4-SIGNIN: the browser's "last workspace": ONLY a Slack workspace id (a "T", then 6 to 15 capital letters or digits), kept in localStorage so the next Sign in
 * with Slack opens on it. It is a convenience, never read as who someone is: every read and write is guarded, and anything that is not a workspace id is no hint.
 */
export const LAST_WORKSPACE_KEY = "rovara.last-slack-workspace";
const WORKSPACE_ID = /^T[A-Z0-9]{6,15}$/u;
export function createBrowserHost(win: BrowserWindow): AppHost {
 let csrf: string | undefined, refreshing: Promise<void> | undefined;
 function lastWorkspace(): string | undefined {
  try { const stored = win.localStorage.getItem(LAST_WORKSPACE_KEY);return typeof stored === "string" && WORKSPACE_ID.test(stored) ? stored : undefined; } catch { return undefined; }
 }
 async function fetchJson(path: string, init: RequestInit): Promise<ApiResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
   if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("Browser writes send text bodies.");
   const hash = await payloadHash(init.body ?? undefined);
   if (hash !== undefined) { const headers = new Headers(init.headers);headers.set(PAYLOAD_HASH_HEADER, hash);init = { ...init, headers }; }
  }
  const response = await win.fetch(path, { ...init, credentials: "same-origin", redirect: "error" });
  let body: unknown;try { body = response.status === 204 ? undefined : await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
 }
 async function refresh(): Promise<void> {
  refreshing ??= (async () => { const response = await fetchJson("/v1/web/me", { method: "GET", headers: { accept: "application/json" } });const pending = noCompanyCsrf(response);if (pending !== undefined) { csrf = pending;return; }if (response.status !== 200) throw new ApiError(response.status, "AUTH_REQUIRED", "Sign in to continue.");const me = AppMeResponseReaderSchema.safeParse(response.body);if (!me.success || me.data.csrf === undefined) throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue.");csrf = me.data.csrf; })().finally(() => { refreshing = undefined; });
  return refreshing;
 }
 // A stale bundle cannot parse a newer overview. Compare with the no-store shell inside the browser bridge.
 const loadedApp = (win.document as Partial<Document> | undefined)?.querySelector?.('script[type="module"][src]')?.getAttribute("src");
 async function newerAppAvailable(): Promise<boolean> {
  if (loadedApp === null || loadedApp === undefined) return false;
  const controller = new AbortController(), timer = setTimeout(() => { controller.abort(); }, 5000);
  try {
   const shell = await win.fetch("/app", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
   if (!shell.ok) return false;
   const html = await shell.text(), current = /<meta\s+name=["']rovara-cloud-app["']\s+content=["']([A-Za-z0-9._-]+\.js)["']/i.exec(html)?.[1];
   return current !== undefined && !loadedApp.endsWith(`/app/assets/${current}`);
  } catch { return false; } finally { clearTimeout(timer); }
 }
 const transport = { async request(input: ApiRequest): Promise<ApiResponse> {
  const path = apiPath(input.path), write = input.method !== "GET" && input.method !== "HEAD", headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(input.headers ?? {})) { if (name.toLowerCase() === "authorization") throw new Error("Browser requests use your sign-in.");headers.set(name, value); }
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);if (body !== undefined) headers.set("content-type", "application/json");
  if (write && csrf === undefined) await refresh();
  const send = () => { if (write) headers.set("x-rovara-csrf", csrf!);return fetchJson(path, { method: input.method, headers, ...(body === undefined ? {} : { body }) }); };
  let response = await send();
  if (write && input.retry !== "never" && response.status === 403 && typeof response.body === "object" && response.body !== null && "error" in response.body && typeof response.body.error === "object" && response.body.error !== null && "code" in response.body.error && response.body.error.code === "CSRF_STALE") { await refresh();response = await send(); }
  if (input.method === "GET" && input.path === "/v1/app/me" && response.status === 200) { const me = AppMeResponseReaderSchema.safeParse(response.body);if (me.success) csrf = me.data.csrf; }
  if (input.method === "GET" && /^\/v1\/app\/projects\/[^/]+\/overview$/u.test(input.path) && response.status >= 200 && response.status < 300) {
   // Overview contracts belong to the lazy project route, not every app startup.
   const { ProjectOverviewReaderSchema } = await import("./overview-reader.js");
   const overview = ProjectOverviewReaderSchema.safeParse(response.body);
   if (!overview.success && await newerAppAvailable()) {
    logResponseShapeFailure(overview.error);
    throw new ApiError(502, "INVALID_RESPONSE", "Rovara Cloud was updated. Reload this page to continue.");
   }
  }
  return response;
 } };
 const host: AppHost = {
  // Lane A: copy only on explicit UI invocation; sanitize platform failures.
  async copyText(text) { try { if (win.navigator?.clipboard === undefined) throw new Error("Unavailable");await win.navigator.clipboard.writeText(text); } catch { throw new Error("Copying is unavailable. Try a browser that supports secure clipboard access."); } },
  kind: "web", origin: win.location.origin, transport, currentPath: () => win.location.pathname + win.location.search,
  async realtimeToken() { const result = await api.send("POST", "/v1/app/realtime/token", undefined, RealtimeTokenResponseReaderSchema);if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Live updates are temporarily unavailable.");return result.value; },
  setTitle(title) { win.document.title = title; },
  openSocket(url, protocols): RealtimeSocket {
   const socket = new win.WebSocket(url, protocols);
   return { onOpen: listener => { socket.addEventListener("open", listener);return () => socket.removeEventListener("open", listener); }, onMessage: listener => { const receive = (event: MessageEvent<unknown>) => listener(event.data);socket.addEventListener("message", receive);return () => socket.removeEventListener("message", receive); }, onClose: listener => { socket.addEventListener("close", listener);return () => socket.removeEventListener("close", listener); }, onError: listener => { socket.addEventListener("error", listener);return () => socket.removeEventListener("error", listener); }, send: data => socket.send(data), close: () => socket.close() };
  },
  openExternal(url) { const safe = safeExternalUrl(url);if (safe !== undefined) win.open(safe, "_blank", "noopener,noreferrer"); },
  navigate(url) { if (isGithubInstallationUrl(url) || isGithubAuthorizeUrl(url) || isSlackAuthorizeUrl(url, win.location.origin) || isLinearAuthorizeUrl(url, win.location.origin)) { win.location.assign(url);return; }const safe = returnPath(url);if (safe !== url) throw new Error("Invalid app destination.");win.location.assign(safe); },
  saveFile(name, data) { const url = win.URL.createObjectURL(data), link = win.document.createElement("a");try { link.href = url;link.download = name;win.document.body.appendChild(link);link.click(); } finally { link.remove();win.URL.revokeObjectURL(url); } },
  lastWorkspace: () => lastWorkspace(),
  async signInOffer() {
   try {
    const response = await fetchJson("/v1/auth/browser/methods", { method: "GET", headers: { accept: "application/json" } });
    const body = response.body as { slack?: unknown; github?: unknown } | undefined;
    return response.status === 200 && typeof body?.slack === "boolean" && typeof body.github === "boolean" ? { slack: body.slack, github: body.github } : undefined;
   } catch { return undefined; }
  },
  async rememberSignInWorkspace() {
   try {
    const response = await fetchJson("/v1/web/me/sign-in-workspace", { method: "GET", headers: { accept: "application/json" } });
    const id = (response.body as { slackTeamId?: unknown } | undefined)?.slackTeamId;
    if (response.status === 200 && typeof id === "string" && WORKSPACE_ID.test(id) && id !== lastWorkspace()) win.localStorage.setItem(LAST_WORKSPACE_KEY, id);
   } catch { /* The hint is optional: blocked or full storage, or a failed request, is no hint. */ }
  },
  signIn(path, options) {
   const destination = returnPath(path), key = "rovara.sign-in." + destination;
   // L4-SIGNIN: "Use a different workspace" (and a button for GitHub) sign in with no Slack hint; the remembered workspace is forgotten for the first.
   if (options?.differentWorkspace === true) { try { win.localStorage.setItem(LAST_WORKSPACE_KEY, ""); } catch { /* Blocked storage: nothing to forget. */ } }
   const hint = options?.differentWorkspace === true || options?.method === "github" ? undefined : lastWorkspace();
   try { const stored = win.sessionStorage.getItem(key);if (options?.automatic === true && stored !== null && Number.isFinite(Number(stored)) && Date.now() - Number(stored) < SIGN_IN_REPEAT_GUARD_MS) { win.location.assign("/app/signed-out?reason=failed");return; }win.sessionStorage.setItem(key, String(Date.now())); } catch { /* Blocked preference storage does not prevent a deliberate sign-in. */ }
   win.location.assign("/v1/auth/browser/authorize?return_to=" + encodeURIComponent(destination) + (options?.join === true ? "&join=1" : "")
    + (options?.method === "slack" || options?.method === "github" ? "&method=" + options.method : "") + (hint === undefined ? "" : "&slack_team=" + hint));
  },
  // DEC 253z: the invite link's token stays in the page's fragment (never sent as a URL); Cloud's server looks it up and keeps the join ticket.
  async lookUpInvite() {
   const token = /^#invite=(.*)$/su.exec(win.location.hash ?? "")?.[1];
   if (token === undefined || !INVITE_LINK_TOKEN.test(token)) return undefined;
   // Out of the address bar and the history once read: the token is a bearer secret until the invite is used.
   try { win.history?.replaceState(null, "", win.location.pathname + win.location.search); } catch { /* the lookup still runs */ }
   const response = await fetchJson("/v1/auth/browser/join", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ invite: token }) });
   const body = response.body as { companyName?: unknown } | undefined;
   return response.status === 200 && typeof body?.companyName === "string" && body.companyName.length > 0 && body.companyName.length <= 200 ? { companyName: body.companyName } : undefined;
  },
  async signOut() {
   if (csrf === undefined) {
    try { await refresh(); } catch (error) {
     if (!(error instanceof ApiError) || error.status !== 401) throw error;
     csrf = undefined;win.location.assign("/app/signed-out?reason=ended");return;
    }
   }
   const response = await fetchJson("/v1/auth/browser/sign-out", { method: "POST", headers: { "x-rovara-csrf": csrf! } });
   if (response.status !== 204) throw new ApiError(response.status, "SIGN_OUT_FAILED", "Couldn't sign out. Try again.");
   csrf = undefined;win.location.assign("/app/signed-out?reason=ended");
  },
  viewport: { width: () => win.innerWidth ?? 0, subscribe(listener) { win.addEventListener?.("resize", listener);return () => win.removeEventListener?.("resize", listener); } },
  storage: { get(key) { try { return win.localStorage.getItem(key) ?? undefined; } catch { return undefined; } }, set(key, value) { try { win.localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } } }, features: { admin: true },
 };
 const api = createApiClient(host);return host;
}
