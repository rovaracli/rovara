// Test services slice 1: the seams that let a caller add catalog keys or claim a build flavor exist only for tests (`@agentx/contracts/testing`). Production code (packages/*/src, infra, scripts) must not use them, and must not
// hand `loadSignedCatalog` or `catalogTrustedKeyPems` a key list, a source list or a flavor. The behavioural half (production functions ignore what a caller passes anyway) is in catalog-trust.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
function files(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "cdk.out" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files(path, found);
    else if (/\.(?:ts|tsx|mjs|js)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(path);
  }
  return found;
}
const production = [
  ...readdirSync(join(ROOT, "packages")).flatMap((name) => files(join(ROOT, "packages", name, "src"), [])).filter((path) => !path.includes("/src/testing")),
  ...files(join(ROOT, "infra")), ...files(join(ROOT, "scripts")),
].map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
/** The only files that may define or wire the seams: the contracts package's own trust modules. */
const OWN = new Set(["packages/contracts/src/catalog-trust.ts", "packages/contracts/src/catalog-staging-keys.ts", "packages/contracts/src/catalog-trust-core.ts", "packages/contracts/src/catalog-load-core.ts", "packages/contracts/src/testing.ts"]);

describe("the catalog trust seams", () => {
  it("scans real files (so a pass means something)", () => {
    expect(production.length).toBeGreaterThan(500);
    expect(production.some((file) => file.path === "packages/contracts/src/catalog-trust.ts")).toBe(true);
    expect(production.some((file) => file.path === "scripts/linux-check-test-services-live.ts")).toBe(true);
  });
  it("no production code imports the testing entry point or the cores behind it", () => {
    const code = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
    const offenders = production.filter((file) => !OWN.has(file.path) && /@agentx\/contracts\/testing|contracts\/src\/testing|catalog-trust-core|catalog-load-core|loadSignedCatalogWith|trustedKeyPemsFor|trustedKeyPemsOf/u.test(code(file.text))).map((file) => file.path);
    expect(offenders).toEqual([]);
    // and the contracts package's own index does not export them
    const index = production.find((file) => file.path === "packages/contracts/src/index.ts")!.text;
    expect(index).not.toMatch(/catalog-trust-core|catalog-load-core|testing\.js/u);
    expect(index).toContain('export * from "./catalog-trust.js";');
  });
  it("no production code passes loadSignedCatalog a key list, or catalogTrustedKeyPems a second argument or a flavor", () => {
    const offenders: string[] = [];
    for (const file of production) {
      const text = file.text.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
      if (/\bloadSignedCatalog\s*\(\s*\{[^}]*\b(?:trustedKeys|stagingOnly|sources|flavor)\b/u.test(text)) offenders.push(`${file.path}: loadSignedCatalog`);
      if (/\bcatalogTrustedKeyPems\s*\([^()]*,/u.test(text)) offenders.push(`${file.path}: catalogTrustedKeyPems`);
      if (/\bcatalogTrustedKeyPems\b[^;\n]*\b(?:flavor|stagingOnly|sources)\s*:/u.test(text)) offenders.push(`${file.path}: catalogTrustedKeyPems flavor`);
    }
    expect(offenders).toEqual([]);
  });
  it("the production signatures take no key list and no flavor", () => {
    const trust = production.find((file) => file.path === "packages/contracts/src/catalog-trust.ts")!.text;
    expect(trust).toMatch(/export function catalogTrustedKeyPems\(context: CatalogTrustContext\): string\[\]/u);
    expect(trust).toMatch(/export function loadSignedCatalog\(input: \{ catalogBytes: Uint8Array; signatureBytes: Uint8Array; trust\?: CatalogTrustContext \}\)/u);
  });
});
