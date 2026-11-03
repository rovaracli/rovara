// The staging build path's one switch (test services slice 1): `catalog-build-flavor.ts` says "release" in every commit, and a build made for the staging account sets it to "staging" in its WORKING COPY before it
// compiles (`tsc -b`) and bundles, then sets it back. A release build refuses a tree that says anything but "release" (scripts/release/build.ts) and also requires a clean checkout, so a staging build can never be released.
//   npx tsx scripts/release/catalog-flavor.ts staging|release
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FLAVOR_FILE = fileURLToPath(new URL("../../packages/contracts/src/catalog-build-flavor.ts", import.meta.url));
const LINE = /^export const CATALOG_BUILD_FLAVOR: "release" \| "staging" = "(?:release|staging)";$/mu;

/** The file's text with the flavor set. Throws when the file is not the one line it expects, so a hand-edited file is never silently rewritten. */
export function withFlavor(text: string, flavor: "release" | "staging"): string {
  if (flavor !== "release" && flavor !== "staging") throw new Error("the flavor is release or staging");
  if (text.match(new RegExp(LINE.source, "gmu"))?.length !== 1) throw new Error("catalog-build-flavor.ts is not in the expected form");
  return text.replace(LINE, `export const CATALOG_BUILD_FLAVOR: "release" | "staging" = "${flavor}";`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flavor = process.argv[2];
  if (flavor !== "release" && flavor !== "staging") {
    process.stderr.write("usage: catalog-flavor.ts release|staging\n");
    process.exitCode = 2;
  } else {
    readFile(FLAVOR_FILE, "utf8").then((text) => writeFile(FLAVOR_FILE, withFlavor(text, flavor))).then(() => process.stdout.write(`catalog build flavor: ${flavor}\n`), (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
      process.exitCode = 1;
    });
  }
}
