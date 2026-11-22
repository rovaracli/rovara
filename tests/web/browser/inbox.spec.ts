import { expect, test } from "@playwright/test";
import { InboxPage, PROJECT, ProjectPage, SessionPage, seedInbox } from "./pages/index.js";

// The Inbox screen and nav badge (web task channel K5), on the pretend Code (it serves Code's C7 inbox shapes; a spec seeds the rows).
// The person who signs in is Priya. She starts a task here (so Cloud has a session for it); a second row is for a task she did not start here.
const RUNNING_TASK = "22222222-2222-4222-8222-222222222222";

test("the inbox lists the person's rows with a badge, opens a task, and marks rows read", async ({ page }, testInfo) => {
  const title = `Inbox task ${String(Date.now())}`;
  const project = new ProjectPage(page);
  await project.open(PROJECT);
  await project.startWork(title);
  await expect(page).toHaveURL(SessionPage.SHARE_ADDRESS);
  const sessionId = new SessionPage(page).sessionIdFromAddress();
  await seedInbox(page, { off: false, clear: true, rows: [{ taskTitle: title, kind: "needs_you", atMs: Date.now() }, { taskId: RUNNING_TASK, kind: "ready", atMs: Date.now() - 60_000 }] });

  const inbox = new InboxPage(page);
  await inbox.open();
  await expect(inbox.rows).toHaveCount(2);
  await expect(inbox.navLink).toHaveAccessibleName("Inbox, 2 unread");
  await expect(inbox.badge).toHaveText("2");
  await expect(inbox.rows.first()).toContainText(title);
  await expect(inbox.rows.first()).toContainText("Needs you");
  // The task started here opens on its session; the other one opens by its task id.
  await expect(inbox.row(title).getByRole("link")).toHaveAttribute("href", `/s/${sessionId}`);
  await expect(inbox.row("Speed up the search index").getByRole("link")).toHaveAttribute("href", `/t/${RUNNING_TASK}`);
  await expect(page.getByText("Your inbox isn't available on this install yet.")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-list.png") });

  // Opening a row opens the task and marks the row read.
  await inbox.row(title).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`, "u"));
  await new SessionPage(page).expectLoaded(title);
  await inbox.navLink.waitFor();
  await expect(inbox.badge).toHaveText("1");
  await inbox.open();
  await expect(inbox.row(title)).toHaveAttribute("data-read", "true");
  await expect(inbox.row("Speed up the search index")).toHaveAttribute("data-read", "false");

  // Mark all as read: the badge empties and the button goes.
  await inbox.markAll.click();
  await expect(inbox.badge).toHaveText("");
  await expect(inbox.markAll).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-all-read.png") });

  // A phone-width screen has no sideways scroll and keeps the rows readable.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(inbox.rows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("inbox-phone.png") });
});

test("a Code with no inbox hides the badge and the screen says so in one sentence", async ({ page }, testInfo) => {
  await seedInbox(page, { off: true });
  try {
    await page.goto("/app");
    await expect(page.getByRole("complementary").getByRole("link", { name: "Work" })).toBeVisible();
    const inbox = new InboxPage(page);
    await expect(inbox.navLink).toHaveCount(0);
    await inbox.open();
    await expect(inbox.unavailable).toHaveText("Your inbox isn't available on this install yet.");
    await expect(inbox.rows).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("inbox-unavailable.png") });
  } finally {
    await seedInbox(page, { off: false, clear: true });
  }
});

test("an empty inbox says so", async ({ page }) => {
  await seedInbox(page, { off: false, clear: true });
  const inbox = new InboxPage(page);
  await inbox.open();
  // The rebuilt page has no separate "Nothing in your inbox" block: an empty read shows no updates, no Mark all and no unread count.
  await expect(inbox.rows).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Updates" })).toHaveCount(0);
  await expect(inbox.markAll).toHaveCount(0);
  await expect(inbox.navLink).toHaveAccessibleName("Inbox, 0 unread");
});
