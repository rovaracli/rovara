// The learning lane's tests, run against the DynamoDB lesson store on a fake table (LR-W2). Usage:
//   heavy.sh npx vitest run -c vitest.lessons-dynamo.config.ts tests/unit/lessons/*.test.ts --maxWorkers=2
import { defineConfig } from "vitest/config";
import { sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

export default defineConfig({
  test: {
    ...sharedVitestSettings,
    setupFiles: [...sharedVitestSettings.setupFiles, "tests/support/lessons-dynamo-setup.ts"],
    include: ["tests/unit/lessons/**/*.test.ts", "tests/unit/team-record-core/round9.test.ts"],
  },
});
