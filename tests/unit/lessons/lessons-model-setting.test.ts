// Lessons in production, lane 1b: the company's optional "lessons model" setting. An owner or admin sets it from a live browser session; it must be a company-billed, non-forbidden model; it is audited
// (no ledger entry, no change); a write is conditional on the value that was read; unset means the cheapest suitable model.
import { describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { DEFAULT_AGENT_GUARDRAILS, ModelSourceSchema, agentGuardrailsKey, editionPolicy, type ModelIdentifier } from "../../../packages/contracts/src/index.js";
import { routeLearningModel } from "../../../packages/broker/src/aws/developer-routes/learning-model.js";
import { readLessonsModel } from "../../../packages/broker/src/lessons/model-setting.js";
import { LEDGERED, lessonAuditSink } from "../../../packages/broker/src/lessons/audit-sink.js";
import { ModelSourceStore } from "../../../packages/broker/src/model-sources/store.js";
import type { RoutingDependencies } from "../../../packages/broker/src/model-sources/routing.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";
import { Audit } from "./lesson-helpers.js";
import type { LessonAuditEvent } from "../../../packages/broker/src/lessons/ports.js";

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU: ModelIdentifier = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const SRC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_OR = "src_rrrrrrrrrrrrrrrrrrrr";

/** An audit sink whose events ride in the change's own transaction: the staged item is a pending audit row in the State table. */
class StagingAudit extends Audit {
  failing = false;
  sentCount = 0;
  rowKeys: string[] = [];
  stage(event: LessonAuditEvent): { items: unknown[]; sent(): Promise<void> } {
    if (this.failing) throw new Error("no ledger");
    this.events.push(event);
    const sk = `at#${String(this.events.length)}`;
    this.rowKeys.push(sk);
    return { items: [{ Put: { TableName: "state", Item: { pk: "AUDIT_PENDING#0", sk, event: { action: event.action, facts: event.facts } } } }], sent: async () => { this.sentCount += 1; } };
  }
}

async function world(over: { forbidden?: ModelIdentifier[]; order?: string[]; auditFails?: boolean; openrouter?: string[] } = {}) {
  const db = new FakeDynamoDb();
  if (over.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: over.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  await store.save({ orgId: TEST_ORG, source: ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC, label: "Anthropic", models: [{ catalog: SONNET }, { catalog: HAIKU }] }), mode: "create", by: "dev-owner" });
  if (over.openrouter !== undefined) await store.save({ orgId: TEST_ORG, source: ModelSourceSchema.parse({ kind: "openrouter", sourceId: SRC_OR, label: "OpenRouter", models: over.openrouter.map((modelId) => ({ catalog: { provider: "openrouter", modelId } })) }), mode: "create", by: "dev-owner" });
  await store.setOrder({ orgId: TEST_ORG, order: over.order ?? (over.openrouter === undefined ? [SRC] : [SRC, SRC_OR]), by: "dev-owner" });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy("public"),
    forbiddenModels: async () => over.forbidden ?? [], chatgpt: { serves: async () => "gpt-5.4" },
  };
  const audit = new StagingAudit();
  audit.failing = over.auditFails === true;
  const table = { documentClient: db, tableName: "team" };
  const deps = { documentClient: db, tableName: "state", now: () => 77, teamRecord: { table }, lessons: { audit }, agents: { modelRouting: routing } } as never;
  /** How many staged audit lines were really written (a cancelled transaction writes none). */
  const committed = () => audit.rowKeys.filter((sk) => db.get("AUDIT_PENDING#0", sk) !== undefined).length;
  const call = (role: string, method: string, body?: unknown, over2: { browserSession?: boolean } = {}) => routeLearningModel(deps,
    { orgId: TEST_ORG, developerId: "dev-owner", orgRole: role, browserSession: over2.browserSession ?? true } as never, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: {} } as never, new URL("https://rovara.test/v1/app/org/learning-model"));
  return { db, table, audit, call, committed, routing };
}
const bodyOf = (reply: unknown) => (reply as { body: Record<string, unknown> }).body;
const refusal = async (promise: Promise<unknown>): Promise<AgentXError> => { try { await promise; } catch (error) { if (error instanceof AgentXError) return error; throw error; } throw new Error("expected a refusal"); };

describe("the lessons model setting", () => {
  it("is unset by default; an owner sees it with the models the company can choose (company-billed, not forbidden)", async () => {
    const w = await world({ forbidden: [SONNET] });
    const reply = bodyOf(await w.call("owner", "GET"));
    expect(reply.model).toBeNull();
    expect(reply.candidates).toEqual([{ provider: "anthropic", modelId: "claude-haiku-4-5" }]);
  });

  it("an owner or admin sets it from a browser session; it is audited with the old and new model, and read back", async () => {
    const w = await world();
    const reply = await w.call("admin", "POST", { action: "set", model: HAIKU, expected: null });
    expect(bodyOf(reply)).toMatchObject({ status: "applied", model: HAIKU });
    expect(await readLessonsModel(w.table, TEST_ORG)).toEqual(HAIKU);
    expect(w.audit.events.at(-1)).toMatchObject({ action: "lesson.model_set", actor: "dev-owner", facts: { from: "default", to: "anthropic/claude-haiku-4-5" } });
    await w.call("owner", "POST", { action: "clear", expected: HAIKU });
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
    expect(w.audit.events.at(-1)).toMatchObject({ facts: { from: "anthropic/claude-haiku-4-5", to: "default" } });
  });

  it("the audit event has a ledger name, so it can be written for real", () => {
    expect(LEDGERED).toContain("lesson.model_set");
    const written: Array<{ action: string; facts: Record<string, unknown> }> = [];
    return lessonAuditSink(async (event) => { written.push(event as never); }, () => 1).emit({ action: "lesson.model_set", workspaceId: TEST_ORG, project: "_workspace", actor: "a".repeat(64), facts: { from: "default", to: "anthropic/claude-haiku-4-5" } }, { required: true })
      .then(() => expect(written[0]).toMatchObject({ action: "lesson.model_set", facts: { fromModel: "default", toModel: "anthropic/claude-haiku-4-5" } }));
  });

  it("M2: the real sink stages the event as the outbox's pending items (flushed after the commit), and refuses when it has no outbox or the outbox makes no item", async () => {
    const event: LessonAuditEvent = { action: "lesson.model_set", workspaceId: TEST_ORG, project: "_workspace", actor: "a".repeat(64), facts: { from: "default", to: "anthropic/claude-haiku-4-5" } };
    const flushed: unknown[] = [];
    const staged = lessonAuditSink(async () => undefined, () => 1, { pending: (built) => [{ Put: { Item: { event: built } } }], flush: async (built) => { flushed.push(built); } }).stage!(event);
    expect(staged.items).toHaveLength(1);
    expect(flushed).toHaveLength(0);
    await staged.sent();
    expect(flushed[0]).toMatchObject({ action: "lesson.model_set", facts: { fromModel: "default", toModel: "anthropic/claude-haiku-4-5" } });
    expect("stage" in lessonAuditSink(async () => undefined, () => 1)).toBe(false);
    expect(() => lessonAuditSink(async () => undefined, () => 1, { pending: () => [], flush: async () => undefined }).stage!(event)).toThrow();
    // A flush that fails never fails the change: its pending item is durable.
    await expect(lessonAuditSink(async () => undefined, () => 1, { pending: () => [{}], flush: async () => { throw new Error("queue down"); } }).stage!(event).sent()).resolves.toBeUndefined();
  });

  it("is refused for a model that is forbidden, not served by a company source, or a person's ChatGPT plan", async () => {
    const w = await world({ forbidden: [SONNET] });
    expect((await refusal(w.call("owner", "POST", { action: "set", model: SONNET, expected: null }))).code).toBe("CONFIG_INVALID");
    expect((await refusal(w.call("owner", "POST", { action: "set", model: { provider: "openai", modelId: "gpt-5.4" }, expected: null }))).code).toBe("CONFIG_INVALID");
    expect((await refusal(w.call("owner", "POST", { action: "set", model: { provider: "x", modelId: "bad id with spaces" }, expected: null }))).code).toBe("CONFIG_INVALID");
    const chatgptOnly = await world({ order: ["personal-chatgpt"] });
    expect((await refusal(chatgptOnly.call("owner", "POST", { action: "set", model: HAIKU, expected: null }))).code).toBe("CONFIG_INVALID");
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
    expect(w.audit.events).toHaveLength(0);
  });

  it("only an owner or admin, only from a live browser session; a member and a token get nothing", async () => {
    const w = await world();
    expect((await refusal(w.call("member", "GET"))).code).toBe("FORBIDDEN");
    expect((await refusal(w.call("member", "POST", { action: "set", model: HAIKU, expected: null }))).code).toBe("FORBIDDEN");
    expect((await refusal(w.call("owner", "POST", { action: "set", model: HAIKU, expected: null }, { browserSession: false }))).code).toBe("FORBIDDEN");
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
  });

  it("M2: the change and its audit line are ONE transaction: a lost race leaves no audit line, and a success leaves exactly one", async () => {
    const w = await world();
    await w.call("owner", "POST", { action: "set", model: HAIKU, expected: null });
    expect(w.committed()).toBe(1);
    // The loser read "unset" before the winner wrote; its transaction is cancelled whole.
    expect((await refusal(w.call("owner", "POST", { action: "set", model: SONNET, expected: null }))).code).toBe("CHANGE_STALE");
    expect(w.committed()).toBe(1);
    expect(w.audit.rowKeys).toHaveLength(1);
    expect(w.audit.sentCount).toBe(1);
  });

  it("M2: a race inside the write itself (another admin writes between the read and the write) loses cleanly for a set and for a clear: the other admin's value stays and the loser leaves no audit line", async () => {
    for (const action of ["set", "clear"] as const) {
      const w = await world();
      if (action === "clear") await w.call("owner", "POST", { action: "set", model: HAIKU, expected: null });
      const before = w.committed();
      let raced = false;
      const send = w.db.send.bind(w.db);
      Object.assign(w.db, { send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "TransactWriteCommand" && !raced) { raced = true; w.db.set({ pk: `WS#${TEST_ORG}#P#_workspace`, sk: "LESSONSET#MODEL", entityType: "LESSON_MODEL_SETTING", provider: SONNET.provider, modelId: SONNET.modelId, updatedAt: 1 }); }
        return send(command as never);
      } });
      const body = action === "set" ? { action: "set", model: HAIKU, expected: null } : { action: "clear", expected: HAIKU };
      expect((await refusal(w.call("owner", "POST", body))).code).toBe("CHANGE_STALE");
      expect(raced).toBe(true);
      expect(await readLessonsModel(w.table, TEST_ORG)).toEqual(SONNET);
      expect(w.committed()).toBe(before);
    }
  });

  it("a sink that cannot stage the event into the transaction refuses the change (fail closed)", async () => {
    const w = await world();
    const bare = new Audit();
    const reply = routeLearningModel({ documentClient: w.db, tableName: "state", now: () => 77, teamRecord: { table: w.table }, lessons: { audit: bare }, agents: { modelRouting: w.routing } } as never,
      { orgId: TEST_ORG, developerId: "dev-owner", orgRole: "owner", browserSession: true } as never, { method: "POST", body: JSON.stringify({ action: "set", model: HAIKU, expected: null }), headers: {} } as never, new URL("https://rovara.test/v1/app/org/learning-model"));
    expect((await refusal(reply)).code).toBe("AUDIT_UNAVAILABLE");
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
  });

  it("H1: a free variant, a router and a zero-priced model cannot be chosen, are not offered, and a stored one reads as unset (and can still be cleared)", async () => {
    const w = await world({ openrouter: ["openrouter/auto", "cohere/north-mini-code:free", "anthropic/claude-haiku-4.5"] });
    const offered = (bodyOf(await w.call("owner", "GET")).candidates as Array<{ modelId: string }>).map((candidate) => candidate.modelId);
    expect(offered).toContain("anthropic/claude-haiku-4.5");
    expect(offered).not.toContain("openrouter/auto");
    expect(offered).not.toContain("cohere/north-mini-code:free");
    for (const modelId of ["openrouter/auto", "cohere/north-mini-code:free"]) {
      expect((await refusal(w.call("owner", "POST", { action: "set", model: { provider: "openrouter", modelId }, expected: null }))).code).toBe("CONFIG_INVALID");
    }
    expect(w.committed()).toBe(0);
    // Something put one in the table anyway (an older build, by hand): it reads as unset, so the default applies, and an admin can still clear the row.
    w.db.set({ pk: `WS#${TEST_ORG}#P#_workspace`, sk: "LESSONSET#MODEL", entityType: "LESSON_MODEL_SETTING", provider: "openrouter", modelId: "openrouter/auto", updatedAt: 1 });
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
    expect(bodyOf(await w.call("owner", "GET")).model).toBeNull();
    await w.call("owner", "POST", { action: "set", model: { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" }, expected: null });
    expect(await readLessonsModel(w.table, TEST_ORG)).toEqual({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" });
  });

  it("L7: the answer says that a project whose own sources do not serve the model falls back to the cheapest one", async () => {
    const w = await world();
    expect(String(bodyOf(await w.call("owner", "GET")).note)).toMatch(/cheapest suitable model/u);
  });

  it("a write is conditional on the value that was read, and with no ledger entry nothing changes", async () => {
    const w = await world();
    await w.call("owner", "POST", { action: "set", model: HAIKU, expected: null });
    expect((await refusal(w.call("owner", "POST", { action: "set", model: SONNET, expected: null }))).code).toBe("CHANGE_STALE");
    expect(await readLessonsModel(w.table, TEST_ORG)).toEqual(HAIKU);
    const noLedger = await world({ auditFails: true });
    expect((await refusal(noLedger.call("owner", "POST", { action: "set", model: HAIKU, expected: null }))).code).toBe("AUDIT_UNAVAILABLE");
    expect(await readLessonsModel(noLedger.table, TEST_ORG)).toBeUndefined();
  });

  it("a stored value that does not parse reads as unset, and the path is not found where the install has no lessons ports", async () => {
    const w = await world();
    w.db.set({ pk: `WS#${TEST_ORG}#P#_workspace`, sk: "LESSONSET#MODEL", provider: "anthropic", modelId: "has spaces; drop" });
    expect(await readLessonsModel(w.table, TEST_ORG)).toBeUndefined();
    const reply = await routeLearningModel({ documentClient: w.db, tableName: "state" } as never, { orgId: TEST_ORG, orgRole: "owner" } as never, { method: "GET" } as never, new URL("https://rovara.test/v1/app/org/learning-model"));
    expect(reply).toBeUndefined();
  });
});
