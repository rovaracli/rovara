import { LambdaClient, type InvokeCommand, type InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { AgentXError } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { LearningNotForwarded, type ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler } from "../../packages/broker/src/model-proxy/handler.js";
import { LEARNING_NEEDS_SINGLE_ATTEMPT, ModelAccessInvoker, singleAttemptLambda, type ModelAccessInvokerInput } from "../../packages/broker/src/model-proxy/invoker.js";
import { routeFetch } from "../support/developer-fakes.js";

const ORG = "org_abcdefghij0123456789";
const DEV = "c".repeat(64);
const FUNCTION_NAME = "agentx-staging-model-access";

// The real Lambda client must fit the invoker's narrow view of it.
export const realClientFits: ModelAccessInvokerInput["lambda"] = new LambdaClient({});
// Both implementations satisfy the one interface later tasks depend on.
export const satisfies: ModelAccess[] = [new ModelAccessInvoker({ functionName: "f", lambda: realClientFits }), new ModelProxyClient({ baseUrl: "http://x", masterKey: async () => "k", fetch, now: Date.now })];

type Send = ModelAccessInvokerInput["lambda"]["send"];
const answer = (body: unknown, extra: { FunctionError?: string } = {}): InvokeCommandOutput =>
  ({ StatusCode: 200, Payload: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)), $metadata: {}, ...extra }) as InvokeCommandOutput;

function invokerWith(send: Send) {
  const sent: InvokeCommand[] = [];
  const client = { send: async (command: InvokeCommand, options?: { abortSignal?: AbortSignal }) => { sent.push(command); return send(command, options); } };
  const invoker = new ModelAccessInvoker({ functionName: FUNCTION_NAME, lambda: client, learningLambda: client });
  return { invoker, sent };
}
const payloadOf = (command: InvokeCommand) => JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString("utf8")) as unknown;
const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as AgentXError; }
  throw new Error("expected a rejection");
};

describe("ModelAccessInvoker", () => {
  it("invokes the function synchronously with the operation and its arguments", async () => {
    const { invoker, sent } = invokerWith(async () => answer({ ok: true, result: null }));
    await invoker.upsertOrg(ORG, 100);
    await invoker.upsertMember(ORG, DEV, 10);
    await invoker.revokeKey("sk-virtual");
    expect(sent.map((command) => command.input.FunctionName)).toEqual([FUNCTION_NAME, FUNCTION_NAME, FUNCTION_NAME]);
    expect(sent.map((command) => command.input.InvocationType)).toEqual(["RequestResponse", "RequestResponse", "RequestResponse"]);
    expect(sent.map(payloadOf)).toEqual([
      { op: "upsertOrg", args: { orgId: ORG, monthlyBudgetUsd: 100 } },
      { op: "upsertMember", args: { orgId: ORG, developerId: DEV, monthlyBudgetUsd: 10 } },
      { op: "revokeKey", args: { key: "sk-virtual" } },
    ]);
  });

  it("blocks a key by its id through the function", async () => {
    const { invoker, sent } = invokerWith(async () => answer({ ok: true, result: null }));
    await invoker.blockKey("d".repeat(64));
    expect(sent.map(payloadOf)).toEqual([{ op: "blockKey", args: { keyId: "d".repeat(64) } }]);
  });

  it("returns the spend and the minted key from the function's answer", async () => {
    const spend = { member: { spentUsd: 1, limitUsd: 2 }, org: { spentUsd: 3, limitUsd: 4 } };
    const { invoker, sent } = invokerWith(async (command) => answer({ ok: true, result: (payloadOf(command) as { op: string }).op === "spend" ? spend : { key: "sk-v", expiresAt: 99 } }));
    expect(await invoker.spend(ORG, DEV)).toEqual(spend);
    const mint = { orgId: ORG, developerId: DEV, purpose: "task" as const, refId: "task-1", maxBudgetUsd: 2, ttlSeconds: 300 };
    expect(await invoker.mintKey(mint)).toEqual({ key: "sk-v", expiresAt: 99 });
    expect(payloadOf(sent[1]!)).toEqual({ op: "mintKey", args: mint });
  });

  it("asks for the org's spend and the keys' spend, and a key list that is empty needs no invoke", async () => {
    const ids = ["a".repeat(64), "b".repeat(64)];
    const { invoker, sent } = invokerWith(async (command) => answer({ ok: true, result: (payloadOf(command) as { op: string }).op === "orgSpend" ? { spentUsd: 3, limitUsd: 4 } : 2.5 }));
    expect(await invoker.orgSpend(ORG)).toEqual({ spentUsd: 3, limitUsd: 4 });
    expect(await invoker.keySpend(ids)).toBe(2.5);
    expect(await invoker.keySpend([])).toBe(0);
    expect(sent.map(payloadOf)).toEqual([{ op: "orgSpend", args: { orgId: ORG } }, { op: "keySpend", args: { keyIds: ids } }]);
    const wrong = invokerWith(async () => answer({ ok: true, result: { spentUsd: "x" } }));
    expect((await failure(wrong.invoker.orgSpend(ORG))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect((await failure(wrong.invoker.keySpend(ids))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("sends a key request with no developer as one with no developerId", async () => {
    const { invoker, sent } = invokerWith(async () => answer({ ok: true, result: { key: "sk-v", expiresAt: 99 } }));
    await invoker.mintKey({ orgId: ORG, developerId: undefined, purpose: "task", refId: "op-1", maxBudgetUsd: 25, ttlSeconds: 300 });
    expect(payloadOf(sent[0]!)).toEqual({ op: "mintKey", args: { orgId: ORG, purpose: "task", refId: "op-1", maxBudgetUsd: 25, ttlSeconds: 300 } });
  });

  it("maps ok:false to an AgentXError with the same code and message", async () => {
    const { invoker } = invokerWith(async () => answer({ ok: false, code: "NOT_FOUND", message: "no such team" }));
    const error = await failure(invoker.spend(ORG, DEV));
    expect(error).toBeInstanceOf(AgentXError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("NOT_FOUND: no such team");
    const unavailable = invokerWith(async () => answer({ ok: false, code: "MODEL_PROXY_UNAVAILABLE", message: "model proxy is unreachable" }));
    const refused = await failure(unavailable.invoker.revokeKey("k"));
    expect(refused.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(refused.statusCode).toBe(503);
  });

  it("treats an invoke failure, a function error, a missing or garbled payload and a malformed result as MODEL_PROXY_UNAVAILABLE", async () => {
    const cases: Send[] = [
      async () => { throw new Error("AccessDeniedException"); },
      async () => answer({ errorMessage: "boom" }, { FunctionError: "Unhandled" }),
      async () => ({ StatusCode: 200, $metadata: {} }),
      async () => answer("not json"),
      async () => answer({ hello: "world" }),
      async () => answer({ ok: false, code: "NOT_A_CODE", message: "x" }),
      async () => answer({ ok: true, result: { member: "nope" } }),
    ];
    for (const send of cases) {
      const { invoker } = invokerWith(send);
      expect((await failure(invoker.spend(ORG, DEV))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    }
    const noKey = invokerWith(async () => answer({ ok: true, result: { key: "" } }));
    expect((await failure(noKey.invoker.mintKey({ orgId: ORG, developerId: DEV, purpose: "turn", refId: "r", maxBudgetUsd: 1, ttlSeconds: 1 }))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("gives up with MODEL_PROXY_UNAVAILABLE when the function does not answer in time", async () => {
    const hang: Send = (_command, options) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const invoker = new ModelAccessInvoker({ functionName: FUNCTION_NAME, lambda: { send: hang }, timeoutMs: 20 });
    expect((await failure(invoker.revokeKey("k"))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("round-trips through the real handler and client: a proxy 4xx keeps its code and a proxy 503 stays unavailable", async () => {
    let status = 200;
    const catalog = ["us.anthropic.claude-sonnet-4-6"];
    const fetch = routeFetch(async (url) => new Response(JSON.stringify(status !== 200 ? { error: { message: "Team not found" } } : url.pathname === "/team/info" ? { team_info: { models: catalog } } : { key: "sk-v" }), { status }));
    const run = createModelAccessHandler({ access: new ModelProxyClient({ baseUrl: "http://proxy:4000", masterKey: async () => "sk-m", fetch, now: () => 0, catalog }), log: () => undefined });
    const { invoker } = invokerWith(async (command) => answer(await run(payloadOf(command))));
    const mint = { orgId: ORG, developerId: DEV, purpose: "task" as const, refId: "t", maxBudgetUsd: 1, ttlSeconds: 60 };
    expect(await invoker.mintKey(mint)).toEqual({ key: "sk-v", expiresAt: 60_000 });
    status = 404;
    expect((await failure(invoker.mintKey(mint))).code).toBe("NOT_FOUND");
    status = 503;
    expect((await failure(invoker.mintKey(mint))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });
});

describe("R4: a learning call is sent to the function once, never retried by the SDK", () => {
  it("the client made for it sends each command once (maxAttempts 1); the ordinary client keeps the SDK's default retries", async () => {
    expect(await singleAttemptLambda({ region: "us-west-2" }).config.maxAttempts()).toBe(1);
    expect(await new LambdaClient({ region: "us-west-2" }).config.maxAttempts()).toBeGreaterThan(1);
  });

  it("H2: a reasoning effort reaches the function, and an absent one adds no field", async () => {
    const { invoker, sent } = invokerWith(async () => answer({ ok: true, result: { text: "{}", model: "m" } }));
    const base = { key: "k".repeat(24), purpose: "reflect" as const, system: "s", user: "u", maxOutputTokens: 10, model: "alias", api: "openai-responses" as const };
    await invoker.learningCompletion({ ...base, reasoningEffort: "minimal" });
    await invoker.learningCompletion(base);
    expect((payloadOf(sent[0]!) as { args: Record<string, unknown> }).args.reasoningEffort).toBe("minimal");
    expect(Object.keys((payloadOf(sent[1]!) as { args: Record<string, unknown> }).args)).not.toContain("reasoningEffort");
  });

  it("F1: an invoker with no single-attempt client REFUSES a learning call with a fixed LearningNotForwarded, sends nothing, and still serves every other operation", async () => {
    const sent: InvokeCommand[] = [];
    const ordinary = { send: async (command: InvokeCommand) => { sent.push(command); return answer({ ok: true, result: null }); } };
    const invoker = new ModelAccessInvoker({ functionName: FUNCTION_NAME, lambda: ordinary });
    const error = await failure(invoker.learningCompletion({ key: "k".repeat(24), purpose: "reflect", system: "s", user: "u", maxOutputTokens: 10, model: "alias", api: "anthropic-messages" }));
    expect(error).toBeInstanceOf(LearningNotForwarded);
    expect(error.message).toContain(LEARNING_NEEDS_SINGLE_ATTEMPT);
    expect(sent).toEqual([]);
    await invoker.revokeKey("sk-virtual");
    expect(sent).toHaveLength(1);
  });

  it("learningCompletion goes through the single-attempt client; every other operation goes through the ordinary one", async () => {
    const used: string[] = [];
    const lambda = (name: string, body: unknown): ModelAccessInvokerInput["lambda"] => ({ send: async () => { used.push(name); return answer(body); } });
    const invoker = new ModelAccessInvoker({ functionName: FUNCTION_NAME, lambda: lambda("ordinary", { ok: true, result: null }), learningLambda: lambda("single", { ok: true, result: { text: "{}", model: "m" } }) });
    await invoker.learningCompletion({ key: "k".repeat(24), purpose: "reflect", system: "s", user: "u", maxOutputTokens: 10, model: "alias", api: "anthropic-messages" });
    await invoker.revokeKey("sk-virtual");
    expect(used).toEqual(["single", "ordinary"]);
  });
});
