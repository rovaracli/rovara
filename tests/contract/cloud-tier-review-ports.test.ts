// S3-9: the lighter flow's reviewer ports over the broker's own money and model machinery (cloud/app/tier-review-ports.ts), on a fake table and a fake proxy with the REAL admission, mint and ledger:
// the task's captured payer, a source billed to the company (never a person's plan, never a forbidden model), the payer's budgets (a used-up month refuses), and a key capped at the call's hold,
// reserved on the payer's scopes, used for the one call and blocked after it whatever happened.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, ModelSourceSchema, agentGuardrailsKey, modelSourcesKey, sourceAlias, type ModelIdentifier, type Payer } from "@rovara-code/contracts";
import { editionPolicy, modelKeyKey, spendCounterKey, spendOriginKind } from "@agentx/cloud-contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { cloudTierReviewPorts, tierReviewCallKey, tierReviewLongCallsOn, TIER_REVIEW_ORIGIN } from "../../packages/broker/src/cloud/app/tier-review-ports.js";
import { tierReviewCallBlocked, type TierReviewCallRow } from "../../packages/broker/src/cloud/app/tier-review.js";
import { taskPayerKey } from "../../packages/broker/src/cloud/app/money.js";
import type { ReviewCompletionInput } from "../../packages/broker/src/model-proxy/access.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

const SRC = "src_aaaaaaaaaaaaaaaaaaaa";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const MEMBER = "c".repeat(64);
const MONTH = new Date().toISOString().slice(0, 7);
const ROUTE = { model: SONNET, alias: sourceAlias(TEST_ORG, SRC, SONNET), sourceId: SRC, api: "anthropic-messages" as const };

afterEach(() => { vi.restoreAllMocks(); });

function install(options: { forbidden?: ModelIdentifier[]; models?: ModelIdentifier[]; order?: string[]; withReview?: boolean; assistantModel?: ModelIdentifier; kind?: "anthropic" | "openai" } = {}) {
  const db = new FakeDynamoDb();
  const chatgptServes = vi.fn(async () => "gpt-5.4");
  if (options.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: options.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy("public"),
    forbiddenModels: async () => options.forbidden ?? [], chatgpt: { serves: chatgptServes },
  };
  const proxy = fakeModelAccess();
  proxy.setOrgSpent(TEST_ORG, 0);
  const baseMint = proxy.mintKey.getMockImplementation()!;
  proxy.mintKey.mockImplementation(async (mint) => ({ ...(await baseMint(mint)), expiresAt: Date.now() + mint.ttlSeconds * 1000 }));
  const reviews: ReviewCompletionInput[] = [];
  const reviewCompletion = vi.fn(async (input: ReviewCompletionInput) => { reviews.push(input); return { text: "[]", model: input.model }; });
  const access = Object.assign(proxy, options.withReview === false ? {} : { reviewCompletion });
  const ledger = { documentClient: db, tableName: "state", access, now: Date.now, cloud: true };
  const logs: Array<Record<string, unknown>> = [];
  const ports = cloudTierReviewPorts({ companyId: TEST_ORG, documentClient: db, tableName: "state", access, routing, ledger, cloud: true, log: (event, fields) => { logs.push({ event, ...fields }); } });
  const ready = async () => {
    const source = ModelSourceSchema.parse({ kind: options.kind ?? "anthropic", sourceId: SRC, label: options.kind === "openai" ? "OpenAI" : "Anthropic", models: (options.models ?? [SONNET]).map((catalog) => ({ catalog })) });
    await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" });
    await store.setOrder({ orgId: TEST_ORG, order: options.order ?? [SRC], by: "dev-owner" });
    if (options.assistantModel !== undefined) db.set({ ...db.get(modelSourcesKey(TEST_ORG))!, assistantModel: options.assistantModel });
  };
  const payerRow = (taskId: string, payer: Payer, orgId: string = TEST_ORG) => db.set({ ...taskPayerKey(taskId), entityType: "TASK_PAYER", orgId, taskId, payer, project: "web", origin: "app", settingsRevision: 0 });
  const limitProject = (limitUsd: number) => db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#web`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, monthlyBudgetUsd: limitUsd, revision: 1 });
  const counter = (sk: string) => db.get(spendCounterKey(TEST_ORG, MONTH, sk)) as { committedUsd?: number } | undefined;
  return { db, proxy, ports, reviews, reviewCompletion, ready, payerRow, limitProject, counter, logs, chatgptServes };
}

const sentLog: string[] = [];
const call = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task-1", project: "web", payer: { kind: "member", developerId: MEMBER } as Payer, route: ROUTE, holdUsd: 0.2, prompt: "the whole prompt", purpose: "questions" as const, signal: new AbortController().signal,
  sent: async () => { sentLog.push("sent"); }, ...overrides,
});

describe("task: the payer the core task's start captured, for this company only", () => {
  it("answers the captured payer and project; another company's row, or none, is no payer", async () => {
    const t = install();
    t.payerRow("task-1", { kind: "member", developerId: MEMBER });
    t.payerRow("task-2", { kind: "project", project: "web" }, OTHER_ORG);
    expect(await t.ports.task("task-1")).toEqual({ project: "web", payer: { kind: "member", developerId: MEMBER } });
    expect(await t.ports.task("task-2")).toBeUndefined();
    expect(await t.ports.task("task-none")).toBeUndefined();
  });

  it("a row whose payer is not a payer (no kind, a kind that is not text, not an object) is no payer", async () => {
    const t = install();
    for (const [taskId, payer] of [["task-3", {}], ["task-4", { kind: 7 }], ["task-5", "member"], ["task-6", null]] as const) {
      t.db.set({ ...taskPayerKey(taskId), entityType: "TASK_PAYER", orgId: TEST_ORG, taskId, payer, project: "web", origin: "app", settingsRevision: 0 });
      expect(await t.ports.task(taskId), taskId).toBeUndefined();
    }
  });
});

describe("route: a source billed to the company, never a person's plan, never a forbidden model", () => {
  it("routes the model Code's checking rule chose through the company's own source", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.route({ project: "web", model: SONNET })).toEqual(ROUTE);
  });

  it("a forbidden model, a model no company source serves, or only a person's ChatGPT plan: no route", async () => {
    const forbidden = install({ forbidden: [SONNET] });
    await forbidden.ready();
    expect(await forbidden.ports.route({ project: "web", model: SONNET })).toBeUndefined();
    const unserved = install();
    await unserved.ready();
    expect(await unserved.ports.route({ project: "web", model: { provider: "openai", modelId: "gpt-5.4" } })).toBeUndefined();
    const plan = install({ order: ["personal-chatgpt"] });
    await plan.ready();
    expect(await plan.ports.route({ project: "web", model: undefined })).toBeUndefined();
    expect(await plan.ports.route({ project: "web", model: { provider: "openai", modelId: "gpt-5.4" } })).toBeUndefined();
  });

  it("M4: no model chosen: the CHEAPEST listed model with a price that fits the per-call ceiling (never the dearest), never a forbidden one", async () => {
    const t = install({ models: [SONNET, HAIKU] });
    await t.ready();
    expect((await t.ports.route({ project: "web", model: undefined }))?.model).toEqual(HAIKU);
    const without = install({ models: [HAIKU, SONNET], forbidden: [HAIKU] });
    await without.ready();
    expect((await without.ports.route({ project: "web", model: undefined }))?.model).toEqual(SONNET);
  });

  it("M4: no model chosen: the company's assistant model comes first, even when a cheaper one is listed", async () => {
    const t = install({ models: [SONNET, HAIKU], assistantModel: SONNET });
    await t.ready();
    expect((await t.ports.route({ project: "web", model: undefined }))?.model).toEqual(SONNET);
  });

  it("M3/M4: no model chosen: a model with no list price is never picked, and one whose largest call is over $5 is passed over for one that fits", async () => {
    const UNPRICED = { provider: "anthropic", modelId: "acme-tuned-1" };
    const t = install({ models: [UNPRICED] });
    await t.ready();
    expect(await t.ports.route({ project: "web", model: undefined })).toBeUndefined();
    const mixed = install({ models: [UNPRICED, SONNET] });
    await mixed.ready();
    expect((await mixed.ports.route({ project: "web", model: undefined }))?.model).toEqual(SONNET);
  });

  it("M4: no model chosen and the only listed model's largest call is over the $5 ceiling: no route (it is never picked by default)", async () => {
    const pro = { provider: "openai", modelId: "gpt-5-pro" };
    const t = install({ kind: "openai", models: [pro] });
    await t.ready();
    expect(await t.ports.route({ project: "web", model: undefined })).toBeUndefined();
    // Named by Code's checking rule it is still routed (the meter then refuses a call over the ceiling, per prompt).
    expect((await t.ports.route({ project: "web", model: pro }))?.model).toEqual(pro);
  });

  it("M3: an assistant model with no list price is passed over for the cheapest priced one", async () => {
    const UNPRICED = { provider: "anthropic", modelId: "acme-tuned-1" };
    const t = install({ models: [UNPRICED, SONNET], assistantModel: UNPRICED });
    await t.ready();
    expect((await t.ports.route({ project: "web", model: undefined }))?.model).toEqual(SONNET);
  });

  it("a person's ChatGPT plan is never even consulted: with it first in the order, the plan's serving check is not asked and the company's own source serves", async () => {
    const t = install({ order: ["personal-chatgpt", SRC] });
    await t.ready();
    expect((await t.ports.route({ project: "web", model: undefined }))?.sourceId).toBe(SRC);
    expect((await t.ports.route({ project: "web", model: SONNET }))?.sourceId).toBe(SRC);
    expect(t.chatgptServes).not.toHaveBeenCalled();
  });
});

describe("room: the payer's budgets, as a chat turn of the project", () => {
  it("answers the room; a project month that is used up refuses with the project's code", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).toBeGreaterThan(0);
    // The room is the smallest scope's room: a project month of $1 with $0.70 taken leaves $0.30, which is what bounds the call's hold.
    t.limitProject(1);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 0.7, committedUsd: 0.7 });
    expect(await t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).toBeCloseTo(0.3, 6);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 1, committedUsd: 1 });
    await expect(t.ports.room({ project: "web", payer: { kind: "project", project: "web" } })).rejects.toMatchObject({ code: "PROJECT_BUDGET_EXCEEDED" });
  });
});

describe("call: one key for the task's payer, capped at the hold, reserved, used once, blocked after", () => {
  it("mints a key for the member payer, scoped to the one alias, tagged with the task and the reviewer origin, reserved on the payer's scopes; the call carries the key and the prompt only; the key is blocked", async () => {
    const t = install();
    await t.ready();
    expect(await t.ports.call(call())).toBe("[]");
    expect(t.proxy.mintKey).toHaveBeenCalledTimes(1);
    const minted = t.proxy.mintKey.mock.calls[0]![0];
    expect(minted).toMatchObject({ orgId: TEST_ORG, developerId: MEMBER, models: [ROUTE.alias], maxBudgetUsd: 0.2, ttlSeconds: 300 });
    expect(minted.tags).toMatchObject({ taskId: "task-1", payerKind: "member", payerId: MEMBER, project: "web", source: SRC, origin: TIER_REVIEW_ORIGIN });
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]).toMatchObject({ key: t.proxy.mintedKeys()[0], purpose: "questions", user: "the whole prompt", model: ROUTE.alias, api: "anthropic-messages" });
    // Reserved on the company's, the project's and the member's month (the scopes every spend of the task counts against), and blocked after the call so the sweep settles it.
    const keyId = keyIdOf(t.proxy.mintedKeys()[0]!);
    const record = t.db.get(modelKeyKey(TEST_ORG, keyId)) as { capUsd: number; finalizeAfter?: number };
    expect(record.capUsd).toBe(0.2);
    expect(record.finalizeAfter).toBeTypeOf("number");
    for (const scope of ["ORG", "PROJECT#web", `MEMBER#${MEMBER}`]) expect(t.counter(scope)?.committedUsd ?? 0).toBeGreaterThan(0);
  });

  it("`sent` is recorded before the prompt leaves; a `sent` that fails stops the call there (the key is blocked, nothing sent)", async () => {
    const t = install();
    await t.ready();
    const order: string[] = [];
    t.reviewCompletion.mockImplementationOnce(async (input) => { order.push("forwarded"); return { text: "[]", model: input.model }; });
    await t.ports.call(call({ sent: async () => { order.push("sent"); } }));
    expect(order).toEqual(["sent", "forwarded"]);
    await expect(t.ports.call(call({ sent: async () => { throw new Error("table down"); } }))).rejects.toThrow(/table down/u);
    expect(t.reviews).toHaveLength(0);
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(t.proxy.mintedKeys()[1]!))) as { finalizeAfter?: number };
    expect(record.finalizeAfter).toBeTypeOf("number");
  });

  it("a key that cannot be blocked after the call is logged (ids and names only, never the key)", async () => {
    const t = install();
    await t.ready();
    t.proxy.blockKey.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }));
    await t.ports.call(call());
    const line = t.logs.find((entry) => entry["event"] === "tier_review.key_not_blocked");
    expect(line).toMatchObject({ taskId: "task-1", error: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(t.logs)).not.toContain(t.proxy.mintedKeys()[0]!);
  });

  it("the call fails: the key is blocked all the same (its cap stays held until the sweep settles it, never charged at $0)", async () => {
    const t = install();
    await t.ready();
    t.reviewCompletion.mockRejectedValueOnce(new Error("provider down"));
    await expect(t.ports.call(call())).rejects.toThrow("provider down");
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(t.proxy.mintedKeys()[0]!))) as { finalizeAfter?: number };
    expect(record.finalizeAfter).toBeTypeOf("number");
  });

  it("a full scope (the project's month cannot take the hold) refuses at the mint: no call is made", async () => {
    const t = install();
    await t.ready();
    t.limitProject(1);
    t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, "PROJECT#web"), entityType: "SPEND_COUNTER", spentUsd: 0.9, committedUsd: 0.9 });
    await expect(t.ports.call(call({ payer: { kind: "project", project: "web" } }))).rejects.toThrow();
    expect(t.reviews).toEqual([]);
  });

  it("a model access with no reviewer call refuses before any key is minted", async () => {
    const t = install({ withReview: false });
    await t.ready();
    await expect(t.ports.call(call())).rejects.toThrow(/no reviewer calls/u);
    expect(t.proxy.mintKey).not.toHaveBeenCalled();
  });

  it("an aborted signal after the mint: no call, and the key is blocked", async () => {
    const t = install();
    await t.ready();
    const controller = new AbortController();
    controller.abort();
    await expect(t.ports.call(call({ signal: controller.signal }))).rejects.toThrow(/time ran out/u);
    expect(t.reviews).toEqual([]);
  });
});


describe("calls: the durable row of each reviewer call (review H1b), its condition the same rule as the meter's", () => {
  const purpose = "questions" as const;
  it("claims a free row, refuses a held one, and frees it by outcome or by age exactly as `tierReviewCallBlocked` says", async () => {
    const t = install();
    const now = 50_000_000;
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c1", at: now })).toBe(true);
    expect(t.db.get(tierReviewCallKey(TEST_ORG as never, "task-1", purpose))).toMatchObject({ orgId: TEST_ORG, status: "started", callId: "c1", startedAt: now });
    expect(tierReviewCallKey(TEST_ORG as never, "task-1", purpose).pk).toBe(`ORG#${TEST_ORG}#TIER_REVIEW_CALL#task-1`);
    // Held while started (and while sent) for ten minutes.
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c2", at: now + 1 })).toBe(false);
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c1", status: "sent", at: now + 2 });
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c2", at: now + 599_999 })).toBe(false);
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c2", at: now + 600_000 })).toBe(true);
    // Another call's late outcome cannot overwrite the new claim.
    await expect(t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c1", status: "answered", at: now + 600_001 })).rejects.toThrow();
    // failed after sent: held 5 minutes from its end (the first failure); answered or failed unsent: free at once.
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c2", status: "sent", at: now + 600_002 });
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c2", status: "failed_sent", at: now + 600_010 });
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c3", at: now + 900_009 })).toBe(false);
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c3", at: now + 900_010 })).toBe(true);
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c3", status: "failed_unsent", at: now + 900_011 });
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c4", at: now + 900_012 })).toBe(true);
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c4", status: "answered", at: now + 900_013 });
    // An outcome is final: it never goes back to sent.
    await expect(t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c4", status: "sent", at: now + 900_014 })).rejects.toThrow();
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c5", at: now + 900_014 })).toBe(true);
  });

  it("the claim's condition and the meter's rule agree on every status at the window edges", async () => {
    const now = 90_000_000;
    const rows: TierReviewCallRow[] = [];
    for (const status of ["started", "sent", "answered", "failed_unsent", "failed_sent"] as const) {
      for (const failures of [undefined, 0, 1, 2, 3, 4]) {
        for (const age of [0, 59_999, 299_999, 300_000, 599_999, 600_000, 1_199_999, 1_200_000]) rows.push({ callId: "old", status, startedAt: now - age, ...(status === "started" || status === "sent" ? {} : { endedAt: now - age }), ...(failures === undefined ? {} : { failures }) });
      }
    }
    for (const row of rows) {
      const t = install();
      t.db.set({ ...tierReviewCallKey(TEST_ORG, "task-1", purpose), entityType: "TIER_REVIEW_CALL", orgId: TEST_ORG, taskId: "task-1", purpose, ...row });
      expect(await t.ports.calls.last({ taskId: "task-1", purpose }), JSON.stringify(row)).toEqual(row);
      expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "new", at: now }), JSON.stringify(row)).toBe(tierReviewCallBlocked(row, now) === undefined);
    }
  });

  it("the failure count lives in the row: a claim keeps it, a failure after the send adds one, an unsent failure does not, an answer resets it, and 3 close the row until it expires", async () => {
    const t = install();
    const key = tierReviewCallKey(TEST_ORG, "task-1", purpose);
    const row = () => t.db.get(key) as { failures?: number; status: string; endedAt?: number };
    let at = 10_000_000;
    const attempt = async (callId: string, outcome: "failed_sent" | "failed_unsent" | "answered"): Promise<boolean> => {
      if (!(await t.ports.calls.claim({ taskId: "task-1", purpose, callId, at }))) return false;
      await t.ports.calls.mark({ taskId: "task-1", purpose, callId, status: "sent", at: at + 1 });
      await t.ports.calls.mark({ taskId: "task-1", purpose, callId, status: outcome, at: at + 2 });
      return true;
    };
    expect(await attempt("c1", "failed_sent")).toBe(true);
    expect(row().failures).toBe(1);
    // A claim never drops the count (it updates the row; an old end time is cleared).
    at += 300_010;
    expect(await t.ports.calls.claim({ taskId: "task-1", purpose, callId: "c2", at })).toBe(true);
    expect(row()).toMatchObject({ status: "started", failures: 1 });
    expect(row().endedAt).toBeUndefined();
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "c2", status: "failed_unsent", at: at + 1 });
    expect(row().failures).toBe(1);
    expect(await attempt("c3", "failed_sent")).toBe(true);
    expect(row().failures).toBe(2);
    // The second backoff is 20 minutes.
    at += 300_010;
    expect(await attempt("c4", "failed_sent")).toBe(false);
    at += 900_000;
    expect(await attempt("c4", "failed_sent")).toBe(true);
    expect(row().failures).toBe(3);
    // Capped: nothing claims it, however long since.
    for (const later of [1, 3_600_000, 23 * 3_600_000]) { at += later; expect(await attempt("c5", "answered"), String(later)).toBe(false); }
    expect(row()).toMatchObject({ status: "failed_sent", failures: 3 });
    // An answered outcome (a late one, here set straight on a sent row) resets it.
    t.db.set({ ...key, entityType: "TIER_REVIEW_CALL", orgId: TEST_ORG, taskId: "task-1", purpose, callId: "late", status: "sent", startedAt: at, failures: 3 });
    await t.ports.calls.mark({ taskId: "task-1", purpose, callId: "late", status: "answered", at: at + 1 });
    expect(row().failures).toBe(0);
    expect(await attempt("c6", "answered")).toBe(true);
  });

  it("a row whose failure count is not a count reads as a call in flight (it blocks), never as free", async () => {
    for (const failures of [-1, 1.5, "2", null]) {
      const t = install();
      t.db.set({ ...tierReviewCallKey(TEST_ORG, "task-1", purpose), entityType: "TIER_REVIEW_CALL", orgId: TEST_ORG, taskId: "task-1", purpose, callId: "x", status: "answered", startedAt: 1, failures });
      expect(tierReviewCallBlocked(await t.ports.calls.last({ taskId: "task-1", purpose }), Date.now()), String(failures)).toBe("in_flight");
    }
  });

  it("a row of another company, or one out of shape, reads as a call in flight (it blocks), never as free", async () => {
    const t = install();
    t.db.set({ ...tierReviewCallKey(TEST_ORG, "task-1", purpose), entityType: "TIER_REVIEW_CALL", orgId: OTHER_ORG, callId: "x", status: "answered", startedAt: 1 });
    expect(tierReviewCallBlocked(await t.ports.calls.last({ taskId: "task-1", purpose }), Date.now())).toBe("in_flight");
    t.db.set({ ...tierReviewCallKey(TEST_ORG, "task-1", purpose), entityType: "TIER_REVIEW_CALL", orgId: TEST_ORG, callId: "x", status: "weird", startedAt: 1 });
    expect(tierReviewCallBlocked(await t.ports.calls.last({ taskId: "task-1", purpose }), Date.now())).toBe("in_flight");
  });
});

describe("M2 and the spend kind", () => {
  it("the reviewer runs only where TIER_REVIEW_ENABLED is exactly 1 (the model access function's long-timeout variable and the Team record switch are not read)", () => {
    expect(tierReviewLongCallsOn({})).toBe(false);
    expect(tierReviewLongCallsOn({ TIER_REVIEW_ENABLED: "0" })).toBe(false);
    expect(tierReviewLongCallsOn({ TIER_REVIEW_ENABLED: "true" })).toBe(false);
    expect(tierReviewLongCallsOn({ LEARNING_COMPLETION_ENABLED: "1", TEAM_RECORD_ENABLED: "1" })).toBe(false);
    expect(tierReviewLongCallsOn({ TIER_REVIEW_ENABLED: "1" })).toBe(true);
  });

  it("a reviewer call's spend reads as autonomous (the scheduled tier pass made it, not a person), like learning's", () => {
    expect(spendOriginKind(TIER_REVIEW_ORIGIN)).toBe("autonomous");
  });
});
