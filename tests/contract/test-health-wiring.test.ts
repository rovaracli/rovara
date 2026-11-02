// Setup and test health SH28 through the whole broker: the test-health route, and the notice on a task start and a task read. All behind the `nh` switch: with it off the route does not exist and a task is
// byte for byte what it was.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { noteBlockedTask } from "../../packages/broker/src/test-env/health.js";
import { healthPortsOf } from "../../packages/broker/src/test-env/health-wiring.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const PROJECT = "payments";
const HEALTH = `/v1/app/projects/${PROJECT}/test-health`;
const KEYS = ["NIGHTLY_HEALTH_ENABLED", "TEST_ENVIRONMENT_ENABLED"] as const;
afterEach(() => { for (const key of KEYS) delete process.env[key]; });
const switches = (health: string | undefined, testEnv: string | undefined) => {
  for (const [key, value] of [["NIGHTLY_HEALTH_ENABLED", health], ["TEST_ENVIRONMENT_ENABLED", testEnv]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
};
type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

async function inRepair(h: Harness) {
  const deps = { documentClient: h.db, tableName: "state", now: () => Date.now() };
  for (const id of ["task_1", "task_2", "task_3"]) await noteBlockedTask(deps, healthPortsOf(deps), { orgId: TEST_ORG, project: PROJECT, taskId: id, reason: "host_blocked" });
}
const start = (h: Harness) => h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Fix it", client: "claude-code" });

describe("the test-health route", () => {
  it("does not exist unless both nh and the test environment are exactly 1", async () => {
    const h = await createDeveloperTaskBroker();
    for (const [health, testEnv] of [[undefined, undefined], ["1", undefined], [undefined, "1"], ["0", "1"], ["1", "true"], [" 1", "1"]] as const) {
      switches(health, testEnv);
      for (const [method, body] of [["GET", undefined], ["POST", { action: "set_propose_fix_task", enabled: true, requestId: "request-12345" }]] as const) {
        const reply = await h.dev(MAYA, method, HEALTH, body);
        expect(reply.status, `${method} ${String(health)}/${String(testEnv)}`).toBe(404);
      }
    }
    expect(h.db.find((item) => String(item.sk).startsWith("TESTENV#HEALTH"))).toEqual([]);
  });

  it("reads where the project stands: unknown health, the setting off, no proposed tasks", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    const reply = await h.dev(MAYA, "GET", HEALTH);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ health: { state: "unknown" }, proposeFixTask: false, proposedTasks: [] });
  });

  it("shows 'needs repair' with its cause once three tasks were blocked by the same cause", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    await inRepair(h);
    const reply = await h.dev(MAYA, "GET", HEALTH);
    expect(reply.body).toMatchObject({ health: { state: "needs_repair", cause: "host_blocked" } });
  });

  it("a maintainer turns the setting on and off; a person who is not a maintainer can read but not change", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const set = (who: typeof MAYA, enabled: boolean) => h.dev(who, "POST", HEALTH, { action: "set_propose_fix_task", enabled, requestId: randomUUID() });
    const on = await set(OMAR, true);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ proposeFixTask: true });
    expect((await h.dev(MAYA, "GET", HEALTH)).body).toMatchObject({ proposeFixTask: true });
    const refused = await set(MAYA, false);
    expect(refused.status).toBe(403);
    expect((await h.dev(MAYA, "GET", HEALTH)).body).toMatchObject({ proposeFixTask: true });
    expect((await set(OMAR, false)).body).toMatchObject({ proposeFixTask: false });
  });

  it("refuses a body it does not know, with field names only", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    for (const body of [{}, { action: "set_propose_fix_task", enabled: "yes", requestId: "request-12345" }, { action: "set_propose_fix_task", enabled: true, requestId: "x" }, { action: "dismiss_proposed_task", key: "nope" }, { action: "set_propose_fix_task", enabled: true, requestId: "request-12345", extra: 1 }]) {
      const reply = await h.dev(MAYA, "POST", HEALTH, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the notice on a task", () => {
  it("is on the start answer and the task read while the project needs repair; the task still starts", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    await inRepair(h);
    const started = await start(h);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const task = started.body.task as { taskId: string; testingNotice?: unknown };
    expect(task.testingNotice).toEqual({ state: "needs_repair", text: expect.stringContaining("Testing may be blocked") as unknown });
    const read = await h.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect((read.body.task as { testingNotice?: unknown }).testingNotice).toMatchObject({ state: "needs_repair" });
  });

  it("is absent when the project is not in that state, and the task view has no such key at all", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    const started = await start(h);
    expect(started.status).toBe(200);
    expect(started.body.task as object).not.toHaveProperty("testingNotice");
  });

  it("is absent with the switch off, even for a project that needs repair: the start and the read are today's", async () => {
    const h = await createDeveloperTaskBroker();
    switches("1", "1");
    await inRepair(h);
    switches(undefined, "1");
    const started = await start(h);
    expect(started.status).toBe(200);
    const task = started.body.task as { taskId: string };
    expect(task).not.toHaveProperty("testingNotice");
    const read = await h.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect(read.body.task as object).not.toHaveProperty("testingNotice");
  });
});
