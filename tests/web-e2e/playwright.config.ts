import { defineConfig, devices } from "@playwright/test";
import { selectedBrowsers } from "./support/browsers.js";
import { mockCellOrigin, SLOT_ENV } from "./support/port.js";
// ROVARA_E2E_BROWSER=<name> runs one browser (CI: one job per browser); ROVARA_E2E_ALL_BROWSERS=1 runs all three one after another; default chromium.
const browsers = selectedBrowsers(process.env);
// Two workers by default. Each worker slot (parallelIndex) has a mock cell process of its own, started below, so no state is shared between workers; ROVARA_E2E_WORKERS=1 runs everything on one cell.
const workers = Number(process.env.ROVARA_E2E_WORKERS ?? "2");
if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error(`ROVARA_E2E_WORKERS must be a whole number from 1 to 8, not "${process.env.ROVARA_E2E_WORKERS}".`);
export default defineConfig({
 testDir: ".", testMatch: "*.e2e.ts", workers, retries: process.env.CI ? 1 : 0, timeout: 30_000,
 outputDir: "../../.test-build/web-e2e/results", reporter: process.env.CI ? [["list"], ["html", { outputFolder: "../../.test-build/web-e2e/report", open: "never" }]] : "list",
 // baseURL is set per worker slot by the test fixture in support/csp.ts.
 use: { ignoreHTTPSErrors: true, trace: "retain-on-failure", video: "off" },
 projects: browsers.map(name => ({ name, use: { ...devices[name === "chromium" ? "Desktop Chrome" : name === "firefox" ? "Desktop Firefox" : "Desktop Safari"] } })),
 webServer: Array.from({ length: workers }, (_, slot) => ({ name: `mock cell ${slot}`, command: "npx tsx tests/web-e2e/support/mock-cell.ts", cwd: process.cwd(), env: { [SLOT_ENV]: String(slot) }, url: mockCellOrigin(slot) + "/app", ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 60_000 })),
});
