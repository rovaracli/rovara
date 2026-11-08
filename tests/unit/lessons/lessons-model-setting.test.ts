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

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const HAIKU: ModelIdentifier = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const SRC = "src_aaaaaaaaaaaaaaaaaaaa";

async function world(over: { forbidden?: ModelIdentifier[]; order?: string[]; auditFails?: boolean } = {}) {
  const db = new FakeDynamoDb();
  if (over.forbidden !== undefined) db.set({ ...agentGuardrailsKey(TEST_ORG), guardrails: { ...DEFAULT_AGENT_GUARDRAILS, forbiddenModels: over.forbidden }, revision: 1 });
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
  await store.save({ orgId: TEST_ORG, source: ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC, label: "Anthropic", models: [{ catalog: SONNET }, { catalog: HAIKU }] }), mode: "create", by: "dev-owner" });
  await store.setOrder({ orgId: TEST_ORG, order: over.order ?? [SRC], by: "dev-owner" });
  const routing: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] }, edition: editionPolicy("public"),
    forbiddenModels: async () => over.forbidden ?? [], chatgpt: { serves: async () => "gpt-5.4" },
  };
  const audit = new Audit();
  if (over.auditFails === true) audit.emit = async () => { throw new Error("no ledger"); };
  const table = { documentClient: db, tableName: "team" };
  const deps = { documentClient: db, tableName: "state", now: () => 77, teamRecord: { table }, lessons: { audit }, agents: { modelRouting: routing } } as never;
  const call = (role: string, method: string, body?: unknown, over2: { browserSession?: boolean } = {}) => routeLearningModel(deps,
    { orgId: TEST_ORG, developerId: "dev-owner", orgRole: role, browserSession: over2.browserSession ?? true } as never, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: {} } as never, new URL("https://rovara.test/v1/app/org/learning-model"));
  return { db, table, audit, call };
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
