// Slice 5 "Outside tools": `agentx session start --project <name> <instructions>` starts Rovara Code as the signed-in person and prints the task and the link to its page; mistakes are refused
// before anything is sent; a link that is not the control plane's own is never printed.
import { afterEach, describe, expect, it } from "vitest";
import { agentsCli, cleanHarnessDirs, CELL } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const SES = "ses_aaaaaaaaaaaaaaaaaaaa";
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

describe("agentx session start", () => {
  it("starts the task with a fresh request id and prints the task and its page", async () => {
    const h = await agentsCli({ "POST /v1/dev/tasks": Response.json({ task: { taskId: TASK, sessionId: SES, sessionUrl: `${CELL}/s/${SES}` } }, { status: 202 }) });
    expect(await h.run(["session", "start", "--project", "payments", "Fix the flaky retry test"])).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/v1/dev/tasks", body: { project: "payments", instructions: "Fix the flaky retry test", client: "agentx-cli" } });
    expect((h.calls[0]!.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(h.stdout()).toContain(`Started task ${TASK} on payments.`);
    expect(h.stdout()).toContain(`Follow it here: ${CELL}/s/${SES}`);
  });

  it("asks for the plan-first workflow with --workflow", async () => {
    const h = await agentsCli({ "POST /v1/dev/tasks": Response.json({ task: { taskId: TASK, sessionId: SES } }) });
    expect(await h.run(["session", "start", "--project", "payments", "--workflow", "full", "Do it"])).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({ workflow: true, workflowPath: "FULL" });
    // No link from the server: the link is built from the session id on the control plane's own origin.
    expect(h.stdout()).toContain(`${CELL}/app/sessions/${SES}`);
  });

  it("never prints a link to another host", async () => {
    const h = await agentsCli({ "POST /v1/dev/tasks": Response.json({ task: { taskId: TASK, sessionId: SES, sessionUrl: "https://evil.example/s/x" } }) });
    expect(await h.run(["session", "start", "--project", "payments", "Do it"])).toBe(0);
    expect(h.stdout()).not.toContain("evil.example");
  });

  it("refuses a missing project or a bad --workflow before anything is sent", async () => {
    const h = await agentsCli({});
    expect(await h.run(["session", "start", "Do it"])).not.toBe(0);
    expect(await h.run(["session", "start", "--project", "payments", "--workflow", "medium", "Do it"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});
