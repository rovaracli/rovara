// Browser tests for Rovara Cloud's web app, run against the pretend Rovara Code (npm run fake-code, tests/support/fake-code.ts).
//
// One line to run them here (the first time also: npx playwright install chromium):
//
//   npm run build && npm run test:browser
//
// Playwright starts both servers itself: the pretend Code and Cloud (npm run cloud:local) on top of the built web app. Chromium only for now.
// Ports are not the ones `npm run fake-code` / `npm run cloud:local` use by hand (8790, 8787), so a test run never meets a server you started yourself;
// change them with ROVARA_E2E_CODE_PORT and ROVARA_E2E_CLOUD_PORT. Every selector the specs use lives in ./pages (data-testid first), so a redesign edits those files.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port from 1024 to 65535, not "${process.env[name] ?? ""}".`);
  return value;
}
const codePort = port("ROVARA_E2E_CODE_PORT", 18790);
const cloudPort = port("ROVARA_E2E_CLOUD_PORT", 18787);
if (codePort === cloudPort) throw new Error("ROVARA_E2E_CODE_PORT and ROVARA_E2E_CLOUD_PORT must differ.");
const root = resolve(import.meta.dirname, "../../..");
if (!existsSync(resolve(root, "packages/web/dist/app/index.html"))) throw new Error("The web app is not built. Run `npm run build` first (it builds the packages and packages/web/dist/app).");
const codeUrl = `http://127.0.0.1:${String(codePort)}`;
const cloudUrl = `http://127.0.0.1:${String(cloudPort)}`;
const clientSecret = "fake-secret";
// Playwright adds `env` to the shell's own variables; the ones the two servers read as settings are removed first, so a developer's shell cannot change what the specs expect.
const unset = (names: readonly string[]) => names.map((name) => `-u ${name}`).join(" ");
const CLEARED_FOR_CODE = unset(["FAKE_CODE_PERSON", "ROVARA_CLIENT_ID", "HOST"]);
const CLEARED_FOR_CLOUD = unset(["CLOUD_ORIGIN", "CLOUD_ORG_NAME", "CLOUD_APP_DIRECTORY", "CLOUD_SESSIONS_FILE", "CLOUD_WORK_SESSIONS_FILE", "PROTOTYPE_SESSIONS_FILE", "ROVARA_CLIENT_ID", "ROVARA_CLIENT_SECRET_FILE", "ROVARA_SCOPES", "HOST"]);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // The pretend Code keeps its state in memory and every spec signs in as the same person, so the specs run one after another.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: "../../../.test-build/browser/results",
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { outputFolder: "../../../.test-build/browser/report", open: "never" }]],
  use: { baseURL: cloudUrl, trace: "retain-on-failure", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "pretend Rovara Code",
      command: `env ${CLEARED_FOR_CODE} npm run fake-code`,
      cwd: root,
      env: { PORT: String(codePort), ROVARA_CLIENT_SECRET: clientSecret },
      // The pretend Code has no page of its own to ask for, so Playwright waits for the port to accept connections.
      port: codePort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: "Rovara Cloud",
      command: `env ${CLEARED_FOR_CLOUD} npm run cloud:local`,
      cwd: root,
      env: { PORT: String(cloudPort), ROVARA_CODE_URL: codeUrl, ROVARA_CLIENT_SECRET: clientSecret },
      url: `${cloudUrl}/app`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
