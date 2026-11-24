import { defineConfig } from "vitest/config";

// The evaluator is a stand-alone gate-pack unit; the repo's own vitest config includes only tests/ and packages/.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], passWithNoTests: false, testTimeout: 30_000 } });
