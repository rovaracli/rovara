// QA6-02: a decision card's "Open the details" must go to a page the web app really has. The staging 0.5.6 design card opened `/app/tasks/<uuid>`, which the app has no route for ("Not found").
// Every card source that links to a task, a project or a settings page builds its link in the broker; each is matched here against `appRoutes`, the app's own route table, so a link to a page that does not exist fails.
import { expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { taskOpenPath, sessionOpenPath } from "../../packages/broker/src/decisions/open-path.js";
import { specChoiceItemOf } from "../../packages/broker/src/spec/decision-item.js";
import { hostAskItem, type SetupHostAsk } from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { isSafeRelativePath } from "../../packages/broker/src/decisions/text.js";

const routes = appRoutes({ localAgents: true, usage: true, admin: true, chains: true, notices: true, describe: true });
/** Whether the app has a real page at this path: a match that is not the catch-all "Not found" route. */
function appHasPage(path: string): boolean {
  const matches = matchRoutes(routes, path.split("?")[0]!);
  const leaf = matches?.at(-1)?.route.path;
  return matches !== null && leaf !== "*";
}

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = `ses_${"a".repeat(20)}`;

it("the route check is real: a task by its own id is not a page of the app, a session and a project are", () => {
  expect(appHasPage(`/app/tasks/${TASK}`)).toBe(false);
  expect(appHasPage(`/app/projects/payments/settings`)).toBe(false);
  expect(appHasPage(sessionOpenPath(SESSION))).toBe(true);
  expect(appHasPage("/app/projects/payments")).toBe(true);
});

it("a task's card opens its session, or its project's page when it has no session, and both are pages the app has", () => {
  for (const task of [{ project: "payments", sessionId: SESSION }, { project: "payments" }, { project: "payments", sessionId: "not a session id" }]) {
    const path = taskOpenPath(task);
    expect(isSafeRelativePath(path), path).toBe(true);
    expect(appHasPage(path), path).toBe(true);
    expect(path).not.toContain(TASK);
  }
  expect(taskOpenPath({ project: "payments", sessionId: SESSION })).toBe(`/app/sessions/${SESSION}`);
  expect(taskOpenPath({ project: "payments" })).toBe("/app/projects/payments");
  // A project name is one path segment, whatever it holds.
  expect(taskOpenPath({ project: "a/b c" })).toBe("/app/projects/a%2Fb%20c");
});

it("a held spec's card opens a page the app has, with and without a session", () => {
  const now = "2026-11-05T10:00:00.000Z";
  const input = { taskId: TASK, project: "payments", title: "Retry payments", state: undefined, corrupt: true, now };
  for (const sessionId of [SESSION, undefined]) {
    const item = specChoiceItemOf({ ...input, sessionId })!;
    expect(item, "positive control: the card exists").toMatchObject({ kind: "spec_choice" });
    expect(appHasPage(item.openPath), item.openPath).toBe(true);
  }
  expect(specChoiceItemOf({ ...input, sessionId: SESSION })!.openPath).toBe(`/app/sessions/${SESSION}`);
});

it("a website request's card opens the project page, where Allowed websites is, not a settings page the app does not have", () => {
  const ask = { orgId: "org_1", project: "payments", host: "api.example.com", taskId: TASK, askedAt: "2026-11-05T10:00:00.000Z", state: "pending", requestedBy: "a".repeat(64) } as unknown as SetupHostAsk;
  const item = hostAskItem(ask, { staffStep: true });
  expect(item.openPath).toBe("/app/projects/payments");
  expect(appHasPage(item.openPath)).toBe(true);
});
