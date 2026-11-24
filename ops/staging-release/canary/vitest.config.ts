import { defineConfig } from "vitest/config";

// A stand-alone gate-pack unit (like the evaluator): the repo's own vitest config includes only tests/ and packages/.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], passWithNoTests: false, testTimeout: 30_000 } });
