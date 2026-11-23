export const sharedVitestSettings = {
  coverage: { enabled: false },
  globalSetup: ["tests/support/test-temp-dir.ts"] as string[],
  // Each test file removes the CDK assemblies it made when it ends (tests/support/test-file-temp-dir.ts).
  // + the Testing Library wait for lazily loaded routes (tests/support/testing-library-timeout.ts).
  setupFiles: ["tests/support/test-file-temp-dir.ts", "tests/support/testing-library-timeout.ts"] as string[],
  passWithNoTests: false,
  testTimeout: 60_000,
  // v1.2 learning: the install default of the company's master suggestions switch is OFF in production; the existing learning tests exercise suggestions, so the test environment has it on.
  // The switch's own tests (tests/contract/learning-suggestions-switch*.test.ts) set and clear it themselves.
  env: { LEARNING_SUGGESTIONS_DEFAULT: "on" } as Record<string, string>,
} as const;
