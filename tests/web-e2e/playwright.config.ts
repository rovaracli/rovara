import { defineConfig, devices } from "@playwright/test";
import { selectedBrowsers } from "./support/browsers.js";
import { mockCellOrigin } from "./support/port.js";
// ROVARA_E2E_BROWSER=<name> runs one browser (CI: one job per browser); ROVARA_E2E_ALL_BROWSERS=1 runs all three one after another; default chromium.
const browsers = selectedBrowsers(process.env);
export default defineConfig({
 testDir: ".", testMatch: "*.e2e.ts", workers: 1, retries: process.env.CI ? 1 : 0, timeout: 30_000,
 outputDir: "../../.test-build/web-e2e/results", reporter: process.env.CI ? [["list"], ["html", { outputFolder: "../../.test-build/web-e2e/report", open: "never" }]] : "list",
 use: { baseURL: mockCellOrigin(), ignoreHTTPSErrors: true, trace: "retain-on-failure", video: "off" },
 projects: browsers.map(name => ({ name, use: { ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"] } })),
 webServer: { command: "npx tsx tests/web-e2e/support/mock-cell.ts", cwd: process.cwd(), url: mockCellOrigin() + "/app", ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30_000 },
});
