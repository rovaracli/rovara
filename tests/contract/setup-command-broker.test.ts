// "Run a command" in a setup run (SH13), broker side: who may queue a command, what a command may be, one at a time, a bounded number, a repeat of a request id, delivery to the worker by the
// authenticated run only, and the journal the worker's results are kept in. Driven against the in-memory table; the route and the worker callback are wired in SH14.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_JOURNAL_MAX_ENTRIES, projectRevisionKey, setupDraftKey, type ProjectRole, type SetupJournalEntry } from "../../packages/contracts/src/index.js";
import {
  SETUP_COMMAND_TAKEN_STALE_MS, SETUP_COMMAND_TEXT_MAX, SETUP_COMMAND_WORDS, SETUP_PERSON_COMMANDS_MAX, checkPersonCommand, finishSetupCommand, queueSetupCommand, runSetupCommand, takeSetupCommand,
} from "../../packages/broker/src/rovara-code/setup-command.js";
import { SETUP_JOURNAL_BATCH_MAX, appendSetupJournal, readJournalEntry, readSetupJournal } from "../../packages/broker/src/rovara-code/setup-journal.js";
import { setupAgentKey, setupAgentPointerItem, type SetupAgentDependencies } from "../../packages/broker/src/rovara-code/setup-agent.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const orgId = TEST_ORG;
const project = "web";
const OWNER = "e".repeat(64);
const MAINTAINER = "f".repeat(64);
const TASK = randomUUID();
const WORKSPACE = randomUUID();
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const fakeToken = () => ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const scope = { orgId, project, taskId: TASK };

async function world(options: { running?: boolean; enabled?: boolean; role?: ProjectRole } = {}) {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  if (options.running !== false) {
    await db.send(new TransactWriteCommand({ TransactItems: [setupAgentPointerItem("state", {
      orgId, project, taskId: TASK, requestId: randomUUID(), requestedBy: OWNER, basedOnRevision: 1, startedAt: new Date(T0).toISOString(), limits: SETUP_AGENT_LIMITS_DEFAULT, seenTaskId: undefined,
    })] }));
    db.set({ ...taskKey(TASK), entityType: "DEVTASK", taskId: TASK, orgId, project, purpose: "setup_agent", workspaceId: WORKSPACE, startingRevision: 1 });
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", status: "BUSY" });
    db.set({ ...taskPointerKey(WORKSPACE), taskId: TASK });
  }
  const deps = {
    documentClient: db, tableName: "state", now: () => clock.now, enabled: options.enabled ?? true, starter: undefined,
    projectFor: async () => ({ name: project, role: options.role ?? "maintainer" }),
    requireNewWork: async () => undefined,
    latest: async () => ({ revision: 1, definition: {} as never }),
    limitSettings: async () => ({}), payerFor: async () => ({ kind: "member", developerId: OWNER }) as never,
  } satisfies SetupAgentDependencies;
  const caller = (developerId = MAINTAINER): DeveloperCaller => ({ orgId, developerId, name: "Maya", orgRole: "member", sessionId: "s", amr: "oidc" }) as unknown as DeveloperCaller;
  const post = (body: unknown, who = MAINTAINER) => runSetupCommand(deps, caller(who), project, body);
  const table = { documentClient: db, tableName: "state", now: () => clock.now };
  return { db, clock, deps, post, table };
}
const has = (text: string): unknown => expect.stringContaining(text);
const body = (command: string, requestId = randomUUID()) => ({ requestId, command });
const rows = (w: Awaited<ReturnType<typeof world>>, prefix: string) => w.db.find((item) => item.pk === setupDraftKey(orgId, project).pk && String(item.sk).startsWith(prefix));

describe("checkPersonCommand", () => {
  it("accepts one plain line", () => {
    expect(checkPersonCommand("  npm ls --depth=0 ")).toEqual({ ok: true, command: "npm ls --depth=0" });
  });
  it.each(["", "   ", "a\nb", "a\tb", "x\u0000y", "x‮y", "a b", "x".repeat(SETUP_COMMAND_TEXT_MAX + 1)])("refuses %j as not one plain line", (text) => {
    expect(checkPersonCommand(text)).toEqual({ ok: false, reason: "oneLine" });
  });
  it("refuses a command with a secret in it rather than running a redacted form of it", () => {
    expect(checkPersonCommand(`curl -H "Authorization: Bearer ${fakeToken()}" https://x`)).toEqual({ ok: false, reason: "secret" });
    expect(checkPersonCommand(`echo ${fakeToken()}`)).toEqual({ ok: false, reason: "secret" });
  });
});

describe("POST setup-agent/command", () => {
  it("is not found while the switch is off, and reads nothing", async () => {
    const w = await world({ enabled: false });
    await expect(w.post(body("ls"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows(w, "CMD")).toEqual([]);
  });
  it.each(["contributor", "viewer"] as const)("is refused for a %s before anything about the run is read", async (role) => {
    const w = await world({ role });
    await expect(w.post(body("ls"))).rejects.toMatchObject({ code: "FORBIDDEN", message: has(SETUP_COMMAND_WORDS.who) });
    expect(rows(w, "CMD")).toEqual([]);
  });
  it("queues a maintainer's command for the running task, from the pointer (never the request)", async () => {
    const w = await world();
    const reply = await w.post(body("npm ls"));
    expect(reply.statusCode).toBe(202);
    expect(reply.body).toEqual({ seq: 1, state: "queued" });
    expect(rows(w, "CMD#")).toHaveLength(1);
    expect(rows(w, "CMD#")[0]).toMatchObject({ taskId: TASK, orgId, project, command: "npm ls", by: MAINTAINER, state: "queued", seq: 1 });
  });
  it("refuses a body with extra fields (a task id, a limit, a payer) and bad input", async () => {
    const w = await world();
    await expect(w.post({ ...body("ls"), taskId: randomUUID() })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.post({ requestId: "x", command: "ls" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.post(body("a\nb"))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: has(SETUP_COMMAND_WORDS.oneLine) });
    await expect(w.post(body(`echo ${fakeToken()}`))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: has(SETUP_COMMAND_WORDS.secret) });
    expect(rows(w, "CMD#")).toEqual([]);
  });
  it("is refused when no run is going", async () => {
    const w = await world({ running: false });
    await expect(w.post(body("ls"))).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: has(SETUP_COMMAND_WORDS.notRunning) });
    const stopped = await world();
    stopped.db.set({ ...taskPointerKey(WORKSPACE), taskId: TASK, cancelledAt: new Date(T0).toISOString() });
    await expect(stopped.post(body("ls"))).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });
  it("a repeat of the request id is the first command and queues nothing; the same id from another person is a conflict", async () => {
    const w = await world();
    const requestId = randomUUID();
    await w.post(body("ls", requestId));
    const again = await w.post(body("ls", requestId));
    expect(again.statusCode).toBe(200);
    expect(rows(w, "CMD#")).toHaveLength(1);
    await expect(w.post(body("ls", requestId), OWNER)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("one at a time, and a bounded number", () => {
  it("a second command waits for the first to finish", async () => {
    const w = await world();
    await w.post(body("one"));
    await expect(w.post(body("two"))).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: has(SETUP_COMMAND_WORDS.busy) });
    expect(await takeSetupCommand(w.table, scope)).toEqual({ seq: 1, command: "one" });
    await expect(w.post(body("two"))).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await finishSetupCommand(w.table, scope, { seq: 1, journalN: 3 })).toBe(true);
    expect((await w.post(body("two"))).body).toEqual({ seq: 2, state: "queued" });
  });
  it("a command taken by a worker that never finished stops holding the box after the longest a command may run", async () => {
    const w = await world();
    await w.post(body("one"));
    await takeSetupCommand(w.table, scope);
    w.clock.now += SETUP_COMMAND_TAKEN_STALE_MS - 1;
    await expect(w.post(body("two"))).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    w.clock.now += 2;
    expect((await w.post(body("two"))).statusCode).toBe(202);
  });
  it("stops at the run's limit of commands typed by a person", async () => {
    const w = await world();
    for (let i = 1; i <= SETUP_PERSON_COMMANDS_MAX; i += 1) {
      await w.post(body(`echo ${String(i)}`));
      await takeSetupCommand(w.table, scope);
      await finishSetupCommand(w.table, scope, { seq: i });
    }
    await expect(w.post(body("one more"))).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: has(SETUP_COMMAND_WORDS.limit) });
  });
  it("two requests at once for the same place: one wins, the other is told the box is busy", async () => {
    const w = await world();
    const results = await Promise.allSettled([w.post(body("a")), w.post(body("b"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rows(w, "CMD#")).toHaveLength(1);
  });
});

describe("delivery to the worker", () => {
  it("hands a command over once, only to the run it was queued for", async () => {
    const w = await world();
    await w.post(body("make test"));
    expect(await takeSetupCommand(w.table, { ...scope, taskId: randomUUID() })).toBeUndefined();
    expect(await takeSetupCommand(w.table, { ...scope, project: "other" })).toBeUndefined();
    expect(await takeSetupCommand(w.table, scope)).toEqual({ seq: 1, command: "make test" });
    expect(await takeSetupCommand(w.table, scope)).toBeUndefined();
    expect(rows(w, "CMD#")[0]).toMatchObject({ state: "taken" });
  });
  it("nothing to hand over when nothing was queued", async () => {
    const w = await world();
    expect(await takeSetupCommand(w.table, scope)).toBeUndefined();
  });
  it("only a taken command of this run can be finished, once", async () => {
    const w = await world();
    await w.post(body("ls"));
    expect(await finishSetupCommand(w.table, scope, { seq: 1 })).toBe(false);
    await takeSetupCommand(w.table, scope);
    expect(await finishSetupCommand(w.table, { ...scope, taskId: randomUUID() }, { seq: 1 })).toBe(false);
    expect(await finishSetupCommand(w.table, scope, { seq: 99 })).toBe(false);
    expect(await finishSetupCommand(w.table, scope, { seq: 1, journalN: 4 })).toBe(true);
    expect(await finishSetupCommand(w.table, scope, { seq: 1, journalN: 5 })).toBe(false);
    expect(rows(w, "CMD#")[0]).toMatchObject({ state: "done", journalN: 4 });
  });
  it("queueSetupCommand directly: the store alone enforces the order", async () => {
    const w = await world();
    expect((await queueSetupCommand(w.table, scope, { requestId: randomUUID(), command: "a", by: MAINTAINER })).seq).toBe(1);
  });
});

function entry(n: number, over: Partial<SetupJournalEntry> = {}): SetupJournalEntry {
  return { n, source: n % 2 === 0 ? "person" : "agent", command: `step ${String(n)}`, exitCode: 0, durationMs: 1200, timedOut: false, flagged: false, blockedHosts: [], tail: "ok\n", startedAt: new Date(T0).toISOString(), ...over };
}

describe("the journal", () => {
  it("stores entries once, in order, and reads them back after a position", async () => {
    const w = await world();
    expect(await appendSetupJournal(w.table, scope, [entry(1), entry(2), entry(3)])).toEqual({ stored: 3, repeated: 0, refused: 0 });
    expect((await readSetupJournal(w.table, scope)).map((e) => e.n)).toEqual([1, 2, 3]);
    expect((await readSetupJournal(w.table, scope, 2)).map((e) => e.n)).toEqual([3]);
    expect(await appendSetupJournal(w.table, scope, [entry(2, { command: "changed" }), entry(4)])).toEqual({ stored: 1, repeated: 1, refused: 0 });
    expect((await readSetupJournal(w.table, scope))[1]!.command).toBe("step 2");
  });
  it("keeps the first entry for a position, redacts again, cuts the tail, and refuses what the contract refuses", async () => {
    const w = await world();
    const result = await appendSetupJournal(w.table, scope, [
      entry(1, { tail: `token ${fakeToken()}\n`, command: `echo ${fakeToken()}` }), { ...entry(2), extra: true }, entry(401), { ...entry(3), exitCode: 1000 }, "nope", entry(4, { tail: "é".repeat(5000) }),
    ]);
    expect(result).toMatchObject({ stored: 2, refused: 4 });
    const stored = await readSetupJournal(w.table, scope);
    expect(JSON.stringify(stored)).not.toContain(fakeToken());
    expect(Buffer.byteLength(stored.find((e) => e.n === 4)!.tail)).toBeLessThanOrEqual(4096);
  });
  it("takes no more than a batch, and a run's journal is bounded", async () => {
    const w = await world();
    const many = Array.from({ length: SETUP_JOURNAL_BATCH_MAX + 5 }, (_, i) => entry(i + 1));
    expect(await appendSetupJournal(w.table, scope, many)).toEqual({ stored: SETUP_JOURNAL_BATCH_MAX, repeated: 0, refused: 5 });
    expect(readJournalEntry(entry(SETUP_JOURNAL_MAX_ENTRIES + 1 as never))).toBeUndefined();
  });
  it("keeps one run's entries apart from another's, and another project's", async () => {
    const w = await world();
    await appendSetupJournal(w.table, scope, [entry(1)]);
    expect(await readSetupJournal(w.table, { ...scope, taskId: randomUUID() })).toEqual([]);
    expect(await readSetupJournal(w.table, { ...scope, project: "other" })).toEqual([]);
  });
  it("moves the task's count up to the highest position, never down", async () => {
    const w = await world();
    await appendSetupJournal(w.table, scope, [entry(1), entry(2)]);
    expect(w.db.get(taskKey(TASK))).toMatchObject({ setupAgentProgress: { commands: 2 } });
    await appendSetupJournal(w.table, scope, [entry(1)]);
    expect(w.db.get(taskKey(TASK))).toMatchObject({ setupAgentProgress: { commands: 2 } });
    await appendSetupJournal(w.table, scope, [entry(5)]);
    expect(w.db.get(taskKey(TASK))).toMatchObject({ setupAgentProgress: { commands: 5 } });
  });
  it("does not touch a task that is not a setup run", async () => {
    const w = await world();
    const other = randomUUID();
    w.db.set({ ...taskKey(other), entityType: "DEVTASK", taskId: other, orgId, project, workspaceId: randomUUID() });
    await appendSetupJournal(w.table, { ...scope, taskId: other }, [entry(1)]);
    expect(w.db.get(taskKey(other))).not.toHaveProperty("setupAgentProgress");
  });
  it("a hostile host name in an entry is shown but is not an ask and not a grant", async () => {
    const w = await world();
    await appendSetupJournal(w.table, scope, [entry(1, { blockedHosts: ["evil.example.com"] })]);
    expect(w.db.find((item) => item.entityType === "SETUP_HOST_ASK")).toEqual([]);
    expect(w.db.get(projectRevisionKey(orgId, project, 2))).toBeUndefined();
    expect(w.db.get(setupAgentKey(orgId, project))).toBeDefined();
  });
});
