// The list of files the worker's compiled output must hold, and the check over it (the build step is scripts/check-worker-dist.ts, which has no other logic: it runs this unconditionally, so how it is
// started, through a link or a path spelled differently, can never turn it off). Original note: Build-time check: after `tsc -b`, the worker's compiled output must hold the detector thread's entry file. The environment detectors run in a thread started from `dist/env-detect/detect-thread.js`; if it is
// missing from the image, they fall back to running unguarded (with one log line), so a packaging fault would otherwise only show in production logs.
// Test services (TS-RUN-1, image part) add two more: `dist/service-probe.js`, which the helper launcher runs in a probe container for tcp and http health questions (service-helpers.ts PROBE_ENTRY), and
// `dist/sealed-dns-helper.js`, which the sealed check sandbox's name server runs (check-sandbox.ts SEALED_DNS_HELPER_ENTRY). A worker image without either would fail every dependency's health check or leave the sealed
// round without its name server, and only at run time, so the build refuses it.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

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
