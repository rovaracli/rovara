import { configDefaults, defineConfig } from "vitest/config";
import { DurationSequencer } from "./tests/support/duration-sequencer.js";
import { nativeP0Files, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  // RULING Q7: root React/React DOM pins must match the UI and web hosts to share one dispatcher.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    ...sharedVitestSettings,
    exclude: [...configDefaults.exclude, ...nativeP0Files],
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    // `--shard=N/M` (CI's six test shards) takes a share balanced by each file's recorded run time, not an even number of files (tests/.timings/vitest-durations.json).
    sequence: { sequencer: DurationSequencer },
  },
});
