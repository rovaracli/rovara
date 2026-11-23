import type { RouteObject } from "react-router";
/**
 * G5 ship: the account pages own the real /app/account addresses, each a lazy route (one chunk, LazyPages). Relative to the /app parent.
 * The setup frames (company progress, workflows for setup, setup run progress and journal) are mounted by the lazy /app/onboard route (OnboardPage), around the live wizard.
 */
export function accountSetupReadRoutes(): RouteObject[] {
 return [
  { path: "account", lazy: async () => ({ Component: (await import("../screens/account-setup-read/LazyPages.js")).AccountPage }) },
  { path: "account/github", lazy: async () => ({ Component: (await import("../screens/account-setup-read/LazyPages.js")).GithubAccountPage }) },
  { path: "account/automation-keys", lazy: async () => ({ Component: (await import("../screens/account-setup-read/LazyPages.js")).AutomationKeysPage }) },
 ];
}
