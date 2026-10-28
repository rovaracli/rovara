import { defineConfig, devices } from "@playwright/test";
import { mockCellOrigin } from "./support/port.js";
const browsers = process.env.ROVARA_E2E_ALL_BROWSERS === "1" ? ["chromium", "firefox", "webkit"] as const : ["chromium"] as const;
export default defineConfig({
 testDir: ".", testMatch: "*.e2e.ts", workers: 1, retries: process.env.CI ? 1 : 0, timeout: 30_000,
 outputDir: "../../.test-build/web-e2e/results", reporter: process.env.CI ? [["list"], ["html", { outputFolder: "../../.test-build/web-e2e/report", open: "never" }]] : "list",
 use: { baseURL: mockCellOrigin(), ignoreHTTPSErrors: true, trace: "retain-on-failure", video: "off" },
 projects: browsers.map(name => ({ name, use: { ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"] } })),
 webServer: { command: "npx tsx tests/web-e2e/support/mock-cell.ts", cwd: process.cwd(), url: mockCellOrigin() + "/app", ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 30_000 },
});
