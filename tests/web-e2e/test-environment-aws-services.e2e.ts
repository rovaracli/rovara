// Test services, wide AWS plans (decision 109): in a real browser, a maintainer opens the AWS services of an emulated dependency in the Setup step's test environment, searches the table, picks one, and saves it; at a phone's
// width and a desktop's, nothing scrolls sideways and the rows wrap; both themes pass axe.
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
async function toTheProposal(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) {
 await request.post("/__mock/scenario",{data:{name:"onboarding"}});await page.route("https://github.com/apps/rovara/installations/new",async route=>route.fulfill({response:await route.fetch({url:baseURL!+"/__mock/github-landing"})}));await context.clearCookies();await page.goto("/app/signup");
 await page.getByRole("button",{name:"Create a company"}).click();await expect(page.getByRole("heading",{name:"Sign in to the mock cell"})).toBeVisible();await page.getByRole("button",{name:"Sign in",exact:true}).click();
 await page.getByLabel("Company name").fill("Acme");await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByRole("heading",{name:"Connect GitHub",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Connect GitHub",exact:true}).click();await expect(page.getByRole("heading",{name:"Choose repositories"})).toBeVisible();await page.getByLabel("acme/payments").check();await page.getByLabel("Project name",{exact:true}).fill("payments");await page.getByRole("button",{name:"Create project"}).click();
 const section=page.getByRole("region",{name:"Test environment"});
 await section.getByRole("button",{name:"Check it works"}).click();
 await expect(section.getByText("What will run")).toBeVisible();
 return section;
}
for (const [width, height] of [[390, 844], [1280, 800]] as const) test(`a maintainer picks AWS services for an emulated dependency at ${String(width)}px`, async ({ page, context, request, baseURL }) => {
 await page.setViewportSize({ width, height });
 const section = await toTheProposal(page, context, request, baseURL);

 // The WHOLE dependency row fits the screen (name, variables, picker summary, seed field), not only the picker.
 const rowFits = async () => section.getByRole("list", { name: "Services the tests use" }).evaluate((list, limit) => [...list.querySelectorAll<HTMLElement>("*")].filter(node => node.getBoundingClientRect().right > limit + 1).map(node => node.tagName + "." + node.className), width);
 expect(await rowFits()).toEqual([]);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await section.getByText(/^AWS services \(1\)/).click();
 const picker = section.getByRole("group", { name: "AWS services for this dependency" });
 await expect(picker.getByText(/serves \d+ AWS services/)).toBeVisible();
 await expect(picker.getByRole("checkbox", { name: /s3/ })).toBeChecked();
 await expect(picker.getByRole("checkbox", { name: /s3/ })).toBeDisabled();
 await picker.getByLabel("Search AWS services").fill("kinesis");
 await picker.getByRole("checkbox", { name: /kinesis/ }).first().check();
 await expect(picker.getByRole("status").first()).toHaveText(/2 picked/);
 // Nothing of the picker sits past the screen's edge.
 const wide = await picker.evaluate((group, limit) => [...group.querySelectorAll<HTMLElement>("*"), group].filter(node => node.getBoundingClientRect().right > limit + 1).map(node => node.tagName), width);
 expect(wide).toEqual([]);
 const box = await picker.getByRole("checkbox", { name: /kinesis/ }).first().evaluate(node => { const label = (node as HTMLInputElement).labels![0]!.getBoundingClientRect(); return { height: label.height, right: label.right }; });
 expect(box.height).toBeGreaterThanOrEqual(44);
 expect(box.right).toBeLessThanOrEqual(width);
 expect(await rowFits()).toEqual([]);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: test.info().outputPath(`aws-services-${String(width)}.png`), fullPage: true });
 for (const theme of ["light", "dark"] as const) await checkA11y(page, { theme });
 await picker.getByRole("button", { name: "Save the AWS services" }).click();
 await expect(section.getByText(/^AWS services \(2\)/)).toBeVisible();
});
