// Blind test 02 (staging 0.4.13): a Rovara Code question could not be answered from the CLI. `session tell` said "Queued" and nothing resumed; only the web route answered. `agentx session answer
// <task-or-session> --q1 ... --q2 ...` answers the questions on the same route the web uses (`POST /v1/app/sessions/{id}/answers`), and `session tell` on a task that waits for answers says where to
// answer. These tests run the real CLI against the real broker handler.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { INTENT_NOT_WAITING_MESSAGE, ANSWER_EVERY_QUESTION_MESSAGE } from "@rovara-code/contracts";
import { CELL, DEV_ISSUER, MAYA, questionsBroker, type QuestionsBroker } from "../support/rovara-code-questions-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type { Developer } from "../support/developer-task-broker.js";

const entry = { url: CELL, issuer: DEV_ISSUER, tokenEndpoint: `${DEV_ISSUER}/token`, revocationEndpoint: `${DEV_ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
beforeAll(loadSlackBroker);

/** The real CLI, signed in as `who`, whose every request goes to the real broker handler. */
async function cliAgainst(h: QuestionsBroker, who: Developer = MAYA) {
  const home = await mkdtemp(join(tmpdir(), "rovara-answer-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(DEV_ISSUER), { accessToken: (await h.bearer(who)).replace(/^Bearer /, ""), refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; status: number; sent: Record<string, unknown> | undefined; body: Record<string, unknown> }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const response = await h.handler({
      version: "2.0", rawPath: target.pathname, rawQueryString: target.search.slice(1), headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}), requestContext: { requestId: randomUUID(), http: { method } },
    });
    calls.push({ method, path: target.pathname, status: response.statusCode, sent: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined, body: JSON.parse(response.body) as Record<string, unknown> });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { run, text: () => out.join(""), errors: () => err.join(""), calls, posts: (suffix: string) => calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix)) };
}

describe("agentx session answer against the real broker", () => {
  it("answers every question on the answers route, an option by its letter and an open question by its words, and Understand runs again", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.sessionId, "--q1", "b", "--q2", "25 items"]), cli.errors()).toBe(0);
    const sent = cli.posts("/answers");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe(`/v1/app/sessions/${task.sessionId}/answers`);
    expect(sent[0]!.sent).toEqual({ requestId: expect.any(String) as string, round: 1, answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "25 items" }] });
    expect(sent[0]!.status).toBe(200);
    expect(h.meta(task.taskId).workflow).toMatchObject({ stage: "UNDERSTAND", state: "RUNNING", intent: { rounds: 1, answers: [{ round: 1, source: "app", answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "25 items" }] }] } });
    expect(cli.text()).toMatch(/Answered/);
    expect(cli.text()).toContain(`/app/sessions/${task.sessionId}`);
  });

  it("takes the task's ID as well as the session's, an option's label as well as its letter, and \"your call\" as an answer", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.taskId, "--q1", "Plain array", "--q2", "your call"]), cli.errors()).toBe(0);
    expect(cli.posts("/answers")[0]!.sent).toMatchObject({ answers: [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "your call" }] });
  });

  it("shows the questions, with the recommended option, and how to answer, when no answer is given, and sends nothing", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.sessionId]), cli.errors()).toBe(0);
    expect(cli.posts("/answers")).toEqual([]);
    expect(cli.text()).toContain("1. What response shape should the paginated endpoint return?");
    expect(cli.text()).toContain("b) Envelope: items, total, limit, offset (recommended)");
    expect(cli.text()).toContain("2. Which page size by default?");
    expect(cli.text()).toContain(`agentx session answer ${task.sessionId} --q1 <a|b|your own words> --q2 <your own words>`);
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });

  it("prints the server's exact words for a partial answer, and sends the round it read", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.sessionId, "--q1", "b"])).not.toBe(0);
    expect(cli.errors()).toContain(ANSWER_EVERY_QUESTION_MESSAGE);
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });

  it("says nothing waits for answers once they are answered, without sending a second answer", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.sessionId, "--q1", "b", "--q2", "25"]), cli.errors()).toBe(0);
    expect(await cli.run(["session", "answer", task.sessionId, "--q1", "a", "--q2", "50"])).not.toBe(0);
    expect(cli.errors()).toContain(INTENT_NOT_WAITING_MESSAGE);
    expect(cli.posts("/answers")).toHaveLength(1);
  });

  it("refuses an answer to a question the task did not ask, and a task that is not a session's, before sending anything", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "answer", task.sessionId, "--q3", "x"])).not.toBe(0);
    expect(cli.errors()).toMatch(/asks 2 questions/);
    expect(await cli.run(["session", "answer", "nonsense", "--q1", "a"])).not.toBe(0);
    expect(cli.posts("/answers")).toEqual([]);
  });

  it("is refused for a person who can only view the session, in the server's words", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const viewer: Developer = { developerId: "b2".repeat(32), name: "Max Weber", provider: "oidc", sessionId: "s-max" };
    h.member(viewer, "viewer");
    const share = await h.dev(MAYA, "PUT", `/v1/app/sessions/${task.sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: viewer.developerId }, level: "view" });
    expect(share.status, JSON.stringify(share.body)).toBeLessThan(300);
    const cli = await cliAgainst(h, viewer);
    expect(await cli.run(["session", "answer", task.sessionId, "--q1", "b", "--q2", "25"])).not.toBe(0);
    expect(cli.errors()).toMatch(/Viewers of payments can only watch/);
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });
});

describe("agentx session tell on a task that waits for answers", () => {
  it("says it was not delivered and where to answer, instead of \"Queued\"", async () => {
    const h = await questionsBroker();
    const task = await h.waitingTask();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "tell", task.sessionId, "use the envelope"]), cli.errors()).toBe(0);
    expect(cli.text()).not.toContain("Queued");
    expect(cli.text()).toContain("Not delivered");
    expect(cli.text()).toContain(`agentx session answer ${task.sessionId}`);
    expect(h.meta(task.taskId).workflow.state).toBe("WAITING");
  });
});
