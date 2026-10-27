// Blind test 02 (staging 0.4.13): an AI tool could not answer a Rovara Code question. agentx_continue_task said TASK_BUSY, agentx_tell_session_agent said "queued" and nothing resumed, and
// agentx_get_task showed the questions only inside the summary. The plan allows AI tools to answer (Plan 6 Task 25: agentx_answer_task_questions); the person's authority is the same as in the app
// ("can use" on the session, judged by the control plane), and nothing here approves a plan, merges or spends. These tests drive the real MCP server against the real broker handler.
import { describe, expect, it } from "vitest";
import { ANSWER_EVERY_QUESTION_MESSAGE, INTENT_NOT_WAITING_MESSAGE } from "../../packages/contracts/src/index.js";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/tools.js";
import { OMAR } from "../support/developer-task-broker.js";
import { signedInClient } from "../support/mcp-broker-client.js";
import { MAYA, questionsBroker } from "../support/rovara-code-questions-broker.js";

describe("agentx_get_task for a task that waits for answers", () => {
  it("lists the questions, the round and the options in its structured answer, and says in its text how to answer them", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const read = await tool("agentx_get_task", { task_id: task.taskId });
    expect(read.isError).toBe(false);
    expect(read.value).toMatchObject({
      workflow: { stage: "UNDERSTAND", state: "WAITING" },
      questions: { round: 1, items: [
        { id: "q1", text: "What response shape should the paginated endpoint return?", options: [{ id: "a", label: "Plain array" }, { id: "b", label: "Envelope: items, total, limit, offset" }], recommended: "b" },
        { id: "q2", text: "Which page size by default?" },
      ] },
    });
    expect(read.text).toContain("agentx_answer_task_questions");
    expect(read.text).toContain("round 1");
    expect(read.text).toContain("[q1] What response shape should the paginated endpoint return?");
    expect(read.text).toContain("b) Envelope: items, total, limit, offset (recommended)");
    // Neither of the tools that looked like they would answer does.
    expect(read.text).toMatch(/not agentx_continue_task or agentx_tell_session_agent/);
  });

  it("shows no questions once they are answered", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "b" }, { question_id: "q2", text: "25" }] });
    const read = await tool("agentx_get_task", { task_id: task.taskId });
    expect(read.value).not.toHaveProperty("questions");
    expect(read.text).not.toContain("agentx_answer_task_questions");
  });
});

describe("agentx_answer_task_questions", () => {
  it("is among the developer tools, with a task and its answers as inputs", () => {
    const tool = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_answer_task_questions");
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema).sort()).toEqual(["answers", "request_id", "round", "task_id"]);
    expect(tool!.description).toMatch(/Needs "can use" on the task's session/);
    // It answers questions and nothing else: no tool of the list approves, merges or spends.
    expect(DEVELOPER_TOOLS.map((entry) => entry.name).filter((name) => /merge|approve/.test(name))).toEqual([]);
  });

  it("answers on the answers route the app uses: an option, and a person's own words, and Understand runs again", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool, expectNoTokenLeaked } = await signedInClient(h, MAYA);
    const answered = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "b" }, { question_id: "q2", text: "25 items" }] });
    expect(answered.isError, JSON.stringify(answered.error)).toBe(false);
    expect(h.meta(task.taskId).workflow).toMatchObject({ stage: "UNDERSTAND", state: "RUNNING", intent: { rounds: 1, answers: [{ round: 1, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "25 items" }] }] } });
    expect(answered.value).toMatchObject({ task_id: task.taskId, workflow: { stage: "UNDERSTAND", state: "RUNNING" } });
    expect(typeof answered.value.request_id).toBe("string");
    expect(answered.text).toMatch(/answers were sent/i);
    expectNoTokenLeaked();
  });

  it("says Answer every question, in the control plane's words, when one is left out, and changes nothing", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const partial = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "b" }] });
    expect(partial.isError).toBe(true);
    // The tool errors drop a message's closing full stop.
    expect(partial.error?.message).toContain(ANSWER_EVERY_QUESTION_MESSAGE.replace(/\.$/u, ""));
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });

  it("refuses an answer to a question the task did not ask, an option it did not offer and an empty answer, before sending anything", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const unknown = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q9", text: "x" }] });
    expect(unknown.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(unknown.error?.message).toContain("q9");
    expect(unknown.error?.message).toContain("q1, q2");
    const option = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "z" }, { question_id: "q2", text: "x" }] });
    expect(option.error).toMatchObject({ code: "INVALID_REQUEST" });
    const empty = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1" }, { question_id: "q2", text: "x" }] });
    expect(empty.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });

  it("refuses answers to questions from another round, saying the questions changed", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const stale = await tool("agentx_answer_task_questions", { task_id: task.taskId, round: 2, answers: [{ question_id: "q1", option_id: "b" }, { question_id: "q2", text: "x" }] });
    expect(stale.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(stale.error?.message).toMatch(/round 1/);
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });

  it("says nothing waits for answers once they are answered, and sends no second answer", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "b" }, { question_id: "q2", text: "25" }] });
    const again = await tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "a" }, { question_id: "q2", text: "50" }] });
    expect(again.error).toMatchObject({ code: "SESSION_REFUSED" });
    expect(again.error?.message).toContain(INTENT_NOT_WAITING_MESSAGE.replace(/\.$/u, ""));
    expect((h.meta(task.taskId).workflow.intent?.answers ?? [])).toHaveLength(1);
  });

  it("does not show another person's task", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const omar = await signedInClient(h, OMAR);
    const refused = await omar.tool("agentx_answer_task_questions", { task_id: task.taskId, answers: [{ question_id: "q1", option_id: "b" }, { question_id: "q2", text: "x" }] });
    expect(refused.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });
});

describe("agentx_tell_session_agent on a task that waits for answers", () => {
  it("says it was not delivered, with the reason and where to answer, instead of that it is queued", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const told = await tool("agentx_tell_session_agent", { session_id: task.sessionId, text: "use the envelope" });
    expect(told.isError).toBe(false);
    expect(told.value).toMatchObject({ delivery: "not_delivered", delivery_reason: expect.stringContaining("waiting for your answers") as string });
    expect(told.text).toContain("It was not delivered");
    expect(told.text).toContain("agentx_answer_task_questions");
    expect(told.text).not.toMatch(/queued/i);
  });
});

describe("agentx_continue_task on a task that waits for answers", () => {
  it("is TASK_BUSY in words that say to answer the questions, and its next step is the answer tool, not waiting", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const { tool } = await signedInClient(h, MAYA);
    const refused = await tool("agentx_continue_task", { task_id: task.taskId, instructions: "use the envelope" });
    expect(refused.error).toMatchObject({ code: "TASK_BUSY" });
    expect(refused.error?.message).toContain("waiting for your answers to Rovara's questions");
    expect(refused.error?.message).toContain(`agentx session answer ${task.sessionId}`);
    expect(refused.error?.message).toContain("agentx_answer_task_questions");
    expect(refused.error?.next_step).toContain("agentx_answer_task_questions");
    expect(refused.error?.next_step).not.toContain("agentx_wait_for_task");
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });
});
