import { AppMeResponseReaderSchema, RealtimeTokenResponseReaderSchema, SessionIdSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse, AppHost, RealtimeSocket } from "@agentx/ui";
import { ApiError, createApiClient, SIGN_IN_REPEAT_GUARD_MS } from "@agentx/ui";
import { safeExternalUrl, isGithubInstallationUrl, isSlackLinkUrl } from "../../ui/src/text/links.js";
export interface BrowserWindow {
 // Lane A: optional on hosts without clipboard support; never falls back to storage.
 navigator?: Pick<Navigator, "clipboard">;
 innerWidth?: number;
 addEventListener?: (type: "resize", listener: () => void) => void;
 removeEventListener?: (type: "resize", listener: () => void) => void;
 location: Pick<Location, "origin" | "pathname" | "search" | "assign">;
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
 return /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/.test(path) && !path.includes("..") && !path.includes("//") && !/%2e|%2f|%5c/i.test(path) && !path.split("?", 1)[0]!.split("/").includes(".") ? path : "/app";
}
export function createBrowserHost(win: BrowserWindow): AppHost {
 let csrf: string | undefined, refreshing: Promise<void> | undefined;
 async function fetchJson(path: string, init: RequestInit): Promise<ApiResponse> {
  const response = await win.fetch(path, { ...init, credentials: "same-origin", redirect: "error" });
  let body: unknown;try { body = response.status === 204 ? undefined : await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
 }
 async function refresh(): Promise<void> {
  refreshing ??= (async () => { const response = await fetchJson("/v1/web/me", { method: "GET", headers: { accept: "application/json" } });if (response.status !== 200) throw new ApiError(response.status, "AUTH_REQUIRED", "Sign in to continue.");const me = AppMeResponseReaderSchema.safeParse(response.body);if (!me.success || me.data.csrf === undefined) throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue.");csrf = me.data.csrf; })().finally(() => { refreshing = undefined; });
  return refreshing;
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
  navigate(url) { if (isGithubInstallationUrl(url) || isSlackLinkUrl(url, win.location.origin)) { win.location.assign(url);return; }const safe = returnPath(url);if (safe !== url) throw new Error("Invalid app destination.");win.location.assign(safe); },
  saveFile(name, data) { const url = win.URL.createObjectURL(data), link = win.document.createElement("a");try { link.href = url;link.download = name;win.document.body.appendChild(link);link.click(); } finally { link.remove();win.URL.revokeObjectURL(url); } },
  signIn(path, options) {
   const destination = returnPath(path), key = "rovara.sign-in." + destination;
   try { const stored = win.sessionStorage.getItem(key);if (options?.automatic === true && stored !== null && Number.isFinite(Number(stored)) && Date.now() - Number(stored) < SIGN_IN_REPEAT_GUARD_MS) { win.location.assign("/app/signed-out?reason=failed");return; }win.sessionStorage.setItem(key, String(Date.now())); } catch { /* Blocked preference storage does not prevent a deliberate sign-in. */ }
   win.location.assign("/v1/auth/browser/authorize?return_to=" + encodeURIComponent(destination));
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
