import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { readFileSync } from "node:fs";
const webSafeFiles = JSON.parse(readFileSync(new URL("./packages/contracts/web-safe-files.json", import.meta.url), "utf8"));

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
    files: ["packages/ui/**/*.{ts,tsx}", "packages/web/**/*.{ts,tsx}", "tests/web/**/*.{ts,tsx}", "tests/web-e2e/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { project: false, projectService: { allowDefaultProject: ["packages/web/vite.config.ts"] } } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property[key.name='dangerouslySetInnerHTML']", message: "Render data as text or SafeMarkdown." }],
    },
  },
  {
    files: ["packages/web/src/server/**/*.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./packages/web/tsconfig.server.json" } },
  },
  {
    files: ["packages/web/vite.config.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./packages/web/tsconfig.tools.json" } },
  },
  {
    files: ["packages/ui/src/**/*.{ts,tsx}", "packages/web/src/**/*.{ts,tsx}"],
    ignores: ["packages/web/src/server/**"],
    rules: { "no-restricted-imports": ["error", { paths: [{ name: "@agentx/contracts", message: "Use @agentx/contracts/web." }], patterns: ["**/packages/web/**", "@agentx/web"] }] },
  },
  {
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", "fetch", "localStorage", "sessionStorage"],
      "no-restricted-properties": ["error", { object: "document", property: "cookie" }, { object: "window", property: "location" }, { object: "window", property: "fetch" }, { object: "window", property: "localStorage" }, { object: "window", property: "sessionStorage" }],
    },
  },
  {
    files: webSafeFiles,
    rules: { "no-restricted-imports": ["error", { paths: ["typescript", "@rovara/audit-verifier"], patterns: ["node:*", "typescript/*", "@rovara/audit-verifier/*"] }] },
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
