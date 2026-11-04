// Build-time check: after `tsc -b`, the worker's compiled output must hold the files in scripts/worker-dist-files.ts (the detector thread's entry files, and the test services' probe and sealed name server).
// This file is only the command: it checks every time it is run, however it is started (a link, a relative path), because a build step that could skip itself would pass an image without them.
// Usage: node scripts/check-worker-dist.ts [repository root]
import { missingWorkerDistFiles } from "./worker-dist-files.ts";

const missing = missingWorkerDistFiles(process.argv[2] ?? process.cwd());
if (missing.length > 0) {
  console.error(`The worker build is missing ${missing.join(", ")}. Run \`tsc -b\` and check packages/worker/tsconfig.json.`);
  process.exit(1);
}
console.log("The worker build holds the detector thread's entry file and the test services' probe and sealed name server.");
