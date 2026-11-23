// A model with no AWS quota room (a Bedrock tokens-per-minute quota of 0) shows on the company's own-Bedrock panel as "not usable right now" with what to
// do, in a real browser at desktop and phone width, light and dark. The served Bedrock view is mocked (the pretend Code has no Bedrock route).
// Screenshots go to the test output folder.
import { expect, test, type Page } from "@playwright/test";
import { AiSpendPage } from "./pages/index.js";

const QUOTA_STEPS = "AWS has no room for this model in your account right now: its Bedrock tokens-per-minute quota is probably 0 or used up. Tasks on this model will fail until that is fixed. Choose another model, or ask AWS to raise the quota in Service Quotas, then test the connection again.";
const AT = Date.UTC(2026, 10, 23, 17, 0);

async function mockBedrock(page: Page) {
  await page.route("**/v1/web/org/agent-ai", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      source: null, effectiveSource: "rovara", sourceIsDefault: true, version: 0, canChange: true, anthropicKeyConnected: false, bedrockConnected: true,
      choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: true }],
    }) })
    : route.fallback());
  await page.route("**/v1/web/org/bedrock", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      revision: 3, canChange: true, removedUntil: null, usage: "Your AWS account pays for these calls. Rovara counts them at AWS list price under your company's monthly limit; your AWS bill is the record.",
      connection: {
        connected: true, connectedAt: AT, updatedAt: AT, roleArn: "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa", region: "us-east-1", allowGlobal: false, checkedAt: AT,
        models: [{ name: "claude-haiku-5-5", id: "us.anthropic.claude-haiku-5-5", state: "no_quota" }, { name: "claude-haiku-4-5", id: "us.anthropic.claude-haiku-4-5-v1:0", state: "ready" }],
        productModels: [], quotaSteps: QUOTA_STEPS,
      },
    }) })
    : route.fallback());
}

for (const scheme of ["light", "dark"] as const) {
  for (const [name, size] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
    test(`the own-Bedrock panel names a model with no quota room, ${name} wide, ${scheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      await mockBedrock(page);
      const screen = new AiSpendPage(page);
      await screen.openStep();
      await screen.step.getByText("Connect company AI").click();
      const panel = screen.step.getByRole("region", { name: "Your own Bedrock" });
      await panel.getByRole("button", { name: "Check Bedrock connection" }).click();
      await expect(panel.getByText("claude-haiku-5-5: not usable right now (AWS quota is 0 or used up)")).toBeVisible();
      await expect(panel.getByText("claude-haiku-4-5: ready")).toBeVisible();
      await expect(panel.getByText(QUOTA_STEPS)).toBeVisible();
      // No horizontal scroll at phone width.
      // The panel itself never runs past the screen (the sources table further down the page is not this change's).
      expect(await panel.evaluate((el) => { const box = el.getBoundingClientRect(); return box.right <= document.documentElement.clientWidth && el.scrollWidth <= el.clientWidth; })).toBe(true);
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: testInfo.outputPath(`bedrock-quota-${name}-${scheme}.png`) });
    });
  }
}
