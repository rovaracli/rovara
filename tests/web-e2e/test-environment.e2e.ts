// Setup wizard (E4), one journey in a real browser: onboarding reaches the Setup step, the test environment section loads as its own chunk, and a maintainer proposes, sees what will run and where it came from,
// is told the setup check has not run the commands, adds them to the project's settings, proves the environment and approves it.
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
test("a maintainer proposes, proves and approves the test environment from the Setup step",async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"onboarding"}});await page.route("https://github.com/apps/rovara/installations/new",async route=>route.fulfill({response:await route.fetch({url:baseURL!+"/__mock/github-landing"})}));await context.clearCookies();await page.goto("/app/signup");
 await page.getByRole("button",{name:"Sign up or sign in"}).click();await expect(page.getByRole("heading",{name:"Sign in to the mock cell"})).toBeVisible();await page.getByRole("button",{name:"Sign in",exact:true}).click();
 await page.getByLabel("Company name").fill("Acme");await page.getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByRole("heading",{name:"Connect GitHub",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Connect GitHub",exact:true}).click();await expect(page.getByRole("heading",{name:"Choose repositories"})).toBeVisible();await page.getByLabel("acme/payments").check();await page.getByLabel("Project name",{exact:true}).fill("payments");await page.getByRole("button",{name:"Create project"}).click();
 const section=page.getByRole("region",{name:"Test environment"});
 await expect(section.getByRole("button",{name:"Propose a test environment"})).toBeVisible();
 await expect(section.getByText("Found a package.json.")).toBeVisible();
 await section.getByRole("button",{name:"Propose a test environment"}).click();
 await expect(section.getByText("What will run")).toBeVisible();
 await expect(section.getByRole("list",{name:"Setup commands for payments"}).getByText("npm ci")).toBeVisible();
 await expect(section.getByRole("list",{name:"Setup commands for payments"}).getByText(/package\.json, line 4/)).toBeVisible();
 await expect(section.getByRole("list",{name:"Checks for payments"}).getByText("{tests}")).toBeVisible();
 await expect(section.getByRole("button",{name:"Approve"})).toBeDisabled();
 await section.getByRole("button",{name:"Prove it"}).click();
 await expect(section.getByRole("alert")).toContainText("Apply the proposal's commands to the project's settings");
 await section.getByRole("button",{name:"Add these commands to the project's settings"}).click();
 await expect(section.getByText(/Added to the project's settings, and the setup check started/)).toBeVisible();
 await section.getByRole("button",{name:"Prove it"}).click();
 await expect(section.getByText(/Proved: the setup check ran these commands/)).toBeVisible();
 for(const theme of ["light","dark"] as const)await checkA11y(page,{theme});
 await section.getByRole("button",{name:"Approve"}).click();
 await expect(section.getByText(/Approved: revision 1/)).toBeVisible();
});
