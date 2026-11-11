import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { HSTS, appHeaders, assetOrigin, type AppEnvironment } from "./headers.js";
import { notFound, serveAsset, type AppResponse } from "./assets.js";
import { renderShell } from "./shell.js";
import { joinResponse } from "./join.js";
export interface AppEvent { rawPath?: string; rawQueryString?: string; headers?: Record<string, string | undefined>; requestContext?: { http?: { method?: string } } }
/** `canonicalOrigin` (0.5.7, a custom domain): the one origin the app's pages belong on; empty or absent means every address is canonical. */
export interface AppHandlerOptions extends AppEnvironment { appDirectory: string; canonicalOrigin?: string }
export function createAppHandler(options: AppHandlerOptions): (event: AppEvent) => Promise<AppResponse> {
 const env = { ...options, assetOrigin: assetOrigin(options.assetOrigin) };
 return async event => {
  if (event.requestContext?.http?.method !== "GET") return { statusCode: 405, headers: { "strict-transport-security": HSTS, allow: "GET", "cache-control": "no-store" }, body: "This address answers GET only." };
  const path = event.rawPath ?? "";
  if (path.startsWith("/app/assets/")) {
   if (env.assetOrigin !== "") return notFound();
   const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
   return serveAsset(env.appDirectory, path.slice("/app/assets/".length), headers["accept-encoding"] ?? "");
  }
  const moved = canonicalRedirect(options.canonicalOrigin ?? "", event, path);
  if (moved !== undefined) return moved;
  // UX1: an invite link opens on the app's own origin.
  if (path === "/join") return joinResponse(event.rawQueryString);
  const session = path.startsWith("/s/") && SessionIdSchema.safeParse(path.slice(3)).success;
  if (!(path === "/app" || path.startsWith("/app/") || session)) return notFound();
  const nonce = randomBytes(18).toString("base64url");
  const headers = { ...appHeaders(env, nonce), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  try { return { statusCode: 200, headers, body: renderShell(await readFile(join(env.appDirectory, "index.html"), "utf8"), env.assetOrigin, nonce) }; }
  catch { return { statusCode: 503, headers, body: "Rovara is temporarily unavailable. Try again shortly." }; }
 };
}
// The app's page on the API's own address (a bookmark, an old link) goes to the custom domain: its sign-in cookies are host-only, so the page and its sign-in must share a host.
// A temporary redirect, so a rollback leaves nothing cached. Assets are not pages and are never redirected.
function canonicalRedirect(canonicalOrigin: string, event: AppEvent, path: string): AppResponse | undefined {
 if (canonicalOrigin === "" || !(path === "/app" || path.startsWith("/app/") || path.startsWith("/s/") || path === "/join")) return undefined;
 const canonical = new URL(canonicalOrigin);
 const host = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "host")?.[1]?.toLowerCase();
 if (host === undefined || host === canonical.host.toLowerCase()) return undefined;
 const query = event.rawQueryString === undefined || event.rawQueryString === "" ? "" : `?${event.rawQueryString}`;
 return { statusCode: 307, headers: { "strict-transport-security": HSTS, location: `${canonical.origin}${path}${query}`, "cache-control": "no-store" }, body: "" };
}
export const handler = createAppHandler({
 canonicalOrigin: process.env.CANONICAL_ORIGIN ?? "",
 appDirectory: join(process.env.LAMBDA_TASK_ROOT ?? resolve(process.cwd(), "packages/web/dist"), "app"),
 assetOrigin: process.env.ASSET_ORIGIN ?? "", realtimeHttpHost: process.env.REALTIME_HTTP_HOST ?? "", realtimeWsHost: process.env.REALTIME_WS_HOST ?? "",
});
