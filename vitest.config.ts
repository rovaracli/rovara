import { configDefaults, defineConfig } from "vitest/config";
import { nativeP0Files, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  // RULING Q7: root React/React DOM pins must match the UI and web hosts to share one dispatcher.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    ...sharedVitestSettings,
    exclude: [...configDefaults.exclude, ...nativeP0Files],
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
