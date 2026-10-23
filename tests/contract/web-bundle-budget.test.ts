import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { initialJavaScriptGzipBytes, checkWebBundleBudget } from "../../scripts/web-bundle-budget.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "rovara-web-budget-"));directories.push(root);const directory = join(root, "app");mkdirSync(directory);writeFileSync(join(root, "outside.js"), "console.log(123)");mkdirSync(join(directory, ".vite"));mkdirSync(join(directory, "assets"));
 for (const [name, body] of [["main", "console.log('main')"], ["shared", "export const shared=1"], ["builder", "console.log('lazy builder')"]]) writeFileSync(join(directory, "assets", name + ".js"), body!);
 writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify({ "src/main.tsx": { file: "assets/main.js", isEntry: true, imports: ["shared", "shared-alias"], dynamicImports: ["builder"] }, "shared-alias": { file: "assets/shared.js" }, shared: { file: "assets/shared.js", imports: ["src/main.tsx"] }, builder: { file: "assets/builder.js", isDynamicEntry: true } }));return directory;
}
it("counts each initially imported JavaScript chunk once and excludes lazy routes", () => {
 const directory = fixture(), expected = gzipSync("console.log('main')").byteLength + gzipSync("export const shared=1").byteLength;
 expect(initialJavaScriptGzipBytes(directory)).toBe(expected);expect(checkWebBundleBudget(directory, expected)).toBe(expected);expect(() => checkWebBundleBudget(directory, expected - 1)).toThrow("JavaScript");
});
it("refuses a missing entry or unreadable static dependency instead of passing an incomplete budget", () => {
 const directory = fixture();writeFileSync(join(directory, ".vite/manifest.json"), "{}");expect(() => initialJavaScriptGzipBytes(directory)).toThrow();
 writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify({ main: { file: "assets/main.js", isEntry: true, imports: ["missing"] } }));expect(() => initialJavaScriptGzipBytes(directory)).toThrow();
});
it("never follows an asset path outside the built app", () => {
 const directory = fixture();writeFileSync(join(directory, ".vite/manifest.json"), JSON.stringify({ main: { file: "../outside.js", isEntry: true } }));expect(() => initialJavaScriptGzipBytes(directory)).toThrow();
});
