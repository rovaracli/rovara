export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof BROWSERS)[number];
/** The Playwright projects to run. ROVARA_E2E_BROWSER=<name> picks one (CI runs one job per browser); ROVARA_E2E_ALL_BROWSERS=1 picks all three (local use); otherwise chromium alone. */
export function selectedBrowsers(env: Readonly<Record<string, string | undefined>>): readonly BrowserName[] {
 const one = env.ROVARA_E2E_BROWSER;
 if (one) { const match = BROWSERS.find(name => name === one);if (!match) throw new Error(`ROVARA_E2E_BROWSER must be one of ${BROWSERS.join(", ")}, not "${one}".`);return [match]; }
 return env.ROVARA_E2E_ALL_BROWSERS === "1" ? BROWSERS : ["chromium"];
}
