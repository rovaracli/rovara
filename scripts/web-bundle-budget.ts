import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { INITIAL_JS_BUDGET_GZIP_BYTES } from "../packages/ui/src/constants.js";
type Chunk = { file: string; isEntry?: boolean; imports?: string[] };
/** The JavaScript files the page loads before any lazy route: every entry and what it imports statically. */
export function initialJavaScriptFiles(directory: string): string[] {
 const manifest = JSON.parse(readFileSync(resolve(directory, ".vite/manifest.json"), "utf8")) as Record<string, Chunk>;
 const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true).map(([key]) => key);
 if (entries.length === 0) throw new Error("JavaScript manifest has no entry.");
 const visited = new Set<string>(), files = new Set<string>();
 const visit = (key: string) => {
  if (visited.has(key)) return;visited.add(key);
  const chunk = manifest[key];if (chunk === undefined || typeof chunk.file !== "string" || !/^assets\/[A-Za-z0-9._-]+\.js$/.test(chunk.file) || chunk.file.includes("..")) throw new Error("JavaScript manifest has an invalid chunk.");
  files.add(chunk.file);
  for (const dependency of chunk.imports ?? []) visit(dependency);
 };
 for (const entry of entries) visit(entry);
 return [...files];
}
export function initialJavaScriptGzipBytes(directory: string): number {
 return initialJavaScriptFiles(directory).reduce((bytes, file) => bytes + gzipSync(readFileSync(resolve(directory, file))).byteLength, 0);
}
export function checkWebBundleBudget(directory: string, budget = INITIAL_JS_BUDGET_GZIP_BYTES): number {
 const bytes = initialJavaScriptGzipBytes(directory);if (bytes > budget) throw new Error(`Initial JavaScript exceeds its ${budget}-byte gzip budget.`);return bytes;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Initial JavaScript: ${checkWebBundleBudget(resolve("packages/web/dist/app"))} gzip bytes.`);
