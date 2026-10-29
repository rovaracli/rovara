import type { Locator } from "@playwright/test";
// WebKit (Safari) differs from Chromium and Firefox in three ways these specs must not depend on, and none is an app defect:
// - Tab skips buttons unless the OS "keyboard navigation" setting is on, so Tab from a field lands on the page, not the next button.
// - A mouse click does not move focus to a button.
// - A closed <select> matches typed letters against a time-based buffer, so a second typed letter can append to the first.
// In WebKit these helpers put focus on the button directly and then use real key presses, so the focus-return behaviour after the key press is still tested.
const isWebKit = (target: Locator) => target.page().context().browser()?.browserType().name() === "webkit";
/** Moves focus from `from` to the next control by Tab (every browser except WebKit, which skips buttons) or by focus() on WebKit. */
export async function tabTo(from: Locator, to: Locator): Promise<void> {
 await from.press("Tab");
 if (isWebKit(to)) await to.focus();
}
/** Activates a button the way every browser focuses it: by mouse click, except on WebKit where a click leaves focus elsewhere, so focus then Enter. */
export async function activate(button: Locator): Promise<void> {
 if (isWebKit(button)) { await button.focus();await button.press("Enter"); } else await button.click();
}
/** Types letters into a focused closed <select>. WebKit keeps the previous letters in its type-ahead buffer for about a second, so letters typed straight after an earlier key press are read as a longer prefix; wait that out there before the first one. */
export async function typeAhead(select: Locator, letters: string): Promise<void> {
 if (isWebKit(select)) await select.page().waitForTimeout(1500);
 for (const letter of letters) await select.press(letter);
}
