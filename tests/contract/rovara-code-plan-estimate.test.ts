// Plan 6 Task 7: plans with cost and time. A version 2 plan (workflow definition 1.1.0) says what changes, which files and how it will be tested, and shows the expected time to a
// pull request beside the expected cost. Both are estimates: the cost comes from the existing run-cost history (`estimateRun`, Plan 3 Task 34), the time from the project's recent
// task durations (`estimateDuration`), or from the defaults when there is too little history. Nothing here spends: a duration is one DynamoDB item, no model call.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { ROVARA_CODE_BUILD_GUIDANCE, ROVARA_CODE_PLAN_GUIDANCE } from "../../packages/contracts/src/agent-templates.js";
import { releaseFinishedTask } from "../../packages/broker/src/aws/developer-tasks.js";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { slackSectionTexts, workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { estimateDuration, noteDurationAtPullRequest, noteFinishedTaskDuration, noteTaskDuration, recordTaskDuration } from "../../packages/broker/src/rovara-code/duration.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import {
  PLAN_MISSING_CHANGE, PLAN_MISSING_FILES, PLAN_MISSING_TESTS, asksForPlanParts, planAnswerMissingParts, planAnswerProposesChecks, planMissingParts, parsePlanDocument, planDocumentMarkdown, readCanonicalPlan, type PlanDocument,
} from "../../packages/contracts/src/workflow-plan-document.js";
import { createWorkflowSnapshot, WorkflowSnapshotSchema } from "../../packages/contracts/src/task-workflow-node.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { builtinSettingsKey, durationHistoryKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { DEFAULT_RUN_MINUTES, DURATION_HISTORY_SIZE, formatMinutes } from "../../packages/contracts/src/rovara-code.js";
import { RUN_MINUTES_MAX, RunEstimateSchema, type RunEstimate } from "../../packages/contracts/src/spend.js";
import { DeveloperTaskResponseSchema } from "../../packages/contracts/src/index.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const NOW = "2026-10-25T12:00:00.000Z";
const TASK_ID = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  await loadSlackBroker();
});

// ---- history: the durations an estimate reads

const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state" });
const historyKey = (path: "QUICK" | "FULL", org: OrgId = TEST_ORG, project = "payments") => durationHistoryKey(org, project, path);
/** The project's duration history as `recordTaskDuration` leaves it: newest first. */
function seedDurations(db: FakeDynamoDb, path: "QUICK" | "FULL", durations: readonly unknown[], extra: { org?: OrgId; project?: string } = {}): void {
  db.set({ ...historyKey(path, extra.org, extra.project), entityType: "DURATION_HISTORY", durations: [...durations], version: 1 });
}
const estimateOf = (db: FakeDynamoDb, path: "QUICK" | "FULL", extra: { org?: OrgId; project?: string } = {}) =>
  estimateDuration(deps(db), { orgId: extra.org ?? TEST_ORG, project: extra.project ?? "payments", path });
const stored = (db: FakeDynamoDb, path: "QUICK" | "FULL" = "QUICK", org: OrgId = TEST_ORG) =>
  db.get(historyKey(path, org).pk, historyKey(path, org).sk) as { durations: number[]; version: number } | undefined;

describe("estimateDuration", () => {
  it("answers the defaults, labelled as defaults, when there is no history", async () => {
    const db = new FakeDynamoDb();
    expect(await estimateOf(db, "QUICK")).toEqual({ low: DEFAULT_RUN_MINUTES.QUICK.low, high: DEFAULT_RUN_MINUTES.QUICK.high, basis: "default", samples: 0 });
    expect(await estimateOf(db, "FULL")).toEqual({ low: DEFAULT_RUN_MINUTES.FULL.low, high: DEFAULT_RUN_MINUTES.FULL.high, basis: "default", samples: 0 });
    expect(await estimateOf(db, "QUICK")).toEqual({ low: 20, high: 45, basis: "default", samples: 0 });
    expect(await estimateOf(db, "FULL")).toEqual({ low: 60, high: 180, basis: "default", samples: 0 });
  });

  it("takes p50 and p80 by nearest rank over the durations", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [10, 20, 20, 30, 40, 90]);
    expect(await estimateOf(db, "QUICK")).toEqual({ low: 20, high: 40, basis: "history", samples: 6 });
  });

  it("does not depend on the order the durations are kept in", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [90, 40, 20, 10, 30, 20]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ low: 20, high: 40 });
  });

  it("rounds each figure up to five minutes, never to the nearest", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [11, 12, 13, 14, 16, 21]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ low: 15, high: 20 });
    seedDurations(db, "FULL", [31, 31, 31, 31, 31]);
    expect(await estimateOf(db, "FULL")).toMatchObject({ low: 35, high: 35 });
  });

  it("does not round a duration that is already a multiple of five up again", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [25, 25, 25, 25, 25]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ low: 25, high: 25 });
  });

  it("never answers less than five minutes", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [1, 1, 1, 1, 1, 1]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ low: 5, high: 5, basis: "history" });
  });

  it("uses the default below five samples", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [10, 20, 20, 30]);
    expect(await estimateOf(db, "QUICK")).toEqual({ low: 20, high: 45, basis: "default", samples: 4 });
    seedDurations(db, "QUICK", [10, 20, 20, 30, 40]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ basis: "history", samples: 5 });
  });

  it("reads only the newest twenty", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [...Array.from({ length: DURATION_HISTORY_SIZE }, () => 30), ...Array.from({ length: 5 }, () => 400)]);
    expect(await estimateOf(db, "QUICK")).toEqual({ low: 30, high: 30, basis: "history", samples: DURATION_HISTORY_SIZE });
  });

  it("is bounded: a duration above the most a run may be shown at counts as that most", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "FULL", [100_000, 100_000, 100_000, 100_000, 100_000]);
    const estimate = await estimateOf(db, "FULL");
    expect(estimate).toMatchObject({ low: RUN_MINUTES_MAX, high: RUN_MINUTES_MAX, basis: "history" });
    expect(RUN_MINUTES_MAX).toBe(480);
  });

  it("leaves out a stored value that is not a positive finite number", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [20, "x", Number.NaN, -3, 0, null, 25, 30, 35, 40]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ samples: 5, low: 30, high: 35 });
  });

  it("reads the history of this org, project and path only", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [100, 100, 100, 100, 100], { org: ORG_B });
    seedDurations(db, "QUICK", [100, 100, 100, 100, 100], { project: "other" });
    seedDurations(db, "FULL", [100, 100, 100, 100, 100]);
    expect(await estimateOf(db, "QUICK")).toMatchObject({ basis: "default", samples: 0 });
  });

  it("never puts the low end above the high end", async () => {
    const db = new FakeDynamoDb();
    for (const durations of [[5, 5, 5, 5, 5], [5, 500, 5, 500, 5], [7, 8, 9, 10, 11, 1000], [60, 61, 62, 63, 64]]) {
      seedDurations(db, "QUICK", durations);
      const estimate = await estimateOf(db, "QUICK");
      expect(estimate.low).toBeLessThanOrEqual(estimate.high);
    }
  });

  it("fails rather than answering a quieter default when the history can't be read", async () => {
    const db = new FakeDynamoDb();
    db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" } });
    await expect(estimateOf(db, "QUICK")).rejects.toThrow();
  });
});

describe("the time line", () => {
  it("is the range from formatMinutes", () => {
    expect(formatMinutes(20, 45)).toBe("about 20–45 minutes");
    expect(formatMinutes(60, 180)).toBe("about 1–3 hours");
  });

  it("shows one value when the bounds are equal, never 20–20", () => {
    expect(formatMinutes(20, 20)).toBe("about 20 minutes");
    expect(formatMinutes(120, 120)).toBe("about 2 hours");
    expect(formatMinutes(60, 60)).toBe("about 60 minutes");
    expect(formatMinutes(60, 80)).toBe("about 60–80 minutes");
    expect(formatMinutes(95, 100)).toBe("about 2 hours");
  });

  it("keeps a low end below an hour in minutes, across the 5 to 100 minute range", () => {
    expect(formatMinutes(5, 100)).toBe("about 5 minutes to 2 hours");
    expect(formatMinutes(30, 90)).toBe("about 30 minutes to 2 hours");
    expect(formatMinutes(60, 100)).toBe("about 1–2 hours");
    expect(formatMinutes(5, 89)).toBe("about 5–89 minutes");
    for (let low = 5; low <= 100; low += 5) {
      for (let high = low; high <= 100; high += 5) {
        const text = formatMinutes(low, high);
        expect(text, `${String(low)}-${String(high)}`).not.toMatch(/(\d+)[–]\1\b/u);
        expect(text.startsWith("about ")).toBe(true);
      }
    }
  });
});

// ---- recording what a task took

type TaskLike = Pick<DeveloperTaskRecord, "taskId" | "orgId" | "project" | "workflow" | "durationRecordedAt">;
const workflowOf = (extra: Record<string, unknown> = {}, createdAt = "2026-10-25T10:00:00.000Z", version: "1.0.0" | "1.1.0" = "1.1.0") =>
  WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: "a".repeat(64), now: createdAt, definitionVersion: version, path: "QUICK" }), ...extra });
function taskIn(db: FakeDynamoDb, overrides: { [K in keyof TaskLike]?: TaskLike[K] | undefined } & { id?: string } = {}): TaskLike {
  const taskId = overrides.id ?? overrides.taskId ?? randomUUID();
  const task = { taskId, orgId: TEST_ORG, project: "payments", workflow: workflowOf(), ...overrides } as unknown as TaskLike;
  db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", ...task, taskId });
  return task;
}
const markOf = (db: FakeDynamoDb, taskId: string) => (db.get(`DEVTASK#${taskId}`, "META") as { durationRecordedAt?: string } | undefined)?.durationRecordedAt;

describe("recordTaskDuration", () => {
  it("writes the minutes from the task's start to the end, rounded up, and the task's mark, and says it recorded", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db);
    expect(await recordTaskDuration(deps(db), task, { endedAt: "2026-10-25T10:25:01.000Z" })).toBe("recorded");
    expect(stored(db)).toMatchObject({ entityType: "DURATION_HISTORY", orgId: TEST_ORG, project: "payments", path: "QUICK", durations: [26], version: 1 });
    expect(markOf(db, task.taskId)).toBe("2026-10-25T10:25:01.000Z");
  });

  it("puts the newest first and keeps the newest twenty", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", Array.from({ length: DURATION_HISTORY_SIZE }, (_, index) => 100 + index));
    expect(await recordTaskDuration(deps(db), taskIn(db), { endedAt: "2026-10-25T10:30:00.000Z" })).toBe("recorded");
    const durations = stored(db)!.durations;
    expect(durations).toHaveLength(DURATION_HISTORY_SIZE);
    expect(durations[0]).toBe(30);
    expect(durations[1]).toBe(100);
    expect(durations.at(-1)).toBe(118);
    expect(stored(db)!.version).toBe(2);
  });

  it("counts a task once, however often its end is told", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db);
    const args = { endedAt: "2026-10-25T10:20:00.000Z" };
    expect(await recordTaskDuration(deps(db), task, args)).toBe("recorded");
    expect(await recordTaskDuration(deps(db), task, args)).toBe("already_recorded");
    // Even a copy of the task read before the mark was written.
    const unmarked: TaskLike = { ...task };
    delete unmarked.durationRecordedAt;
    expect(await recordTaskDuration(deps(db), unmarked, args)).toBe("already_recorded");
    expect(stored(db)!.durations).toEqual([20]);
  });

  it("writes at least a minute, and at most the bound", async () => {
    const db = new FakeDynamoDb();
    await recordTaskDuration(deps(db), taskIn(db), { endedAt: "2026-10-25T10:00:00.000Z" });
    await recordTaskDuration(deps(db), taskIn(db), { endedAt: "2026-11-25T10:00:00.000Z" });
    expect(stored(db)!.durations).toEqual([RUN_MINUTES_MAX, 1]);
  });

  it("writes nothing for an end before the start or a time it can't read", async () => {
    const db = new FakeDynamoDb();
    const early = taskIn(db);
    expect(await recordTaskDuration(deps(db), early, { endedAt: "2026-10-25T09:00:00.000Z" })).toBe("skipped");
    const broken = taskIn(db);
    expect(await recordTaskDuration(deps(db), broken, { endedAt: "not a time" })).toBe("skipped");
    expect(stored(db)).toBeUndefined();
    expect(markOf(db, early.taskId)).toBeUndefined();
    expect(markOf(db, broken.taskId)).toBeUndefined();
  });

  it("writes nothing for a version 1 task, a task with no org or workflow, or a path it has no history for", async () => {
    const db = new FakeDynamoDb();
    const endedAt = "2026-10-25T10:30:00.000Z";
    const v1 = taskIn(db, { workflow: workflowOf({}, "2026-10-25T10:00:00.000Z", "1.0.0") });
    const noOrg = taskIn(db, { orgId: undefined });
    const noWorkflow = taskIn(db, { workflow: undefined });
    for (const task of [v1, noOrg, noWorkflow]) expect(await recordTaskDuration(deps(db), task, { endedAt })).toBe("skipped");
    expect(stored(db)).toBeUndefined();
    expect(markOf(db, v1.taskId)).toBeUndefined();
  });

  it("keeps each path and each org's history apart", async () => {
    const db = new FakeDynamoDb();
    await recordTaskDuration(deps(db), taskIn(db), { endedAt: "2026-10-25T10:20:00.000Z" });
    await recordTaskDuration(deps(db), taskIn(db, { workflow: workflowOf({ path: "FULL", reviewPhase: "REQUIREMENTS" }) }), { endedAt: "2026-10-25T12:00:00.000Z" });
    await recordTaskDuration(deps(db), taskIn(db, { orgId: ORG_B }), { endedAt: "2026-10-25T10:40:00.000Z" });
    expect(stored(db, "QUICK")!.durations).toEqual([20]);
    expect(stored(db, "FULL")!.durations).toEqual([120]);
    expect(stored(db, "QUICK", ORG_B)!.durations).toEqual([40]);
  });

  it("writes the history and the mark in one transaction, with an expiry", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db);
    await recordTaskDuration(deps(db), task, { endedAt: "2026-10-25T10:20:00.000Z" });
    const transactions = db.transactions();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toHaveLength(2);
    expect((stored(db) as unknown as { indexExpiresAt: number }).indexExpiresAt).toBeGreaterThan(Date.parse("2026-10-25T10:20:00.000Z") / 1000);
  });

  it("loses no duration when two tasks end together: the one that meets a newer history reads it again", async () => {
    const db = new FakeDynamoDb();
    const a = taskIn(db);
    const b = taskIn(db);
    const results = await Promise.all([
      recordTaskDuration(deps(db), a, { endedAt: "2026-10-25T10:20:00.000Z" }),
      recordTaskDuration(deps(db), b, { endedAt: "2026-10-25T10:50:00.000Z" }),
    ]);
    expect(results).toEqual(["recorded", "recorded"]);
    expect([...stored(db)!.durations].sort((x, y) => x - y)).toEqual([20, 50]);
    expect(stored(db)!.version).toBe(2);
  });

  it("loses no duration when another task's write lands between the read and the write", async () => {
    const db = new FakeDynamoDb();
    seedDurations(db, "QUICK", [10]);
    const a = taskIn(db);
    const b = taskIn(db);
    let interleaved = false;
    const racing = { send: async (command: { constructor: { name: string } }) => {
      if (!interleaved && command.constructor.name === "TransactWriteCommand") {
        interleaved = true;
        await recordTaskDuration(deps(db), b, { endedAt: "2026-10-25T10:50:00.000Z" });
      }
      return db.send(command as never);
    } };
    expect(await recordTaskDuration({ documentClient: racing, tableName: "state" }, a, { endedAt: "2026-10-25T10:20:00.000Z" })).toBe("recorded");
    expect(stored(db)!.durations).toEqual([20, 50, 10]);
    expect(stored(db)!.version).toBe(3);
  });

  it("gives up with an error, writing nothing twice, when the history keeps changing", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db);
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException" }, times: 10 });
    await expect(recordTaskDuration(deps(db), task, { endedAt: "2026-10-25T10:20:00.000Z" })).rejects.toThrow();
    expect(markOf(db, task.taskId)).toBeUndefined();
  });
});

describe("noteTaskDuration", () => {
  it("never throws: a failure is logged and the next end tries again", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 10 });
    await expect(noteTaskDuration(deps(db), task, "2026-10-25T10:20:00.000Z")).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain("duration.not_recorded");
    log.mockRestore();
    expect(markOf(db, task.taskId)).toBeUndefined();
  });
});

describe("when a duration is owed", () => {
  const raw = (extra: Record<string, unknown>) => ({ ...workflowOf(), ...extra }) as never;

  it("is owed at the pull request only once every pull request the task needs is in (it waits for the merge)", async () => {
    const db = new FakeDynamoDb();
    const partway = taskIn(db, { workflow: raw({ stage: "PULL_REQUEST", state: "READY" }) });
    await noteDurationAtPullRequest(deps(db), partway.taskId, "2026-10-25T10:20:00.000Z");
    expect(stored(db)).toBeUndefined();
    expect(markOf(db, partway.taskId)).toBeUndefined();
    const done = taskIn(db, { workflow: raw({ stage: "WAIT_FOR_MERGE", state: "WAITING" }) });
    await noteDurationAtPullRequest(deps(db), done.taskId, "2026-10-25T10:20:00.000Z");
    expect(stored(db)!.durations).toEqual([20]);
    // A task that is gone is no failure.
    await expect(noteDurationAtPullRequest(deps(db), randomUUID(), "2026-10-25T10:20:00.000Z")).resolves.toBeUndefined();
  });

  it("is owed at the end only for a task that ran to the end: merged, or passed every step, or answered", async () => {
    const db = new FakeDynamoDb();
    const end = "2026-10-25T10:40:00.000Z";
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["merged", { stage: "MERGED", state: "COMPLETE", outcome: "MERGED" }, true],
      ["passed", { stage: "CLOSED", state: "COMPLETE", outcome: "PASSED" }, true],
      ["answered", { stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" }, true],
      ["rejected", { stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" }, false],
      ["closed", { stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" }, false],
      ["not finished", { stage: "MERGED", state: "RUNNING", outcome: "MERGED" }, false],
      ["merged stage, another outcome", { stage: "MERGED", state: "COMPLETE", outcome: "CLOSED" }, false],
    ];
    for (const [name, workflow, owed] of cases) {
      const task = taskIn(db, { workflow: raw({ ...workflow, updatedAt: end }) });
      await noteFinishedTaskDuration(deps(db), task);
      expect(markOf(db, task.taskId), name).toBe(owed ? end : undefined);
    }
  });

  it("is not owed again once the task is marked", async () => {
    const db = new FakeDynamoDb();
    const task = taskIn(db, { workflow: raw({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", updatedAt: "2026-10-25T10:40:00.000Z" }), durationRecordedAt: "2026-10-25T10:20:00.000Z" });
    await noteFinishedTaskDuration(deps(db), task);
    expect(stored(db)).toBeUndefined();
  });
});

// ---- the plan-ready message

describe("the plan-ready message", () => {
  const taskId = TASK_ID;
  const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: NOW };
  const workflowFor = (version: "1.0.0" | "1.1.0", path: "QUICK" | "FULL" = "QUICK", artifacts: unknown[] = [plan]) =>
    WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW, definitionVersion: version, path }), revision: 3, stage: "PLAN_REVIEW", state: "WAITING", artifacts });
  const estimate = (extra: Partial<RunEstimate> = {}): RunEstimate => ({ lowUsd: 2, highUsd: 4, runLimitUsd: 8, stopAtUsd: 8, basis: "history", samples: 6, minutes: { low: 20, high: 45, basis: "default", samples: 0 }, ...extra });
  const textOf = (runEstimate: RunEstimate | undefined, version: "1.0.0" | "1.1.0" = "1.1.0", agentName = "Rovara Code") =>
    workflowMessage({ taskId, workflow: workflowFor(version), ...(runEstimate === undefined ? {} : { runEstimate, agentName }) })?.text ?? "";

  it("says the estimated time to a pull request on its own line after the cost line", () => {
    expect(textOf(estimate())).toContain("Estimated cost: about $2–$4. Run limit: $8.\nEstimated time: about 20–45 minutes to a pull request.");
  });

  it("keeps the cost line, the time line, AgentX's plan check lines, the answers and the plan's checks together on one card, every Slack section within its limit (mainline #408 sync)", () => {
    const decisions = [{ id: "d1", question: "Which cache should hold the retry state?", answer: "Reuse the existing one" }];
    const checkLines = ["A browser test that a timed-out payment is retried once.", "A command that runs the unit tests of the payments package."];
    const selfCheckLines = ["Not every claim is proved by a check that runs code."];
    const message = workflowMessage({ taskId, workflow: workflowFor("1.1.0"), runEstimate: estimate(), agentName: "Rovara Code",
      documentLink: { url: "https://agentx.example.test/review/x/task?version=1" }, taskPageUrl: "https://agentx.example.test/review/x/task",
      structured: { claims: ["Payments that time out are retried."], claimCount: 3, decisionCount: 1, tiny: false, decisions, checkLines, selfCheckLines } })!;
    expect(message.text).toContain("Estimated cost: about $2–$4. Run limit: $8.\nEstimated time: about 20–45 minutes to a pull request.");
    expect(message.text).toContain("Not every claim is proved by a check that runs code.");
    expect(message.text).toContain("Answer: Reuse the existing one");
    expect(message.text).toContain("A browser test that a timed-out payment is retried once.");
    for (const section of slackSectionTexts(message.text)) expect(section.length).toBeLessThanOrEqual(2_800);
  });

  it("says hours for a long range", () => {
    expect(textOf(estimate({ minutes: { low: 60, high: 180, basis: "default", samples: 0 } }))).toContain("Estimated time: about 1–3 hours to a pull request.");
  });

  it("puts the time line after the max-per-run line, so the cost lines stay together", () => {
    const text = textOf(estimate({ stopAtUsd: 3 }), "1.1.0", "Ticket looker");
    expect(text).toContain("Estimated cost: about $2–$4. Run limit: $8.\nTicket looker's max per run is $3, so this run will stop at $3, before its run limit.\nEstimated time: about 20–45 minutes to a pull request.");
  });

  it("says no time for a version 1 task, whatever the estimate holds, and leaves its message as it was", () => {
    const text = textOf(estimate(), "1.0.0");
    expect(text).not.toContain("Estimated time");
    expect(text).toContain("Estimated cost: about $2–$4. Run limit: $8.");
    expect(textOf(estimate({ minutes: undefined }), "1.0.0")).toBe(text);
  });

  it("says no time when the estimate has none, and nothing at all when there is no estimate", () => {
    expect(textOf(estimate({ minutes: undefined }))).not.toContain("Estimated time");
    expect(textOf(undefined)).not.toContain("Estimated");
  });

  it("says nothing of time on a requirements or design document, as for cost", () => {
    const early = workflowFor("1.1.0", "FULL", [{ ...plan, id: "requirements-v1", type: "requirements" as const }]);
    const text = workflowMessage({ taskId, workflow: early, runEstimate: estimate(), agentName: "Rovara Code" })?.text ?? "";
    expect(text).toContain("is ready for your approval");
    expect(text).not.toContain("Estimated time");
  });
});

describe("the estimate on the task", () => {
  it("accepts a bounded range of minutes and nothing else", () => {
    const base = { lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 };
    expect(RunEstimateSchema.safeParse(base).success).toBe(true);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 20, high: 45, basis: "default", samples: 0 } }).success).toBe(true);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 45, high: 20, basis: "default", samples: 0 } }).success).toBe(false);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 0, high: 20, basis: "default", samples: 0 } }).success).toBe(false);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 20, high: RUN_MINUTES_MAX + 1, basis: "default", samples: 0 } }).success).toBe(false);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 20.5, high: 45, basis: "default", samples: 0 } }).success).toBe(false);
    expect(RunEstimateSchema.safeParse({ ...base, minutes: { low: 20, high: 45, basis: "default", samples: 0, extra: 1 } }).success).toBe(false);
  });

  it("is left out of the view an older client reads, and kept for one that reads version 2", () => {
    const view = { taskId: TASK_ID, title: "t", project: "payments", status: "RUNNING", startingRevision: 1, client: "c", shared: false, createdAt: NOW, updatedAt: NOW, events: [],
      workflow: workflowOf(), runEstimate: { lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0, minutes: { low: 20, high: 45, basis: "default", samples: 0 } } };
    const old = taskViewForClient(view as never, {});
    expect(old.runEstimate).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 });
    expect(taskViewForClient(view as never, { "x-agentx-task-view": "2" }).runEstimate).toMatchObject({ minutes: { low: 20 } });
    // A view with no workflow still has its estimate projected.
    expect(taskViewForClient({ ...view, workflow: undefined } as never, {}).runEstimate).not.toHaveProperty("minutes");
  });
});

// ---- the plan's required parts

const claim = (id: string, text: string, evidence?: PlanDocument["claims"][number]["evidence"]) => ({ id, text, ...(evidence === undefined ? {} : { evidence }) });
const planWith = (claims: PlanDocument["claims"], extra: Partial<PlanDocument> = {}): PlanDocument => planDocument({ claims, ...extra });
const CODE = [{ kind: "code" as const, path: "payments/src/charge.ts", startLine: 10, endLine: 24 }];

describe("planMissingParts", () => {
  it("names nothing for a plan with a change, a file and a test", () => {
    expect(planMissingParts(planWith([claim("1", "Timeouts are retried.", CODE), claim("2", "A test proves a timed-out charge is retried once.")]))).toEqual([]);
  });

  it("names nothing for a plan that says the request needs no code change (merge of Tasks 4 and 7)", () => {
    expect(planMissingParts({ ...planWith([]), noChangeNeeded: { answer: "Already handled.", sources: [] } })).toEqual([]);
  });

  it("asks for the test with the exact words when no claim says how the change is tested", () => {
    expect(planMissingParts(planWith([claim("1", "Timeouts are retried.", CODE)]))).toEqual(["The plan must say how the change will be tested."]);
    expect(PLAN_MISSING_TESTS).toBe("The plan must say how the change will be tested.");
  });

  it("counts a claim that names a test, anywhere in the tree, in any case", () => {
    for (const text of ["Unit tests cover the retry.", "TESTING: retry is asserted.", "Coverage of the timeout path is added.", "charge.spec.ts is extended with a timeout case.", "A test proves a timed-out payment is retried once and never charged twice.", "Nothing here is risky, but one extra test proves the retry is bounded."]) {
      expect(planMissingParts(planWith([{ ...claim("1", "Timeouts are retried.", CODE), children: [claim("1.1", text)] }])), text).toEqual([]);
    }
    for (const text of ["The latest change is shipped.", "Contest mode is added.", "Attestation is stored."]) {
      expect(planMissingParts(planWith([claim("1", text, CODE)])), text).toEqual([PLAN_MISSING_TESTS]);
    }
  });

  it("does not count a claim that says there is no test, or that only mentions a spec", () => {
    for (const text of ["No test needed.", "No tests are needed for this change.", "Existing tests are not touched.", "Tests aren't required here.", "This ships without tests.", "We never test this path.",
      "The spec says so.", "Nothing to test.", "The code is untested.", "Skip the tests."]) {
      expect(planMissingParts(planWith([claim("1", "Timeouts are retried.", CODE), claim("2", text)])), text).toEqual([PLAN_MISSING_TESTS]);
    }
    // A negation in another sentence of the claim doesn't cancel a test named in this one.
    expect(planMissingParts(planWith([claim("1", "Timeouts are retried.", CODE), claim("2", "No schema change. A test proves the retry.")]))).toEqual([]);
  });

  it("counts a proposed check as how the change is tested, as the worker and the broker both read it from the planner's answer", () => {
    const plan = planWith([claim("1", "Timeouts are retried.", CODE)]);
    const withChecks = planAnswer(plan, { checks: { checks: [{ label: "Unit", cwd: "payments", executable: "npm", args: ["test"], proves: ["1"] }] } });
    const none = planAnswer(plan, { checks: { checks: [], none_reason: "No tests exist here." } });
    expect(planAnswerMissingParts(withChecks, plan)).toEqual([]);
    expect(planAnswerMissingParts(none, plan)).toEqual([PLAN_MISSING_TESTS]);
    expect(planAnswerMissingParts(planAnswer(plan), plan)).toEqual([PLAN_MISSING_TESTS]);
  });

  it("asks for the files when no claim cites a real file or names one", () => {
    expect(planMissingParts(planWith([claim("1", "Timeouts are retried."), claim("2", "A test proves it.")]))).toEqual([PLAN_MISSING_FILES]);
    for (const text of ["Timeouts are retried in src/charge.ts.", "Add a retry to charge.ts.", "Edit ./scripts/run.sh to retry.", "Bump the version in package.json.", "Change the Dockerfile base image.", "Add a Makefile target.", "Edit packages/api/src/handlers/charge.test.tsx."]) {
      expect(planMissingParts(planWith([claim("1", text), claim("2", "A test proves it.")])), text).toEqual([]);
    }
  });

  it("does not take a word pair with a slash, a fraction or a link for a file", () => {
    for (const text of ["Retries are decided by the client/server handshake.", "The charge succeeds and/or fails.", "3/4 of the calls are retried.", "See https://example.com/a for the rule.", "See https://example.com/a/b.json for the rule.",
      "Use read/write access.", "Mention e.g. the gateway.", "The app is built on Node.js."]) {
      expect(planMissingParts(planWith([claim("1", text), claim("2", "A test proves it.")])), text).toEqual([PLAN_MISSING_FILES]);
    }
  });

  it("counts a cited `code` item as the files, but a sketch alone names none", () => {
    expect(planMissingParts(planWith([claim("1", "Add a helper.", [{ kind: "sketch", language: "ts", code: "export const x = 1;" }]), claim("2", "A test proves it.")]))).toEqual([PLAN_MISSING_FILES]);
    expect(planMissingParts(planWith([claim("1", "Add a helper in src/helper.ts.", [{ kind: "sketch", language: "ts", code: "export const x = 1;" }]), claim("2", "A test proves it.")]))).toEqual([]);
    expect(planMissingParts(planWith([claim("1", "Retry.", CODE), claim("2", "A test proves it.")]))).toEqual([]);
  });

  it("names the change when there are no claims, and every missing part together", () => {
    expect(planMissingParts({ ...planDocument(), claims: [] })).toEqual([PLAN_MISSING_CHANGE, PLAN_MISSING_FILES, PLAN_MISSING_TESTS]);
    expect(planMissingParts(planWith([claim("1", "Timeouts are retried.")]))).toEqual([PLAN_MISSING_FILES, PLAN_MISSING_TESTS]);
  });

  it("is what the planner is asked for, only when the broker asks for the parts", () => {
    const plain = planDocumentInstructions({ kind: "plan", path: "QUICK", anchors: true });
    const asked = planDocumentInstructions({ kind: "plan", path: "QUICK", anchors: true, requiredParts: true });
    expect(asksForPlanParts(plain)).toBe(false);
    expect(asksForPlanParts(asked)).toBe(true);
    expect(asked.startsWith(plain.slice(0, 200))).toBe(true);
    // Requirements and design documents are not coding plans.
    expect(asksForPlanParts(planDocumentInstructions({ kind: "requirements", path: "FULL", requiredParts: true }))).toBe(false);
    expect(asksForPlanParts(planDocumentInstructions({ kind: "design", path: "FULL", requiredParts: true }))).toBe(false);
    expect(asksForPlanParts(planDocumentInstructions({ kind: "plan", path: "FULL", requiredParts: true }))).toBe(true);
  });

  it("lets the worker count the checks a planner's answer proposes, without validating them", () => {
    const plan = planWith([claim("1", "Timeouts are retried.", CODE)]);
    expect(planAnswerProposesChecks(planAnswer(plan, { checks: { checks: [{ label: "Unit", cwd: "payments", executable: "npm", args: ["test"], proves: ["1"] }] } }))).toBe(true);
    expect(planAnswerProposesChecks(planAnswer(plan, { checks: { checks: [], none_reason: "No tests exist." } }))).toBe(false);
    expect(planAnswerProposesChecks(planAnswer(plan))).toBe(false);
    expect(planAnswerProposesChecks("no block at all")).toBe(false);
  });

  it("reads the answer of a plan that has all three parts", () => {
    const answer = planAnswer(planWith([claim("1", "Timeouts are retried.", CODE), claim("2", "A test proves a timed-out charge is retried once.")]));
    const parsed = parsePlanDocument(answer, { kind: "plan" });
    expect(parsed.ok && planAnswerMissingParts(answer, parsed.plan)).toEqual([]);
  });
});

// ---- the flows

const TESTED_PLAN = planDocument({
  claims: [
    { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }] },
    { id: "2", text: "A test proves a timed-out payment is retried once and never charged twice." },
  ],
});

/** GitHub as the broker sees it when a pull request opens: every commit has the checked tree, and the pull request is #42. */
const githubGateway = (workflows: Record<string, string> = {}, readerFails = false) => ({
  /** The org's read-only reader of the default branch (Plan 6 plan quality): the workflow files the repository has. */
  agentRepositoryReader: vi.fn(async () => {
    if (readerFails) throw new Error("GitHub is down");
    return {
      defaultBranch: "main", commit: "e".repeat(40),
      list: async (path: string) => {
        const entries = Object.keys(workflows).filter((name) => name.startsWith(`${path}/`)).map((name) => ({ name: name.slice(path.length + 1), path: name, type: "file" as const, sha: "a".repeat(40), size: 10 }));
        return entries.length === 0 ? undefined : { entries, truncated: false };
      },
      read: async (path: string) => {
        const text = workflows[path];
        return text === undefined ? undefined : { sha: "a".repeat(40), size: text.length, text };
      },
    };
  }),
  reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
  getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
  getPullRequest: vi.fn(async (_url: string, number: number) => ({ number, url: "https://github.com/example/demo/pull/42", state: "open" as const, headBranch: "x", baseBranch: "main", headCommit: "d".repeat(40), title: "t", body: "" })),
  updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => true),
  getPullRequestFeedback: vi.fn(async (_url: string, number: number) => ({ pullRequest: { number, url: "https://github.com/example/demo/pull/42", state: "open" as const, headBranch: "x", baseBranch: "main", headCommit: "d".repeat(40), title: "t", body: "", headTreeSha: "b".repeat(40) }, comments: [], threads: [] })),
});

async function world(options: { v2?: boolean; proxy?: boolean; workflows?: Record<string, string>; readerFails?: boolean } = {}) {
  const access = options.proxy === false ? undefined : fakeModelAccess();
  const gateway = githubGateway(options.workflows, options.readerFails);
  const h = await createSingleAnswerPlanBroker({
    brokerExtra: { agents: {}, githubPullRequests: gateway, ...(access === undefined ? {} : { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true }) },
  });
  if (access !== undefined) {
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
  }
  if (options.v2 === true) {
    const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  }
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & {
    workspaceId: string; runEstimate?: RunEstimate; planUnreadable?: { errors: string[] }; durationRecordedAt?: string;
    workflow: { revision: number; stage: string; state: string; blockReason?: string; definitionVersion: string; artifacts: Array<{ sha256: string }> };
  };
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const planOperation = (workspaceId: string) => operations(workspaceId).filter((item) => item.workflowMode === "PLAN").at(-1)!;
  const promptOf = (operationId: unknown) => (h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { prompt: string } }).payload.prompt;
  const start = async (path: "QUICK" | "FULL" = "QUICK"): Promise<{ taskId: string; workspaceId: string }> => {
    if (options.v2 === true) {
      const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path });
      expect(reply.status, JSON.stringify(reply.body)).toBe(202);
      const taskId = String((reply.body.task as { taskId: string }).taskId);
      return { taskId, workspaceId: meta(taskId).workspaceId };
    }
    const reply = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: path });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = String((reply.body.task as { taskId: string }).taskId);
    return { taskId, workspaceId: meta(taskId).workspaceId };
  };
  const finishPrepare = async (workspaceId: string) => h.finish(workspaceId, String(operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  const finishPlanning = async (workspaceId: string, plan: PlanDocument = TESTED_PLAN, answer: string = planAnswer(plan)) => {
    const operationId = String(planOperation(workspaceId).id);
    await h.artifact(workspaceId, operationId, "plan.md", answer);
    await h.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    // Plan 6 Task 8: a version 2 coding plan is checked by a second model before it reaches the person; here the check finds nothing to say.
    const taskId = (h.db.find((item) => item.entityType === "DEVELOPER_TASK" && item.workspaceId === workspaceId)[0] as { taskId: string }).taskId;
    if (meta(taskId).workflow.stage === "PLAN_CRITIQUE") {
      const check = operations(workspaceId).filter((item) => item.workflowMode === "PLAN_CRITIQUE").at(-1)!;
      await h.artifact(workspaceId, String(check.id), "plan-critique.md", "```rovara-plan-critique\n{\"verdict\":\"ok\",\"points\":[]}\n```\n");
      await h.finish(workspaceId, String(check.id), "SUCCEEDED", { result: { workflowMode: "PLAN_CRITIQUE" } });
    }
  };
  const planned = async (path: "QUICK" | "FULL" = "QUICK", plan: PlanDocument = TESTED_PLAN) => {
    const started = await start(path);
    await finishPrepare(started.workspaceId);
    await finishPlanning(started.workspaceId, plan);
    return started;
  };
  return { h, access, gateway, meta, operations, planOperation, promptOf, start, finishPrepare, finishPlanning, planned };
}

describe("a version 2 plan that reaches review", () => {
  it("carries the default time range, labelled a default, beside the cost range", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "PLAN_REVIEW", state: "WAITING" });
    expect(t.meta(taskId).runEstimate).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0, minutes: { low: 20, high: 45, basis: "default", samples: 0 } });
  });

  it("estimates the time from this project's recent durations, and the cost as before", async () => {
    const t = await world({ v2: true });
    seedDurations(t.h.db, "QUICK", [10, 20, 20, 30, 40, 90]);
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate).toMatchObject({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, minutes: { low: 20, high: 40, basis: "history", samples: 6 } });
  });

  it("gives a Full task the Full default once the coding plan is made", async () => {
    const t = await world({ v2: true });
    const { taskId, workspaceId } = await t.start("FULL");
    await t.finishPrepare(workspaceId);
    await t.finishPlanning(workspaceId);
    expect(t.meta(taskId).runEstimate).toBeUndefined();
    for (let phase = 0; phase < 2; phase += 1) {
      const workflow = t.meta(taskId).workflow;
      expect((await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: workflow.artifacts.at(-1)!.sha256, acknowledgedRunLimitUsd: (t.meta(taskId) as { runEstimate?: { runLimitUsd?: number } }).runEstimate?.runLimitUsd })).status).toBe(200);
      await t.finishPlanning(workspaceId);
    }
    expect(t.meta(taskId).runEstimate).toMatchObject({ minutes: { low: 60, high: 180, basis: "default", samples: 0 } });
  });

  it("shows the time line in the plan-ready message", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    const record = t.meta(taskId);
    const message = workflowMessage({ taskId, workflow: record.workflow as never, runEstimate: record.runEstimate!, agentName: "Rovara Code" })?.text ?? "";
    expect(message).toContain("Estimated cost: about $1–$3. Run limit: $6.\nEstimated time: about 20–45 minutes to a pull request.");
  });

  it("makes no estimate at all on an install without a model proxy, as before", async () => {
    const t = await world({ v2: true, proxy: false });
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate).toBeUndefined();
  });

  it("asks the planner for the change, the files and the tests", async () => {
    const t = await world({ v2: true });
    const { workspaceId } = await t.start("QUICK");
    await t.finishPrepare(workspaceId);
    expect(asksForPlanParts(t.promptOf(t.planOperation(workspaceId).id))).toBe(true);
  });

  it("stores a plan that has the three parts, with nothing to retry", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).planUnreadable).toBeUndefined();
    expect(t.meta(taskId).workflow.state).toBe("WAITING");
  });

  it("blocks a plan with no test claim as unreadable, naming the exact words for Retry planning, and stores no estimate", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK", planDocument());
    const record = t.meta(taskId);
    expect(record.workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "the plan couldn't be read" });
    expect(record.workflow.artifacts).toHaveLength(0);
    expect(record.planUnreadable?.errors).toEqual([PLAN_MISSING_TESTS]);
    expect(record.runEstimate).toBeUndefined();
  });

  it("reads a proposed check the way the worker does, so a plan the worker let through is never blocked for its tests", async () => {
    const t = await world({ v2: true });
    const { taskId, workspaceId } = await t.start("QUICK");
    await t.finishPrepare(workspaceId);
    const operationId = String(t.planOperation(workspaceId).id);
    const plan = planDocument({ claims: [{ id: "1", text: "Timeouts are retried.", evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 24 }] }] });
    // The only test coverage is a check whose directory the project doesn't have: the worker counts it as proposed, and so does the broker.
    await t.h.artifact(workspaceId, operationId, "plan.md", planAnswer(plan, { checks: { checks: [{ label: "Unit", cwd: "nowhere", executable: "npm", args: ["test"], proves: ["1"] }] } }));
    await t.h.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    expect(t.meta(taskId).planUnreadable?.errors ?? []).not.toContain(PLAN_MISSING_TESTS);
  });

  it("blocks a plan with no file, naming it", async () => {
    const t = await world({ v2: true });
    const noFile = planDocument({ claims: [{ id: "1", text: "Timeouts are retried." }, { id: "2", text: "A test proves it." }] });
    const { taskId } = await t.planned("QUICK", noFile);
    expect(t.meta(taskId).planUnreadable?.errors).toEqual([PLAN_MISSING_FILES]);
  });

  it("asks only a coding plan for the parts: a Full task's requirements document needs none", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("FULL", planDocument());
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });
});

// ---- plan quality: the repository's CI checks in the plan's Checks section

const CI_WORKFLOW = { ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - name: Lint and type-check\n        run: npm run lint\n      - run: npm test\n" };
const PROJECT_NPM_TEST = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };

describe("a version 2 plan's Checks section", () => {
  /** A planned task whose project requires `npm test`, with the stored plan's markdown and the checks the owner would approve. */
  async function planWithPolicy(options: Parameters<typeof world>[0], plan: PlanDocument = TESTED_PLAN, answer?: (plan: PlanDocument) => string) {
    const t = await world({ v2: true, ...options });
    const { taskId, workspaceId } = await t.start("QUICK");
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [PROJECT_NPM_TEST], optional: [], selectedOptionalIds: [] } } });
    await t.finishPrepare(workspaceId);
    await t.finishPlanning(workspaceId, plan, answer === undefined ? planAnswer(plan) : answer(plan));
    const workflow = t.meta(taskId).workflow as unknown as { artifacts: Array<{ objectKey: string }>; checkPolicy?: { proposed?: Array<{ label: string; command: { executable: string; args: string[] } }> }; state: string };
    const stored = [...t.h.s3.objects.entries()].find(([key]) => key === workflow.artifacts.at(-1)?.objectKey)?.[1];
    const parsed = stored === undefined ? undefined : readCanonicalPlan(String(stored));
    return { t, taskId, workflow, plan: parsed, markdown: parsed === undefined ? "" : planDocumentMarkdown(parsed, { kind: "plan", version: 1, sha256: "a".repeat(64) }) };
  }
  const commands = (workflow: Awaited<ReturnType<typeof planWithPolicy>>["workflow"]) => (workflow.checkPolicy?.proposed ?? []).map((check) => [check.label, check.command.executable, ...check.command.args].join(" "));

  it("lists the CI's lint as a proposed check and the npm test the project already runs as a project check, though the planner proposed neither", async () => {
    const { workflow, plan, markdown } = await planWithPolicy({ workflows: CI_WORKFLOW });
    expect(workflow.state).toBe("WAITING");
    expect(commands(workflow)).toEqual(["CI: Lint and type-check npm run lint"]);
    expect(plan?.checks?.alsoRun).toEqual([PROJECT_NPM_TEST]);
    expect(markdown.slice(markdown.indexOf("## Checks"), markdown.indexOf("## Decisions")).trimEnd().split("\n")).toEqual([
      "## Checks",
      "- CI: Lint and type-check: `npm run lint` in `repo/demo`",
      "- npm test: `npm test` in `repo/demo` (a project check; it always runs)",
    ]);
  });

  it("keeps the planner's own checks first and does not repeat a command it proposed", async () => {
    const own = (plan: PlanDocument) => planAnswer(plan, { checks: { checks: [{ label: "Lint", cwd: "repo/demo", executable: "npm", args: ["run", "lint"], proves: ["1"] }] } });
    const { workflow } = await planWithPolicy({ workflows: CI_WORKFLOW }, TESTED_PLAN, own);
    expect(commands(workflow)).toEqual(["Lint npm run lint"]);
  });

  it("still lists the project's checks when the repository has no workflows or GitHub can't be read: the plan is never held up", async () => {
    for (const options of [{}, { workflows: CI_WORKFLOW, readerFails: true }]) {
      const { workflow, plan } = await planWithPolicy(options);
      expect(workflow.state, JSON.stringify(options)).toBe("WAITING");
      expect(commands(workflow)).toEqual([]);
      expect(plan?.checks?.alsoRun).toEqual([PROJECT_NPM_TEST]);
    }
  });

  it("does not let a CI check stand in for the test the plan must name: a plan with no test claim is still unreadable", async () => {
    const { t, taskId } = await planWithPolicy({ workflows: CI_WORKFLOW }, planDocument());
    expect(t.meta(taskId).planUnreadable?.errors).toEqual([PLAN_MISSING_TESTS]);
  });

  it("is as it was for a version 1 plan: no CI checks, no project checks listed, and no read of GitHub", async () => {
    const t = await world({ workflows: CI_WORKFLOW });
    const { taskId, workspaceId } = await t.start("QUICK");
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [PROJECT_NPM_TEST], optional: [], selectedOptionalIds: [] } } });
    await t.finishPrepare(workspaceId);
    await t.finishPlanning(workspaceId);
    const workflow = t.meta(taskId).workflow as unknown as { checkPolicy?: { proposed?: unknown[] }; artifacts: Array<{ objectKey: string }> };
    expect(workflow.checkPolicy?.proposed ?? []).toEqual([]);
    const plan = readCanonicalPlan(String(t.h.s3.objects.get(workflow.artifacts.at(-1)!.objectKey)));
    expect(plan?.checks).not.toHaveProperty("alsoRun");
    expect(t.gateway.agentRepositoryReader).not.toHaveBeenCalled();
  });
});

describe("the plan-quality guidance reaches the prompts", () => {
  /** A task taken through its plan to the build step's operation, with the plan and build prompts. */
  async function prompts(v2: boolean) {
    const t = await world({ v2 });
    const { taskId, workspaceId } = await t.start("QUICK");
    await t.finishPrepare(workspaceId);
    const planPrompt = t.promptOf(t.planOperation(workspaceId).id);
    await t.finishPlanning(workspaceId);
    const digest = t.meta(taskId).workflow.artifacts.at(-1)!.sha256;
    const approved = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: t.meta(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest, acknowledgedRunLimitUsd: (t.meta(taskId) as { runEstimate?: { runLimitUsd?: number } }).runEstimate?.runLimitUsd });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const build = t.operations(workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    return { planPrompt, buildPrompt: t.promptOf(build.id) };
  }

  it("tells a version 2 planner and builder, each in the step's own words, and adds nothing else to either", async () => {
    const { planPrompt, buildPrompt } = await prompts(true);
    expect(planPrompt).toContain(ROVARA_CODE_PLAN_GUIDANCE);
    expect(planPrompt).not.toContain(ROVARA_CODE_BUILD_GUIDANCE);
    expect(buildPrompt).toContain(ROVARA_CODE_BUILD_GUIDANCE);
    expect(buildPrompt).not.toContain(ROVARA_CODE_PLAN_GUIDANCE);
  });

  it("tells a version 1 task's planner and builder nothing of it", async () => {
    const { planPrompt, buildPrompt } = await prompts(false);
    for (const prompt of [planPrompt, buildPrompt]) {
      expect(prompt).not.toContain(ROVARA_CODE_PLAN_GUIDANCE);
      expect(prompt).not.toContain(ROVARA_CODE_BUILD_GUIDANCE);
      expect(prompt).not.toContain("Number()");
    }
  });
});

describe("a version 1 plan that reaches review", () => {
  it("is as before: no time, no required parts, and the planner's prompt without the parts", async () => {
    const t = await world();
    const { taskId, workspaceId } = await t.start("QUICK");
    await t.finishPrepare(workspaceId);
    expect(asksForPlanParts(t.promptOf(t.planOperation(workspaceId).id))).toBe(false);
    await t.finishPlanning(workspaceId, planDocument());
    expect(t.meta(taskId).workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN_REVIEW", state: "WAITING" });
    expect(t.meta(taskId).runEstimate).toEqual({ lowUsd: 1, highUsd: 3, runLimitUsd: 6, stopAtUsd: 6, basis: "default", samples: 0 });
  });
});

// ---- when a task's duration is written

describe("the duration of a task", () => {
  const durationsOf = (t: Awaited<ReturnType<typeof world>>, path: "QUICK" | "FULL" = "QUICK") => stored(t.h.db, path)?.durations;
  const releaseOf = (t: Awaited<ReturnType<typeof world>>, taskId: string) =>
    releaseFinishedTask({ tableName: "state", actions: t.h.actions, documentClient: t.h.db }, t.meta(taskId) as unknown as DeveloperTaskRecord);
  const settle = (t: Awaited<ReturnType<typeof world>>, taskId: string, workflow: Record<string, unknown>) => {
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, ...workflow } });
  };

  it("is written when the pull request opens, from the task's start, and the task is marked", async () => {
    const t = await world({ v2: true });
    const flow = await publishedTask(t);
    const record = t.meta(flow.taskId);
    expect(record.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const minutes = durationsOf(t)!;
    expect(minutes).toHaveLength(1);
    expect(minutes[0]).toBeGreaterThanOrEqual(1);
    expect(record.durationRecordedAt).toEqual(expect.any(String));
  });

  it("is not written for a version 1 task", async () => {
    const t = await world();
    const flow = await publishedTask(t);
    expect(t.meta(flow.taskId).workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "WAIT_FOR_MERGE" });
    expect(durationsOf(t)).toBeUndefined();
    expect(t.meta(flow.taskId).durationRecordedAt).toBeUndefined();
  });

  it("is not written again when the task merges after its pull request opened", async () => {
    const t = await world({ v2: true });
    const flow = await publishedTask(t);
    const before = durationsOf(t)!;
    settle(t, flow.taskId, { stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: undefined });
    await releaseOf(t, flow.taskId);
    expect(durationsOf(t)).toEqual(before);
  });

  it("is written when a task merged before its duration was (the pull request's write was lost), dated by its last change", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, createdAt: "2026-10-25T10:00:00.000Z", stage: "MERGED", state: "COMPLETE", outcome: "MERGED", updatedAt: "2026-10-25T10:45:00.000Z", artifacts: record.workflow.artifacts } });
    await releaseOf(t, taskId);
    expect(durationsOf(t)).toEqual([45]);
    expect(t.meta(taskId).durationRecordedAt).toBe("2026-10-25T10:45:00.000Z");
    // A second release counts nothing.
    await releaseOf(t, taskId);
    expect(durationsOf(t)).toEqual([45]);
  });

  it("is written when a program passed every step, or the question was answered", async () => {
    for (const outcome of ["PASSED", "ANSWERED"] as const) {
      const t = await world({ v2: true });
      const { taskId } = await t.planned("QUICK");
      const record = t.meta(taskId);
      // A program that passed every step is released when its owner closes the task; an answered question is released as soon as it ends.
      t.h.db.set({ ...record, ...(outcome === "PASSED" ? { closedAt: "2026-10-25T11:00:00.000Z" } : {}),
        workflow: { ...record.workflow, createdAt: "2026-10-25T10:00:00.000Z", stage: "CLOSED", state: "COMPLETE", outcome, updatedAt: "2026-10-25T10:30:00.000Z" } });
      await releaseOf(t, taskId);
      expect(durationsOf(t), outcome).toEqual([30]);
    }
  });

  it("is not written for a task whose plan was rejected or that was closed", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, createdAt: "2026-10-25T10:00:00.000Z", stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED", updatedAt: "2026-10-25T10:30:00.000Z" } });
    await releaseOf(t, taskId);
    expect(durationsOf(t)).toBeUndefined();
  });

  it("does not fail the release when the duration can't be written, and tries again on the next", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    const record = t.meta(taskId);
    t.h.db.set({ ...record, workflow: { ...record.workflow, createdAt: "2026-10-25T10:00:00.000Z", stage: "MERGED", state: "COMPLETE", outcome: "MERGED", updatedAt: "2026-10-25T10:45:00.000Z" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    t.h.db.injectFault({ command: "TransactWriteCommand", match: (input: unknown) => JSON.stringify(input).includes("DURATION_HISTORY"), error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    await expect(releaseOf(t, taskId)).resolves.toBeDefined();
    log.mockRestore();
    expect(durationsOf(t)).toBeUndefined();
    expect(t.meta(taskId).durationRecordedAt).toBeUndefined();
    // The next release tries again and counts the task.
    await releaseOf(t, taskId);
    expect(durationsOf(t)).toEqual([45]);
  });
});

/** A v2 (or v1) Quick task taken from plan approval through the checks and reviews to an opened pull request. */
async function publishedTask(t: Awaited<ReturnType<typeof world>>) {
  const started = await t.start("QUICK");
  const { taskId, workspaceId } = started;
  const record = t.meta(taskId);
  t.h.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  await t.finishPrepare(workspaceId);
  await t.finishPlanning(workspaceId);
  const digest = t.meta(taskId).workflow.artifacts.at(-1)!.sha256;
  const approved = await t.h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: t.meta(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest, acknowledgedRunLimitUsd: (t.meta(taskId) as { runEstimate?: { runLimitUsd?: number } }).runEstimate?.runLimitUsd });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const implementation = t.operations(workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const checks = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
  await t.h.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks } });
  const review = t.operations(workspaceId).find((item) => item.workflowMode === "REVIEW")!;
  const recordedAt = new Date().toISOString();
  await t.h.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
    workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: review.id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt })) } });
  const publish = t.operations(workspaceId).find((item) => item.kind === "publish") as { id: string; publication: { headBranch: string } };
  t.h.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "PULL_REQUEST#demo#000000000042", entityType: "PULL_REQUEST", workspaceId, repository: "demo", repositoryUrl: "https://github.com/example/demo.git", number: 42,
    url: "https://github.com/example/demo/pull/42", state: "open", headBranch: publish.publication.headBranch, baseBranch: "main", expectedHeadCommit: "d".repeat(40), title: "Fix retry", body: "",
    createdByOperationId: publish.id, updatedAt: new Date().toISOString() });
  await t.h.finish(workspaceId, publish.id, "SUCCEEDED", { result: { repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headBranch: publish.publication.headBranch, baseBranch: "main", commit: "d".repeat(40), checks: [], reconciled: false } });
  return started;
}

// ---- round trip (bug E): what the broker really answers, read by the schema each client reads it with

describe("round trip: the task view of a plan with an estimate, as the broker sends it", () => {
  it("is read by the clients' task schema, with the time range for a version 2 client and without it for one that sends no header", async () => {
    const t = await world({ v2: true });
    const { taskId } = await t.planned("QUICK");
    expect(t.meta(taskId).runEstimate?.minutes).toBeDefined();
    const full = await t.h.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`, undefined, { "x-agentx-task-view": "2" });
    const old = await t.h.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    for (const reply of [full, old]) {
      expect(reply.status).toBe(200);
      expect(typeof reply.body.requestId).toBe("string");
      const parsed = DeveloperTaskResponseSchema.safeParse(reply.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect((full.body.task as { runEstimate: RunEstimate }).runEstimate.minutes).toMatchObject({ low: 20, high: 45 });
    // A client that sends no header has a strict estimate with no place for the time range: it is never sent one.
    expect((old.body.task as { runEstimate: RunEstimate }).runEstimate).not.toHaveProperty("minutes");
    expect(RunEstimateSchema.safeParse((full.body.task as { runEstimate: unknown }).runEstimate).success).toBe(true);
  });
});
