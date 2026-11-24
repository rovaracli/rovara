// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1) in the browser, on the pretend Code: Priya, the company owner, sees the company's
// "AI and spending" following Rovara's model default and with the default monthly limit prefilled; Save saves explicit choices at once
// (no step-up since owner DEC 254zzz73).
// A project's "AI and spend limit" keeps "Same as company" picked; the project's admin sets its own per-task limit through Cloud's route to Code.
// Screenshots go to the test output folder.
import { expect, test, type Page } from "@playwright/test";
import { AiSpendPage, PROJECT, ROUTES } from "./pages/index.js";

// DEC 254zzz263: no saved choice + no connected own provider serves Rovara AI without saving a source row.
// The browser server has a memory company store but no product-key backend, so its unmocked source read
// correctly refuses unknown connection metadata. Supply a checked source for these editable-state cases.
async function mockCompanyDefault(page: Page) {
  await page.route("**/v1/web/org/agent-ai", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      source: null, effectiveSource: "rovara", sourceIsDefault: true, version: 0, canChange: true,
      anthropicKeyConnected: false, bedrockConnected: false,
      choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }],
    }) })
    : route.fallback());
}

test("the company step follows Rovara's default and prefills the default limit, with Save there at once", async ({ page }, testInfo) => {
  await mockCompanyDefault(page);
  const screen = new AiSpendPage(page);
  await screen.openStep();
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.step.getByRole("region", { name: "Company model setting", exact: true }).locator("p").filter({ hasText: /^Rovara's default \(currently zai\.glm-4\.6\)$/u })).toBeVisible();
  await expect(screen.model.locator("option")).toHaveText(["Choose", "Rovara's default (currently zai.glm-4.6)", "zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"]);
  await expect(screen.rovara).toBeChecked();
  await expect(screen.limit).toHaveValue("500");
  await expect(screen.freshSignIn).toHaveCount(0);
  await expect(screen.save).toBeVisible();
  await screen.own.check();
  await expect(page.getByTestId("ai-spend-own-choices")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-spending-step.png"), fullPage: true });
});

// Keep writes local to each browser context; reads after pin/clear reflect the saved model.
async function mockCompanyWrites(page: Page) {
  await mockCompanyDefault(page);
  const writes: { path: string; body: unknown }[] = [];
  let model: string | null = null;
  let settings: unknown = {};
  let settingsVersion = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT") writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() as unknown });
  });
  await page.route("**/v1/web/org/settings", (route) => {
    if (route.request().method() === "PUT") {
      settings = (route.request().postDataJSON() as { settings: unknown }).settings;
      settingsVersion += 1;
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: settingsVersion, settings }) });
  });
  await page.route("**/v1/web/org/engine-model", (route) => {
    if (route.request().method() === "PUT") model = (route.request().postDataJSON() as { model: string | null }).model;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: model ?? "zai.glm-4.6", source: model === null ? "install" : "company", offered: ["zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"], preselect: "zai.glm-4.6", canChange: true }) });
  });
  return writes;
}

test("Save with the model untouched writes only spending, keeping the served AI default without step-up", async ({ page }, testInfo) => {
  const writes = await mockCompanyWrites(page);
  const screen = new AiSpendPage(page);
  await screen.openStep();
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await screen.save.click();
  await expect(screen.saved).toHaveText("Current AI source: Rovara's AI. Company monthly limit: $500. Company model: zai.glm-4.6.");
  await expect(screen.save).toBeEnabled();
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/settings"]);
  expect(writes[0]?.body).toMatchObject({ expectedVersion: 0, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000 } } });
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-saved.png"), fullPage: true });
});

test("an explicit model choice saves after spending and can go back to Rovara's default", async ({ page }, testInfo) => {
  const writes = await mockCompanyWrites(page);
  const screen = new AiSpendPage(page);
  await screen.openStep();
  await screen.model.selectOption("claude-sonnet-4-5");
  expect(writes).toEqual([]);
  await screen.save.click();
  await expect(screen.saved).toHaveText("Current AI source: Rovara's AI. Company monthly limit: $500. Company model: claude-sonnet-4-5.");
  await expect(screen.save).toBeEnabled();
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/settings", "/v1/web/org/engine-model"]);
  expect(writes[1]?.body).toEqual({ model: "claude-sonnet-4-5" });
  await expect(screen.step.getByText("Your choice: claude-sonnet-4-5", { exact: true })).toBeVisible();
  const companyModel = screen.step.getByRole("region", { name: "Company model setting", exact: true });
  const clear = companyModel.getByRole("button", { name: "Go back to Rovara's default", exact: true });
  await expect(clear).toBeVisible();
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-model-choice.png"), fullPage: true });
  await clear.click();
  await expect(screen.saved).toHaveText("Current AI source: Rovara's AI. Company monthly limit: $500. Company model: zai.glm-4.6.");
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.save).toBeEnabled();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({ path: "/v1/web/org/engine-model", body: { model: null } });
  await expect(screen.step.getByText("Your choice: claude-sonnet-4-5", { exact: true })).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  await expect(companyModel.locator("p").filter({ hasText: /^Rovara's default \(currently zai\.glm-4\.6\)$/u })).toBeVisible();
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-model-default.png"), fullPage: true });
});

test("an unavailable AI source keeps the company model read only and offers no Save", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "PUT") writes.push(new URL(request.url()).pathname); });
  await page.route("**/v1/web/org/agent-ai", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "AI for your agents is unavailable right now. Try again." } }) }));
  const screen = new AiSpendPage(page);
  await screen.openStep();
  await expect(page.getByTestId("ai-spend-source-read-error")).toBeVisible();
  await expect(screen.step.getByTestId("ai-spend-read-only")).toContainText("Changes are unavailable until the source and spending settings can be checked.");
  await expect(screen.model).toHaveCount(0);
  await expect(screen.save).toHaveCount(0);
  expect(writes).toEqual([]);
});

// WIRING-1 restore: the same controls on the rebuilt admin AI page, in its dialogs (the pretend Code serves no step-models route, so the model Save is the "not served" case).
test("the admin AI page: Change spending saves the limit with one write and the section shows it", async ({ page }) => {
  const writes = await mockCompanyWrites(page);
  await page.goto(ROUTES.admin.aiSpending);
  const section = page.getByRole("region", { name: "Spending" });
  await expect(section).toContainText("Rovara's AI");
  await expect(section).toContainText("Not saved yet");
  await page.getByRole("button", { name: "Change spending" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Company monthly limit/).fill("750");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByTestId("ai-spend-saved")).toContainText("Company monthly limit: $750");
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/settings"]);
  expect(writes[0]?.body).toMatchObject({ expectedVersion: 0, settings: { budgets: { companyMonthlyUsdMicros: 750_000_000 } } });
  await page.keyboard.press("Escape");
  await expect(section).toContainText("$750");
});

test("the admin AI page: where step models are not served the company model Save is still there, with one write", async ({ page }) => {
  const writes = await mockCompanyWrites(page);
  await page.goto(ROUTES.admin.aiSpending);
  await page.getByRole("button", { name: "Change a model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Company model", { exact: true }).selectOption("claude-sonnet-4-5");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Save company model" }).click();
  await expect(dialog.getByTestId("ai-spend-saved")).toBeVisible();
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/engine-model"]);
  expect(writes[0]?.body).toEqual({ model: "claude-sonnet-4-5" });
});

test("the admin AI page: Connect company AI opens the setup card's connection forms and sends nothing by opening", async ({ page }) => {
  const writes = await mockCompanyWrites(page);
  await page.goto(ROUTES.admin.aiSpending);
  await page.getByRole("button", { name: "Connect company AI" }).click();
  const dialog = page.getByRole("dialog");
  // The pretend Code serves no learning-AI route, so the key section says so; Bedrock's own connection card is there; no write is made by opening it.
  await expect(dialog.getByRole("region", { name: "Learning AI key" })).toContainText("isn't connected to Rovara Code yet");
  await expect(dialog.getByRole("region", { name: "Your own Bedrock" })).toBeVisible();
  expect(writes).toEqual([]);
});

for (const entry of ["setup", "admin"] as const) for (const form of ["key", "endpoint"] as const) {
  test(`${entry} ${form}: a company switch in another tab refuses Save without sending credentials`, async ({ page }) => {
    await mockCompanyDefault(page);
    await page.route("**/v1/web/org/learning-ai", route => route.fulfill({ json: { revision: 1, accounts: { anthropic: { connected: false } }, removed: [], pausedNow: [], pauseReasons: [] } }));
    await page.route("**/v1/web/org/agent-ai", route => route.fulfill({ json: { source: null, effectiveSource: "rovara", sourceIsDefault: true, version: 1, keysRevision: 1, endpointConnected: false, choices: [{ source: "rovara", available: true }, { source: "custom_endpoint", available: true }] } }));
    const writes: string[] = [];
    page.on("request", r => { if (r.method() === "PUT") writes.push(new URL(r.url()).pathname); });
    if (entry === "setup") { await new AiSpendPage(page).openStep(); await expect(page.getByLabel(/Company monthly limit/u)).toBeVisible(); await page.getByText("Connect company AI", { exact: true }).click(); }
    else { await page.goto(ROUTES.admin.aiSpending); await expect(page.getByRole("heading", { name: "AI and spending", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Connect company AI" }).click(); }
    const field = page.getByLabel(form === "key" ? "Paste the Anthropic key" : "Key", { exact: true });
    await field.fill("fixture-private-marker");
    if (form === "endpoint") { await page.getByLabel("Address (https, port 443)").fill("https://llm.example.com/v1"); await page.getByLabel("Models, one per line: name=provider/model").fill("coder=openai/gpt-5-mini"); }
    // The UI retains its opened scope while /me sees the new session, as after switching in another tab.
    await page.route("**/v1/web/me", async route => { const result = await route.fetch(); const me = await result.json() as { org: { orgId: string } }; me.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb"; await route.fulfill({ response: result, json: me }); });
    await (form === "key" ? page.getByRole("region", { name: "Anthropic", exact: true }).getByRole("button", { name: "Connect key" }) : page.getByRole("button", { name: "Connect endpoint" })).click();
    await expect(page.getByText("Company access changed. Reload to check access.", { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
  for (const release of ["a newer revision", "an explicit continue"] as const) test(`${entry} ${form}: an unknown send stays held until Check reads a newer revision or the person continues (${release})`, async ({ page }) => {
    await mockCompanyDefault(page);
    let revision = 1;
    const writes: string[] = [];
    await page.route("**/v1/web/org/learning-ai", route => route.fulfill({ json: { revision, accounts: { anthropic: { connected: false } }, removed: [], pausedNow: [], pauseReasons: [] } }));
    await page.route("**/v1/web/org/agent-ai", route => route.fulfill({ json: { source: null, effectiveSource: "rovara", sourceIsDefault: true, version: 1, keysRevision: revision, endpointConnected: false, choices: [{ source: "rovara", available: true }, { source: "custom_endpoint", available: true }] } }));
    const path = form === "key" ? "/v1/web/org/learning-ai/key" : "/v1/web/org/agent-ai/endpoint";
    await page.route(`**${path}`, route => { writes.push(route.request().method()); return route.fulfill({ status: 503, json: {} }); });
    if (entry === "setup") { await new AiSpendPage(page).openStep(); await expect(page.getByLabel(/Company monthly limit/u)).toBeVisible(); await page.getByText("Connect company AI", { exact: true }).click(); }
    else { await page.goto(ROUTES.admin.aiSpending); await page.getByRole("button", { name: "Connect company AI" }).click(); }
    const field = page.getByLabel(form === "key" ? "Paste the Anthropic key" : "Key", { exact: true });
    await field.fill("fixture-private-marker");
    if (form === "endpoint") { await page.getByLabel("Address (https, port 443)").fill("https://llm.example.com/v1"); await page.getByLabel("Models, one per line: name=provider/model").fill("coder=openai/gpt-5-mini"); }
    await (form === "key" ? page.getByRole("region", { name: "Anthropic", exact: true }).getByRole("button", { name: "Connect key" }) : page.getByRole("button", { name: "Connect endpoint" })).click();
    const paused = page.getByText("A key change on this page isn't confirmed yet, so changes are paused. Check the connection to continue.", { exact: true }).first();
    const callout = page.getByTestId("held-connection");
    await expect(paused).toBeVisible(); await expect(field).toBeDisabled(); expect(writes).toEqual(["PUT"]);
    const check = page.getByRole("button", { name: form === "key" ? "Check Anthropic key" : "Check own endpoint" });
    // Same revision: not confirmed, still held, no resend. The pause line is replaced by the not-confirmed words and Continue is offered.
    await check.click(); await expect(check).toBeEnabled();
    await expect(page.getByText("Not confirmed. The settings shown are current. If they look right, choose Continue with these settings.", { exact: true }).first().or(page.getByText(/Rovara still shows the same settings as before your change/u)).first()).toBeVisible();
    await expect(paused).toHaveCount(0); await expect(field).toBeDisabled(); expect(writes).toEqual(["PUT"]);
    const next = page.getByRole("button", { name: "Continue with these settings" }).first();
    await expect(next).toBeVisible();
    if (release === "a newer revision") { revision = 2; await check.click(); }
    else await next.click();
    await expect(callout).toHaveCount(0); await expect(field).toBeEnabled(); expect(writes).toEqual(["PUT"]);
  });
}

test("a project's spend limit: Same as company first, then the project's own per-task limit", async ({ page }, testInfo) => {
  const screen = new AiSpendPage(page);
  await screen.open(`${ROUTES.admin.projects}/${PROJECT}`);
  await expect(screen.projectLimits).toBeVisible();
  await expect(screen.projectSame).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("project-spend-same.png") });
  await screen.projectOwn.check();
  await screen.perTask.fill("12.50");
  await screen.projectLimits.getByRole("button", { name: "Save" }).click();
  await expect(screen.projectSaved).toBeVisible();
  await expect(screen.projectOwn).toBeChecked();
  await expect(screen.perTask).toHaveValue("12.5");
  await screen.projectLimits.screenshot({ path: testInfo.outputPath("project-spend-own.png") });
});
