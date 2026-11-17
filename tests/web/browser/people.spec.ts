import { expect, test } from "@playwright/test";
import { FAKE_CODE_URL, PeoplePanel, PROJECT, ProjectPage, SessionPage } from "./pages/index.js";

// The People panel on a task's page (web task channel K3), on the pretend Code (it serves the planned People shapes, candidates and add included).
// The person who signs in is Priya, the owner of the task she starts; Sam is a member of the project and is the person added.
test("the owner adds a person, changes the role through the confirm step, and removes them", async ({ page }, testInfo) => {
  const title = `People on a task ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  await new SessionPage(page).expectLoaded(title);

  const people = new PeoplePanel(page);
  await people.open();
  await expect(people.rows).toHaveCount(1);
  await expect(people.row("Priya")).toContainText("(you)");
  await expect(people.row("Priya")).toContainText("GitHub");
  await expect(people.row("Priya")).toContainText("Owner");
  await expect(people.panel.getByRole("button", { name: "Take ownership" })).toHaveCount(0);

  // Add Sam from the candidates, to view. The pretend Code commits it at once.
  await people.panel.getByRole("combobox", { name: "Person" }).selectOption({ label: "Sam" });
  await people.panel.getByRole("combobox", { name: "Add as" }).selectOption({ label: "Can view" });
  await page.screenshot({ path: testInfo.outputPath("people-panel-add.png") });
  await people.panel.getByRole("button", { name: "Add person" }).click();
  await expect(people.row("Sam")).toContainText("Slack");
  await expect(people.row("Sam")).toContainText("Can view");
  await expect(people.message).toHaveText("Done");
  await page.screenshot({ path: testInfo.outputPath("people-panel-list.png") });

  // Making Sam an owner waits for the confirm step on Code's page; the panel offers to open it and waits.
  await people.roleOf("Sam").selectOption({ label: "Owner" });
  await expect(people.waiting).toContainText("Waiting for you to confirm this change in Rovara Code.");
  // The button to Code's confirm page shows for an https address only (the pretend Code here is plain http on loopback); the unit tests cover it.
  await expect(people.waiting.getByRole("button", { name: "Open confirmation" })).toHaveCount(0);
  await expect(people.roleOf("Sam")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("people-panel-waiting.png") });
  // Confirming on Code's page (a stand-in for it); the panel's next read sees the change and finishes.
  const confirmed = await page.request.post(`${FAKE_CODE_URL}/__fake/people-confirm`, { data: {} });
  expect(confirmed.status()).toBe(200);
  await expect(people.waiting).toHaveCount(0, { timeout: 15_000 });
  await expect(people.message).toHaveText("Done");
  await expect(people.roleOf("Sam")).toHaveValue("owner");
  await page.screenshot({ path: testInfo.outputPath("people-panel-confirmed.png") });

  // Removing a person is the role "Removed".
  await people.panel.getByRole("button", { name: "Remove Sam" }).click();
  await expect(people.row("Sam")).toContainText("Removed");
  await expect(people.panel.getByRole("button", { name: "Remove Sam" })).toHaveCount(0);
  await expect(page.getByTestId("people-panel")).not.toContainText(/slack invite|channel/iu);
});

// D8: Share folds into People. Where Code serves the task's People list, the Share button opens the panel to add a viewer, and the people a Share made readers show in the same list.
test("Share opens the People panel to add a viewer, and a person shared with before shows in the list as a viewer", async ({ page }, testInfo) => {
  const title = `Share into People ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  await new SessionPage(page).expectLoaded(title);
  const people = new PeoplePanel(page);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.panel.getByRole("combobox", { name: "Add as" })).toHaveValue("viewer");
  await expect(people.panel.getByRole("combobox", { name: "Person" })).toBeFocused();
  await expect(page.getByText("Share this session")).toHaveCount(0);
  await people.panel.getByRole("combobox", { name: "Person" }).selectOption({ label: "Sam" });
  await people.panel.getByRole("button", { name: "Add person" }).click();
  await expect(people.row("Sam")).toContainText("Can view");
  await page.screenshot({ path: testInfo.outputPath("people-panel-share.png") });
});
