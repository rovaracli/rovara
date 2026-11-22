import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import { TaskCloseProgressStatusView } from "../packages/ui/src/screens/session/TaskCloseProgressStatusView.tsx";
import { sessionFixture } from "../tests/web/support/session-fixture.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? "/private/tmp/rovara-task-close-progress-status-captures");
const designCss = await readFile(path.join(root, "packages/ui/src/design/design.css"), "utf8");
const session = SessionViewReaderSchema.parse(sessionFixture());
const scenes = [
 ["slow", "Closing is taking longer than usual. The operation may still be running; leaving this window does not confirm closure. Check this task's close status."],
 ["pending", "Closing is waiting for confirmation. Its result is not yet known. Open this task to check the close status."],
 ["unconfirmed", "Closing this task was not confirmed. Its workspace may still be held. Check the task's close status."],
];
const viewports = [[1440, 1000], [768, 1024]];
const browser = await chromium.launch({ headless: true });
try {
 await mkdir(output, { recursive: true });
 for (const [state, expected] of scenes) {
  const markup = renderToStaticMarkup(React.createElement(TaskCloseProgressStatusView, { taskId: session.sessionId, state, onCheck: () => undefined }));
  if (!markup.includes(expected) || !markup.includes("Check") || /close|discard|release/i.test(markup.replace(expected, "").replace("Check", ""))) {
   throw new Error(`Unexpected ${state} status markup for ${session.sessionId}`);
  }
  for (const theme of ["light", "dark"]) {
   for (const [width, height] of viewports) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
    await page.setContent(`<html data-theme="${theme}" data-look="v2"><head><style>${tokensCss()}${lookV2Css()}${designCss}body{padding:24px}</style></head><body><main>${markup}</main></body></html>`);
    const status = page.getByRole("status");
    if (!(await status.innerText()).includes(expected) || await page.getByRole("button").count() !== 1) {
     throw new Error(`Capture state assertion failed for ${state}, ${theme}, ${width}x${height}`);
    }
    await page.screenshot({ path: path.join(output, `${state}-${theme}-${width}x${height}.png`), fullPage: true });
    await page.close();
   }
  }
 }
} finally {
 await browser.close();
}
console.log(`Captured 12 status-only images for task ${session.sessionId} in ${output}`);
