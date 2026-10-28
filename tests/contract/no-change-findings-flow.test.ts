// A coding run that ends with no code change is not a dead end: what the agent found (the commands it ran, their output and its own conclusion) reaches Slack, the task page and the task view, with the
// new plain words and the same ways out. Nothing is claimed that did not happen: no checks, no pull request, no "verified". The worker's block is optional (an older worker sends none) and is redacted
// and bounded again by the broker. These run through the real broker; the secrets are built at run time.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { getTaskDocumentView, taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { createTaskWeb } from "../../packages/broker/src/aws/task-web.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { agentSessionKey, builtinSettingsKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import {
  NO_CHANGE_CHOICES_LINE, NO_CHANGE_CHOICES_PAGE, NO_CHANGE_FINDINGS_TOTAL_MAX, NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, NO_CHANGE_NO_CONCLUSION, NO_CODE_CHANGED_LEGACY_REASONS, NO_CODE_CHANGED_STEP, NO_CODE_CHANGED_REASON,
  noChangeFindingsSize,
} from "../../packages/contracts/src/no-change-findings.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WORKFLOW_NO_CODE_CHANGE_MESSAGE, WorkflowSnapshotSchema } from "../../packages/contracts/src/task-workflow-node.js";
import type { IntentAssessment } from "../../packages/contracts/src/rovara-code.js";
import { UNDERSTAND_ARTIFACT_NAME } from "../../packages/contracts/src/index.js";
import { MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const NOW = "2026-10-26T12:00:00.000Z";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const PROXY_URL = "http://internal-proxy.example.test:4000";
const ready = (): IntentAssessment => ({ kind: "ready", path: "QUICK", restatement: "Run the retry audit and tell me what it finds.", assumptions: [] });
const noChange = () => ({ answer: "The flag already reads the config file; nothing to change.", sources: [{ repository: "demo", path: "src/retry.ts", line: 9 }] });
// Built at run time: no key-shaped literal is in this file.
const secret = (): string => ["ghp_", "Ab12".repeat(9)].join("");

beforeAll(loadSlackBroker);

async function world() {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const who: Developer = MAYA;
  h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
  h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  type Meta = Record<string, unknown> & { workspaceId: string; sessionId: string; workflow: Record<string, unknown> & { stage: string; state: string; blockReason?: string; pullRequests?: unknown[]; candidate?: unknown; verification?: unknown; outcome?: string; revision: number; artifacts: Array<{ sha256: string }> } };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Meta;
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const operationOf = (workspaceId: string, mode: string) => operations(workspaceId).filter((item) => item.workflowMode === mode).at(-1);
  /** A task whose plan was approved: its coding run is the next one. */
  const approved = async () => {
    const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Run the retry audit and tell me what it finds." } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const run = { taskId, workspaceId: meta(taskId).workspaceId, sessionId: meta(taskId).sessionId };
    await h.finish(run.workspaceId, String(operations(run.workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const understand = String(operationOf(run.workspaceId, "UNDERSTAND")!.id);
    await h.artifact(run.workspaceId, understand, UNDERSTAND_ARTIFACT_NAME, JSON.stringify(ready()));
    await h.finish(run.workspaceId, understand, "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
    const plan = operationOf(run.workspaceId, "PLAN")!;
    await h.artifact(run.workspaceId, String(plan.id), "plan.md", planAnswer(planDocument({ noChangeNeeded: noChange() }), { checks: { checks: [], none_reason: "Nothing runs." } }));
    await h.finish(run.workspaceId, String(plan.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const digest = meta(taskId).workflow.artifacts.at(-1)!.sha256;
    const decided = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: meta(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return run;
  };
  /** The coding run ends the way the worker reports a run that left the code as it was. */
  const noChangeEnding = async (result?: unknown, error = `CONFIG_INVALID: ${WORKFLOW_NO_CODE_CHANGE_MESSAGE}`) => {
    const run = await approved();
    await h.finish(run.workspaceId, String(operationOf(run.workspaceId, "IMPLEMENT")!.id), "FAILED", { error, ...(result === undefined ? {} : { result }) });
    return run;
  };
  const refreshSummary = (sessionId: string) => refreshSessionSummary({ documentClient: h.db, tableName: "state", now: Date.now, log: () => undefined }, TEST_ORG, sessionId);
  const sessionRecord = (sessionId: string) => h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Record<string, unknown> & { summary: { status: string; step?: string } };
  const everything = () => JSON.stringify(h.db.find(() => true));
  return { ...h, meta, operations, operationOf, noChangeEnding, refreshSummary, sessionRecord, everything };
}

const findings = () => ({
  commands: [
    { command: "grep -rn retry src", output: "src/retry.ts:9: export const retry = true;" },
    { command: "npm test -- retry", output: "12 passed, 0 failed" },
  ],
  conclusion: "We do use retry, in src/retry.ts only. It is already on by default.",
});

describe("a coding run that left the code as it was: what it found reaches the people who asked", () => {
  it("keeps the findings on the blocked step, shows the new words with the summary in Slack, and offers the same ways out", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const stored = t.meta(run.taskId).workflow;
    // The state is what it was: the coding step, blocked, with no pull request, no candidate and no checks.
    expect(stored).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.noCodeChanged });
    expect(stored.blockReason).toBe(NO_CODE_CHANGED_REASON);
    expect(stored.pullRequests ?? []).toEqual([]);
    expect(stored.candidate).toBeUndefined();
    expect(stored.verification).toBeUndefined();
    expect(stored.noChangeFindings).toEqual(findings());
    const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(stored) })!;
    const lines = message.text.split("\n");
    expect(lines[0]).toBe(NO_CHANGE_FOUND_HEADER);
    expect(message.text).toContain("We do use retry, in src/retry.ts only.");
    expect(message.text).toContain("grep -rn retry src");
    expect(message.text).toContain("src/retry.ts:9: export const retry = true;");
    expect(message.text).toContain("12 passed, 0 failed");
    expect(lines.at(-1)).toBe(NO_CHANGE_CHOICES_LINE);
    // Nothing is claimed that did not happen.
    expect(message.text).not.toMatch(/verified|checks passed|opened a (draft )?pull request|pull request is open/iu);
    expect(message.text).toContain("no pull request was opened");
    // The ways out are the existing buttons: Retry coding (with a reply, the way to ask for a change) and Close task.
    const buttons = message.blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements as Array<{ action_id: string; text: { text: string } }>);
    expect(buttons.map((button) => [button.action_id, button.text.text])).toEqual([["agentx_workflow_retry_implementation", "Retry coding"], ["agentx_workflow_close", "Close task"]]);
  });

  it("shows the same on the task view, the session and the task's status, and the task is not a failed task", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const reply = await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`);
    const task = reply.body.task as { status: string; failure?: unknown; workflow: { state: string; blockReason?: string; noChangeFindings?: unknown } };
    expect(task.status).not.toBe("FAILED");
    expect(task.failure).toBeUndefined();
    expect(task.workflow).toMatchObject({ state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON, noChangeFindings: findings() });
    expect(JSON.stringify(task)).not.toContain("CONFIG_INVALID");
    await t.refreshSummary(run.sessionId);
    expect(t.sessionRecord(run.sessionId).summary).toMatchObject({ status: "needs_person", step: NO_CODE_CHANGED_STEP });
    const stage = taskPageStage(WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow), false, true);
    expect(stage.status).toBe("No code changes were needed");
    expect(stage.nextStep).toContain("Close the task");
    expect(stage.nextStep).toContain("Retry coding");
    expect(JSON.stringify(stage)).not.toMatch(/verified|passed/iu);
  });

  it("redacts a secret an agent's command printed everywhere it can be seen, even when the worker did not (defence in depth)", async () => {
    const token = secret();
    const t = await world();
    // A worker that forgot to redact: the broker must not store or show the secret.
    const run = await t.noChangeEnding({ noChangeFindings: {
      commands: [{ command: `curl -H "Authorization: Bearer ${token}" https://example.test/health`, output: `{"key":"${token}"}` }], conclusion: `The service answers, and its key is ${token}.`,
    } });
    // Positive control: the finding itself did arrive, so its absence of the secret below is the redaction's.
    const stored = t.meta(run.taskId).workflow.noChangeFindings as { commands: Array<{ command: string }>; conclusion: string };
    expect(stored.commands[0]!.command).toContain("curl");
    expect(stored.conclusion).toContain("The service answers");
    const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow) })!;
    expect(message.text).toContain("[REDACTED]");
    const view = JSON.stringify((await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body);
    await t.refreshSummary(run.sessionId);
    for (const where of [message.text, JSON.stringify(message.blocks), view, t.everything()]) expect(where).not.toContain(token);
  });

  it("bounds a worker that sent far too much: the stored block stays under the fixed limit", async () => {
    const t = await world();
    const huge = { commands: Array.from({ length: 300 }, (_, index) => ({ command: `run-${String(index)} ${"c".repeat(2_000)}`, output: "o".repeat(100_000) })), conclusion: "k".repeat(200_000), omitted: 5 };
    const run = await t.noChangeEnding({ noChangeFindings: huge });
    const stored = t.meta(run.taskId).workflow.noChangeFindings as { commands: unknown[]; conclusion: string; omitted: number } & Parameters<typeof noChangeFindingsSize>[0];
    expect(stored.commands).toHaveLength(10);
    expect(stored.omitted).toBe(5 + 290);
    expect(noChangeFindingsSize(stored)).toBeLessThanOrEqual(NO_CHANGE_FINDINGS_TOTAL_MAX);
    const operation = t.operations(run.workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    expect(JSON.stringify(operation.result).length).toBeLessThan(20_000);
  });

  it("says the agent did not write a conclusion when the block has none", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: { commands: [{ command: "ls src" }] } });
    const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow) })!;
    expect(message.text).toContain(NO_CHANGE_NO_CONCLUSION);
    expect(message.text).toContain("ls src");
    const empty = await t.noChangeEnding({ noChangeFindings: { commands: [] } });
    expect(workflowMessage({ taskId: empty.taskId, workflow: WorkflowSnapshotSchema.parse(t.meta(empty.taskId).workflow) })!.text).toContain(NO_CHANGE_NO_CONCLUSION);
  });

  it("an older worker that sends no findings block still gets the new wording, with no summary and the same ways out", async () => {
    const t = await world();
    for (const result of [undefined, { workflowMode: "IMPLEMENT" }, { noChangeFindings: "not a block" }]) {
      const run = await t.noChangeEnding(result);
      const stored = t.meta(run.taskId).workflow;
      expect(stored).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON });
      expect(stored.noChangeFindings).toBeUndefined();
      const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(stored) })!;
      expect(message.text.split("\n")[0]).toBe(NO_CHANGE_NEEDED_LINE);
      expect(message.text).not.toContain(NO_CHANGE_FOUND_HEADER);
      expect(message.text).not.toContain(NO_CHANGE_NO_CONCLUSION);
      expect(message.text).toContain(NO_CHANGE_CHOICES_LINE);
      const buttons = message.blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements as Array<{ action_id: string }>);
      expect(buttons.map((button) => button.action_id)).toEqual(["agentx_workflow_retry_implementation", "agentx_workflow_close"]);
    }
  });

  it("keeps findings only with this stop: another kind of failed coding run shows no summary (positive control)", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() }, "RUNTIME_UNAVAILABLE: the model call failed: provider-outage attempt 4; retry the step");
    const stored = t.meta(run.taskId).workflow;
    expect(stored.blockReason).not.toBe(NO_CODE_CHANGED_REASON);
    expect(stored.noChangeFindings).toBeUndefined();
    expect(workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(stored) })!.text).not.toContain(NO_CHANGE_FOUND_HEADER);
  });

  it("shows no findings on the task view once the step is blocked for another reason, even if the stored row still holds them", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const row = t.db.get(`DEVTASK#${run.taskId}`, "META") as { workflow: Record<string, unknown> };
    t.db.set({ ...row, workflow: { ...row.workflow, blockReason: WORKFLOW_BLOCK_REASONS.planNotSaved } } as never);
    const task = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body.task as { workflow: Record<string, unknown> };
    expect(task.workflow.blockReason).toBe(WORKFLOW_BLOCK_REASONS.planNotSaved);
    expect(task.workflow).not.toHaveProperty("noChangeFindings");
  });

  it("a task stored blocked with the earlier wording still reads as this stop (existing data keeps working)", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const legacy = WorkflowSnapshotSchema.parse({ ...t.meta(run.taskId).workflow, blockReason: NO_CODE_CHANGED_LEGACY_REASONS[0], noChangeFindings: undefined });
    const message = workflowMessage({ taskId: run.taskId, workflow: legacy })!;
    expect(message.text.split("\n")[0]).toBe(NO_CHANGE_NEEDED_LINE);
    expect(message.text).not.toContain("Coding stopped before it finished");
    expect(taskPageStage(legacy, false, true).status).toBe("No code changes were needed");
  });
});

describe("the task page", () => {
  const web = (view: unknown) => createTaskWeb({ authenticateSession: async () => ({ developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya", orgId: TEST_ORG, orgRole: "member" }), getTaskDocumentView: async () => view as never });
  const page = async (view: { taskId: string }) => (await web(view)({ method: "GET", path: `/review/${view.taskId}/task`, headers: { cookie: "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111" }, requestId: "r" },
    new URL(`https://agentx.example.test/review/${view.taskId}/task`))).body;

  /** A blocked coding step with findings on a stored task in the page fixture. */
  const blockedTask = (extra: Record<string, unknown> = {}) => {
    const fixture = pageTask();
    fixture.addVersion("plan", planDocument());
    fixture.setWorkflow(WorkflowSnapshotSchema.parse({ ...fixture.workflow(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON, ...extra }));
    return fixture;
  };

  it("loads the findings into the page's view and renders them escaped, with the choices and nothing claimed", async () => {
    const token = secret();
    const fixture = blockedTask({ noChangeFindings: { commands: [{ command: "cat <script>x</script>", output: "a & b" }], conclusion: `Found <img src=x> and ${token}` } });
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    expect(view.status).toBe("No code changes were needed");
    const html = (await page(view)).replaceAll("&#39;", "'");
    expect(html).toContain(NO_CHANGE_FOUND_HEADER);
    expect(html).toContain("Found &lt;img src=x&gt; and [REDACTED]");
    expect(html).toContain("cat &lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain(NO_CHANGE_CHOICES_PAGE);
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/checks passed|was verified/iu);
    fixture.close();
  });

  it("says no change was needed, with no summary, when the stored step has no findings (an older worker)", async () => {
    const fixture = blockedTask();
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    const html = await page(view);
    expect(html).toContain(NO_CHANGE_NEEDED_LINE);
    expect(html).not.toContain(NO_CHANGE_FOUND_HEADER);
    expect(html).not.toContain(NO_CHANGE_NO_CONCLUSION);
    fixture.close();
  });

  it("shows nothing of it on another blocked step, even if findings were left on the row (they belong to this stop only)", async () => {
    const fixture = blockedTask({ blockReason: WORKFLOW_BLOCK_REASONS.planNotSaved, noChangeFindings: { commands: [], conclusion: "left over" } });
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    const html = await page(view);
    expect(html).not.toContain("left over");
    expect(html).not.toContain("What the agent found");
    expect(html).not.toContain(NO_CHANGE_NEEDED_LINE);
    expect(view.status).not.toBe("No code changes were needed");
    fixture.close();
  });
});
