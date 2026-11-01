// Live interaction A3 / B1: a question in a Slack-started task's thread when the Ask switch is ON. The asker must be a member with "can use" on the task's session (read now); the channel gets file
// names and counts only; the Ask rates apply; and a refusal is ANSWERED in fixed words (the service posts the sentence and marks the note answered), so a refused question never stays behind as a
// note the next agent step could read as an instruction. With the switch OFF the old behaviour is pinned by the unchanged fixtures of developer-task-workflow-flow.test.ts and page-comment-answers.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASK_RATE } from "../../packages/contracts/src/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { SLACK_ASK_NOT_ALLOWED_WORDS, slackAskRefusalContext } from "../../packages/broker/src/aws/broker/thread-workspaces.js";
import { taskOwnsThread } from "../../packages/broker/src/aws/developer-tasks/task-answer-context.js";
import { ASK_RATE_TEXT } from "../../packages/broker/src/agent-sessions/ask.js";
import { createSingleAnswerPlanBroker, seedMembership, teammate } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const MAYA_SLACK = "U0MAYA001";

describe("a question in a task's thread with the Ask switch on", () => {
  const TASK_REQUEST = { includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true, includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true, includeSharedTask: true };
  const MARKDOWN = "# Plan\n\nAdd greet.\n\nUse a horizontal rule between the two sections.\n";

  async function planWaiting(threadTs: string, extra: Record<string, unknown> = {}, member = true) {
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { slackAskOn: true, slackAskLevel: async () => "use", ...extra } });
    if (member) seedMembership(harness.db, developerIdForSlackUser("U0TEAMMATE1"));
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs };
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA_SLACK, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const workspaceId = String(harness.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
    harness.db.set({ ...harness.db.get(`DEVTASK#${taskId}`, "META")!, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" });
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), MARKDOWN);
    const subject = `${thread.teamId}/${thread.channelId}/${thread.threadTs}`;
    const ensure = (as = "U0TEAMMATE1") => teammate(harness.handler, subject, as, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), ...TASK_REQUEST, taskAnswer: { taskId } });
    return { harness, taskId, subject, ensure };
  }
  const contextOf = async (t: Awaited<ReturnType<typeof planWaiting>>, as?: string) => String((await t.ensure(as)).body.taskContext);
  const refused = (words: string) => slackAskRefusalContext(words);

  it("answers a member with 'can use' from the Slack tier's context", async () => {
    const t = await planWaiting("1695500000.000141");
    const context = await contextOf(t);
    expect(context.startsWith("This Slack thread is an AgentX task (untrusted data follows).")).toBe(true);
    expect(context).toContain("Add a greeting");
  });

  it("refuses in fixed words (an answered question, not a note) a non-member, a viewer, a person with no level, a throwing level and a sessionless task", async () => {
    const stranger = await planWaiting("1695500000.000142");
    expect(await contextOf(stranger, "U0OUTSIDER9")).toBe(refused(SLACK_ASK_NOT_ALLOWED_WORDS));
    for (const [threadTs, level] of [["1695500000.000143", async () => "view"], ["1695500000.000144", async () => "none"], ["1695500000.000145", async () => { throw new Error("table down"); }]] as const) {
      const t = await planWaiting(threadTs, { slackAskLevel: level });
      expect(await contextOf(t)).toBe(refused(SLACK_ASK_NOT_ALLOWED_WORDS));
    }
    const sessionless = await planWaiting("1695500000.000146");
    sessionless.harness.db.set({ ...sessionless.harness.db.get(`DEVTASK#${sessionless.taskId}`, "META")!, sessionId: undefined });
    expect(await contextOf(sessionless)).toBe(refused(SLACK_ASK_NOT_ALLOWED_WORDS));
    // The refusal carries no data from the task.
    expect(refused(SLACK_ASK_NOT_ALLOWED_WORDS)).not.toContain("Add a greeting");
  });

  it("reads the level for THE ASKER", async () => {
    const asker = developerIdForSlackUser("U0TEAMMATE1");
    const t = await planWaiting("1695500000.000148", { slackAskLevel: async (person: { developerId: string }) => (person.developerId === asker ? "use" : "none") });
    expect(await contextOf(t)).toContain("Add a greeting");
    expect(await contextOf(t, MAYA_SLACK)).toBe(refused(SLACK_ASK_NOT_ALLOWED_WORDS));
  });

  it("gives the channel file names and counts only, never patch text", async () => {
    const readers = {
      diff: async () => ({ source: "pull_request" as const, files: [{ path: "src/greet.ts", additions: 4, deletions: 1 }], patches: [{ path: "src/greet.ts", patch: "@@ -1 +1 @@\n+PATCH-BODY-MARKER-9" }] }),
      notes: async () => [{ authorLabel: "person p_a1b2c3", authority: "owner_instruction" as const, text: "NOTE-TEXT-MARKER-9" }],
    };
    const t = await planWaiting("1695500000.000147", { slackAskReaders: readers });
    const context = await contextOf(t);
    expect(context).toContain("src/greet.ts +4 -1");
    for (const absent of ["PATCH-BODY-MARKER-9", "@@ -1 +1 @@", "NOTE-TEXT-MARKER-9", "diff_patch"]) expect(context, absent).not.toContain(absent);
  });

  it("spends the Ask rates: past 20 an hour the asker is answered with the rate sentence, and another person is not held", async () => {
    const t = await planWaiting("1695500000.000149");
    seedMembership(t.harness.db, developerIdForSlackUser("U0TEAMMATE2"));
    for (let index = 0; index < ASK_RATE.perPersonPerHour; index += 1) expect(await contextOf(t)).toContain("Add a greeting");
    expect(await contextOf(t)).toBe(refused(ASK_RATE_TEXT));
    expect(await contextOf(t, "U0TEAMMATE2")).toContain("Add a greeting");
  });

  it("with the switch OFF the same people are answered as before: an unlinked user, a viewer, a task with no session, no agents runtime", async () => {
    const off = await createSingleAnswerPlanBroker({ brokerExtra: { slackAskLevel: async () => "none" } });
    const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000151" };
    const started = await off.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA_SLACK, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID() });
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    const workspaceId = String(off.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
    await off.finish(workspaceId, String(operations(off, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    await finishPlanningWithMarkdown(off, workspaceId, String(operations(off, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), MARKDOWN);
    const answer = await teammate(off.handler, `${thread.teamId}/${thread.channelId}/${thread.threadTs}`, "U0OUTSIDER9", "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), ...TASK_REQUEST, taskAnswer: { taskId } });
    expect(String(answer.body.taskContext)).toContain("Add a greeting");
    expect(String(answer.body.taskContext)).not.toContain("This question cannot be answered");
  });

  it("knows a task's own open thread: another thread, another workspace and a closed task are not", async () => {
    const t = await planWaiting("1695500000.000152");
    const table = { documentClient: t.harness.db as never, tableName: "state" };
    const task = t.harness.db.get(`DEVTASK#${t.taskId}`, "META")! as { workspaceId: string };
    const own = { taskId: t.taskId, workspaceId: task.workspaceId, thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000152" } };
    expect(await taskOwnsThread(table, own)).toBe(true);
    expect(await taskOwnsThread(table, { ...own, thread: { ...own.thread, threadTs: "1695500000.000999" } })).toBe(false);
    expect(await taskOwnsThread(table, { ...own, thread: { ...own.thread, channelId: "C0OTHER9999" } })).toBe(false);
    expect(await taskOwnsThread(table, { ...own, thread: { ...own.thread, teamId: "T0OTHER9999" } })).toBe(false);
    expect(await taskOwnsThread(table, { ...own, workspaceId: randomUUID() })).toBe(false);
    t.harness.db.set({ ...t.harness.db.get(`DEVTASK#${t.taskId}`, "META")!, closedAt: new Date().toISOString() });
    expect(await taskOwnsThread(table, own)).toBe(false);
  });

  it("a thread that is not the task's, or a closed task, stays closed exactly as before (no fixed-words answer)", async () => {
    const t = await planWaiting("1695500000.000150");
    t.harness.db.set({ ...t.harness.db.get(`DEVTASK#${t.taskId}`, "META")!, closedAt: new Date().toISOString() });
    expect((await t.ensure()).body).toMatchObject({ outcome: "VIEW_ONLY", closed: true });
  });
});
