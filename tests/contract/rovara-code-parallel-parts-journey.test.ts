import { describe, expect, it } from "vitest";
import { AGENT_WORKER_OUTDATED, PARALLEL_PARTS_MAX, WORKER_INVOCATION_FEATURES, taskGraphDigest } from "@agentx/contracts";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { createWorkflowE2E, type WorkflowE2E } from "../support/workflow-e2e.js";
import { workspaceLimitsKey } from "../../packages/broker/src/developer/limits.js";
import { TEST_ORG } from "../support/orgs.js";
import { assertJourneyInvariants, registerJourneyInvariants } from "../support/workflow-e2e-invariants.js";

registerJourneyInvariants();

// A Rovara Code v2 task (definition version 1.1.0) whose approved plan has independent parts, through the real broker, the real dispatch and the real worker. The plan's first
// two parts do not depend on each other; the third needs both. Version 2 tasks need no install switch for ordered work; version 1 keeps AGENTX_WORKFLOW_DEPENDENCIES_ENABLED.

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const ITEM_C = "33333333-3333-4333-8333-333333333333";

function graphFor(taskId: string) {
  return { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: ITEM_A, title: "A: create formatter", description: "Create the shared formatter function.", repository: "demo", dependsOn: [] },
    { id: ITEM_B, title: "B: create clock", description: "Create the shared clock function.", repository: "demo", dependsOn: [] },
    { id: ITEM_C, title: "C: integration assertion", description: "Add an executable integration assertion over A and B.", repository: "demo", dependsOn: [ITEM_A, ITEM_B] },
  ] };
}

function fullPlan(taskId: string, latest: string): string {
  const cleanClaims = [{ id: "1", text: "Users can create and use a greeting service in src/greeting.ts, covered by a test in src/greeting.test.ts." }];
  if (/writing the requirements/i.test(latest)) return planAnswer(planDocument({ title: "Requirements", claims: cleanClaims }));
  if (/writing the design/i.test(latest)) return planAnswer(planDocument({ title: "Design", claims: cleanClaims }));
  return planAnswer(planDocument({ title: "Coding plan", claims: cleanClaims, workBreakdown: graphFor(taskId) }));
}

/** Parts work in a folder of their own whose root is the repository; a part run one after another works in the workspace, where the repository is repo/demo. */
const where = (latest: string, file: string) => `${/built at the same time/.test(latest) ? "" : "repo/demo/"}${file}`;

function itemEdits(latest: string) {
  const title = latest.match(/Current approved item[^\n]*\nTitle: (.*)/)?.[1];
  if (title === "A: create formatter") return [{ path: where(latest, "formatter.mjs"), content: "export const formatGreeting = (name) => `Hello, ${name}`;\n" }];
  if (title === "B: create clock") return [{ path: where(latest, "clock.mjs"), content: "export const today = () => '2026-10-26';\n" }];
  if (title === "C: integration assertion") return [{ path: where(latest, "integration.mjs"), content: "import assert from 'node:assert/strict';\nimport { formatGreeting } from './formatter.mjs';\nimport { today } from './clock.mjs';\nassert.equal(formatGreeting('Ada'), 'Hello, Ada');\nassert.equal(today(), '2026-10-26');\n" }];
  return [];
}

function modelFor(context: { current?: WorkflowE2E }) {
  return { plan: (latest: string) => fullPlan(context.current!.taskId(), latest), edits: itemEdits };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The parts a run built one after another, in order: they share one session, so each shows only in the coding turns. */
const itemTitlesInOrder = (e2e: WorkflowE2E, after = 0) => [...new Set(e2e.turns.slice(after).filter((turn) => turn.role === "CODER" && /Current approved item/.test(turn.userText)).map((turn) => turn.userText.match(/Title: (.*)/)?.[1] ?? ""))];
/** One entry per coding session that was given a part, in the order the sessions opened. */
const itemTitles = (e2e: WorkflowE2E) => e2e.prompts.filter((prompt) => /Current approved item/.test(prompt)).map((prompt) => prompt.match(/Title: (.*)/)?.[1] ?? "");
const implementInvocations = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT");
const dependenciesOf = (invocation: ReturnType<typeof implementInvocations>[number]) => (invocation.kind === "task" ? invocation.payload.workflowDependencies : undefined);

/** Starts a Full task, and makes it a version 2 task before its plans are approved, as an org on Rovara Code version 2 would have it. */
async function startFull(e2e: WorkflowE2E, version: "1.0.0" | "1.1.0"): Promise<void> {
  expect(await e2e.mention("Add a shared greeting service")).toBe(200);
  expect(await e2e.mention("full please", { type: "message" })).toBe(200);
  await e2e.settle();
  if (version === "1.1.0") {
    const key = { pk: `DEVTASK#${e2e.taskId()}`, sk: "META" };
    const task = e2e.db.get(key.pk, key.sk) as { workflow: Record<string, unknown> };
    e2e.db.set({ ...key, ...task, workflow: { ...task.workflow, definitionVersion: "1.1.0" } });
  }
}

async function approveAll(e2e: WorkflowE2E): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    expect(e2e.slack.lastPostWithAction("agentx_workflow_approve")).toBeDefined();
    const viewCount = e2e.slack.views.length;
    await e2e.click("agentx_workflow_approve");
    if (e2e.slack.views.length > viewCount) await e2e.submitView();
    await e2e.settle();
  }
}

type Progress = { itemId: string; sequence: number; state: string; baseTreeSha: string; candidateTreeSha?: string; integratedTreeSha?: string; operationId: string };
const progressOf = (e2e: WorkflowE2E): Progress[] => ((e2e.workflow() as unknown as { workflowDependenciesProgress?: Progress[] }).workflowDependenciesProgress ?? []);
const READINESS = [{ cwd: "repo/demo", executable: "node", args: ["integration.mjs"], timeoutSeconds: 30 }];

describe("a Rovara Code v2 task builds the independent parts of its plan side by side", () => {
  it("runs A and B together, then C on both, merges them, and opens one pull request on the integrated tree", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ readiness: READINESS, realProjectCommands: true, model: modelFor(context) });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);

    const workflow = e2e.workflow() as unknown as { definitionVersion: string; stage: string; state: string; candidate?: { repositories: Array<{ treeSha: string }> } };
    expect(workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "WAIT_FOR_MERGE", state: "WAITING" });
    // The broker sent the graph and the parts setting, within the plan's cap; one operation carried all three parts.
    const implement = implementInvocations(e2e);
    expect(implement).toHaveLength(1);
    expect(dependenciesOf(implement[0]!)?.parallel).toEqual({ max: PARALLEL_PARTS_MAX });
    expect(dependenciesOf(implement[0]!)?.graph.items).toHaveLength(3);
    // With room for every part there is no line about running them one at a time.
    expect(e2e.db.find((item) => item["entityType"] === "EVENT" && /^Running (parts|up to)/.test((item["payload"] as { message?: string } | undefined)?.message ?? ""))).toEqual([]);
    // A and B started before either finished, and C started after both were merged.
    const progress = progressOf(e2e);
    expect(progress.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.slice(0, 2).map((entry) => entry.state)).toEqual(["STARTED", "STARTED"]);
    expect(progress.slice(0, 2).map((entry) => entry.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    const implemented = progress.filter((entry) => entry.state === "IMPLEMENTED");
    expect(implemented.map((entry) => entry.itemId).slice(2)).toEqual([ITEM_C]);
    expect(implemented.every((entry) => entry.integratedTreeSha !== undefined)).toBe(true);
    const cStart = progress.find((entry) => entry.itemId === ITEM_C && entry.state === "STARTED")!;
    expect(cStart.baseTreeSha).toBe(implemented[1]!.integratedTreeSha);
    expect(workflow.candidate!.repositories[0]!.treeSha).toBe(implemented[2]!.integratedTreeSha);
    // The code holds all three parts, and the checks ran once on the integrated tree.
    expect(await e2e.repoFile("formatter.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("clock.mjs")).toContain("today");
    expect(await e2e.repoFile("integration.mjs")).toContain("assert.equal(today()");
    expect(e2e.checkRuns).toHaveLength(1);
    expect(e2e.checkRuns[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(workflow.candidate!.repositories[0]!.treeSha);
    // The prompts: one per part, and C's prompt came after the other two.
    expect(itemTitles(e2e).sort()).toEqual(["A: create formatter", "B: create clock", "C: integration assertion"]);
    expect(itemTitles(e2e).at(-1)).toBe("C: integration assertion");
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("says on the timeline why the parts run one after another when the person's workspaces are in use (Bug N)", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ readiness: READINESS, realProjectCommands: true, model: modelFor(context) });
    context.current = e2e;
    // One workspace allowed per person: the task's own is the only one, so its two independent parts have no room to run together.
    e2e.db.set({ ...workspaceLimitsKey(TEST_ORG), entityType: "SETTING", perPerson: 1, perOrganization: 1, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const implement = implementInvocations(e2e);
    expect(dependenciesOf(implement[0]!)?.parallel).toEqual({ max: 1 });
    const lines = e2e.db.find((item) => item["entityType"] === "EVENT" && item["operationId"] === implement[0]!.operationId)
      .map((item) => (item["payload"] as { message?: string }).message).filter((message) => /^Running parts/.test(message ?? ""));
    expect(lines).toEqual(["Running parts one at a time: 1 of 1 of your workspaces are in use."]);
    // The worker's own events follow it without a clash of sequence numbers.
    const sequences = e2e.db.find((item) => item["entityType"] === "EVENT" && item["operationId"] === implement[0]!.operationId).map((item) => item["sequence"] as number).sort((x, y) => x - y);
    expect(sequences[0]).toBe(1);
    expect(new Set(sequences).size).toBe(sequences.length);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("a version 1 task keeps building its ordered work one item at a time, and gets no parts setting", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ workflowDependenciesEnvironment: { AGENTX_WORKFLOW_DEPENDENCIES_ENABLED: "true" }, readiness: READINESS, realProjectCommands: true, model: modelFor(context) });
    context.current = e2e;
    await startFull(e2e, "1.0.0");
    await approveAll(e2e);
    expect(e2e.workflow()).toMatchObject({ definitionVersion: "1.0.0", stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(dependenciesOf(implementInvocations(e2e)[0]!)?.parallel).toBeUndefined();
    expect(itemTitlesInOrder(e2e)).toEqual(["A: create formatter", "B: create clock", "C: integration assertion"]);
    expect(progressOf(e2e).map((entry) => entry.state)).toEqual(["STARTED", "IMPLEMENTED", "STARTED", "IMPLEMENTED", "STARTED", "IMPLEMENTED"]);
    expect(progressOf(e2e).every((entry) => entry.integratedTreeSha === undefined)).toBe(true);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("a version 1 task without the install's switch still saves its graph and does not start it", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ readiness: READINESS, realProjectCommands: true, model: modelFor(context) });
    context.current = e2e;
    await startFull(e2e, "1.0.0");
    // The coding plan is the third; its approval is refused for a version 1 task with the switch off.
    for (let index = 0; index < 2; index += 1) {
      await e2e.click("agentx_workflow_approve");
      await e2e.settle();
    }
    const before = e2e.workflow();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(implementInvocations(e2e)).toEqual([]);
    expect(e2e.workflow().revision).toBe(before.revision);
  }, 240_000);

  it("a worker that cannot build parts side by side is sent the plan whole and builds them one after another", async () => {
    const context: { current?: WorkflowE2E } = {};
    const e2e = await createWorkflowE2E({ readiness: READINESS, realProjectCommands: true, model: modelFor(context) });
    context.current = e2e;
    e2e.worker.features(WORKER_INVOCATION_FEATURES.filter((feature) => feature !== "task.workflowParallelParts"));
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    // The broker still stored the setting for the operation; only the delivery withheld it from the worker.
    expect(progressOf(e2e).map((entry) => entry.state)).toEqual(["STARTED", "IMPLEMENTED", "STARTED", "IMPLEMENTED", "STARTED", "IMPLEMENTED"]);
    expect(progressOf(e2e).every((entry) => entry.integratedTreeSha === undefined)).toBe(true);
    expect(await e2e.repoFile("clock.mjs")).toContain("today");
    expect(e2e.github.pullRequests).toHaveLength(1);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("when one part fails the finished part is kept, nothing new starts, and the owner's retry builds only what is left", async () => {
    const context: { current?: WorkflowE2E } = {};
    let failA = true;
    const model = modelFor(context);
    const e2e = await createWorkflowE2E({
      readiness: READINESS, realProjectCommands: true,
      model: { ...model, edits: (latest) => {
        if (failA && /Title: A: create formatter/.test(latest)) throw new Error("model stopped before a result");
        return itemEdits(latest);
      } },
    });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const first = progressOf(e2e);
    expect(first.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([ITEM_B]);
    expect(first.some((entry) => entry.itemId === ITEM_C)).toBe(false);
    expect(e2e.github.pullRequests).toEqual([]);
    // The part that finished is in the repository; the one that did not, is not.
    expect(await e2e.repoFile("clock.mjs")).toContain("today");
    await expect(e2e.repoFile("formatter.mjs")).rejects.toThrow();
    const promptsBefore = itemTitles(e2e).length;

    failA = false;
    // The org's room shrank while the task waited: the retry is sent a fresh setting, not the first operation's.
    e2e.db.set({ ...workspaceLimitsKey(TEST_ORG), entityType: "SETTING", perPerson: 1, perOrganization: 1, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    // B was not built again.
    expect(itemTitles(e2e).slice(promptsBefore).sort()).toEqual(["A: create formatter", "C: integration assertion"]);
    expect(implementInvocations(e2e)).toHaveLength(2);
    expect(dependenciesOf(implementInvocations(e2e)[1]!)?.resumeProgress?.map((entry) => entry.itemId)).toContain(ITEM_B);
    expect(dependenciesOf(implementInvocations(e2e)[0]!)?.parallel).toEqual({ max: PARALLEL_PARTS_MAX });
    expect(dependenciesOf(implementInvocations(e2e)[1]!)?.parallel).toEqual({ max: 1 });
    expect(await e2e.repoFile("formatter.mjs")).toContain("formatGreeting");
    expect(e2e.github.pullRequests).toHaveLength(1);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("when the last part fails, the finished parts are kept on their merged tree and the retry builds only that part", async () => {
    const context: { current?: WorkflowE2E } = {};
    let failC = true;
    const model = modelFor(context);
    const e2e = await createWorkflowE2E({
      readiness: READINESS, realProjectCommands: true,
      model: { ...model, edits: (latest) => {
        if (failC && /Title: C: integration assertion/.test(latest)) throw new Error("model stopped before a result");
        return itemEdits(latest);
      } },
    });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const first = progressOf(e2e).filter((entry) => entry.state === "IMPLEMENTED");
    expect(first.map((entry) => entry.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    expect(new Set(first.map((entry) => entry.integratedTreeSha)).size).toBe(2);
    expect(await e2e.repoFile("formatter.mjs")).toContain("formatGreeting");
    expect(await e2e.repoFile("clock.mjs")).toContain("today");
    failC = false;
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    // The retry starts from the tree the later of the two parts was merged into, not the earlier.
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(itemTitles(e2e).slice(-1)).toEqual(["C: integration assertion"]);
    const cStart = progressOf(e2e).filter((entry) => entry.itemId === ITEM_C && entry.state === "STARTED").at(-1)!;
    expect(cStart.baseTreeSha).toBe(first.sort((left, right) => right.sequence - left.sequence)[0]!.integratedTreeSha);
    expect(e2e.github.pullRequests).toHaveLength(1);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("a cancel while parts are running leaves no part marked as still running, and the owner's retry can go on", async () => {
    const context: { current?: WorkflowE2E } = {};
    let cancelled = false;
    const started = new Set<string>();
    const e2e = await createWorkflowE2E({
      readiness: READINESS, realProjectCommands: true, model: modelFor(context),
      workerCallbackResponse: async ({ path, body, statusCode }) => {
        if (!cancelled && path.endsWith("/events") && statusCode === 200) {
          const parsed = JSON.parse(body) as { events?: Array<{ payload?: { workItemProgress?: { state?: string; itemId?: string } } }> };
          for (const event of parsed.events ?? []) if (event.payload?.workItemProgress?.state === "STARTED") started.add(event.payload.workItemProgress.itemId ?? "");
          if (started.size >= 2) {
            cancelled = true;
            const operationId = /\/operations\/([^/]+)\/events$/.exec(path)?.[1];
            await context.current!.worker.cancelOperation(operationId!);
          }
        }
        return undefined;
      },
    });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(cancelled).toBe(true);
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    // Every part that started has an end: the worker's, or the broker's "unknown" for one it could not report.
    const progress = progressOf(e2e);
    for (const itemId of new Set(progress.map((entry) => entry.itemId))) {
      const own = progress.filter((entry) => entry.itemId === itemId);
      expect(own.at(-1)!.state, `part ${itemId.slice(0, 2)} ends without a result`).not.toBe("STARTED");
    }
    expect(progress.some((entry) => entry.itemId === ITEM_C)).toBe(false);
    expect(e2e.github.pullRequests).toEqual([]);
    cancelled = true;
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pullRequests).toHaveLength(1);
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("an older worker is refused a plan whose finished parts are not a prefix of its order, and takes over one whose are", async () => {
    const context: { current?: WorkflowE2E } = {};
    let failA = true;
    const model = modelFor(context);
    const e2e = await createWorkflowE2E({
      readiness: READINESS, realProjectCommands: true,
      model: { ...model, edits: (latest) => {
        if (failA && /Title: A: create formatter/.test(latest)) throw new Error("model stopped before a result");
        return itemEdits(latest);
      } },
    });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    // Part B finished, part A did not: B alone is not a prefix of A, B, C.
    expect(progressOf(e2e).filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([ITEM_B]);
    const older = WORKER_INVOCATION_FEATURES.filter((feature) => feature !== "task.workflowParallelParts");
    e2e.worker.features(older);
    failA = false;
    const prompts = e2e.prompts.length;
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(e2e.prompts).toHaveLength(prompts);
    // The dispatcher refused it with the worker-outdated words; the older worker was never sent a run it could not resume.
    expect(e2e.worker.deliveryFailures.map((failure) => failure.error).join("\n")).toContain(AGENT_WORKER_OUTDATED);
    expect(e2e.github.pullRequests).toEqual([]);
    // A worker that can build parts resumes it.
    e2e.worker.features(WORKER_INVOCATION_FEATURES);
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    assertJourneyInvariants(e2e);
  }, 240_000);

  it("an older worker takes over when the finished part is the first of the plan's order", async () => {
    const context: { current?: WorkflowE2E } = {};
    let failB = true;
    const model = modelFor(context);
    const e2e = await createWorkflowE2E({
      readiness: READINESS, realProjectCommands: true,
      model: { ...model, edits: (latest) => {
        if (failB && /Title: B: create clock/.test(latest)) throw new Error("model stopped before a result");
        return itemEdits(latest);
      } },
    });
    context.current = e2e;
    await startFull(e2e, "1.1.0");
    await approveAll(e2e);
    expect(progressOf(e2e).filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual([ITEM_A]);
    e2e.worker.features(WORKER_INVOCATION_FEATURES.filter((feature) => feature !== "task.workflowParallelParts"));
    failB = false;
    const turnsBefore = e2e.turns.length;
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(itemTitlesInOrder(e2e, turnsBefore)).toEqual(["B: create clock", "C: integration assertion"]);
    assertJourneyInvariants(e2e);
  }, 240_000);
});

void taskGraphDigest;
void wait;
