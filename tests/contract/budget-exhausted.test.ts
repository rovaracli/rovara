// Task 16: a budget running out mid-task ends the task clearly, and the owner can continue it once the budget is raised.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, DeveloperTaskFailureCategorySchema } from "../../packages/contracts/src/index.js";
import { ModelBudgetExhaustedError, PROXY_DEFAULT_MAX_OUTPUT_TOKENS, budgetExhaustedFromMarker, createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { BUDGET_HELD_MAX_WAIT_MS, budgetHeldBody, budgetHeldDelayMs, budgetMaxTokensHint, withOutputLimit } from "../../packages/model-runtime/src/budget.js";
import { failureCategory } from "../../packages/broker/src/developer/task-records.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
import { createDefaultPiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { seedTaskRunLimit } from "../support/run-history.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { call } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PROXY_KEY = "sk-proxy-budget-key-0001";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const EXACT = "Stopped: the AI budget for this task ran out. Raise the budget and choose Continue to resume.";

// The bodies the proxy answered with (docs/learnings/model-proxy-spike.md, question 3), HTTP 422.
const KEY_BODY = { error: { message: "Budget has been exceeded! Key=spike-key-budget (sk-...<redacted>) Current cost: 0.06170999999999999, Max budget: 0.05", type: "budget_exceeded", param: null, code: "422" } };
const USER_BODY = { error: { message: "ExceededBudget: User=spike-user-u over budget. Spend=0.06119999999999999, Budget=0.05", type: "budget_exceeded", param: null, code: "422" } };
const TEAM_BODY = { error: { message: "Budget has been exceeded! Team=spike-team-t Current cost: 0.06119999999999999, Max budget: 0.05", type: "budget_exceeded", param: null, code: "422" } };
const refusal = (body: unknown, status = 422) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function proxiedRuntime(transport: typeof fetch, apiKey: string | (() => Promise<string>) = PROXY_KEY, onUsage: (record: Record<string, unknown>) => void = () => undefined) {
  const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: transport, onUsage, proxy: { baseUrl: PROXY_URL, apiKey } });
  return { runtime, model: runtime.getModel("amazon-bedrock", BEDROCK_MODEL)! };
}

describe("the model runtime meets the proxy's budget refusal", () => {
  it.each([
    ["Team=", TEAM_BODY, "org"],
    ["User=", USER_BODY, "member"],
    ["Key=", KEY_BODY, "task"],
  ] as const)("classifies a %s refusal as the %s's budget, once, without keeping the body", async (_name, body, scope) => {
    const transport = vi.fn<typeof fetch>(async () => refusal(body));
    const usage = vi.fn();
    const { runtime, model } = await proxiedRuntime(transport, PROXY_KEY, usage);
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: `AI budget exhausted (${scope})` });
    expect(budgetExhaustedFromMarker(result.errorMessage)).toMatchObject({ name: "ModelBudgetExhaustedError", scope, message: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
    // A 422 is final: it is not retried.
    expect(transport).toHaveBeenCalledTimes(1);
    for (const surfaced of [result.errorMessage, JSON.stringify(usage.mock.calls)]) {
      expect(surfaced).not.toContain("spike-");
      expect(surfaced).not.toContain("Max budget");
      expect(surfaced).not.toContain(PROXY_KEY);
    }
  });

  it("leaves any other 422, or a 422 that is not JSON, as the generic failure", async () => {
    for (const answer of [refusal({ error: { message: "Invalid request", type: "invalid_request_error" } }), new Response("Budget has been exceeded! Team=x", { status: 422 }), refusal(TEAM_BODY, 400)]) {
      const { runtime, model } = await proxiedRuntime(async () => answer.clone());
      const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
      expect(result.stopReason).toBe("error");
      expect(budgetExhaustedFromMarker(result.errorMessage)).toBeUndefined();
      expect(result.errorMessage).toMatch(/^Anthropic request failed; /);
    }
  });

  it("does not read or buffer a successful stream's body for a budget", async () => {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const cloned = vi.spyOn(Response.prototype, "clone");
    try {
      const { runtime, model } = await proxiedRuntime(async () => sse([
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: BEDROCK_MODEL, content: [], stop_reason: null, usage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]));
      expect((await runtime.streamSimple(model, context, { maxTokens: 64 }).result()).stopReason).toBe("stop");
      expect(cloned).not.toHaveBeenCalled();
    } finally { cloned.mockRestore(); }
  });

  it("surfaces a budget refusal of a re-minted key the same way", async () => {
    let asked = 0;
    const transport = vi.fn<typeof fetch>(async () => refusal(TEAM_BODY));
    const { runtime, model } = await proxiedRuntime(transport, async () => {
      asked += 1;
      if (asked > 1) throw new ModelBudgetExhaustedError("org");
      return PROXY_KEY;
    });
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: "AI budget exhausted (org)" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["project", "agent", "chain", "test"] as const)("carries the %s's refusal of a re-minted key to the worker in the stream's message", async (scope) => {
    let asked = 0;
    const { runtime, model } = await proxiedRuntime(vi.fn<typeof fetch>(), async () => {
      asked += 1;
      if (asked > 1) throw new ModelBudgetExhaustedError(scope);
      return PROXY_KEY;
    });
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: `AI budget exhausted (${scope})` });
    expect(budgetExhaustedFromMarker(result.errorMessage)).toMatchObject({ name: "ModelBudgetExhaustedError", scope, message: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
  });

  // The proxy's 429 budget_held (rovara_guard.py, section 4): the budget has room but the task's other calls hold it. Both envelopes the proxy answers with.
  const HELD_OPENAI = { error: { message: "other model calls of this task hold its budget for now; try again shortly", type: "budget_held", param: null, code: "429" } };
  const HELD_ANTHROPIC = { type: "error", error: { type: "budget_held", message: "other model calls of this task hold its budget for now; try again shortly" } };
  const held = (body: unknown, retryAfter = "0") => new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } });
  const answered = () => sse([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: BEDROCK_MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);

  it("waits out a 429 budget_held and sends the same request again, never reading it as a rate limit or a spent budget", async () => {
    const bodies: string[] = [];
    let n = 0;
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "not text");
      n += 1;
      return n === 1 ? held(HELD_ANTHROPIC) : n === 2 ? held(HELD_OPENAI) : answered();
    });
    const { runtime, model } = await proxiedRuntime(transport);
    const started = Date.now();
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result.stopReason).toBe("stop");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(new Set(bodies).size).toBe(1);
    // retry-after 0 is held to the 0.25 s floor, so the proxy cannot be hammered
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it("stops waiting for held budget when the call is cancelled", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>(async () => held(HELD_OPENAI, "30"));
    const { runtime, model } = await proxiedRuntime(transport);
    const stream = runtime.streamSimple(model, context, { maxTokens: 64, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("tells a held budget only by its type: a rate limit, a spent budget or a non-JSON 429 is not one", () => {
    expect(budgetHeldBody(429, JSON.stringify(HELD_OPENAI))).toBe(true);
    expect(budgetHeldBody(429, JSON.stringify(HELD_ANTHROPIC))).toBe(true);
    expect(budgetHeldBody(422, JSON.stringify(HELD_OPENAI))).toBe(false);
    expect(budgetHeldBody(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }))).toBe(false);
    expect(budgetHeldBody(429, JSON.stringify(KEY_BODY))).toBe(false);
    expect(budgetHeldBody(429, "budget_held")).toBe(false);
    expect([budgetHeldDelayMs("2"), budgetHeldDelayMs(null), budgetHeldDelayMs("0"), budgetHeldDelayMs("9999"), budgetHeldDelayMs("soon")]).toEqual([2_000, 2_000, 250, 30_000, 2_000]);
    // longer than the guard's 1,000 s orphan expiry, so a hold whose replica died is spent first
    expect(BUDGET_HELD_MAX_WAIT_MS).toBeGreaterThan(1_000_000);
  });

  it("asks the proxy for a realistic output limit: 32,000 tokens unless the caller or the step set one", async () => {
    const sent: number[] = [];
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      sent.push((JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { max_tokens: number }).max_tokens);
      return answered();
    });
    const { runtime, model } = await proxiedRuntime(transport);
    expect(model.maxTokens).toBeGreaterThan(PROXY_DEFAULT_MAX_OUTPUT_TOKENS);
    await runtime.streamSimple(model, context).result();                                   // nothing named: the proxy default
    await runtime.streamSimple(model, context, { maxTokens: 64 }).result();                // the caller's
    await runtime.streamSimple({ ...model, maxTokens: 50_000 }, context).result();         // a step that lowered the model's limit (pi-session maxOutputTokens)
    await runtime.streamSimple({ ...model, maxTokens: 8_000 }, context).result();
    expect(sent).toEqual([PROXY_DEFAULT_MAX_OUTPUT_TOKENS, 64, 50_000, 8_000]);
  });

  it("sends a call again with the output limit the budget can still pay for (422 budget_max_tokens) instead of ending the task", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hint = (body: unknown) => new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/json", "x-rovara-max-tokens": "10000" } });
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      sent.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
      return sent.length === 1 ? hint({ type: "error", error: { type: "budget_max_tokens", message: "the task budget left pays for at most 10000 output tokens" } }) : answered();
    });
    const { runtime, model } = await proxiedRuntime(transport);
    const result = await runtime.streamSimple(model, context, { maxTokens: 64_000 }).result();
    expect(result.stopReason).toBe("stop");
    expect(sent.map((body) => body.max_tokens)).toEqual([64_000, 10_000]);
    expect(budgetExhaustedFromMarker(result.errorMessage)).toBeUndefined();
    // the OpenAI envelope too; a hint that never helps stops after two lowered sends and is not read as a spent budget
    const stubborn = vi.fn<typeof fetch>(async () => hint({ error: { type: "budget_max_tokens", message: "m", param: null, code: "422" } }));
    const again = await proxiedRuntime(stubborn);
    const failed = await again.runtime.streamSimple(again.model, context, { maxTokens: 64_000 }).result();
    expect(stubborn).toHaveBeenCalledTimes(3);
    expect(failed.stopReason).toBe("error");
    expect(budgetExhaustedFromMarker(failed.errorMessage)).toBeUndefined();
  });

  it("reads a max-tokens hint only from its own answer, and keeps a thinking budget under the lowered limit", () => {
    const body = JSON.stringify({ error: { type: "budget_max_tokens" } });
    expect(budgetMaxTokensHint(422, body, "10000")).toBe(10_000);
    expect(budgetMaxTokensHint(422, body, null)).toBeUndefined();
    expect(budgetMaxTokensHint(422, body, "lots")).toBeUndefined();
    expect(budgetMaxTokensHint(422, JSON.stringify(KEY_BODY), "10000")).toBeUndefined();
    expect(budgetMaxTokensHint(429, body, "10000")).toBeUndefined();
    expect(JSON.parse(withOutputLimit(JSON.stringify({ max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 20_000 } }), 10_000)!)).toEqual({ max_tokens: 10_000, thinking: { type: "enabled", budget_tokens: 8_976 } });
    expect(JSON.parse(withOutputLimit(JSON.stringify({ max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 4_000 } }), 10_000)!)).toEqual({ max_tokens: 10_000, thinking: { type: "enabled", budget_tokens: 4_000 } });
    expect(JSON.parse(withOutputLimit(JSON.stringify({ max_output_tokens: 64_000, max_completion_tokens: 100 }), 10_000)!)).toEqual({ max_output_tokens: 10_000, max_completion_tokens: 100 });
    expect(JSON.parse(withOutputLimit(JSON.stringify({ model: "m" }), 10_000)!)).toEqual({ model: "m", max_tokens: 10_000 });
    expect(withOutputLimit("not json", 10_000)).toBeUndefined();
  });

  it("refuses a runtime whose first key is already refused for budget, as the budget and not as a proxy fault", async () => {
    const error = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { proxy: { baseUrl: PROXY_URL, apiKey: async () => { throw new ModelBudgetExhaustedError("member"); } } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelBudgetExhaustedError);
  });
});

describe("the worker's model access meets a spent budget at a re-mint (ruling R37)", () => {
  const source = (response: Response) => modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: async () => response.clone() });
  const body = (code: string, message: string) => JSON.stringify({ error: { code, message } });
  const caught = async (response: Response) => source(response)().catch((error: unknown) => error);

  it.each([
    ["the organisation's", "ORG_BUDGET_EXCEEDED", "Your company's monthly AI budget is used up. Ask an admin to raise it.", "org"],
    ["the member's", "BUDGET_EXCEEDED", "Your monthly AI budget is used up ($29.00 of $29.00). Ask an admin to raise it.", "member"],
    ["the task's own", "BUDGET_EXCEEDED", "This task has used its AI budget ($25.00 of $25.00). Choose Continue to resume this task with a fresh budget.", "task"],
    ["the project's", "PROJECT_BUDGET_EXCEEDED", "The web project's monthly AI budget is used up ($5.00 of $5.00). Ask for more from the project's page.", "project", 402],
    ["the agent's", "AGENT_BUDGET_EXCEEDED", "Ticket Triage's monthly AI budget is used up ($20.00 of $20.00). Ask its owner for more.", "agent", 402],
    ["a member's testing allowance", "TEST_ALLOWANCE_USED", "Your testing allowance for this month is used up ($10.00 of $10.00). Run the agent as a normal task instead.", "test", 402],
    ["an agent with no budget", "AGENT_BUDGET_REQUIRED", "Ticket Triage has no monthly budget, so it can't run work that no person started. Ask its owner to set one.", "agent", 409],
    ["the chain's (Plan 4)", "CHAIN_BUDGET_EXCEEDED", "Investigate's monthly AI budget is used up ($5.00 of $5.00). Ask its owner for more.", "chain", 402],
    ["a chain with no budget (Plan 4)", "CHAIN_BUDGET_REQUIRED", "Investigate has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both.", "chain", 409],
  ] as const)("ends on %s refusal with ModelBudgetExhaustedError", async (_name, code, message, scope, status = 402) => {
    const error = await caught(new Response(body(code, message), { status }));
    // By name: the worker's source imports the package's built copy of the class, this test its source's.
    expect(error).toMatchObject({ name: "ModelBudgetExhaustedError", scope, message: BUDGET_EXHAUSTED_FAILURE_MESSAGE });
  });

  it.each([
    ["a 503", new Response(body("MODEL_PROXY_UNAVAILABLE", "x"), { status: 503 })],
    ["a 402 of another code", new Response(body("SOMETHING_ELSE", "x"), { status: 402 })],
    ["a 402 without a body", new Response("", { status: 402 })],
    ["a 402 whose code is an object property's name", new Response(body("constructor", "x"), { status: 402 })],
    ["a 409 of another code", new Response(body("WORKSPACE_BUSY", "x"), { status: 409 })],
  ])("keeps %s a RUNTIME_UNAVAILABLE", async (_name, response) => {
    const error = await caught(response);
    expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("a task whose budget runs out mid-task", () => {
  it("ends FAILED with the one message, whichever budget it was", async () => {
    for (const [body, scope] of [[TEAM_BODY, "org"], [USER_BODY, "member"], [KEY_BODY, "task"]] as const) {
      const rootPath = await mkdtemp(join(tmpdir(), "agentx-budget-"));
      try {
        const repository = join(rootPath, "repo/app");
        await mkdir(repository, { recursive: true });
        const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
        git("init", "--quiet", "--initial-branch=main");
        await writeFile(join(repository, "README.md"), "base\n");
        git("add", ".");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
        const at = new Date().toISOString();
        await mkdir(join(rootPath, ".agentx"));
        await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1,
          repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit: git("rev-parse", "HEAD"), resolvedAt: at, completedAt: at }],
          completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: at }));
        // The real model runtime and session, with the proxy answering the model request with the recorded refusal.
        const transport = vi.fn<typeof fetch>(async () => refusal(body));
        const model = { provider: "amazon-bedrock", modelId: BEDROCK_MODEL };
        const piAdapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: (await proxiedRuntime(transport)).runtime, model }) });
        const invocation = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
          payload: { conversationId: randomUUID(), prompt: "Change the readme" } };
        const failure = await runTaskInvocation(invocation as never, { rootPath, model, piAdapter, eventSink: async () => undefined, artifactSink: async () => undefined }).catch((error: unknown) => error);
        expect(failure).toMatchObject({ name: "ModelBudgetExhaustedError", scope, message: EXACT });
        expect(transport).toHaveBeenCalledTimes(1);
      } finally {
        await rm(rootPath, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

describe("the control plane reads the task's failure", () => {
  it("has budget_exhausted among the failure categories, with the plan's exact message", () => {
    expect(DeveloperTaskFailureCategorySchema.options).toContain("budget_exhausted");
    expect(BUDGET_EXHAUSTED_FAILURE_MESSAGE).toBe(EXACT);
  });

  it("categorises the message as budget_exhausted for a task, and nothing else is", () => {
    expect(failureCategory("task", "FAILED", EXACT)).toBe("budget_exhausted");
    expect(failureCategory("task", "FAILED", "the model call failed: rate limited")).toBe("task_failed");
    expect(failureCategory("task", "FAILED", `RUNTIME_UNAVAILABLE: ${EXACT}`)).toBe("worker_unavailable");
    expect(failureCategory("task", "INTERRUPTED", EXACT)).toBe("interrupted");
  });

  async function exhaustedTask() {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(task.workspaceId, active(), "SUCCEEDED");
    await harness.finish(task.workspaceId, active(), "FAILED", { error: EXACT });
    return { ...harness, taskId, task, active };
  }

  it("shows the ended task FAILED with category budget_exhausted and the exact message", async () => {
    const { dev, taskId } = await exhaustedTask();
    const view = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(view.status).toBe(200);
    expect(view.body.task).toMatchObject({ status: "FAILED", failure: { category: "budget_exhausted", message: EXACT } });
  });

  it("accepts continue on that task once the budget is raised", async () => {
    const { dev, db, taskId, task, active } = await exhaustedTask();
    const requestId = randomUUID();
    const continued = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId, instructions: "Carry on where you stopped." });
    expect(continued.status).toBe(200);
    expect(continued.body.task).toMatchObject({ status: "RUNNING" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${active()}`)).toMatchObject({ kind: "task", requestId });
  });
});


describe("continuing after the budget ran out (ruling R38)", () => {
  /** A task with a proxy: started, its first model key minted, then ended FAILED for budget. Asks for model access as the worker of the latest operation. */
  async function exhausted() {
    const access = fakeModelAccess();
    const h = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true } });
    // A task with no workflow starts at the TASK estimate's run limit (Task 34); these tests are written for a task budget of $25.
    seedTaskRunLimit(h.db);
    access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
    access.setOrgSpent(TEST_ORG, 0);
    const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const active = () => String((h.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    const ask = () => {
      const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === active())[0]!;
      const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
      return call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    };
    await h.finish(task.workspaceId, active(), "SUCCEEDED");
    expect((await ask()).status).toBe(200);
    const record = () => h.db.get(`DEVTASK#${taskId}`, "META") as { budgetUsd: number; budgetBaselineUsd?: number; modelKeyIds?: string[] };
    const end = () => h.finish(task.workspaceId, active(), "FAILED", { error: EXACT });
    const cont = () => h.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Carry on." });
    return { ...h, access, taskId, task, active, ask, record, end, cont };
  }

  it("mints again after the member's budget is raised, where it was refused before", async () => {
    const h = await exhausted();
    h.access.setMemberSpent(TEST_ORG, MAYA.developerId, 29);
    expect(await h.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    await h.end();
    // The task's budget is its whole $25, whatever the member had left when it started.
    expect(h.record().budgetUsd).toBe(25);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    expect((await h.dev(MAYA, "PUT", "/v1/dev/org/budget", { requestId: randomUUID(), memberDefaultMonthlyUsd: 100 })).status).toBe(200);
    expect((await h.cont()).status).toBe(200);
    const minted = h.access.mintKey.mock.calls.length;
    expect((await h.ask()).status).toBe(200);
    expect(h.access.mintKey).toHaveBeenCalledTimes(minted + 1);
    expect(h.access.mintKey.mock.calls.at(-1)![0].maxBudgetUsd).toBe(25);
  });

  it("gives a task that spent its own $25 a fresh window when its owner continues it, and counts only what it spends after", async () => {
    const h = await exhausted();
    h.access.setKeySpent(h.access.mintedKeys()[0]!, 25);
    expect(await h.ask()).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    await h.end();
    expect((await h.cont()).status).toBe(200);
    expect(h.record().budgetBaselineUsd).toBe(25);
    expect((await h.ask()).status).toBe(200);
    expect(h.access.mintKey.mock.calls.at(-1)![0].maxBudgetUsd).toBe(25);
    // The new window is spent in turn: $10 of it leaves $15 for the next key, and $25 of it ends the task again.
    h.access.setKeySpent(h.access.mintedKeys()[1]!, 10);
    expect((await h.ask()).status).toBe(200);
    expect(h.access.mintKey.mock.calls.at(-1)![0].maxBudgetUsd).toBe(15);
    h.access.setKeySpent(h.access.mintedKeys()[1]!, 25);
    const spentAgain = await h.ask();
    expect(spentAgain).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(JSON.stringify(spentAgain.body)).toContain("This task has used its AI budget ($25.00 of $25.00)");
  });

  it("refuses a continue with 503 while the proxy is down, and changes nothing", async () => {
    const h = await exhausted();
    h.access.setKeySpent(h.access.mintedKeys()[0]!, 25);
    await h.end();
    const before = JSON.stringify(h.db.find(() => true));
    h.access.goDown();
    const refused = await h.cont();
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(h.record().budgetBaselineUsd).toBeUndefined();
    expect(JSON.stringify(h.db.find(() => true))).toBe(before);
  });
});
