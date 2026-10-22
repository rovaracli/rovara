import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "cdk.out/**",
      ".release-synth/**",
      "coverage/**",
      "tests/fixtures/e2e-web-api-app/**",
      "packages/verifier/assets/qualification-app/**",
      "tests/fixtures/orders-web-starter/**",
      "packages/audit-verifier/scripts/**",
      "**/.test-build/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off"
    },
  },
  {
    // The static rovara.dev/join forwarder (Plan 2, Task 6): plain browser scripts, outside the TypeScript projects.
    files: ["web/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: "script",
      parserOptions: { project: false },
      globals: { document: "readonly", fetch: "readonly", history: "readonly", location: "readonly", URL: "readonly", URLSearchParams: "readonly" },
    },
  },
  {
    // Plain Node scripts outside the TypeScript projects (Plan 2, Task 17: the Public Suffix List generator).
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: "module",
      parserOptions: { project: false },
      globals: { console: "readonly", fetch: "readonly", process: "readonly", URL: "readonly" },
    },
  },
);
