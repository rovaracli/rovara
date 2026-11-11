// The browser tests (the web-e2e legs of ci.yml) do not build: the web-e2e-build job runs `tsc -b` and `npm run build:web` once and the legs unpack its
// archive over their checkout. Each leg runs this first, so a missing or half-unpacked build stops the leg with a message naming what is absent,
// not a module-not-found error from the mock cell halfway through the run. Node runs this file directly, so it imports only Node's own modules.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the archive must hold: every package that is built by `tsc -b` (it has a tsconfig.json) has a non-empty dist, and the web build holds the app the mock cell serves. */
export const WEB_E2E_BUILD_FILES = ["packages/web/dist/app/index.html", "packages/cloud-contracts/dist/index.js", "vendor/rovara-code/packages/contracts/dist/index.js"] as const;

function hasFiles(directory: string): boolean {
  try {
    return readdirSync(directory).some((entry) => { const status = statSync(join(directory, entry)); return status.isFile() || (status.isDirectory() && hasFiles(join(directory, entry))); });
  } catch {
    return false;
  }
}

/** The paths (relative to `root`) that the build should have produced and did not. */
export function missingBuildOutputs(root: string): string[] {
  const missing: string[] = [];
  const packages = join(root, "packages");
  for (const name of readdirSync(packages).sort()) {
    if (existsSync(join(packages, name, "tsconfig.json")) && !hasFiles(join(packages, name, "dist"))) missing.push(`packages/${name}/dist`);
  }
  for (const file of WEB_E2E_BUILD_FILES) if (!existsSync(join(root, file))) missing.push(file);
  return missing;
}

// Usage: node scripts/web-e2e-build-guard.ts [root]
if (process.argv[1]?.endsWith("web-e2e-build-guard.ts")) {
  const missing = missingBuildOutputs(process.argv[2] ?? ".");
  for (const path of missing) console.log(`::error::The web-e2e-build archive does not hold ${path}.`);
  console.log(missing.length === 0 ? "The build the browser tests need is in place." : `${missing.length} build output(s) missing; the web-e2e-build job did not produce them or the archive was not unpacked here.`);
  process.exitCode = missing.length === 0 ? 0 : 1;
}
