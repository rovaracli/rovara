import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { INITIAL_JS_BUDGET_GZIP_BYTES } from "../packages/ui/src/constants.js";
type Chunk = { file: string; isEntry?: boolean; imports?: string[] };
export function initialJavaScriptGzipBytes(directory: string): number {
 const manifest = JSON.parse(readFileSync(resolve(directory, ".vite/manifest.json"), "utf8")) as Record<string, Chunk>;
 const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true).map(([key]) => key);
 if (entries.length === 0) throw new Error("JavaScript manifest has no entry.");
 const visited = new Set<string>(), files = new Set<string>();let bytes = 0;
 const visit = (key: string) => {
  if (visited.has(key)) return;visited.add(key);
  const chunk = manifest[key];if (chunk === undefined || typeof chunk.file !== "string" || !/^assets\/[A-Za-z0-9._-]+\.js$/.test(chunk.file) || chunk.file.includes("..")) throw new Error("JavaScript manifest has an invalid chunk.");
  if (!files.has(chunk.file)) { files.add(chunk.file);bytes += gzipSync(readFileSync(resolve(directory, chunk.file))).byteLength; }
  for (const dependency of chunk.imports ?? []) visit(dependency);
 };
 for (const entry of entries) visit(entry);
 return bytes;
}
export function checkWebBundleBudget(directory: string, budget = INITIAL_JS_BUDGET_GZIP_BYTES): number {
 const bytes = initialJavaScriptGzipBytes(directory);if (bytes > budget) throw new Error(`Initial JavaScript exceeds its ${budget}-byte gzip budget.`);return bytes;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Initial JavaScript: ${checkWebBundleBudget(resolve("packages/web/dist/app"))} gzip bytes.`);
