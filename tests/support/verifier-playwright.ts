// The verifier's own copy of playwright-core (1.63.0, the version the executor image pins). The repository root has another (1.64.0, for
// @playwright/test), so a test that hands a BrowserContext to verifier code must take its types from the verifier's copy, or the two
// BrowserContext types do not match. Test files that only launch a browser can keep importing "playwright-core".
export { chromium, type Browser, type BrowserContext, type Page } from "../../packages/verifier/node_modules/playwright-core/index.js";
