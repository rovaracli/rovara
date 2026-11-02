// Live interaction A3 (LA-3): the Ask context gains the failing checks' output tails and the agent's last tool events. Both are bounded and made safe; neither goes to an audience that may not have it
// (the tiers of `ask-context.ts` decide that, and are tested in ask-context.test.ts); and a run whose records cannot be read leaves its section out, not the answer.
import { describe, expect, it } from "vitest";
import { askContext, type AskContextDependencies } from "../../packages/broker/src/agent-sessions/ask-context.js";
import { createAskReaders } from "../../packages/broker/src/agent-sessions/ask-readers.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const OLD_RUN = "33333333-3333-4333-8333-333333333333";
const NEW_RUN = "44444444-4444-4444-8444-444444444444";
const PASSWORD = "AKIAIOSFODNN7EXAMPLE";

const check = (id: string, label: string, after: string, output: string) => ({ id, label, source: "project", before: "passed", after, class: after === "failed" ? "regression" : "passing", output, durationMs: 10 });
const report = (checks: unknown[]) => ({ status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64), checks, extraTry: "not_needed", agentClaim: "success" });
const policy = { required: [{ id: "unit", label: "Unit tests", command: { program: "npm", args: ["test"] }, kind: "tests" }, { id: "lint", label: "Lint", command: { program: "npm", args: ["run", "lint"] }, kind: "lint" }], optional: [], selectedOptionalIds: [], proposed: [] };

function world(options: { withReport?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const task = { pk: `DEVTASK#${TASK_ID}`, sk: "META", taskId: TASK_ID, orgId: ORG, sessionId: SESSION, workspaceId: WORKSPACE, title: "Fix retry", project: "payments", ownerKey: "o".repeat(64),
    workflow: { revision: 5, stage: "REVIEW", state: "BLOCKED", checkPolicy: policy, artifacts: [], decisions: [], pullRequests: [] } };
  db.set(task);
  if (options.withReport !== false) {
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE", latestChecks: { report: report([
      check("readiness:0", "npm test", "failed", `FAIL src/pay.test.ts\n  expected 3 got 4\n${"line\n".repeat(100)}key ${PASSWORD}\nLAST-LINE-OF-THE-FAILURE`),
      check("readiness:1", "npm run lint", "passed", "all clean"),
      check("agent:0", "node scripts/x.js", "timed_out", "took too long"),
    ]), operationId: OLD_RUN, fence: 1, recordedAt: "2026-11-02T10:00:00.000Z" } });
  }
  const operation = (id: string, kind: string, createdAt: string) => db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${id}`, entityType: "OPERATION", id, kind, createdAt, status: "RUNNING" });
  operation(OLD_RUN, "task", "2026-11-02T09:00:00.000Z");
  operation(NEW_RUN, "task", "2026-11-02T10:00:00.000Z");
  operation("55555555-5555-4555-8555-555555555555", "prepare", "2026-11-02T11:00:00.000Z");
  const event = (run: string, sequence: number, type: string, payload: unknown) => db.set({ pk: `OPERATION#${run}`, sk: `EVENT#${String(sequence).padStart(12, "0")}`, entityType: "EVENT", sequence, type, timestamp: `2026-11-02T10:00:${String(sequence).padStart(2, "0")}.000Z`, payload });
  event(OLD_RUN, 1, "tool_start", { toolName: "OLD-RUN-TOOL" });
  event(NEW_RUN, 1, "tool_start", { toolName: "read_file", args: { path: "src/secret.ts" } });
  event(NEW_RUN, 2, "tool_end", { toolName: "read_file", isError: false, output: "TOOL-OUTPUT-MARKER" });
  event(NEW_RUN, 3, "tool_start", { toolName: "run_command", args: { command: "npm test" } });
  event(NEW_RUN, 4, "tool_end", { toolName: "run_command", isError: true, output: "TOOL-OUTPUT-MARKER-2" });
  event(NEW_RUN, 5, "progress", { message: "thinking about it" });
  return { db, task, readers: createAskReaders({ documentClient: db, tableName: "state" }) };
}

describe("the failing checks' tails (LA-3)", () => {
  it("hands over the output tail of each failing or timed-out check by the workflow's check id, redacted and cut to the tail size, and none for a passing check", async () => {
    const { readers, task } = world();
    const tails = await readers.checkTails!(task as never);
    expect(Object.keys(tails).sort()).toEqual(["agent:0", "unit"]);
    expect(tails["unit"]).toContain("LAST-LINE-OF-THE-FAILURE");
    expect(tails["unit"]).not.toContain(PASSWORD);
    expect(tails["unit"]!.length).toBeLessThanOrEqual(4_000);
    expect(tails["unit"]!.split("\n").length).toBeLessThanOrEqual(40);
    expect(tails["agent:0"]).toBe("took too long");
  });

  it("gives nothing when the workspace has no report, an unreadable one, or one that says why it has none", async () => {
    const none = world({ withReport: false });
    expect(await none.readers.checkTails!(none.task as never)).toEqual({});
    const broken = world();
    broken.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", latestChecks: { report: { status: "verified", checks: "nonsense" } } });
    expect(await broken.readers.checkTails!(broken.task as never)).toEqual({});
    const marker = world();
    marker.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", latestChecks: { report: { status: "not_verified", reason: "failed" } } });
    expect(await marker.readers.checkTails!(marker.task as never)).toEqual({});
  });

  it("reaches the context: a failed check shows its tail to the web asker, redacted, and a Slack asker gets names only", async () => {
    const { db, readers } = world();
    // The verification the page shows: the unit check failed.
    const row = db.get(`DEVTASK#${TASK_ID}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    db.set({ ...row, workflow: { ...row.workflow, verification: { candidateDigest: "a".repeat(64), producer: "worker", environmentId: "env", recordedAt: "2026-11-02T10:00:00.000Z", results: [{ checkId: "unit", status: "FAILED" }, { checkId: "lint", status: "PASS" }] } } });
    const deps = { documentClient: db, tableName: "state", actions: {} as never, sessionLevel: async () => "use" as const } satisfies AskContextDependencies;
    const web = await askContext(deps, { audience: "web", orgId: ORG, developerId: "d".repeat(64) }, TASK_ID, readers);
    expect(web?.text).toContain("LAST-LINE-OF-THE-FAILURE");
    expect(web?.text).not.toContain(PASSWORD);
    const slack = await askContext(deps, { audience: "slack", workspaceId: WORKSPACE, thread: { teamId: "T0123456789", channelId: "C0123456789", threadTs: "1700000000.000100" } }, TASK_ID, readers);
    expect(slack?.text ?? "").not.toContain("LAST-LINE-OF-THE-FAILURE");
  });
});

describe("the agent's last tool events (LA-3)", () => {
  it("lists the newest run's tool events oldest first, as names and whether they failed, with no arguments and no output", async () => {
    const { readers, task } = world();
    const timeline = await readers.timeline!(task as never, "events");
    expect(timeline?.agentEvents).toEqual([
      "2026-11-02T10:00:01.000Z Started read_file", "2026-11-02T10:00:02.000Z Finished read_file", "2026-11-02T10:00:03.000Z Started run_command", "2026-11-02T10:00:04.000Z Failed run_command",
    ]);
    const text = JSON.stringify(timeline);
    for (const never of ["TOOL-OUTPUT-MARKER", "src/secret.ts", "npm test", "OLD-RUN-TOOL", "thinking about it"]) expect(text).not.toContain(never);
  });

  it("is bounded to the newest 40 lines", async () => {
    const { db, readers, task } = world();
    for (let sequence = 6; sequence < 120; sequence += 1) db.set({ pk: `OPERATION#${NEW_RUN}`, sk: `EVENT#${String(sequence).padStart(12, "0")}`, entityType: "EVENT", sequence, type: "tool_start", timestamp: `2026-11-02T11:00:${String(sequence % 60).padStart(2, "0")}.000Z`, payload: { toolName: `tool_${String(sequence)}` } });
    const lines = (await readers.timeline!(task as never, "events"))?.agentEvents ?? [];
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toContain("tool_119");
  });

  it("is for the web asker's tier alone: the Slack tier's timeline carries none", async () => {
    const { readers, task } = world();
    expect((await readers.timeline!(task as never, "milestones"))?.agentEvents).toBeUndefined();
  });

  it("leaves the events out, not the timeline, when the run's records cannot be read", async () => {
    const { db, readers, task } = world();
    const send = db.send.bind(db);
    (db as { send: typeof send }).send = async (command: Parameters<typeof send>[0]) => {
      const input = (command as { input?: { ExpressionAttributeValues?: Record<string, unknown> } }).input;
      if (String(input?.ExpressionAttributeValues?.[":pk"]).startsWith("OPERATION#")) throw new Error("table down");
      return send(command);
    };
    const timeline = await readers.timeline!(task as never, "events");
    expect(timeline).toBeDefined();
    expect(timeline?.agentEvents).toBeUndefined();
  });

  it("reaches the web asker's context under its own heading", async () => {
    const { db, readers } = world();
    const deps = { documentClient: db, tableName: "state", actions: {} as never, sessionLevel: async () => "use" as const } satisfies AskContextDependencies;
    const web = await askContext(deps, { audience: "web", orgId: ORG, developerId: "d".repeat(64) }, TASK_ID, readers);
    expect(web?.text).toContain("Started read_file");
    expect(web?.text).toContain("Failed run_command");
  });
});
