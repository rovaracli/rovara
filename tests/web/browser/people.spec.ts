import { createHash, randomUUID } from "node:crypto";
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

// D8: Share folds into People. A person a Share made a reader of the task (the earlier Share route, still there) shows in the same People list as a viewer, and is
// removed from it with the share removal. (Cloud's session offers no Share button today; where one is offered, the unit tests cover it opening this panel.)
test("a person shared with before shows in the People list as a viewer and can be removed there", async ({ page }, testInfo) => {
  const title = `Share into People ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  const session = new SessionPage(page);
  await session.expectLoaded(title);
  const sessionId = session.sessionIdFromAddress();
  // The earlier Share route makes Sam a reader (Code's task readers).
  const me = await (await page.request.get("/v1/web/me")).json() as { csrf: string };
  const sam = createHash("sha256").update("fake-code:sam").digest("hex");
  const shared = await page.request.put(`/v1/web/sessions/${sessionId}/shares`, { headers: { "x-rovara-csrf": me.csrf }, data: { requestId: randomUUID(), principal: { kind: "member", developerId: sam }, level: "view" } });
  expect(shared.status()).toBe(200);
  const people = new PeoplePanel(page);
  await people.open();
  await expect(people.row("Sam")).toContainText("Can view");
  await expect(people.rows).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("people-panel-shared-viewer.png") });
  await people.panel.getByRole("button", { name: "Remove Sam" }).click();
  await expect(people.row("Sam")).toHaveCount(0);
  await expect(people.rows).toHaveCount(1);
});
