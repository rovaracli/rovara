// Setup wizard (E4, TS-UX-1 setup pattern), one journey in a real browser: onboarding reaches the Setup step, the test environment section loads as its own chunk, and a maintainer presses ONE "Check it works"
// (it proposes and runs the proposal's own check; nothing is added to the project's settings), sees what will run and where it came from with a tick, and presses ONE Approve; the approval adds the commands.
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
test("a maintainer checks it works and approves the test environment from the Setup step, one press each",async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"onboarding"}});await page.route("https://github.com/apps/rovara/installations/new",async route=>route.fulfill({response:await route.fetch({url:baseURL!+"/__mock/github-landing"})}));await context.clearCookies();await page.goto("/app/signup");
 await page.getByRole("button",{name:"Sign up or sign in"}).click();await expect(page.getByRole("heading",{name:"Sign in to the mock cell"})).toBeVisible();await page.getByRole("button",{name:"Sign in",exact:true}).click();
 await page.getByLabel("Company name").fill("Acme");await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByRole("heading",{name:"Connect GitHub",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Connect GitHub",exact:true}).click();await expect(page.getByRole("heading",{name:"Choose repositories"})).toBeVisible();await page.getByLabel("acme/payments").check();await page.getByLabel("Project name",{exact:true}).fill("payments");await page.getByRole("button",{name:"Create project"}).click();
 const section=page.getByRole("region",{name:"Test environment"});
 await expect(section.getByRole("button",{name:"Check it works"})).toBeVisible();
 await expect(section.getByText("Found a package.json.")).toBeVisible();
 await expect(section.getByRole("button",{name:"Propose a test environment"})).toHaveCount(0);
 await section.getByRole("button",{name:"Check it works"}).click();
 await expect(section.getByText("What will run")).toBeVisible();
 await expect(section.getByRole("list",{name:"Setup commands for payments"}).getByText("npm ci")).toBeVisible();
 await expect(section.getByRole("list",{name:"Setup commands for payments"}).getByText(/package\.json, line 4/)).toBeVisible();
 await expect(section.getByRole("list",{name:"Checks for payments"}).getByText("{tests}")).toBeVisible();
 await expect(section.getByText(/✓ It works: the check ran these commands/)).toBeVisible();
 await expect(section.getByRole("button",{name:"Prove it"})).toHaveCount(0);
 await evidenceShot(page, {path:test.info().outputPath("test-environment-check-it-works.png"),fullPage:true});
 for(const theme of ["light","dark"] as const)await checkA11y(page,{theme});
 await section.getByRole("button",{name:"Approve"}).click();
 await expect(section.getByText(/Approved: revision 1/)).toBeVisible();
});
