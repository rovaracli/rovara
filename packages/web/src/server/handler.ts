import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionIdSchema } from "@agentx/contracts/web";
import { appHeaders, assetOrigin, type AppEnvironment } from "./headers.js";
import { notFound, serveAsset, type AppResponse } from "./assets.js";
import { renderShell } from "./shell.js";
export interface AppEvent { rawPath?: string; headers?: Record<string, string | undefined>; requestContext?: { http?: { method?: string } } }
export interface AppHandlerOptions extends AppEnvironment { appDirectory: string }
export function createAppHandler(options: AppHandlerOptions): (event: AppEvent) => Promise<AppResponse> {
 const env = { ...options, assetOrigin: assetOrigin(options.assetOrigin) };
 return async event => {
  if (event.requestContext?.http?.method !== "GET") return { statusCode: 405, headers: { allow: "GET", "cache-control": "no-store" }, body: "This address answers GET only." };
  const path = event.rawPath ?? "";
  if (path.startsWith("/app/assets/")) {
   if (env.assetOrigin !== "") return notFound();
   const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
   return serveAsset(env.appDirectory, path.slice("/app/assets/".length), headers["accept-encoding"] ?? "");
  }
  const session = path.startsWith("/s/") && SessionIdSchema.safeParse(path.slice(3)).success;
  if (!(path === "/app" || path.startsWith("/app/") || session)) return notFound();
  const nonce = randomBytes(18).toString("base64url");
  const headers = { ...appHeaders(env, nonce), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  try { return { statusCode: 200, headers, body: renderShell(await readFile(join(env.appDirectory, "index.html"), "utf8"), env.assetOrigin, nonce) }; }
  catch { return { statusCode: 503, headers, body: "Rovara is temporarily unavailable. Try again shortly." }; }
 };
}
export const handler = createAppHandler({
 appDirectory: join(process.env.LAMBDA_TASK_ROOT ?? resolve(process.cwd(), "packages/web/dist"), "app"),
 assetOrigin: process.env.ASSET_ORIGIN ?? "", realtimeHttpHost: process.env.REALTIME_HTTP_HOST ?? "", realtimeWsHost: process.env.REALTIME_WS_HOST ?? "",
});
