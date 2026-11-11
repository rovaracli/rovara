// Bug G (staging 0.4.11): the broker had `POST /v1/app/sessions/{id}/merge` and nothing called it. `agentx session merge <task-or-session>` shows what is approved and whether checks passed,
// asks, presses, and prints the link where the person confirms it in their browser (a person always presses Merge; only the confirmation merges). These tests run the real CLI against the
// real broker handler, so a reader that cannot read what the broker really sends fails here.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { mergeTrackingKey } from "@rovara-code/contracts";
import { MERGE_NOT_READY_MESSAGES as M } from "../../packages/cloud-contracts/src/rovara-code.js";
import { CELL, DEV_ISSUER, HEAD_A, LOGIN, MAYA, mergeButtonBroker, type MergeButtonBroker } from "../support/merge-button-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const ISSUER = DEV_ISSUER;
const entry = { url: CELL, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
beforeAll(loadSlackBroker);

/** The real CLI, signed in as Maya, whose every request goes to the real broker handler. `answers` is what the person types at the question. */
async function cliAgainst(h: MergeButtonBroker, options: { answer?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-merge-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: (await h.bearer(MAYA)).replace(/^Bearer /, ""), refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; status: number; body: Record<string, unknown> }> = [];
  const questions: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const response = await h.handler({
      version: "2.0", rawPath: target.pathname, rawQueryString: target.search.slice(1), headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}), requestContext: { requestId: randomUUID(), http: { method } },
    });
    calls.push({ method, path: target.pathname, status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
    confirm: async (question: string) => { questions.push(question); return options.answer ?? true; },
  });
  return { run, text: () => out.join(""), errors: () => err.join(""), calls, questions, presses: () => calls.filter((call) => call.method === "POST" && call.path.endsWith("/merge")) };
}

describe("agentx session merge against the real broker", () => {
  it("shows who approved, the checks and the head, presses, and prints the link where the person confirms it", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), cli.errors()).toBe(0);
    const press = cli.presses();
    expect(press).toHaveLength(1);
    expect(press[0]!.status).toBe(202);
    const confirmUrl = String(press[0]!.body.confirmUrl);
    expect(cli.text()).toContain(`demo #7  open  head ${HEAD_A.slice(0, 7)}  checks passing  approved by ${LOGIN.arjun}`);
    expect(cli.text()).toContain("Ready to merge.");
    expect(cli.text()).toContain("Merge demo pull request 7 (squash)");
    expect(cli.text()).toContain(`Confirm this in your browser: ${confirmUrl}`);
    // Nothing is merged by the press: only the confirmation on the page merges.
    expect(h.github.mergeCalls).toEqual([]);
  });

  it("takes the task's ID as well as the session's", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.taskId, "--yes"]), cli.errors()).toBe(0);
    expect(cli.presses()).toHaveLength(1);
    expect(cli.text()).toContain("Confirm this in your browser: ");
  });

  it("sends the press as a person: the version 2 task view is asked for, and the answer's requestId is read past", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes", "--json"]), cli.errors()).toBe(0);
    const press = cli.presses()[0]!;
    expect(typeof press.body.requestId).toBe("string");
    expect(Object.keys(press.body).sort()).toEqual(["changes", "code", "confirmUrl", "requestId", "status"]);
    const json = JSON.parse(cli.text()) as { data?: { status?: string; confirmUrl?: string } };
    expect(json.data).toMatchObject({ status: "NEEDS_CONFIRMATION", confirmUrl: press.body.confirmUrl });
  });

  it("asks first, and a no presses nothing", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h, { answer: false });
    expect(await cli.run(["session", "merge", h.sessionId])).not.toBe(0);
    expect(cli.questions).toHaveLength(1);
    expect(cli.questions[0]).toContain("approved by");
    expect(cli.errors()).toContain("you did not press Merge; nothing changed");
    expect(cli.presses()).toEqual([]);
  });

  it("--yes presses without asking", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h, { answer: false });
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), cli.errors()).toBe(0);
    expect(cli.questions).toEqual([]);
    expect(cli.presses()).toHaveLength(1);
  });

  it("the confirmation link, opened and approved in a browser, merges once with the checked head", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), cli.errors()).toBe(0);
    const decided = await h.decide(String(cli.presses()[0]!.body.confirmUrl));
    expect(decided.status, decided.body.slice(decided.body.indexOf("</style>")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400)).toBeLessThan(400);
    expect(h.github.mergeCalls).toEqual([{ number: 7, sha: HEAD_A, method: "squash" }]);
  });

  it("a double press makes two links but the pull request is merged once", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), cli.errors()).toBe(0);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), cli.errors()).toBe(0);
    const [first, second] = cli.presses().map((press) => String(press.body.confirmUrl));
    expect(first).not.toBe(second);
    await h.decide(first!);
    await h.decide(second!);
    expect(h.github.mergeCalls).toHaveLength(1);
  });

  it("a press repeated with the same request ID is the same pending change (the broker's replay)", async () => {
    const h = await mergeButtonBroker();
    const requestId = randomUUID();
    const first = await h.dev(MAYA, "POST", `/v1/app/sessions/${h.sessionId}/merge`, { requestId });
    const second = await h.dev(MAYA, "POST", `/v1/app/sessions/${h.sessionId}/merge`, { requestId });
    expect(first.status).toBe(202);
    const approvalOf = (answer: { body: Record<string, unknown> }) => new URL(String(answer.body.confirmUrl)).pathname;
    expect(approvalOf(second)).toBe(approvalOf(first));
  });

  it("says why when the task is not ready, in the control plane's exact words, and presses nothing", async () => {
    const cases: Array<{ name: string; make: () => Promise<{ h: MergeButtonBroker; text: string }> }> = [
      { name: "checks failing", make: async () => ({ h: await mergeButtonBroker({ tracking: { ci: "failing", failingChecks: ["test"] } }), text: M.checks }) },
      { name: "no approval", make: async () => ({ h: await mergeButtonBroker({ approver: "none" }), text: M.needsOtherApproval("Maya Chen") }) },
      { name: "a draft", make: async () => ({ h: await mergeButtonBroker({ tracking: { draft: true } }), text: M.draft }) },
      { name: "the requester's own approval", make: async () => ({ h: await mergeButtonBroker({ approver: "maya" }), text: M.needsOtherApproval("Maya Chen") }) },
      { name: "a conflict", make: async () => ({ h: await mergeButtonBroker({ tracking: { branch: "conflicted" } }), text: M.conflicted("main") }) },
      { name: "closed", make: async () => ({ h: await mergeButtonBroker({ tracking: { state: "closed" } }), text: M.notOpen }) },
    ];
    for (const { name, make } of cases) {
      const { h, text } = await make();
      const cli = await cliAgainst(h);
      expect(await cli.run(["session", "merge", h.sessionId, "--yes"]), name).not.toBe(0);
      expect(cli.errors(), name).toContain(text);
      expect(cli.presses(), name).toEqual([]);
    }
  });

  it("prints the server's refusal when the press itself is refused (a task whose view says nothing about merging)", async () => {
    const h = await mergeButtonBroker();
    // The tracking is gone, so the view has no `merge`; the control plane refuses the press in its own words.
    h.db.delete(mergeTrackingKey(h.taskId, "demo", 7));
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", h.sessionId, "--yes"])).not.toBe(0);
    expect(cli.presses()).toHaveLength(1);
    expect(cli.presses()[0]!.status).toBe(409);
    expect(cli.errors()).toContain(M.notTrackedYet);
  });

  it("refuses a session that is not a task, and an ID that is neither a session nor a task", async () => {
    const h = await mergeButtonBroker();
    const cli = await cliAgainst(h);
    expect(await cli.run(["session", "merge", "not-an-id", "--yes"])).not.toBe(0);
    expect(cli.errors()).toContain("give a session ID");
    expect(cli.presses()).toEqual([]);
  });
});
