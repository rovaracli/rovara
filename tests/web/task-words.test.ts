// @vitest-environment jsdom
// Web task channel K6: Rovara Code's sentences that talk about a Slack thread are said without it for a task that has no thread, and stay exactly Code's words for a task that does.
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema, NO_CHANGE_CHOICES_NO_THREAD, NO_CHANGE_CHOICES_PAGE, SessionViewReaderSchema } from "@agentx/contracts/web";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { taskWords } from "../../packages/ui/src/text/task-words.js";
import { workTask } from "../../packages/cloud-server/src/work-reads.js";
import { readTask, readTaskList, workRows } from "../../packages/ui/src/api/work.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { QuietCard } from "../../packages/ui/src/screens/work/TaskPane.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { NOW, decisionsView, task } from "./support/work-fixture.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const REASONS = Object.values(WORKFLOW_BLOCK_REASONS);
const REVISE = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise, STALE = WORKFLOW_BLOCK_REASONS.checkRetryStale;
const SLACKY = /slack|thread/iu;

it("keeps Code's words exactly for a task that has a Slack thread (golden)", () => {
  for (const reason of REASONS) expect(taskWords(reason, true)).toBe(reason);
  expect(taskWords(REVISE, true)).toContain("(in the task's Slack thread or on the task page)");
  expect(taskWords(STALE, true)).toBe("This check run no longer matches the task's current step. Use the latest update in the thread.");
});

it("says the two Slack-thread sentences with the page alone for a task with no thread", () => {
  expect(taskWords(REVISE, false)).toBe(REVISE.replace(" (in the task's Slack thread or on the task page)", " (on the task page)"));
  expect(taskWords(REVISE, false)).toContain("Choose Revise the plan (on the task page): Rovara plans again");
  expect(taskWords(STALE, false)).toBe("This check run no longer matches the task's current step. Use the latest update on the task page.");
});

it("changes nothing else: every other block reason is the same bytes with or without a thread", () => {
  for (const reason of REASONS.filter((one) => one !== REVISE && one !== STALE)) expect(taskWords(reason, false), reason).toBe(reason);
});

it("leaves no word about Slack or a thread in any of Code's block reasons for a task with no thread, so a new such reason fails here until it has a rule", () => {
  for (const reason of REASONS) expect(SLACKY.test(taskWords(reason, false)), reason).toBe(false);
});

it("keeps the no-change last line for each kind of task (golden), the one without a thread free of Slack words", () => {
  expect(NO_CHANGE_CHOICES_PAGE).toBe("No tests were run and no pull request was opened. To change something, reply here and choose Retry coding; otherwise close the task.");
  expect(NO_CHANGE_CHOICES_NO_THREAD).toBe("No tests were run and no pull request was opened. To change something, start a new request describing it; otherwise close the task.");
  expect(SLACKY.test(NO_CHANGE_CHOICES_NO_THREAD)).toBe(false);
});

// ---- Cloud's list projection ----
it("passes on only a `shared: true` from Code's list (the task has a Slack share); any other value leaves the field out, so a task Code does not mark shared reads exactly as before", () => {
  const raw = { taskId: "66666666-6666-4666-8666-666666666666", title: "T", project: "web" };
  expect(workTask({ ...raw, shared: true })?.["shared"]).toBe(true);
  for (const shared of [false, undefined, "yes", 1, null]) expect(Object.hasOwn(workTask({ ...raw, shared })!, "shared")).toBe(false);
});

// ---- The Work page's quiet card ----
const quiet = (patch: Record<string, unknown>) => {
  const listed = readTaskList({ tasks: [task("66666666-6666-4666-8666-666666666666", "Stopped one", { status: "FAILED", workflow: { stage: "IMPLEMENT", state: "BLOCKED", revision: 1, blockReason: REVISE }, ...patch }, "IMPLEMENT", "BLOCKED")] });
  const row = workRows(listed, readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([]))), NOW)[0]!;
  render(h(MemoryRouter, {}, h(QuietCard, { row, decisionsError: undefined })));
  return screen.getByTestId("decision-quiet").textContent ?? "";
};

it("reads a task as having a thread from a list row's `shared` or a share with a thread, and a private task as having none", () => {
  const base = task("66666666-6666-4666-8666-666666666666", "T");
  expect(readTask({ ...base, shared: true })?.hasThread).toBe(true);
  expect(readTask({ ...base, shared: false })?.hasThread).toBe(false);
  expect(readTask(base)?.hasThread).toBe(false);
  expect(readTask({ ...base, share: { threadUrl: "https://example.slack.test/archives/C1/p1" } })?.hasThread).toBe(true);
  expect(readTask({ ...base, share: { threadTs: "1763380800.000100" } })?.hasThread).toBe(true);
  expect(readTask({ ...base, share: { channelId: "C1" } })?.hasThread).toBe(false);
});

it("the Work page's quiet card says Code's reason with the page alone for a task with no thread", () => {
  const words = quiet({});
  expect(words).toContain("Choose Revise the plan (on the task page)");
  expect(SLACKY.test(words)).toBe(false);
});

it("the Work page's quiet card keeps Code's exact reason for a task in a Slack thread (golden)", () => {
  const words = quiet({ shared: true });
  expect(words).toContain("Choose Revise the plan (in the task's Slack thread or on the task page)");
});

// ---- The task page's Pipeline tab ----
function pipeline(taskPatch: Record<string, unknown>) {
  const session = SessionViewReaderSchema.parse(workspaceFixture({ status: "needs_person" }, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: REVISE }, ...taskPatch }));
  const f = fakeHost(async () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } })), query = createQueryClient();
  const router = createMemoryRouter([{ path: "*", element: h("main", {}, h("h1", {}, session.title), h(Workspace, { session, onComment: () => undefined })) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
  return { close() { ui.unmount(); router.dispose(); query.clear(); } };
}

it("the Pipeline tab says why a task stopped with the page alone when the task has no thread", async () => {
  const s = pipeline({});
  expect(await screen.findByText("Stopped: " + taskWords(REVISE, false))).toBeTruthy();
  expect(screen.queryByText(/Slack thread/u)).toBeNull();
  s.close();
});

it("the Pipeline tab keeps Code's exact words for a task whose share has a thread (golden)", async () => {
  const s = pipeline({ share: { mode: "view", channelId: "C0123456789", sharedReason: "requested", threadUrl: "https://example.slack.test/archives/C0123456789/p1763380800000100" } });
  expect(await screen.findByText("Stopped: " + REVISE)).toBeTruthy();
  s.close();
});
