// Build-time check: after `tsc -b`, the worker's compiled output must hold the detector thread's entry file. The environment detectors run in a thread started from `dist/env-detect/detect-thread.js`; if it is
// missing from the image, they fall back to running unguarded (with one log line), so a packaging fault would otherwise only show in production logs.
// Test services (TS-RUN-1, image part) add two more: `dist/service-probe.js`, which the helper launcher runs in a probe container for tcp and http health questions (service-helpers.ts PROBE_ENTRY), and
// `dist/sealed-dns-helper.js`, which the sealed check sandbox's name server runs (check-sandbox.ts SEALED_DNS_HELPER_ENTRY). A worker image without either would fail every dependency's health check or leave the sealed
// round without its name server, and only at run time, so the build refuses it.
// Usage: node scripts/check-worker-dist.ts [repository root]
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_WORKER_DIST_FILES = [
  "packages/worker/dist/env-detect/detect-thread.js",
  "packages/worker/dist/env-detect/guarded.js",
  "packages/worker/dist/service-probe.js",
  "packages/worker/dist/sealed-dns-helper.js",
] as const;

/** The required files that are missing or empty under `root`. */
export function missingWorkerDistFiles(root: string): string[] {
  return REQUIRED_WORKER_DIST_FILES.filter((relative) => {
    const path = join(root, relative);
    return !existsSync(path) || statSync(path).size === 0;
  });
}

// Only when run as the build step, never when a test imports the list.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = missingWorkerDistFiles(process.argv[2] ?? process.cwd());
  if (missing.length > 0) {
    console.error(`The worker build is missing ${missing.join(", ")}. Run \`tsc -b\` and check packages/worker/tsconfig.json.`);
    process.exit(1);
  }
  console.log("The worker build holds the detector thread's entry file and the test services' probe and sealed name server.");
}
