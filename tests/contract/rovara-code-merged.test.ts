// Plan 6 Task 20: reporting merged. The transaction that moves a task to MERGED also writes the `merged` milestone, with every pull request and the session's bindings, so the
// handlers Plan 9 registers can close the Linear issue (found through `sessionForSurface`) and post the Slack line. One merge is one milestone, however often it is observed; the
// end handlers (Plan 4's runner among them) are told the same pull requests and bindings; and the Slack thread's line is `Merged: <url>`, one line per pull request.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { createCandidateManifest, sessionBindingKey, type CodeMilestone, type OrgId, type SessionBinding } from "@rovara-code/contracts";
import { bindSessionSurface, sessionForSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { onTaskEnded, registerTaskEndHandler, type TaskEndEvent } from "../../packages/broker/src/agents/task-end.js";
import { reconcileTaskPullRequestFeedback } from "../../packages/broker/src/aws/github-webhooks.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { mergedLines } from "../../packages/broker/src/rovara-code/merged-lines.js";
import { mergedMilestoneItems } from "../../packages/broker/src/rovara-code/merged.js";
import { deliverCodeMilestones, registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ORG_A, ORG_B, sessionWorld } from "../support/agent-session-world.js";
import { projectorWorld, workflow as plainWorkflow } from "../support/agent-session-projector-world.js";

const NOW = "2026-10-26T12:00:00.000Z";
const THREAD: SessionBinding = { kind: "slack_thread", teamId: "T0TEAM001", channelId: "C0CHAN001", threadTs: "1695500000.000031" };
const ISSUE: SessionBinding = { kind: "linear_issue", issueId: "ENG-142", url: "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug" };
const off: Array<() => void> = [];
afterEach(() => { while (off.length > 0) off.pop()!(); });

/** A task with `count` pull requests waiting for their merge, a session with the given bindings, and a webhook reconcile that writes through a fake table. */
function harness(options: { mode?: "merge" | "feedback"; definitionVersion?: "1.0.0" | "1.1.0"; bindings?: SessionBinding[]; orgId?: OrgId | null; count?: number } = {}) {
  const { mode = "merge", definitionVersion = "1.1.0", bindings = [], count = 2 } = options;
  const w = sessionWorld();
  const seeded = w.seedSession();
  const { taskId, sessionId } = seeded;
  const orgId = options.orgId === undefined ? ORG_A : options.orgId;
  const table = { documentClient: w.db, tableName: "state", now: () => Date.parse(NOW) };
  const repositories = ["api", "ui", "docs", "ops"].slice(0, count);
  const candidate = createCandidateManifest(repositories.map((repositoryId) => ({ repositoryId, commitSha: "a".repeat(40), treeSha: "b".repeat(40) })));
  const urlOf = (repositoryId: string, number: number) => `https://github.com/acme/${repositoryId}/pull/${String(number)}`;
  let workflow: WorkflowSnapshot = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: NOW, definitionVersion }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING",
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests: repositories.map((repositoryId, index) => ({ repositoryId, number: index + 1, url: urlOf(repositoryId, index + 1), headSha: "a".repeat(40), headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" })),
  });
  repositories.forEach((repositoryId, index) => w.db.set({
    pk: `GITHUB_PR#acme/${repositoryId}`, sk: `PR#${String(index + 1).padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${repositoryId}`, repositoryId, number: index + 1,
    url: urlOf(repositoryId, index + 1), taskId, workspaceId: "workspace", candidateDigest: candidate.digest,
  }));
  const remote = new Map<number, "open" | "merged">(repositories.map((_, index) => [index + 1, "open"]));
  let revision = 0;
  let clock = Date.parse(NOW);
  const reconcile = (repositoryId: string) => {
    const number = repositories.indexOf(repositoryId) + 1;
    return reconcileTaskPullRequestFeedback({
      documentClient: w.db, tableName: "state", repositoryFullName: `acme/${repositoryId}`, number, deliveryId: randomUUID(), ...(mode === "merge" ? { observationMode: "merge" as const } : {}),
      now: new Date(clock += 1000).toISOString(),
      loadTask: async () => ({ project: "web", startingRevision: 1, ...(orgId === null ? {} : { orgId }), sessionId, workflow }),
      repositoryUrl: async (_project: string, _revision: number, id: string) => `https://github.com/acme/${id}.git`,
      getCurrentFeedback: async (_url: string, prNumber: number) => ({
        pullRequest: { number: prNumber, url: urlOf(repositories[prNumber - 1]!, prNumber), state: remote.get(prNumber)!, headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), headTreeSha: "b".repeat(40), title: "t", body: "" },
        comments: [], threads: [],
      }),
      persistBundle: async () => { throw new Error("no feedback is collected on a merge"); },
      saveWorkflow: async (_taskId, expectedRevision, next, extraItems = []) => {
        if (expectedRevision !== workflow.revision) throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
        revision += 1;
        await w.db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: "state", Item: { pk: "TASK", sk: "META", revision } } }, ...extraItems] }));
        workflow = next;
      },
    });
  };
  const merge = (...numbers: number[]) => numbers.forEach((number) => remote.set(number, "merged"));
  const milestones = () => w.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("CODE_MILESTONE#merged#"));
  const sessionEvents = () => w.db.find((item) => typeof item.pk === "string" && item.pk.includes(sessionId) && String(item.sk).startsWith("EVENT#") && typeof item.text === "string" && item.text.startsWith("Merged:"));
  return { w, table, taskId, sessionId, bindings, repositories, urlOf, reconcile, merge, milestones, sessionEvents, workflow: () => workflow, bind: (binding: SessionBinding) => bindSessionSurface(table, { orgId: ORG_A, sessionId, binding }) };
}

const bound = async (...bindings: SessionBinding[]) => {
  const h = harness();
  for (const binding of bindings) await h.bind(binding);
  return h;
};

describe("the merged milestone", () => {
  it("is written by the transaction that completes the task, with every pull request and the session's bindings, and not before", async () => {
    const h = await bound(THREAD, ISSUE);
    h.merge(1);
    expect(await h.reconcile("api")).toBe(true);
    expect(h.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(h.milestones()).toHaveLength(0);
    h.merge(2);
    expect(await h.reconcile("ui")).toBe(true);
    expect(h.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    const [milestone] = h.milestones();
    expect(h.milestones()).toHaveLength(1);
    expect(milestone).toMatchObject({
      kind: "merged", orgId: ORG_A, taskId: h.taskId, sessionId: h.sessionId, entityType: "CODE_MILESTONE",
      pullRequests: [{ repository: "api", number: 1, url: h.urlOf("api", 1) }, { repository: "ui", number: 2, url: h.urlOf("ui", 2) }],
      bindings: [THREAD, ISSUE],
      text: `Merged: ${h.urlOf("api", 1)}\nMerged: ${h.urlOf("ui", 2)}`,
    });
    // The session's own timeline says it too, from the same transaction.
    expect(h.sessionEvents()).toHaveLength(1);
  });

  it.each([["merge", "1.1.0"], ["feedback", "1.1.0"], ["merge", "1.0.0"], ["feedback", "1.0.0"]] as const)("is written once however often the merge is observed (%s observation, version %s)", async (mode, version) => {
    const h = harness({ mode, definitionVersion: version });
    await h.bind(ISSUE);
    h.merge(1, 2);
    expect(await h.reconcile("api")).toBe(true);
    expect(h.milestones()).toHaveLength(1);
    // A redelivery and the recovery sweep see the same merge: they change nothing and write nothing.
    expect(await h.reconcile("api")).toBe(false);
    expect(await h.reconcile("ui")).toBe(false);
    expect(h.milestones()).toHaveLength(1);
    expect(h.sessionEvents()).toHaveLength(1);
    expect(h.milestones()[0]).toMatchObject({ bindings: [ISSUE] });
  });

  it("leaves the bindings out when the session follows nothing, and writes none for a task whose org is unknown", async () => {
    const plain = harness();
    plain.merge(1, 2);
    await plain.reconcile("api");
    expect(plain.milestones()).toHaveLength(1);
    expect(plain.milestones()[0]).not.toHaveProperty("bindings");
    const legacy = harness({ orgId: null });
    legacy.merge(1, 2);
    await legacy.reconcile("api");
    expect(legacy.workflow()).toMatchObject({ stage: "MERGED" });
    expect(legacy.milestones()).toHaveLength(0);
  });

  it("names only the session's own bindings: another org's, and an item that names another org, are left out", async () => {
    const h = await bound(THREAD);
    // A tampered item at this org's key that says it belongs to another org, and a real binding of the same session id under another org's key.
    h.w.db.set({ ...sessionBindingKey(ORG_A, h.sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_B, sessionId: h.sessionId, binding: ISSUE, at: NOW });
    h.w.db.set({ ...sessionBindingKey(ORG_B, h.sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_B, sessionId: h.sessionId, binding: { ...ISSUE, issueId: "OPS-9" }, at: NOW });
    h.merge(1, 2);
    await h.reconcile("api");
    expect(h.milestones()[0]).toMatchObject({ bindings: [THREAD] });
  });

  it("leaves out a binding that does not read", async () => {
    const h = await bound(THREAD);
    h.w.db.set({ ...sessionBindingKey(ORG_A, h.sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId: h.sessionId, binding: { kind: "linear_issue", issueId: "bad id!", url: "http://x" }, at: NOW });
    h.merge(1, 2);
    await h.reconcile("api");
    expect(h.milestones()[0]).toMatchObject({ bindings: [THREAD] });
  });

  it("leaves out an item that holds the other kind of binding than its key names", async () => {
    const h = await bound(THREAD);
    h.w.db.set({ ...sessionBindingKey(ORG_A, h.sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_A, sessionId: h.sessionId, binding: { ...THREAD, threadTs: "1695500000.000099" }, at: NOW });
    h.merge(1, 2);
    await h.reconcile("api");
    expect(h.milestones()[0]).toMatchObject({ bindings: [THREAD] });
  });

  it("fails closed: bindings that cannot be read stop the move to MERGED, so the Linear close is never lost", async () => {
    const h = await bound(ISSUE);
    h.merge(1, 2);
    const original = h.w.db.send.bind(h.w.db);
    h.w.db.send = ((command: { constructor: { name: string }; input?: { Key?: { pk?: string } } }) => {
      if (command.constructor.name === "GetCommand" && String(command.input?.Key?.pk ?? "").includes("SESSION_BINDING#")) return Promise.reject(Object.assign(new Error("table down"), { name: "ServiceUnavailable" }));
      return original(command as never);
    });
    await expect(h.reconcile("api")).rejects.toThrow();
    expect(h.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE" });
    expect(h.milestones()).toHaveLength(0);
  });

  it("says Merged: <url> for each pull request, within the milestone's 500 characters however many there are", async () => {
    const h = harness({ count: 4 });
    h.merge(1, 2, 3, 4);
    await h.reconcile("api");
    const text = String(h.milestones()[0]?.text);
    expect(text.split("\n")).toEqual(h.repositories.map((repository, index) => `Merged: ${h.urlOf(repository, index + 1)}`));
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("is told to a Plan 9 handler with the Linear binding, and the issue's session is found through sessionForSurface", async () => {
    const h = await bound(THREAD, ISSUE);
    h.merge(1, 2);
    await h.reconcile("api");
    const heard: Array<{ milestone: CodeMilestone; closes?: string }> = [];
    off.push(registerCodeMilestoneHandler({
      name: "fake_linear_close",
      on: async (_deps, milestone) => {
        const issue = milestone.bindings?.find((binding) => binding.kind === "linear_issue");
        const session = issue === undefined ? undefined : await sessionForSurface(h.table, milestone.orgId, issue);
        heard.push({ milestone, ...(session === undefined ? {} : { closes: session.sessionId }) });
      },
    }));
    await deliverCodeMilestones({ documentClient: h.w.db, tableName: "state", now: () => Date.parse(NOW) }, h.taskId);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.milestone).toMatchObject({ kind: "merged", taskId: h.taskId, bindings: [THREAD, ISSUE], pullRequests: [{ repository: "api", number: 1 }, { repository: "ui", number: 2 }] });
    expect(heard[0]?.closes).toBe(h.sessionId);
    // Told again, it is not told twice.
    await deliverCodeMilestones({ documentClient: h.w.db, tableName: "state", now: () => Date.parse(NOW) }, h.taskId);
    expect(heard).toHaveLength(1);
  });
});

describe("mergedMilestoneItems", () => {
  it("writes nothing for a workflow that was already merged, one that is not merged, or a task with no org", async () => {
    const h = harness({ count: 1 });
    h.merge(1);
    await h.reconcile("api");
    const merged = h.workflow();
    const waiting = WorkflowSnapshotSchema.parse({ ...merged, stage: "WAIT_FOR_MERGE", state: "WAITING", outcome: undefined });
    const reader = { documentClient: h.w.db, tableName: "state" };
    const task = { taskId: h.taskId, orgId: ORG_A, sessionId: h.sessionId };
    expect(await mergedMilestoneItems(reader, task, merged, merged, NOW)).toEqual([]);
    expect(await mergedMilestoneItems(reader, task, waiting, waiting, NOW)).toEqual([]);
    expect(await mergedMilestoneItems(reader, { taskId: h.taskId }, waiting, merged, NOW)).toEqual([]);
    expect((await mergedMilestoneItems(reader, task, waiting, merged, NOW)).length).toBeGreaterThan(0);
  });

  it("lists only the pull requests that merged, and cuts a long list at a line with a count of the rest", async () => {
    const h = harness({ count: 2 });
    h.merge(1, 2);
    await h.reconcile("api");
    const merged = h.workflow();
    const waiting = WorkflowSnapshotSchema.parse({ ...merged, stage: "WAIT_FOR_MERGE", state: "WAITING", outcome: undefined });
    const reader = { documentClient: h.w.db, tableName: "state" };
    const task = { taskId: h.taskId, orgId: ORG_A, sessionId: h.sessionId };
    const extra = (number: number, state: "CLOSED" | "MERGED") => ({ repositoryId: "docs", number, url: `https://github.com/acme/${"x".repeat(60)}/pull/${String(number)}`, candidateDigest: merged.candidate!.digest, required: false, state });
    const withClosed = WorkflowSnapshotSchema.parse({ ...merged, pullRequests: [...merged.pullRequests!, extra(9, "CLOSED")] });
    const [put] = await mergedMilestoneItems(reader, task, waiting, withClosed, NOW);
    expect((put?.Put?.Item as { pullRequests: unknown[] }).pullRequests).toHaveLength(2);
    const many = WorkflowSnapshotSchema.parse({ ...merged, pullRequests: [...merged.pullRequests!, ...Array.from({ length: 10 }, (_, index) => extra(10 + index, "MERGED"))] });
    const [long] = await mergedMilestoneItems(reader, task, waiting, many, NOW);
    const text = (long?.Put?.Item as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.split("\n").at(-1)).toMatch(/^and \d+ more$/u);
    expect(text.split("\n")[0]).toBe(`Merged: ${h.urlOf("api", 1)}`);
  });
});

describe("mergedLines", () => {
  it("is one Merged: line for each merged GitHub pull request, and leaves out anything else", () => {
    const pr = (url: string, state = "MERGED") => ({ url, state });
    expect(mergedLines([pr("https://github.com/acme/api/pull/1"), pr("https://github.com/acme/ui/pull/2", "OPEN"), pr("https://github.com/acme/ui/pull/3", "CLOSED")])).toEqual(["Merged: https://github.com/acme/api/pull/1"]);
    for (const url of ["http://github.com/acme/api/pull/1", "https://github.com.evil.example/acme/api/pull/1", "https://github.com/acme/api/issues/1", "https://github.com/acme/api/pull/1 <!@channel>", "https://github.com/acme/api/pull/0", "javascript:alert(1)"]) {
      expect(mergedLines([pr(url)]), url).toEqual([]);
    }
  });
});

describe("the Slack thread's line", () => {
  it("is Merged: <url>, one line for each pull request, for a version 2 task", async () => {
    const h = harness();
    h.merge(1, 2);
    await h.reconcile("api");
    expect(workflowMessage({ taskId: h.taskId, workflow: h.workflow() })?.text).toBe(`Merged: ${h.urlOf("api", 1)}\nMerged: ${h.urlOf("ui", 2)}`);
    const single = harness({ count: 1 });
    single.merge(1);
    await single.reconcile("api");
    expect(workflowMessage({ taskId: single.taskId, workflow: single.workflow() })?.text).toBe(`Merged: ${single.urlOf("api", 1)}`);
  });

  it("is a version 1 task's words, as they were", async () => {
    const h = harness({ definitionVersion: "1.0.0" });
    h.merge(1, 2);
    await h.reconcile("api");
    expect(workflowMessage({ taskId: h.taskId, workflow: h.workflow() })?.text).toBe("All 2 pull requests are merged. This task is complete.");
    const single = harness({ definitionVersion: "1.0.0", count: 1 });
    single.merge(1);
    await single.reconcile("api");
    expect(workflowMessage({ taskId: single.taskId, workflow: single.workflow() })?.text).toBe("The pull request is merged. This task is complete.");
  });
});

describe("what the end handlers are told", () => {
  const PR = { repositoryId: "api", number: 1, url: "https://github.com/acme/api/pull/1" };
  async function ended(extra: Record<string, unknown> = {}, bind: SessionBinding[] = [THREAD, ISSUE]) {
    const p = projectorWorld();
    const s = p.open();
    for (const binding of bind) await bindSessionSurface({ documentClient: p.w.db, tableName: "state", now: () => p.w.clock.now }, { orgId: ORG_A, sessionId: s.sessionId, binding });
    p.patchTask(s.taskId, { workflow: plainWorkflow("MERGED", "COMPLETE", { outcome: "MERGED", pullRequests: [PR] }), ...extra });
    const events: TaskEndEvent[] = [];
    off.push(registerTaskEndHandler(async (_deps, event) => { events.push(event); }));
    const task = p.w.db.get(taskKey(s.taskId)) as unknown as DeveloperTaskRecord;
    await onTaskEnded(p.deps as never, task, "merged", {}, { record: true });
    return { events, session: s };
  }

  it("carries the pull requests and the session's bindings when a task merges", async () => {
    const { events } = await ended();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "merged", pullRequests: [{ repository: "api", number: 1, url: PR.url }], bindings: [THREAD, ISSUE] });
  });

  it("carries them to a chain step's end handler too", async () => {
    const { events } = await ended({ chain: { chainRunId: "crn_00000000000000000001", stepId: "build" } });
    expect(events[0]).toMatchObject({ chain: { chainRunId: "crn_00000000000000000001", stepId: "build" }, pullRequests: [{ repository: "api", number: 1, url: PR.url }], bindings: [THREAD, ISSUE] });
  });

  it("has no bindings when the session follows nothing, and never another org's", async () => {
    const { events } = await ended({}, []);
    expect(events[0]).not.toHaveProperty("bindings");
    expect(events[0]?.pullRequests).toHaveLength(1);
    const p = projectorWorld();
    const s = p.open();
    p.w.db.set({ ...sessionBindingKey(ORG_A, s.sessionId, "linear_issue"), entityType: "AGENT_SESSION_BINDING", orgId: ORG_B, sessionId: s.sessionId, binding: ISSUE, at: NOW });
    p.patchTask(s.taskId, { workflow: plainWorkflow("MERGED", "COMPLETE", { outcome: "MERGED", pullRequests: [PR] }) });
    const heard: TaskEndEvent[] = [];
    off.push(registerTaskEndHandler(async (_deps, event) => { heard.push(event); }));
    await onTaskEnded(p.deps as never, p.w.db.get(taskKey(s.taskId)) as unknown as DeveloperTaskRecord, "merged", {}, { record: true });
    expect(heard[0]).not.toHaveProperty("bindings");
  });
});
