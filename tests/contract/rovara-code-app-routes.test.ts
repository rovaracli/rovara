// Rovara Code (Plan 6 Task 1, review M4): the app routes that answer a task view project it for a client that does not send `x-agentx-task-view: 2`, and the
// native-evidence reader of the CLI sends the header.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeAgentSessionRequest } from "../../packages/broker/src/agent-sessions/routes.js";
import { routeSpendRequests } from "../../packages/broker/src/spend/requests.js";
import { createDeveloperPublicationJoinTransport } from "../../packages/cli/src/loop/enrollment-cli.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { sessionResponseForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import { CELL, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";

const now = "2026-10-24T12:00:00.000Z";
const understanding = (taskId: string, project = "web") => ({
  taskId, title: "Bump the Stripe SDK", project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: now, updatedAt: now, events: [],
  workflow: { ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "WAITING" },
});
const stageOf = (answer: unknown): unknown => (answer as { workflow?: { stage?: unknown } }).workflow?.stage;
const withHeader = { "x-agentx-task-view": "2" };

describe("sessionResponseForClient", () => {
  it("projects the task in a task session's body, and leaves a chain or local body alone", () => {
    const task = understanding(randomUUID());
    const answer = { session: { sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", body: { kind: "task", task } } };
    expect(stageOf((sessionResponseForClient(answer, {}).session.body as { task: unknown }).task)).toBe("PLAN");
    expect(sessionResponseForClient(answer, withHeader)).toBe(answer);
    const chain = { session: { body: { kind: "chain", chain: { sections: [] } } } };
    expect(sessionResponseForClient(chain, {})).toEqual(chain);
    expect(sessionResponseForClient("text", {})).toBe("text");
  });
});

describe("the session routes", () => {
  function world() {
    const w = sessionWorld();
    const seeded = w.seedSession();
    const stepTaskId = randomUUID();
    const deps = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task: { taskId: string; project: string }) => understanding(task.taskId, task.project),
      chain: { runView: async () => { throw new Error("not read"); }, stepTask: async () => understanding(stepTaskId) },
      chainReadAccess: async () => true,
    };
    const get = (who: string, sessionId: string, path: string, headers: Record<string, string> = {}) => routeAgentSessionRequest(
      deps as never, w.caller(who, ORG_A), { method: "GET", path, headers, requestId: "r" }, new URL(path, "https://cell.example.com"),
    );
    return { w, seeded, get };
  }

  it("serves GET /v1/app/sessions/{id} the version 1 projection of its task without the header, and the full view with it", async () => {
    const { seeded, get } = world();
    const path = `/v1/app/sessions/${seeded.sessionId}`;
    const plain = await get(PRIYA, seeded.sessionId, path) as { session: { body: { task: unknown } } };
    expect(stageOf(plain.session.body.task)).toBe("PLAN");
    const full = await get(PRIYA, seeded.sessionId, path, withHeader) as { session: { body: { task: unknown } } };
    expect(stageOf(full.session.body.task)).toBe("UNDERSTAND");
  });

  it("serves a chain step's task the same way", async () => {
    const { w, get } = world();
    const chain = w.seedSession({ kind: "chain" });
    const path = `/v1/app/sessions/${chain.sessionId}/sections/1/task`;
    const plain = await get(PRIYA, chain.sessionId, path) as { task: unknown };
    expect(stageOf(plain.task)).toBe("PLAN");
    expect(stageOf(((await get(PRIYA, chain.sessionId, path, withHeader)) as { task: unknown }).task)).toBe("UNDERSTAND");
  });
});

describe("continue-as-task", () => {
  const caller = { orgId: ORG_A, developerId: PRIYA, name: "Priya" };
  const run = async (headers: Record<string, string>) => {
    const taskId = randomUUID();
    const request = { method: "POST", path: `/v1/app/tasks/${taskId}/continue-as-task`, headers, requestId: "r", body: "{}" };
    const deps = { spendRequests: { continueAsTask: async () => ({ task: understanding(taskId) }) } };
    return await routeSpendRequests(deps as never, caller as never, request, new URL(request.path, "https://agentx.invalid")) as { task: unknown };
  };

  it("projects the task for a client that does not send the header, and not for one that does", async () => {
    expect(stageOf((await run({})).task)).toBe("PLAN");
    expect(stageOf((await run(withHeader)).task)).toBe("UNDERSTAND");
  });
});

describe("the CLI's native task reader", () => {
  it("asks for the full task view, so it can see a stage it does not know", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-cli-header-"));
    const issuer = "https://identity.control.example/";
    const baseUrl = "https://control.example";
    await saveDeveloperEnvironment(home, "dev", { url: baseUrl, issuer, tokenEndpoint: `${baseUrl}/token`, revocationEndpoint: `${baseUrl}/revoke` });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(issuer), { accessToken: "synthetic-cli-session", expiresAt: Date.now() + 600_000 });
    const seen: Array<Record<string, string>> = [];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
      return new Response(JSON.stringify({ task: { taskId: "x" } }), { status: 200 });
    }) as typeof fetch;
    const transport = createDeveloperPublicationJoinTransport({ home, env: "dev", tokenStore, fetch: fetchStub });
    const taskRef = randomUUID();
    await transport.loadTask?.(taskRef, `${baseUrl}/env/dev/project/payments`, "payments");
    const read = seen.find((headers) => headers.authorization === "Bearer synthetic-cli-session");
    expect(read).toMatchObject({ "x-agentx-task-view": "2" });
  });
});
