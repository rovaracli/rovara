export const nativeP0Files = [
  "tests/e2e/project-setup-terminal-authority-fix1.test.ts",
  "tests/e2e/p0-native-journey.test.ts",
  "tests/e2e/p0-native-journey-5b.test.ts",
  "tests/e2e/runtime-installation-qualification.native.test.ts",
  "tests/e2e/m1-web-journey.test.ts",
  "tests/e2e/m1-3-journeys.test.ts",
  "tests/e2e/m1-4-journeys.test.ts",
];

export const sharedVitestSettings = {
  coverage: { enabled: false },
  globalSetup: ["tests/support/test-temp-dir.ts"] as string[],
  // Each test file removes the CDK assemblies it made when it ends (tests/support/test-file-temp-dir.ts).
  setupFiles: ["tests/support/test-file-temp-dir.ts"] as string[],
  passWithNoTests: false,
  testTimeout: 60_000,
  // v1.2 learning: the install default of the company's master suggestions switch is OFF in production; the existing learning tests exercise suggestions, so the test environment has it on.
  // The switch's own tests (tests/contract/learning-suggestions-switch*.test.ts) set and clear it themselves.
  env: { LEARNING_SUGGESTIONS_DEFAULT: "on" } as Record<string, string>,
} as const;
