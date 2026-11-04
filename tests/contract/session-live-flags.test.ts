// Live buttons: `you.live` on the session view says whether "Ask about this task" (switch `ak`) and "Fix with agent" (switch `fd`) are offered to this reader. A key is set only when its switch is
// on AND the feature's own route gate lets the reader use it (`requireSessionLevel(…, "use")` for an Ask, `diagnosisSubjectFor` for a diagnosis). With both switches off the view is byte-identical to the
// one before the field existed: the golden file below was written by the code without it.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionViewSchema, errorRefOf } from "../../packages/contracts/src/index.js";
import { requireSessionLevel } from "../../packages/broker/src/agent-sessions/access.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { diagnosisSubjectFor } from "../../packages/broker/src/diagnosis/authority.js";
import { ARJUN, CELL, MAX, MIA, OLA, ORG_A, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const GOLDEN = new URL("./golden/session-view-ak-fd-off.json", import.meta.url);
const FIXED_TASK = "11111111-1111-4111-8111-111111111111";

afterEach(() => { vi.unstubAllEnvs(); });

function world(withError: boolean | ((taskId: string) => unknown) = false) {
  const w = sessionWorld();
  const deps: SessionReadDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async (task) => ({
      taskId: FIXED_TASK, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false,
      createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [],
      ...(withError === false ? {} : { errorRef: typeof withError === "function" ? withError(task.taskId) : errorRefOf({ kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId: task.taskId }, at: "2026-10-22T08:05:00.000Z" }) }),
    }) as never,
  };
  const read = (who: string, sessionId: string) => sessionView(deps, w.caller(who), sessionId);
  return { w, deps, read };
}
const switches = (ask: "0" | "1" | undefined, fix: "0" | "1" | undefined) => {
  if (ask === undefined) vi.stubEnv("LIVE_ASK_ENABLED", ""); else vi.stubEnv("LIVE_ASK_ENABLED", ask);
  if (fix === undefined) vi.stubEnv("LIVE_FIX_ENABLED", ""); else vi.stubEnv("LIVE_FIX_ENABLED", fix);
};

describe("you.live with both switches off", () => {
  it("leaves the session view byte-identical to the golden written before the field existed", async () => {
    const r = world(true);
    const { sessionId, taskId } = r.w.seedSession();
    for (const [ask, fix] of [[undefined, undefined], ["0", "0"]] as const) {
      switches(ask, fix);
      // The seeded task id is random; the golden holds a fixed one in its place.
      const text = JSON.stringify(await r.read(PRIYA, sessionId)).replaceAll(taskId, FIXED_TASK);
      expect(text).toBe(readFileSync(GOLDEN, "utf8").trimEnd());
      expect(text).not.toContain('"live"');
    }
  });

  it("offers nothing and reads nothing extra for any reader, even one the routes would admit", async () => {
    switches(undefined, undefined);
    const r = world(true);
    const { sessionId } = r.w.seedSession();
    r.w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "use");
    for (const who of [PRIYA, ARJUN, MAX, OLA]) expect((await r.read(who, sessionId)).you).not.toHaveProperty("live");
  });
});

describe("you.live keeps to what the routes accept", () => {
  it("offers fix only for the error kinds the diagnosis route accepts", async () => {
    switches(undefined, "1");
    const at = "2026-10-22T08:05:00.000Z";
    const kinds: Array<[string, (taskId: string) => unknown, boolean]> = [
      ["operation_failed", taskId => errorRefOf({ kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId }, at }), true],
      ["workflow_block", taskId => errorRefOf({ kind: "workflow_block", code: "WORKFLOW_BLOCKED", subject: { taskId }, at }), true],
      ["intake_failure", taskId => errorRefOf({ kind: "intake_failure", code: "INTAKE_FAILED", subject: { taskId }, at }), false],
      ["model_access", () => errorRefOf({ kind: "model_access", code: "MODEL_ACCESS_DENIED", subject: { project: "web" }, at }), false],
      ["connector_health", () => errorRefOf({ kind: "connector_health", code: "CONNECTOR_EXPIRED", subject: { connectorId: "runtime-web" }, at }), false],
    ];
    for (const [kind, make, offered] of kinds) {
      const r = world(make);
      const { sessionId } = r.w.seedSession();
      expect(make("11111111-1111-4111-8111-111111111111"), kind).toBeDefined();
      expect((await r.read(PRIYA, sessionId)).you.live?.fix === true, kind).toBe(offered);
    }
  });

  it("leaves ask out on a closed task and keeps it on the same task while it is open", async () => {
    switches("1", undefined);
    const r = world();
    const open = r.w.seedSession(), closed = r.w.seedSession();
    expect((await r.read(PRIYA, open.sessionId)).you.live).toEqual({ ask: true });
    const key = taskKey(closed.taskId);
    r.w.db.set({ ...r.w.db.get(key)!, closedAt: "2026-10-22T08:30:00.000Z" });
    expect((await r.read(PRIYA, closed.sessionId)).you).not.toHaveProperty("live");
  });
});

describe("you.live with the switches on", () => {
  it("sets ask for a reader the Ask route admits and nobody else, and leaves fix out without an error", async () => {
    switches("1", undefined);
    const r = world(false);
    const { sessionId } = r.w.seedSession();
    r.w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "use");
    r.w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "view");
    expect((await r.read(PRIYA, sessionId)).you.live).toEqual({ ask: true });
    expect((await r.read(ARJUN, sessionId)).you.live).toEqual({ ask: true });
    // A project viewer and a view-only reader are refused by the Ask route, so they are not offered it.
    expect((await r.read(MIA, sessionId)).you).not.toHaveProperty("live");
    expect((await r.read(OLA, sessionId)).you).not.toHaveProperty("live");
    // Someone with no access at all cannot read the session, so there is no view to carry the field.
    await expect(r.read(ZED, sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sets fix only for the error the view shows and a reader the diagnosis routes admit", async () => {
    switches(undefined, "1");
    const withError = world(true), without = world(false);
    const a = withError.w.seedSession(), b = without.w.seedSession();
    expect((await withError.read(PRIYA, a.sessionId)).you.live).toEqual({ fix: true });
    expect((await without.read(PRIYA, b.sessionId)).you).not.toHaveProperty("live");
    withError.w.seedShare(ORG_A, a.sessionId, { kind: "member", developerId: MIA }, "view");
    expect((await withError.read(MIA, a.sessionId)).you).not.toHaveProperty("live");
  });

  it("sets both, and only on a task session", async () => {
    switches("1", "1");
    const r = world(true);
    const task = r.w.seedSession(), local = r.w.seedSession({ kind: "local", project: null });
    expect((await r.read(PRIYA, task.sessionId)).you.live).toEqual({ ask: true, fix: true });
    expect((await r.read(PRIYA, local.sessionId)).you).not.toHaveProperty("live");
    expect(SessionViewSchema.safeParse(await r.read(PRIYA, task.sessionId)).success).toBe(true);
  });

  it("agrees with the routes' own gates for every kind of reader", async () => {
    switches("1", "1");
    const r = world(true);
    const { sessionId, taskId } = r.w.seedSession();
    r.w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "use");
    r.w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MIA }, "view");
    const errorRef = errorRefOf({ kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId }, at: "2026-10-22T08:05:00.000Z" })!;
    const authority = { documentClient: r.deps.documentClient, tableName: "state", access: r.deps };
    for (const who of [PRIYA, ARJUN, MIA, MAX, OLA]) {
      const caller = r.w.caller(who);
      const askAllowed = await requireSessionLevel(r.deps, caller, sessionId, "use", "ask about it").then(() => true, () => false);
      const fixAllowed = await diagnosisSubjectFor(authority, { orgId: ORG_A, developerId: who }, errorRef) !== undefined;
      const live = (await r.read(who, sessionId)).you.live;
      expect({ who, ask: live?.ask === true, fix: live?.fix === true }).toEqual({ who, ask: askAllowed, fix: fixAllowed });
    }
  });
});

