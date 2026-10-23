import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppHandler } from "../../packages/web/src/server/handler.js";
import { appHeaders } from "../../packages/web/src/server/headers.js";
const CDN = "https://assets.example", HTTP = "events.example.test", WS = "socket.example.test";
const script = "console.log('fixture-only');", css = "body{color:blue}";
let directory: string;
beforeAll(async () => {
 directory = await mkdtemp(join(tmpdir(), "rovara-web-handler-"));await mkdir(join(directory, "assets"));
 await writeFile(join(directory, "index.html"), '<!doctype html><html lang="en"><head><link rel="icon" href="./assets/icon-fixture.svg"><link rel="stylesheet" crossorigin href="./assets/main-fixture.css"></head><body><div id="root"></div><script type="module" crossorigin src="./assets/main-fixture.js"></script></body></html>');
 for (const [name, content] of [["main-fixture.js", script], ["main-fixture.css", css], ["icon-fixture.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>']] as const) {
  await writeFile(join(directory, "assets", name), content);await writeFile(join(directory, "assets", name + ".br"), brotliCompressSync(content));await writeFile(join(directory, "assets", name + ".gz"), gzipSync(content));
 }
});
afterAll(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); });
const event = (rawPath: string, method = "GET", headers: Record<string, string> = {}) => ({ rawPath, headers, requestContext: { http: { method } } });
const app = (assetOrigin = CDN) => createAppHandler({ appDirectory: directory, assetOrigin, realtimeHttpHost: HTTP, realtimeWsHost: WS });
describe("the cell app shell and its immutable files", () => {
 it("serves each app route and a real session link with the exact restrictive headers", async () => {
  for (const path of ["/app", "/app/", "/app/live", "/app/projects/web/agents", "/s/ses_aaaaaaaaaaaaaaaaaaaa"]) {
   const response = await app()(event(path));expect(response.statusCode).toBe(200);expect(response.isBase64Encoded ?? false).toBe(false);
   const nonce = /<meta name="csp-nonce" content="([A-Za-z0-9_-]+)">/.exec(response.body)?.[1];expect(nonce).toBeTruthy();
   expect(response.headers).toEqual({ ...appHeaders({ assetOrigin: CDN, realtimeHttpHost: HTTP, realtimeWsHost: WS }, nonce!), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
   expect(response.headers["content-security-policy"]).toBe(`default-src 'none'; script-src 'self' ${CDN}; style-src 'self' ${CDN} 'nonce-${nonce}'; img-src 'self' data: ${CDN}; font-src ${CDN}; connect-src 'self' https://${HTTP} wss://${WS}; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`);
   expect(response.headers["x-frame-options"]).toBe("DENY");expect(response.headers["x-content-type-options"]).toBe("nosniff");expect(response.headers["referrer-policy"]).toBe("same-origin");expect(response.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
   expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();expect(response.body).not.toContain("./assets/");
   for (const name of ["main-fixture.js", "main-fixture.css", "icon-fixture.svg"]) expect(response.body).toContain(`${CDN}/app/assets/${name}`);
  }
 });
 it("creates a fresh nonce per shell response", async () => {
  const handler = app();const first = await handler(event("/app")), second = await handler(event("/app"));
  expect(first.body).not.toBe(second.body);expect(first.headers["content-security-policy"]).not.toBe(second.headers["content-security-policy"]);
 });
 it("refuses malformed links, traversal and other methods", async () => {
  for (const path of ["/s/not-an-id", "/s/ses_aaaaaaaaaaaaaaaaaaaa/extra", "/other", "/app/assets/../index.html", "/app/assets/%2e%2e/index.html", "/app/assets/a%2fb.js", "/app/assets/a%5cb.js", "/app/assets/a\\b.js", "/app/assets//main-fixture.js", "/app/assets/missing.js"]) expect((await app("")(event(path))).statusCode, path).toBe(404);
  const post = await app()(event("/app", "POST"));expect(post.statusCode).toBe(405);expect(post.headers.allow).toBe("GET");
 });
 it("leaves CloudFront files to the distribution", async () => { expect((await app()(event("/app/assets/main-fixture.js"))).statusCode).toBe(404); });
 it("serves cell-hosted Brotli, gzip and plain bytes with immutable cache and Vary", async () => {
  for (const [accept, encoding] of [["br, gzip", "br"], ["gzip", "gzip"], ["", undefined], ["br;q=0, gzip", "gzip"], ["gzip;q=0", undefined]] as const) {
   const response = await app("")(event("/app/assets/main-fixture.js", "GET", { "accept-encoding": accept }));
   expect(response.statusCode).toBe(200);expect(response.isBase64Encoded).toBe(true);expect(response.headers["content-encoding"]).toBe(encoding);expect(response.headers.vary).toBe("accept-encoding");expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
   const bytes = Buffer.from(response.body, "base64");expect((encoding === "br" ? brotliDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes).toString()).toBe(script);
  }
  const shell = await app("")(event("/app"));expect(shell.body).toContain('href="/app/assets/icon-fixture.svg"');expect(shell.headers["content-security-policy"]).not.toContain(CDN);
 });
 it("omits unavailable realtime hosts instead of opening a wildcard connection policy", () => {
  const headers = appHeaders({ assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" }, "fixture");expect(headers["content-security-policy"]).toContain("connect-src 'self';");expect(headers["content-security-policy"]).not.toContain("*");
 });
});
