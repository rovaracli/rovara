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
import { agentSessionKey, builtinSettingsKey, projectMemberKey } from "@rovara-code/contracts";
import { NO_CHANGE_CHOICES_LINE, NO_CHANGE_CHOICES_NO_THREAD, NO_CHANGE_CHOICES_PAGE, NO_CHANGE_FINDINGS_TOTAL_MAX, NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, NO_CHANGE_NO_CONCLUSION_LEAD, NO_CHANGE_OUTPUT_HIDDEN, NO_CODE_CHANGED_LEGACY_REASONS, NO_CODE_CHANGED_STEP, NO_CODE_CHANGED_REASON, noChangeFindingsSize } from "@rovara-code/contracts";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/cloud-contracts/src/task-workflow.js";
import { WORKFLOW_NO_CODE_CHANGE_MESSAGE } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import type { IntentAssessment } from "@rovara-code/contracts";
import { UNDERSTAND_ARTIFACT_NAME } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { PRIYA, pageTask } from "../support/page-tasks.js";
import { TEST_ORG } from "../support/orgs.js";
import { runLimitAck } from "../support/run-limit-ack.js";
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
    const decided = await h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: meta(taskId).workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest, ...runLimitAck(h.db, taskId) });
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

const pageUrl = (taskId: string): string => `https://agentx.example.test/review/${taskId}/task`;

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
    const url = pageUrl(run.taskId);
    const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(stored), taskPageUrl: url })!;
    // The exact words the owner set: the findings first, the commands with the link to the full output, then what was not done and the two ways on.
    expect(message.text).toBe([
      "No code changes were needed. Here's what I found: We do use retry, in src/retry.ts only. It is already on by default.",
      `Commands I ran: \`grep -rn retry src\`, \`npm test -- retry\` · Full output on the task page: <${url}|task page>`,
      "No tests were run and no pull request was opened. To change something, reply here and choose Retry coding; otherwise close the task.",
    ].join("\n"));
    expect(message.text.split("\n").at(-1)).toBe(NO_CHANGE_CHOICES_LINE);
    // Slack has no command output at all (positive control: the stored block holds it, and the task view shows it).
    expect(JSON.stringify(stored.noChangeFindings)).toContain("src/retry.ts:9: export const retry = true;");
    expect(message.text).not.toContain("export const retry");
    expect(message.text).not.toContain("12 passed");
    expect(JSON.stringify(message.blocks)).not.toContain("12 passed");
    // Nothing is claimed that did not happen.
    expect(message.text).not.toMatch(/verified|checks passed|opened a (draft )?pull request|pull request is open|nothing was checked/iu);
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
    expect(stage.nextStep).toBe(NO_CHANGE_CHOICES_PAGE);
    expect(taskPageStage(WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow), false, true, undefined, undefined, undefined, false).nextStep).toBe(NO_CHANGE_CHOICES_NO_THREAD);
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

  it("never lets what a command read from the environment or a secret file reach Slack, the page or the view: `cat .env` and `env` show no output, and secret-looking values are hidden", async () => {
    const salt = ["s4lt", "Zq81".repeat(4)].join("-"), hmac = ["h", "9f3a".repeat(8)].join(""), stripe = ["rk_", "live_", "Q7w2".repeat(6)].join(""), cookie = ["c00k", "Ie77".repeat(5)].join("-");
    const dotenv = `NODE_ENV=production\nSIGNING_SALT=${salt}\nHMAC=${hmac}\nSTRIPE_LIVE=${stripe}\nPORT=3000\n`;
    const t = await world();
    // A worker that filtered nothing: the broker applies the same filters again.
    const run = await t.noChangeEnding({ noChangeFindings: {
      commands: [{ command: "cat .env", output: dotenv }, { command: "env", output: dotenv }, { command: "node dump.js", output: `SESSION_COOKIE: ${cookie}\nHMAC=${hmac}\nrows: 12` }],
      conclusion: `The config sets SIGNING_SALT=${salt} and\nSTRIPE_LIVE: ${stripe}\nso retries are on.`,
    } });
    const workflow = WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow);
    const message = workflowMessage({ taskId: run.taskId, workflow, taskPageUrl: pageUrl(run.taskId) })!;
    const view = JSON.stringify((await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body);
    // Positive controls: the commands, the key names and the harmless lines are shown, so the values' absence is the filters' work.
    expect(message.text).toContain("`cat .env`, `env`, `node dump.js`");
    expect(message.text).toContain("SIGNING_SALT=[hidden]");
    // In Slack every value of a `NAME: value` line is hidden, whatever the name.
    expect(message.text).toContain("STRIPE_LIVE: [hidden]");
    expect(message.text).toContain("so retries are on.");
    expect(view).toContain(NO_CHANGE_OUTPUT_HIDDEN);
    expect(view).toContain("SESSION_COOKIE: [hidden]");
    expect(view).toContain("rows: 12");
    expect(view).not.toContain("NODE_ENV=production");
    expect(message.text).not.toContain("NODE_ENV");
    expect(message.text).not.toContain("rows: 12");
    for (const value of [salt, hmac, stripe, cookie]) {
      for (const where of [message.text, JSON.stringify(message.blocks), view, t.everything()]) expect(where).not.toContain(value);
    }
    const stored = t.meta(run.taskId).workflow.noChangeFindings as { commands: Array<{ output?: string }> };
    expect(stored.commands.map((item) => item.output)).toEqual([NO_CHANGE_OUTPUT_HIDDEN, NO_CHANGE_OUTPUT_HIDDEN, "SESSION_COOKIE: [hidden]\nHMAC=[hidden]\nrows: 12"]);
  });

  it("Retry coding and Close behave as before after this stop: Retry coding starts the approved coding again with the thread's replies, and Close closes the task", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const blocked = t.meta(run.taskId).workflow;
    const route = `/v1/dev/tasks/${run.taskId}/workflow/retry`;
    // A retry made on a stale view is refused, as for any blocked coding step.
    expect((await t.dev(MAYA, "POST", route, { requestId: randomUUID(), expectedRevision: blocked.revision - 1, instructions: "Make the change." })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const requestId = randomUUID();
    const retried = await t.dev(MAYA, "POST", route, { requestId, expectedRevision: blocked.revision, instructions: "Make the retry flag read the config file." });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: blocked.revision + 1 });
    expect(t.meta(run.taskId).workflow.blockReason).toBeUndefined();
    const coding = t.operations(run.workspaceId).find((item) => item.requestId === requestId)!;
    expect(coding).toMatchObject({ workflowMode: "IMPLEMENT" });
    // The findings are no longer shown once the step runs again.
    const running = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body.task as { workflow: Record<string, unknown> };
    expect(running.workflow).not.toHaveProperty("noChangeFindings");
    // The same stop, closed instead.
    const other = await t.noChangeEnding({ noChangeFindings: findings() });
    const closed = await t.dev(MAYA, "POST", `/v1/dev/tasks/${other.taskId}/close`, { requestId: randomUUID() });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(t.operations(other.workspaceId).some((item) => item.kind === "close")).toBe(true);
    expect(t.meta(other.taskId).workflow.pullRequests ?? []).toEqual([]);
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

  it("says the agent wrote no conclusion, and points to the task page, when the block has none", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: { commands: [{ command: "ls src" }] } });
    const url = pageUrl(run.taskId);
    const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(t.meta(run.taskId).workflow), taskPageUrl: url })!;
    expect(message.text).toBe([`No code changes were needed. The agent didn't write a conclusion; see what it ran on the task page: <${url}|task page>`, NO_CHANGE_CHOICES_LINE].join("\n"));
    const empty = await t.noChangeEnding({ noChangeFindings: { commands: [] } });
    expect(workflowMessage({ taskId: empty.taskId, workflow: WorkflowSnapshotSchema.parse(t.meta(empty.taskId).workflow), taskPageUrl: pageUrl(empty.taskId) })!.text).toContain(NO_CHANGE_NO_CONCLUSION_LEAD);
  });

  it("an older worker that sends no findings block still gets the new wording, with no summary and the same ways out", async () => {
    const t = await world();
    for (const result of [undefined, { workflowMode: "IMPLEMENT" }, { noChangeFindings: "not a block" }]) {
      const run = await t.noChangeEnding(result);
      const stored = t.meta(run.taskId).workflow;
      expect(stored).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON });
      expect(stored.noChangeFindings).toBeUndefined();
      const message = workflowMessage({ taskId: run.taskId, workflow: WorkflowSnapshotSchema.parse(stored) })!;
      expect(message.text).toBe(`${NO_CHANGE_NEEDED_LINE}\n${NO_CHANGE_CHOICES_LINE}`);
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
    t.db.set({ ...row, workflow: { ...row.workflow, blockReason: WORKFLOW_BLOCK_REASONS.planNotSaved } });
    const task = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body.task as { workflow: Record<string, unknown> };
    expect(task.workflow.blockReason).toBe(WORKFLOW_BLOCK_REASONS.planNotSaved);
    expect(task.workflow).not.toHaveProperty("noChangeFindings");
  });

  it("a task stored blocked with the earlier wording still reads as this stop (existing data keeps working)", async () => {
    const t = await world();
    const run = await t.noChangeEnding({ noChangeFindings: findings() });
    const legacy = WorkflowSnapshotSchema.parse({ ...t.meta(run.taskId).workflow, blockReason: NO_CODE_CHANGED_LEGACY_REASONS[0], noChangeFindings: undefined });
    const message = workflowMessage({ taskId: run.taskId, workflow: legacy })!;
    expect(message.text).toBe(`${NO_CHANGE_NEEDED_LINE}\n${NO_CHANGE_CHOICES_LINE}`);
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
    // The choices are said once, as the page's next step, not again in the section.
    expect(html.split(NO_CHANGE_CHOICES_PAGE)).toHaveLength(2);
    expect(html).toContain(`Next: ${NO_CHANGE_CHOICES_PAGE}`);
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain(token);
    expect(html).not.toMatch(/checks passed|was verified/iu);
    fixture.close();
  });

  it("chooses the last line by whether the share holds a thread, as the app does: a share with no thread yet reads as no thread", async () => {
    const fixture = pageTask();
    fixture.addVersion("plan", planDocument());
    fixture.setWorkflow(WorkflowSnapshotSchema.parse({ ...fixture.workflow(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON, noChangeFindings: { commands: [], conclusion: "All good." } }));
    expect((await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId)).nextStep).toBe(NO_CHANGE_CHOICES_PAGE);
    const row = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as { share: Record<string, unknown> };
    const { threadTs: _thread, ...shareWithoutThread } = row.share;
    void _thread;
    fixture.db.set({ ...row, share: shareWithoutThread });
    expect((await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId)).nextStep).toBe(NO_CHANGE_CHOICES_NO_THREAD);
    fixture.close();
  });

  it("tells a task with no Slack thread to start a new request instead of replying", async () => {
    const fixture = pageTask({ shared: false });
    fixture.addVersion("plan", planDocument());
    fixture.setWorkflow(WorkflowSnapshotSchema.parse({ ...fixture.workflow(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: NO_CODE_CHANGED_REASON, noChangeFindings: { commands: [], conclusion: "All good." } }));
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    expect(view.nextStep).toBe(NO_CHANGE_CHOICES_NO_THREAD);
    expect(NO_CHANGE_CHOICES_NO_THREAD).toBe("No tests were run and no pull request was opened. To change something, start a new request describing it; otherwise close the task.");
    const html = await page(view);
    expect(html).toContain(`Next: ${NO_CHANGE_CHOICES_NO_THREAD}`);
    expect(html).toContain("No code changes were needed. Here&#39;s what I found: All good.");
    fixture.close();
  });

  it("says no change was needed, with no summary, when the stored step has no findings (an older worker)", async () => {
    const fixture = blockedTask();
    const view = await getTaskDocumentView(fixture.deps, PRIYA, fixture.taskId);
    const html = await page(view);
    expect(html).toContain(NO_CHANGE_NEEDED_LINE);
    expect(html).not.toContain(NO_CHANGE_FOUND_HEADER);
    expect(html).not.toContain(NO_CHANGE_NO_CONCLUSION_LEAD);
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
