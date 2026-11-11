import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initialJavaScriptFiles } from "../../scripts/web-bundle-budget.js";
// The trial and billing screens (switch `rovara.billing`) are lazy: none of their words are in the JavaScript every page loads. Needs `npm run build:web` first, like the bundle budget test.
it("keeps the trial page, the trial banner and the Billing page out of the initial JavaScript", () => {
 const directory = "packages/web/dist/app", markers = ["Billing isn't turned on for this install", "What happens when the allowance runs out", "Your trial allowance is running low", "payment-method-setup", "billing-contact"];
 for (const file of initialJavaScriptFiles(directory)) { const text = readFileSync(join(directory, file), "utf8");for (const marker of markers) expect(text.includes(marker), file + " holds " + marker).toBe(false); }
});
