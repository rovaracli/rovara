// Test services slice 1: the seams that let a caller add catalog keys or claim a build flavor exist only for tests (`@agentx/cloud-contracts/testing`). Production code (packages/*/src, infra, scripts) must not use them, and must not
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
// EVERY non-test file of every package (src, web, tools, bin, whatever else a package has), infra and scripts. The one file that defines the testing entry point is exempt by its exact path.
const production = [
  ...readdirSync(join(ROOT, "packages")).flatMap((name) => files(join(ROOT, "packages", name), [])),
  ...files(join(ROOT, "infra")), ...files(join(ROOT, "scripts")),
].map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
/** The only files that may define or wire the seams: the contracts package's own trust modules, each by its exact path (`testing.ts` is the entry point itself; nothing else called testing-anything is exempt). */
const OWN = new Set(["packages/cloud-contracts/src/catalog-trust.ts", "packages/cloud-contracts/src/catalog-staging-keys.ts", "packages/cloud-contracts/src/catalog-trust-core.ts", "packages/cloud-contracts/src/catalog-load-core.ts", "packages/cloud-contracts/src/testing.ts"]);

/** The seam names and paths, as they could be reached: a static import, a dynamic `import()`, a `require`, a relative path into the contracts package. Comments are not code. */
const SEAM = /@agentx\/contracts\/testing|contracts\/(?:src\/|dist\/)?testing(?:\.[a-z]+)?\b|catalog-trust-core|catalog-load-core|loadSignedCatalogWith|trustedKeyPemsFor|trustedKeyPemsOf/u;
const code = (text: string): string => text.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
const usesSeam = (text: string): boolean => SEAM.test(code(text));

describe("the catalog trust seams", () => {
  it("the detector sees every way in (positive controls)", () => {
    for (const text of [
      'import { loadSignedCatalogWithKeys } from "@agentx/cloud-contracts/testing";',
      'const t = await import("@agentx/cloud-contracts/testing");',
      'const t = await import(`@agentx/cloud-contracts/testing`);',
      'const t = require("@agentx/cloud-contracts/testing");',
      'import * as t from "../../contracts/src/testing.js";',
      'const t = await import("../contracts/dist/testing.js");',
      'import { trustedKeyPemsOf } from "./catalog-trust-core.js";',
      'loadSignedCatalogWith(input, keys);',
    ]) expect(usesSeam(text), text).toBe(true);
    for (const text of ['// import "@agentx/cloud-contracts/testing"', ' * see @agentx/cloud-contracts/testing', 'import { loadSignedCatalog } from "@agentx/contracts";', 'const testing = true;']) expect(usesSeam(text), text).toBe(false);
  });
  it("covers the web packages and the non-src directories of every package, not only src", () => {
    expect(production.some((file) => file.path.startsWith("packages/web/"))).toBe(true);
    expect(production.some((file) => file.path.startsWith("packages/ui/"))).toBe(true);
    expect(production.some((file) => file.path === "packages/cloud-contracts/tools/catalog-flavor.ts")).toBe(true);
    expect(production.some((file) => /^packages\/[^/]+\/(?!src\/|web\/)/u.test(file.path))).toBe(true);
  });
  it("scans real files (so a pass means something)", () => {
    expect(production.length).toBeGreaterThan(500);
    expect(production.some((file) => file.path === "packages/cloud-contracts/src/catalog-trust.ts")).toBe(true);
    expect(production.some((file) => file.path === "scripts/linux-check-test-services-live.ts")).toBe(true);
  });
  it("no production code imports the testing entry point or the cores behind it", () => {
    const offenders = production.filter((file) => !OWN.has(file.path) && usesSeam(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
    // and the contracts package's own index does not export them
    const index = production.find((file) => file.path === "packages/cloud-contracts/src/index.ts")!.text;
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
    const trust = production.find((file) => file.path === "packages/cloud-contracts/src/catalog-trust.ts")!.text;
    expect(trust).toMatch(/export function catalogTrustedKeyPems\(context: CatalogTrustContext\): string\[\]/u);
    expect(trust).toMatch(/export function loadSignedCatalog\(input: \{ catalogBytes: Uint8Array; signatureBytes: Uint8Array; trust\?: CatalogTrustContext \}\)/u);
  });
});
