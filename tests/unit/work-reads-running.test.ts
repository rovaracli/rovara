import { describe, expect, it } from "vitest";
import { WORK_READS } from "../../packages/cloud-server/src/work-reads.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";

const ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const run = { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [{ id: "build", name: "Build", status: "running", private: "drop" }], pendingApprovals: [] };
const listRoute = WORK_READS.find((route) => route.method === "GET" && route.path.test("/sessions"))!;
const task = { taskId: ID, title: "Add retries", project: "payments", status: "RUNNING", createdAt: "a", updatedAt: "b" };
const answerFor = async (taskRead: unknown, sessionBacked = false, refused = false) => {
  const paths: string[] = [];
  const answer = await listRoute.answer({
    client: { json: async (_session: unknown, path: string) => {
      paths.push(path);
      if (path === "/v1/dev/tasks?detail=1&limit=50") return { tasks: [task] };
      if (refused) throw new Error("task read refused");
      return taskRead;
    } },
    session: { access: { developerId: "d".repeat(64) } },
    work: { startedBy: async () => sessionBacked ? [{ taskId: ID, sessionId: SESSION }] : [] },
  } as unknown as RouteContext);
  return { answer, paths };
};

describe("the running task projection", () => {
  it("carries the authenticated task reader's verified run into a direct task-id list row", async () => {
    const { answer, paths } = await answerFor({ task: { taskId: ID, status: "RUNNING", run } });
    expect(paths).toEqual(["/v1/dev/tasks?detail=1&limit=50", `/v1/dev/tasks/${ID}?events=0`]);
    expect((answer.body as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
      taskId: ID,
      run: { state: "RUNNING", currentStep: { id: "build", name: "Build" }, steps: [{ id: "build", name: "Build", status: "running" }], pendingApprovals: [] },
    });
    expect(JSON.stringify(answer.body)).not.toContain("private");
  });

  it("keeps the same run on a session-backed row and preserves the existing session id", async () => {
    const { answer } = await answerFor({ task: { taskId: ID, status: "RUNNING", run } }, true);
    expect((answer.body as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({ taskId: ID, sessionId: SESSION, run: { state: "RUNNING" } });
  });

  it("omits missing, stale-status, and refused run reads without treating list status as progress", async () => {
    for (const taskRead of [{ task: { taskId: ID, status: "RUNNING" } }, { task: { taskId: ID, status: "FAILED", run } }]) {
      const { answer } = await answerFor(taskRead);
      expect((answer.body as { tasks: Array<Record<string, unknown>> }).tasks[0]!.run).toBeUndefined();
    }
    const { answer } = await answerFor(undefined, false, true);
    expect(answer.status).toBe(200);
    expect((answer.body as { tasks: Array<Record<string, unknown>> }).tasks[0]!.run).toBeUndefined();
  });
});
