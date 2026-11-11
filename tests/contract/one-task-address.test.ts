// UX2 slice 2 item 4: ONE task address, `/app/sessions/<id>`. The session link, every Slack line and DM the notifier builds, a document link and the Slack start message point there (the legacy page
// only for a task from before sessions); a link is built only on a plain https origin; and Slack text that says "press Merge in Rovara" or "Retry the fix" carries the link.
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { ciFixAskMessage, sessionLink } from "@rovara-code/contracts";
import { plainHttpsOrigin, sessionPageUrl } from "../../packages/broker/src/decisions/open-path.js";
import { taskAppUrl } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { pageDocumentLink, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { startMessage } from "../../packages/broker/src/developer/share-messages.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const sessionId = "ses_aaaaaaaaaaaaaaaaaaaa";
const ORIGIN = "https://cell.example.com";
const APP = `${ORIGIN}/app/sessions/${sessionId}`;
const wf = (extra: Partial<WorkflowSnapshot>): WorkflowSnapshot => ({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: "2026-11-07T12:00:00.000Z" }), revision: 4, definitionVersion: "1.1.0", ...extra });

describe("the one task address", () => {
  it("is /app/sessions/<id> for the session link and every message outside the app", () => {
    expect(sessionLink(ORIGIN, sessionId as never)).toBe(APP);
    expect(sessionPageUrl(ORIGIN, sessionId)).toBe(APP);
    expect(taskAppUrl(ORIGIN, { taskId, sessionId })).toBe(APP);
    // A task from before sessions keeps the legacy page (it leads with "Decide on the task").
    expect(taskAppUrl(ORIGIN, { taskId })).toBe(`${ORIGIN}/review/${taskId}/task`);
  });

  it("is built only on a plain https origin, never on another scheme, a user or a query", () => {
    for (const bad of ["http://cell.example.com", "https://user:pw@cell.example.com", "https://cell.example.com/?x=1", "javascript:alert(1)", "not a url"]) {
      expect(plainHttpsOrigin(bad), bad).toBeUndefined();
      expect(sessionPageUrl(bad, sessionId), bad).toBeUndefined();
    }
    expect(sessionPageUrl(ORIGIN, "../../evil")).toBeUndefined();
  });

  it("opens a document's tab on the app's task page, and keeps the legacy page's address for a task with no session", () => {
    expect(pageDocumentLink(APP, "doc=coding-plan&from=2", "coding-plan")).toBe(`${APP}#plan`);
    expect(pageDocumentLink(APP, "doc=design", "comment-1", "design")).toBe(`${APP}#design`);
    const legacy = `${ORIGIN}/review/${taskId}/task`;
    expect(pageDocumentLink(legacy, "doc=design", "comment-1", "design")).toBe(`${legacy}?doc=design#comment-1`);
  });
});

describe("Slack lines that send a person to Rovara carry the link", () => {
  it("'press Merge in Rovara' links the task's page", () => {
    const workflow = wf({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "r1", number: 7, url: "https://github.com/acme/web/pull/7", state: "OPEN", required: true, candidateDigest: "c".repeat(64) }] as never });
    const message = workflowMessage({ taskId, workflow, taskPageUrl: APP })!;
    expect(message.text).toContain("press Merge in Rovara");
    expect(message.text).toContain(`<${APP}|Open the task in Rovara to merge>`);
    // Positive control: without a known page there is no link to add.
    expect(workflowMessage({ taskId, workflow })!.text).not.toContain("Open the task in Rovara");
  });

  it("'Retry the fix' (CI failing) links the task's page", () => {
    const workflow = wf({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: ciFixAskMessage("build") });
    const message = workflowMessage({ taskId, workflow, taskPageUrl: APP })!;
    expect(message.text).toContain(`<${APP}|Open the task in Rovara to retry>`);
  });

  it("the start message says the status in words with the task's link, never the raw code", () => {
    const text = startMessage({ developerName: "Maya", client: "Claude Code", title: "Fix refunds", project: "payments", mode: "view", status: "Understanding the request", sharedReason: "requested", link: APP });
    expect(text).toContain(`Status: Understanding the request. Follow it in Rovara: <${APP}|open the task>.`);
    expect(text).not.toMatch(/STARTING|RUNNING/u);
  });
});
