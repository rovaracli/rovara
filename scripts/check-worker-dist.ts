// Build-time check: after `tsc -b`, the worker's compiled output must hold the detector thread's entry file. The environment detectors run in a thread started from `dist/env-detect/detect-thread.js`; if it is
// missing from the image, they fall back to running unguarded (with one log line), so a packaging fault would otherwise only show in production logs.
// Usage: node scripts/check-worker-dist.ts [repository root]
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_WORKER_DIST_FILES = ["packages/worker/dist/env-detect/detect-thread.js", "packages/worker/dist/env-detect/guarded.js"] as const;

const root = process.argv[2] ?? process.cwd();
const missing = REQUIRED_WORKER_DIST_FILES.filter((relative) => {
  const path = join(root, relative);
  return !existsSync(path) || statSync(path).size === 0;
});
if (missing.length > 0) {
  console.error(`The worker build is missing ${missing.join(", ")}. Run \`tsc -b\` and check packages/worker/tsconfig.json.`);
  process.exit(1);
}
console.log("The worker build holds the detector thread's entry file.");
