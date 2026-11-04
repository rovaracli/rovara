import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { initialJavaScriptGzipBytes, initialJavaScriptFiles, checkWebBundleBudget } from "../../scripts/web-bundle-budget.js";
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
it("keeps the actual built application within the complete startup budget", () => {
 expect(() => checkWebBundleBudget("packages/web/dist/app")).not.toThrow();
});
it("keeps screens and contracts that only a lazy route needs out of the initial JavaScript", () => {
 // One string from each: the decision-card tabs contract, the decision card's reject reasons, the loaded-knowledge contract, the Lessons tab's contract and words (L3b: "expectedSetVersion", "scope_not_one_repo"), the setup wizard's test-environment routes (E4: "request-approval"), the second opinion's settings screen with its contract ("caughtMissedByFirst"), and the Sources editing screen's words (T5: "Someone changed this source meanwhile"). Home loads the cards after its first paint.
 const markers = ["second_person_required", "wrong_approach", "loadedKnowledge", "expectedSetVersion", "scope_not_one_repo", "request-approval", "caughtMissedByFirst", "Caught what the first review missed", "Share as company recipe", "Someone changed this source meanwhile", "You're the only person who can approve this"], directory = "packages/web/dist/app";
 for (const file of initialJavaScriptFiles(directory)) { const text = readFileSync(join(directory, file), "utf8");for (const marker of markers) expect(text.includes(marker), file + " holds " + marker).toBe(false); }
});
it("loads the Sources editing screen as a chunk of its own that no initial file imports, and the read-only Sources tab does not hold its code", () => {
 const directory = "packages/web/dist/app", manifest = JSON.parse(readFileSync(join(directory, ".vite/manifest.json"), "utf8")) as Record<string, { file: string; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[] }>;
 const keyOf = (suffix: string) => Object.keys(manifest).find(key => key.endsWith(suffix));
 const adminKey = keyOf("lessons/SourcesAdmin.js") ?? keyOf("lessons/SourcesAdmin.tsx"), tabKey = keyOf("lessons/SourcesTab.js") ?? keyOf("lessons/SourcesTab.tsx");
 expect(adminKey, "the editing screen has its own chunk").toBeDefined();expect(tabKey).toBeDefined();
 const admin = manifest[adminKey!]!, tab = manifest[tabKey!]!;
 expect(admin.isDynamicEntry).toBe(true);
 expect(initialJavaScriptFiles(directory)).not.toContain(admin.file);
 expect(tab.file).not.toBe(admin.file);
 expect(tab.imports ?? []).not.toContain(adminKey);
 // The screen's own code (the add form builds the Rovara row's place) is in its chunk, not in the tab's.
 expect(readFileSync(join(directory, admin.file), "utf8")).toContain("rovara:project/");
 expect(readFileSync(join(directory, tab.file), "utf8")).not.toContain("rovara:project/");
});
