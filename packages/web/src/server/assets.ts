import { HSTS } from "./headers.js";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
export interface AppResponse { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean }
export const notFound = (): AppResponse => ({ statusCode: 404, headers: { "strict-transport-security": HSTS, "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: "Not found." });
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
function accepted(header: string, encoding: string): boolean {
 const preferences = header.split(",").map(part => part.trim().toLowerCase().split(";"));
 const selected = preferences.find(([name]) => name === encoding) ?? preferences.find(([name]) => name === "*");
 if (selected === undefined) return false;
 const raw = selected.slice(1).find(value => value.trim().startsWith("q="))?.trim().slice(2);
 const q = raw === undefined ? 1 : Number(raw);return Number.isFinite(q) && q > 0 && q <= 1;
}
export async function serveAsset(appDirectory: string, name: string, encodingHeader: string): Promise<AppResponse> {
 if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return notFound();
 const type = TYPES[extname(name)];if (type === undefined) return notFound();
 const candidates: Array<{ suffix: string; encoding?: string }> = [];
 if (accepted(encodingHeader, "br")) candidates.push({ suffix: ".br", encoding: "br" });
 if (accepted(encodingHeader, "gzip")) candidates.push({ suffix: ".gz", encoding: "gzip" });
 candidates.push({ suffix: "" });
 for (const candidate of candidates) {
  try {
   const bytes = await readFile(join(appDirectory, "assets", name + candidate.suffix));
   return { statusCode: 200, headers: { "strict-transport-security": HSTS, "content-type": type, "cache-control": "public, max-age=31536000, immutable", vary: "accept-encoding", "x-content-type-options": "nosniff", ...(candidate.encoding === undefined ? {} : { "content-encoding": candidate.encoding }) }, body: bytes.toString("base64"), isBase64Encoded: true };
  } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
 }
 return notFound();
}
