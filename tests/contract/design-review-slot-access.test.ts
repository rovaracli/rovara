// Design review stage, DR7 slice A (security S1 to S9, N4; money W5): the packet route and the per-slot model keys, through the real broker over a fake table and a fake proxy.
// A design-review operation is a PLAN_CRITIQUE operation that carries a stored `designReview` binding; the stored binding, never the worker, decides which slots exist.
import { randomUUID } from "node:crypto";
import type * as CatalogModule from "@agentx/model-runtime/catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, DesignReviewBindingSchema, PacketDeliverySchema, agentGuardrailsKey, canonicalModelName, packetDigestOf, type DesignReviewBinding, type ModelIdentifier, type ReviewerRole } from "@rovara-code/contracts";
import { modelKeyKey } from "@agentx/cloud-contracts";
import { designReviewKeyBudgets } from "../../packages/broker/src/design-review/estimate.js";
import { buildReviewerPacket, type PacketReaders } from "../../packages/broker/src/design-review/packet.js";
import { putSlotPackets, readSlotPacket } from "../../packages/broker/src/design-review/packet-store.js";
import { designReviewProxyCheck } from "../../packages/broker/src/design-review/proxy-check.js";
import { DESIGN_REVIEW_KEY_TTL_SECONDS, allocateSlotBudgets, designReviewKeyIds, designReviewNoOperationKeyId } from "../../packages/broker/src/design-review/slot-keys.js";
import { taskRunRoomUsd } from "../../packages/broker/src/spend/admission.js";
import { verifyReviewerReport } from "../../packages/broker/src/design-review/verify.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

// The price lookup is the catalog's; one test makes the catalog not know a model, to see the guard for an unpriced Rovara model.
const catalog = vi.hoisted(() => ({ unpriced: false }));
vi.mock("@agentx/model-runtime/catalog", async (original) => {
  const real = await original<typeof CatalogModule>();
  return { ...real, listPricesPerMillion: (model: ModelIdentifier) => (catalog.unpriced ? undefined : real.listPricesPerMillion(model)) };
});

const PROXY_URL = "http://internal-proxy.example.test:4000";
const SIGNING_KEY = "c".repeat(64);
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const MODEL: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const readers: PacketReaders = { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) };

// The fake proxy gives every key the same expiry (2026-10-19 13:00 UTC), so the clock stands an hour before it (only Date is faked).
beforeEach(() => { catalog.unpriced = false; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-19T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

async function packetFor(role: ReviewerRole) {
  return buildReviewerPacket({
    role, design: { ref: "design.md", revision: "r1", text: "## §3 Proposed design\nR1: add the endpoint.\n" }, requirements: { ref: "requirements.md", revision: "r1", text: "R1: an endpoint." },
    ...(role === "comprehension" ? { requestText: "Please add an endpoint." } : {}), baseCommits: {}, sources: [],
  }, readers);
}

/** Raw reply of the broker (headers and body bytes), which `call` parses away. */
async function rawGet(handler: (event: never) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>, path: string, capability: string | undefined) {
  const response = await handler({
    version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers: capability === undefined ? {} : { "x-agentx-callback-capability": capability },
    requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  } as never);
  return { status: response.statusCode, headers: response.headers ?? {}, body: response.body };
}

async function rawPost(handler: (event: never) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>, path: string, capability: string) {
  const response = await handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers: { "x-agentx-callback-capability": capability, "content-type": "application/json" }, body: "{}", isBase64Encoded: false,
    requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  } as never);
  return { status: response.statusCode, headers: response.headers ?? {}, body: response.body };
}

async function setup(options: { usableUnusable?: string[] } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({
    brokerExtra: { agents: { modelSources: { launch: { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] } } }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true,
      ...(options.usableUnusable === undefined ? {} : { usableModels: { unusable: async () => new Set(options.usableUnusable), markUnusable: async () => undefined } }) },
  });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const started = await h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const taskId = (started.body.task as { taskId: string }).taskId;
  const workspaceId = (h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await h.finish(workspaceId, active(), "SUCCEEDED", PREPARED);
  const operationId = active();
  const operationItem = () => h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown> & { fence: number };
  const taskItem = () => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
  const state = { documentClient: h.db, tableName: "state" };
  const capability = (options: { packet?: boolean; modelAccess?: boolean } = {}) =>
    issueCapability({ callbackSigningKey: SIGNING_KEY }, workspaceId, operationId, operationItem().fence, { modelAccess: options.modelAccess !== false, designReviewPacket: options.packet !== false });

  /** Makes the running operation a design-review one: the stored binding, the stored packets, and the task's review in progress. */
  async function asDesignReview(over: { roles?: ReviewerRole[]; merge?: boolean; capUsd?: number | undefined; spentUsd?: number; status?: string; modelRoute?: DesignReviewBinding["reviewers"][number]["modelRoute"]; model?: ModelIdentifier; storePackets?: boolean; allocate?: boolean; taskRoomUsd?: number; reviewRoomUsd?: number } = {}) {
    const roles = over.roles ?? ["critic", "codebase"];
    const model = over.model ?? MODEL;
    const reviewers: DesignReviewBinding["reviewers"] = [];
    const built = new Map<string, Awaited<ReturnType<typeof packetFor>>>();
    for (const role of roles) {
      const packet = await packetFor(role);
      built.set(`slot-${role}`, packet);
      reviewers.push({ role, keySlot: `slot-${role}`, packetDigest: packet.packetDigest, model, ...(over.modelRoute === undefined ? {} : { modelRoute: over.modelRoute }) });
    }
    const binding = DesignReviewBindingSchema.parse({
      version: 1, round: 1, reviewers,
      ...(over.merge === false ? {} : { merge: { keySlot: "merge", model, ...(over.modelRoute === undefined ? {} : { modelRoute: over.modelRoute }), prompt: { id: "merge", version: 1, text: "MERGE RULES\n=== MATERIAL ===\n" } } }),
    });
    h.db.set({ ...operationItem(), workflowMode: "PLAN_CRITIQUE", designReview: binding });
    const task = taskItem();
    h.db.set({
      ...task,
      workflow: { ...(task.workflow as object | undefined), designReview: { decidedBy: "auto", reasons: [], status: over.status ?? "running", tier: "standard", spentUsd: over.spentUsd ?? 0, ...("capUsd" in over ? (over.capUsd === undefined ? {} : { capUsd: over.capUsd }) : { capUsd: 10 }), rounds: [] } },
    });
    // Slice B allocates the round's ceilings at dispatch, before it stores the binding: the review's room under its cap, held under the task's remaining run limit.
    // (A test may set the same operation up again; in the product one operation is one round and is allocated once.)
    h.db.delete(`ORG#${TEST_ORG}#DESIGN_REVIEW#${operationId}`, "ALLOC");
    if (over.allocate !== false) {
      const room = designReviewKeyBudgets({ capUsd: "capUsd" in over ? (over.capUsd ?? 0) : 10, spentUsd: over.spentUsd ?? 0, reviewers: roles.length, hasMergeModel: over.merge !== false }).roomUsd;
      await allocateSlotBudgets(state, { orgId: TEST_ORG, operationId, binding, reviewRoomUsd: over.reviewRoomUsd ?? room, taskRoomUsd: over.taskRoomUsd ?? 1_000, nowMs: Date.now() });
    }
    if (over.storePackets !== false) await putSlotPackets(state, { orgId: TEST_ORG, operationId, round: 1, packets: [...built.entries()].map(([keySlot, packet]) => ({ keySlot, packet })), nowMs: Date.now() });
    return { binding, built };
  }
  const packet = (slot: string | undefined, cap: string | null = capability()) => rawGet(h.handler, `/v1/internal/design-review/packet${slot === undefined ? "" : `?slot=${encodeURIComponent(slot)}`}`, cap ?? undefined);
  const key = (slot: string | undefined, cap = capability()) => rawGet(h.handler, `/v1/internal/model-access${slot === undefined ? "" : `?slot=${encodeURIComponent(slot)}`}`, cap);
  const recordRound = () => h.db.set({ ...taskItem(), workflow: { ...(taskItem().workflow as { designReview: Record<string, unknown> }), designReview: { ...(taskItem().workflow as { designReview: Record<string, unknown> }).designReview, rounds: [{ round: 1 }] } } });
  return { ...h, access, taskId, workspaceId, operationId, operationItem, taskItem, state, capability, asDesignReview, packet, key, recordRound };
}
const bodyOf = (reply: { body: string }) => JSON.parse(reply.body) as Record<string, unknown>;

describe("the packet route", () => {
  it("serves the stored packet byte for byte, only the delivery fields, uncached, and the same bytes again", async () => {
    const t = await setup();
    const { binding, built } = await t.asDesignReview();
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const first = await t.packet("slot-critic");
    const again = await t.packet("slot-critic");
    expect(first.status, first.body).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(Buffer.byteLength(first.body, "utf8")).toBeLessThanOrEqual(2_000_000);
    // The stored bytes, not a rebuilt packet; no request id and nothing but the contract's fields.
    expect(first.body).toBe((await readSlotPacket(t.state as never, TEST_ORG, t.operationId, 1, "slot-critic"))!.text);
    expect(again.body).toBe(first.body);
    const delivery = PacketDeliverySchema.parse(JSON.parse(first.body));
    expect(packetDigestOf(delivery)).toBe(binding.reviewers[0]!.packetDigest);
    expect(packetDigestOf(delivery)).toBe(built.get("slot-critic")!.packetDigest);
    expect(first.body).not.toContain("requestId");
    // The other slot gets its own packet, and each fetch is logged with operation, slot and digest.
    expect(PacketDeliverySchema.parse(JSON.parse((await t.packet("slot-codebase")).body)).role).toBe("codebase");
    const served = logs.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((line) => line.event === "design_review.packet_served");
    expect(served[0]).toEqual({ component: "broker", event: "design_review.packet_served", operationId: t.operationId, slot: "slot-critic", digest: binding.reviewers[0]!.packetDigest });
    expect(served).toHaveLength(3);
    logs.mockRestore();
  });

  it("refuses a capability of another purpose (a model-access capability alone), a missing one and a forged one", async () => {
    const t = await setup();
    await t.asDesignReview();
    expect((await t.packet("slot-critic", t.capability({ packet: false }))).status).toBe(401);
    expect((await t.packet("slot-critic", null)).status).toBe(401);
    expect((await t.packet("slot-critic", `${t.capability()}x`)).status).toBe(401);
    // The packet capability is not a model-access one either.
    expect((await t.key("slot-critic", t.capability({ modelAccess: false }))).status).toBe(401);
  });

  it("looks the slot up only in the stored binding's reviewers: unknown, malformed, missing and merge slots get the same refusal", async () => {
    const t = await setup();
    await t.asDesignReview();
    const refusals = [];
    for (const slot of ["slot-nobody", "merge", "../merge", "SLOT-CRITIC", "slot critic", "", undefined]) refusals.push(await t.packet(slot));
    for (const reply of refusals) expect(reply.status).toBe(403);
    expect(new Set(refusals.map((reply) => reply.body.replace(/"requestId":"[^"]+"/u, ""))).size).toBe(1);
    expect((await t.packet("slot-critic")).status).toBe(200);
  });

  it("refuses a packet that does not hash to the binding's digest", async () => {
    const t = await setup();
    const { binding } = await t.asDesignReview();
    t.db.set({ ...t.operationItem(), designReview: { ...binding, reviewers: binding.reviewers.map((reviewer) => ({ ...reviewer, packetDigest: "0".repeat(64) })) } });
    expect((await t.packet("slot-critic")).status).toBe(403);
  });

  it("refuses once the round is recorded on the task, and when the task cannot be read", async () => {
    const t = await setup();
    await t.asDesignReview();
    expect((await t.packet("slot-critic")).status).toBe(200);
    t.recordRound();
    expect((await t.packet("slot-critic")).status).toBe(403);
    t.db.delete(`DEVTASK#${t.taskId}`, "META");
    expect((await t.packet("slot-critic")).status).toBe(403);
  });

  it("refuses an operation that is over, one with another fence, one with no binding and one that is not the plan check", async () => {
    const t = await setup();
    const { binding } = await t.asDesignReview();
    const stale = issueCapability({ callbackSigningKey: SIGNING_KEY }, t.workspaceId, t.operationId, t.operationItem().fence + 1, { designReviewPacket: true });
    expect((await t.packet("slot-critic", stale)).status).toBe(409);
    t.db.set({ ...t.operationItem(), workflowMode: "PLAN" });
    expect((await t.packet("slot-critic")).status).toBe(403);
    t.db.set({ ...t.operationItem(), workflowMode: "PLAN_CRITIQUE", designReview: undefined });
    expect((await t.packet("slot-critic")).status).toBe(403);
    t.db.set({ ...t.operationItem(), workflowMode: "PLAN_CRITIQUE", designReview: binding, status: "SUCCEEDED" });
    expect((await t.packet("slot-critic")).status).toBe(409);
  });

  it("serves nothing when no packet is stored, and nothing stored under another org", async () => {
    const t = await setup();
    const { built } = await t.asDesignReview({ storePackets: false });
    // The uniform refusal: a missing packet does not tell the holder that the slot is valid and the round open.
    const missing = await t.packet("slot-critic");
    expect(missing.status).toBe(403);
    expect(missing.body.replace(/"requestId":"[^"]+"/u, "")).toBe((await t.packet("slot-nobody")).body.replace(/"requestId":"[^"]+"/u, ""));
    await putSlotPackets(t.state, { orgId: "org_bbbbbbbbbbbbbbbbbbbb", operationId: t.operationId, round: 1, packets: [{ keySlot: "slot-critic", packet: built.get("slot-critic")! }], nowMs: Date.now() });
    expect((await t.packet("slot-critic")).status).toBe(403);
    // A packet stored for another round of the operation is not the binding's round's packet.
    await putSlotPackets(t.state, { orgId: TEST_ORG, operationId: t.operationId, round: 2, packets: [{ keySlot: "slot-critic", packet: built.get("slot-critic")! }], nowMs: Date.now() });
    expect((await t.packet("slot-critic")).status).toBe(403);
  });
});

describe("a slot's model key", () => {
  it("is minted for the slot alone, limited to its model, held to the slot's allocated ceiling, with a life past the whole 40-minute stage", async () => {
    const t = await setup();
    await t.asDesignReview({ capUsd: 10, spentUsd: 1 });
    const reply = await t.key("slot-critic");
    expect(reply.status, reply.body).toBe(200);
    expect(bodyOf(reply)).toMatchObject({ baseUrl: PROXY_URL, apiKey: t.access.mintedKeys()[0] });
    const input = t.access.mintKey.mock.calls[0]![0];
    // Two reviewers and the merge step share what was left under the cap at dispatch.
    expect(input.maxBudgetUsd).toBe(designReviewKeyBudgets({ capUsd: 10, spentUsd: 1, reviewers: 2, hasMergeModel: true }).reviewerUsd);
    expect(input.maxBudgetUsd).toBe(3);
    expect(input.models).toHaveLength(1);
    expect(input.models![0]).toBe(MODEL.modelId);
    // One key per slot for the whole operation: its life is the stage limit (40 minutes) plus a margin, and well inside the proxy's own maximum (7 days).
    expect(input.ttlSeconds).toBe(DESIGN_REVIEW_KEY_TTL_SECONDS);
    expect(input.ttlSeconds).toBeGreaterThanOrEqual(40 * 60 + 10 * 60);
    expect(input.ttlSeconds).toBeLessThanOrEqual(7 * 24 * 60 * 60);
    expect(input.refId).toBe(t.taskId);
    // It is the customer's key like any other of the task: reserved against its budgets, tagged with the task and the operation, and recorded on both.
    const keyId = keyIdOf(t.access.mintedKeys()[0]!);
    expect(t.db.get(modelKeyKey(TEST_ORG, keyId))).toMatchObject({ reserved: true, capUsd: 3, tags: { taskId: t.taskId, operationId: t.operationId } });
    expect(t.taskItem().modelKeyIds).toContain(keyId);
    expect(t.operationItem().modelKeyIds).toContain(keyId);
    // NO key secret is stored anywhere: not in any item, and the slot's row names the key's id and facts only.
    expect(JSON.stringify(t.db.find(() => true))).not.toContain(t.access.mintedKeys()[0]);
    const row = t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]!;
    expect(row).toMatchObject({ keyId, budgetUsd: 3, round: 1, askedAgain: 0 });
    expect(Object.keys(row).filter((name) => /seal|secret|apikey|^key$/iu.test(name))).toEqual([]);
  });

  it("is ONE-SHOT: a second ask for the slot gets the fixed refusal, mints nothing, is recorded, and blocks the slot's key so the slot fails closed", async () => {
    const t = await setup();
    await t.asDesignReview();
    const first = await t.key("slot-critic");
    expect(first.status).toBe(200);
    const firstKey = bodyOf(first).apiKey as string;
    const mints = t.access.mintKey.mock.calls.length;
    const refused = await t.key("slot-critic");
    expect(refused.status).toBe(403);
    // The same fixed refusal as any other bad ask, and it carries no key.
    expect(refused.body.replace(/"requestId":"[^"]+"/u, "")).toBe((await t.key("slot-nobody")).body.replace(/"requestId":"[^"]+"/u, ""));
    expect(refused.body).not.toContain(firstKey);
    expect(t.access.mintKey.mock.calls.length).toBe(mints);
    // Recorded on the slot's row, with the key blocked at the proxy; the other slots are untouched.
    expect(t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]).toMatchObject({ keyId: keyIdOf(firstKey), askedAgain: 1 });
    expect(t.access.blockKey).toHaveBeenCalledWith(keyIdOf(firstKey));
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]).toMatchObject({ askedAgain: 2 });
    expect(t.access.mintKey.mock.calls.length).toBe(mints);
    const other = await t.key("slot-codebase");
    expect(other.status).toBe(200);
    expect(t.access.blockKey).not.toHaveBeenCalledWith(keyIdOf(bodyOf(other).apiKey as string));
    // Fails closed for verify: the slot has no key id (no result), though its key id and budget stay known for the cost and the release.
    const ids = await designReviewKeyIds(t.state, t.operationItem() as never);
    expect(ids.bySlot.has("slot-critic")).toBe(false);
    expect(ids.bySlot.get("slot-codebase")).toBe(keyIdOf(bodyOf(other).apiKey as string));
    expect(ids.askedAgain.get("slot-critic")).toBe(keyIdOf(firstKey));
    expect(ids.budgetUsdBySlot.get("slot-critic")).toBeGreaterThan(0);
  });

  it("does not mint again when the slot's key has expired or its record is damaged: the slot stays closed", async () => {
    const t = await setup();
    await t.asDesignReview();
    await t.key("slot-critic");
    const record = () => t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]!;
    t.db.set({ ...record(), expiresAt: Date.now() + 30_000 });
    expect((await t.key("slot-critic")).status).toBe(403);
    t.db.set({ ...record(), keyId: "not-a-key-id" });
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).toHaveBeenCalledTimes(1);
  });

  it("records each slot's key id for verifyRound, the merge key apart, and an operation key that is none of them", async () => {
    const t = await setup();
    const { built } = await t.asDesignReview();
    const keys = { critic: bodyOf(await t.key("slot-critic")).apiKey as string, codebase: bodyOf(await t.key("slot-codebase")).apiKey as string, merge: bodyOf(await t.key("merge")).apiKey as string };
    expect(new Set(Object.values(keys)).size).toBe(3);
    const ids = await designReviewKeyIds(t.state, t.operationItem() as never);
    expect(ids.bySlot.get("slot-critic")).toBe(keyIdOf(keys.critic));
    expect(ids.bySlot.get("slot-codebase")).toBe(keyIdOf(keys.codebase));
    expect(ids.mergeKeyId).toBe(keyIdOf(keys.merge));
    expect(ids.operationKeyId).toBe(designReviewNoOperationKeyId(t.operationId));
    expect([...ids.bySlot.values()]).not.toContain(ids.operationKeyId);
    expect(ids.askedAgain.size).toBe(0);
    // Minting a slot's key never blocks the keys of the slots that run beside it.
    expect(t.access.blockKey).not.toHaveBeenCalled();
    // The reviewer that ran on its own key verifies; one that reports another reviewer's key, or the operation's, does not.
    const packet = { packetDigest: built.get("slot-critic")!.packetDigest, estimatedInputTokens: 1_000 };
    const report = (modelKeyId: string) => ({ sessionId: "s1", packetDigest: packet.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read"], modelKeyId });
    const verify = (modelKeyId: string) => verifyReviewerReport({ packet, report: report(modelKeyId), usedSessionIds: new Set(), usage: { kind: "unavailable" },
      modelKey: { keyId: ids.bySlot.get("slot-critic")!, otherReviewerKeyIds: new Set([ids.bySlot.get("slot-codebase")!, ids.mergeKeyId!]), operationKeyId: ids.operationKeyId } });
    expect(await verify(keyIdOf(keys.critic))).toMatchObject({ verified: true });
    expect(await verify(keyIdOf(keys.codebase))).toEqual({ verified: false, failure: "model_key_mismatch" });
    expect(await verify(ids.operationKeyId)).toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("ignores a row planted for another operation, org or slot when it reads the key ids", async () => {
    const t = await setup();
    await t.asDesignReview();
    await t.key("slot-critic");
    const record = t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY")[0]!;
    t.db.set({ ...record, operationId: "someone-else" });
    expect((await designReviewKeyIds(t.state, t.operationItem() as never)).bySlot.size).toBe(0);
    t.db.set({ ...record, orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect((await designReviewKeyIds(t.state, t.operationItem() as never)).bySlot.size).toBe(0);
    t.db.set({ ...record, keySlot: "slot-nobody" });
    expect((await designReviewKeyIds(t.state, t.operationItem() as never)).bySlot.size).toBe(0);
  });

  it("is refused without a slot, with an unknown or malformed slot: the operation's own key is never handed out", async () => {
    const t = await setup();
    await t.asDesignReview();
    for (const slot of [undefined, "", "slot-nobody", "SLOT-CRITIC", "../merge", "slot-critic%00"]) {
      const reply = await t.key(slot);
      expect(reply.status, String(slot)).toBe(403);
    }
    expect(t.access.mintKey).not.toHaveBeenCalled();
    // A review with no merge model has no merge slot.
    await t.asDesignReview({ merge: false });
    expect((await t.key("merge")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("an operation WITHOUT a stored binding is answered as before, whatever slot it names", async () => {
    const t = await setup();
    const plain = await t.key(undefined);
    expect(plain.status, plain.body).toBe(200);
    const withSlot = await t.key("slot-critic");
    expect(withSlot.status, withSlot.body).toBe(200);
    // Each ask mints an ordinary operation key (the earlier is superseded), with the ordinary life and no slot budget.
    expect(t.access.mintKey).toHaveBeenCalledTimes(2);
    expect(t.access.mintKey.mock.calls[1]![0].ttlSeconds).toBe(3_600);
    expect(t.access.mintKey.mock.calls[1]![0].maxBudgetUsd).toBe(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd);
    expect(bodyOf(withSlot).apiKey).not.toBe(bodyOf(plain).apiKey);
    expect(t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY")).toEqual([]);
  });

  it("gives no key when the slot has no allocated ceiling (nothing was allocated at dispatch, or the review had no room)", async () => {
    const t = await setup();
    await t.asDesignReview({ allocate: false });
    expect((await t.key("slot-critic")).status).toBe(402);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    // A review with no money left under its cap cannot even be allocated: nothing is written, and the caller does not dispatch.
    const none = await setup();
    await expect(none.asDesignReview({ capUsd: 5, spentUsd: 5 })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(none.asDesignReview({ capUsd: undefined })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(none.asDesignReview({ taskRoomUsd: 0 })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(none.db.find((item) => item.entityType === "DESIGN_REVIEW_ALLOCATION")).toEqual([]);
    expect((await none.key("slot-critic")).status).toBe(402);
    expect(none.access.mintKey).not.toHaveBeenCalled();
  });

  it("gives no key when the review is not in progress, or the task is not found", async () => {
    const t = await setup();
    await t.asDesignReview({ status: "done" });
    expect((await t.key("slot-critic")).status).toBe(403);
    await t.asDesignReview({ status: "not_run" });
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("gives no key for a model that cannot be used: forbidden, not offered to the account, not the binding's route, or not served", async () => {
    const t = await setup();
    t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", orgId: TEST_ORG, revision: 1, guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), forbiddenModels: [MODEL] } });
    await t.asDesignReview();
    expect((await t.key("slot-critic")).status).toBe(403);
    t.db.delete(agentGuardrailsKey(TEST_ORG));
    // The route the binding names must be the one the live sources serve.
    await t.asDesignReview({ modelRoute: { alias: "some-other-alias", api: "anthropic-messages", catalog: "x" } });
    expect((await t.key("slot-critic")).status).toBe(403);
    await t.asDesignReview({ model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-does-not-exist" } });
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    await t.asDesignReview();
    expect((await t.key("slot-critic")).status).toBe(200);
  });

  it("gives no key for a model this account cannot call (the usable-models resolution)", async () => {
    const t = await setup({ usableUnusable: [canonicalModelName(MODEL)] });
    await t.asDesignReview();
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("gives no key for a metered-catalog model with no list price: the proxy could not hold its spend to a budget", async () => {
    const t = await setup();
    await t.asDesignReview();
    catalog.unpriced = true;
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    catalog.unpriced = false;
    expect((await t.key("slot-critic")).status).toBe(200);
  });

  it("bills a metered-catalog key to the customer: the payer recorded for it is the task's member or project and its budgets are the customer's, never Rovara", async () => {
    const t = await setup();
    await t.asDesignReview();
    // No modelRoute in the binding: the model is served by Rovara's metered catalog, which is the customer's provider like any other.
    expect((await t.key("slot-critic")).status).toBe(200);
    const keyId = keyIdOf(t.access.mintedKeys()[0]!);
    const row = t.db.get(modelKeyKey(TEST_ORG, keyId)) as { tags: Record<string, string>; scopes?: unknown; orgId?: string };
    expect(row.tags.source).toBe("rovara");
    expect(["member", "project"]).toContain(row.tags.payerKind);
    expect(row.tags.payerId).toBe(row.tags.payerKind === "member" ? MAYA.developerId : "payments");
    expect(String(row.tags.payerId).toLowerCase()).not.toContain("rovara");
    // The spend is held on the customer's org and project budgets (the ledger scopes of the task's payer), not on any Rovara-side account.
    expect(JSON.stringify(row)).toContain(TEST_ORG);
    expect(JSON.stringify(row.scopes ?? row)).not.toMatch(/"kind":"rovara"/u);
  });

  it("cannot be handed out past the task's run limit when the slots ask together: the ceilings were allocated under it, in one write", async () => {
    const t = await setup();
    // The task has $1 left for model spend; the review's cap would allow $10. Three reviewers and the merge step ask at the same moment.
    t.db.set({ ...t.taskItem(), budgetUsd: 1 });
    const taskRoomUsd = await taskRunRoomUsd({ access: t.access }, { taskKeyIds: [], runLimitUsd: 1, stopAtUsd: 1 });
    expect(taskRoomUsd).toBe(1);
    await t.asDesignReview({ roles: ["critic", "codebase", "zoom_out"], capUsd: 10, taskRoomUsd });
    const allocation = t.db.find((item) => item.entityType === "DESIGN_REVIEW_ALLOCATION")[0]!;
    expect(allocation.totalUsd as number).toBeLessThanOrEqual(1);
    const replies = await Promise.all(["slot-critic", "slot-codebase", "slot-zoom_out", "merge"].map((slot) => t.key(slot)));
    expect(replies.map((reply) => reply.status), replies.map((reply) => reply.body).join("|")).toEqual([200, 200, 200, 200]);
    const caps = t.access.mintKey.mock.calls.map(([input]) => input.maxBudgetUsd);
    // Without the allocation each key would be given min(share, $1 left) = $1 and the four could spend $4.
    expect(caps.length).toBe(4);
    for (const cap of caps) expect(cap).toBeLessThanOrEqual(0.25);
    expect(caps.reduce((sum, cap) => sum + cap, 0)).toBeLessThanOrEqual(1);
  });

  it("allocates the round's ceilings in ONE conditional write, under both the review's room and the task's room, and refuses a second allocation", async () => {
    const t = await setup();
    const { binding } = await t.asDesignReview({ allocate: false });
    const input = { orgId: TEST_ORG, operationId: t.operationId, binding, nowMs: Date.now() };
    const sends = vi.spyOn(t.db, "send");
    const allocated = await allocateSlotBudgets(t.state, { ...input, reviewRoomUsd: 0.9, taskRoomUsd: 0.75 });
    // The least of the two rooms, shared by two reviewers and the merge step, rounded down.
    expect(allocated.ceilings).toEqual({ "slot-critic": 0.25, "slot-codebase": 0.25, merge: 0.25 });
    expect(allocated.totalUsd).toBeLessThanOrEqual(0.75);
    expect(sends.mock.calls.filter(([command]) => (command as { constructor: { name: string } }).constructor.name !== "GetCommand")).toHaveLength(1);
    sends.mockRestore();
    // A second allocation, with more room, is refused and changes nothing.
    await expect(allocateSlotBudgets(t.state, { ...input, reviewRoomUsd: 50, taskRoomUsd: 50 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.db.find((item) => item.entityType === "DESIGN_REVIEW_ALLOCATION")[0]).toMatchObject({ totalUsd: allocated.totalUsd, ceilings: allocated.ceilings });
    // The key is held to its ceiling although the review's cap and the task have far more.
    expect((await t.key("slot-critic")).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].maxBudgetUsd).toBe(0.25);
  });

  it("asked for by three slots at once, every slot gets its own key; two asks for one slot at once leave no usable key and never hand out a blocked-at-birth one", async () => {
    const t = await setup();
    await t.asDesignReview({ roles: ["critic", "codebase", "zoom_out"] });
    const replies = await Promise.all(["slot-critic", "slot-codebase", "slot-zoom_out", "merge"].map((slot) => t.key(slot)));
    expect(replies.map((reply) => reply.status), replies.map((reply) => reply.body).join("|")).toEqual([200, 200, 200, 200]);
    expect(new Set(replies.map((reply) => bodyOf(reply).apiKey)).size).toBe(4);
    expect(t.access.blockKey).not.toHaveBeenCalled();
    // The same slot asked twice at once: at most one key is handed out, the other ask is refused, and every key minted for the slot ends up blocked (the slot fails closed).
    const race = await setup();
    await race.asDesignReview();
    const both = await Promise.all([race.key("slot-critic"), race.key("slot-critic")]);
    expect(both.map((reply) => reply.status).sort(), both.map((reply) => reply.body).join("|")).toEqual([200, 403]);
    const minted = race.access.mintedKeys().map(keyIdOf);
    for (const id of minted) expect(race.access.blockKey).toHaveBeenCalledWith(id);
    const refused = both.find((reply) => reply.status === 403)!;
    for (const key of race.access.mintedKeys()) expect(refused.body).not.toContain(key);
    const ids = await designReviewKeyIds(race.state, race.operationItem() as never);
    expect(ids.bySlot.has("slot-critic")).toBe(false);
    expect(ids.askedAgain.has("slot-critic")).toBe(true);
    // The extra key's hold is released at once (it was reserved, then closed).
    for (const id of minted) expect(race.db.get(modelKeyKey(TEST_ORG, id))).toMatchObject({ reserved: true });
  });

  it("closes a key that could not be recorded: blocked at the proxy and its hold released, and the ask fails", async () => {
    const t = await setup();
    await t.asDesignReview();
    const real = t.db.send.bind(t.db);
    const failing = vi.spyOn(t.db, "send").mockImplementation((async (command: { constructor: { name: string }; input: { Item?: { entityType?: string } } }) => {
      if (command.constructor.name === "PutCommand" && command.input.Item?.entityType === "DESIGN_REVIEW_SLOT_KEY") throw new Error("table is down");
      return real(command);
    }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = await t.key("slot-critic");
    failing.mockRestore();
    logs.mockRestore();
    expect(reply.status).toBe(503);
    const [minted] = t.access.mintedKeys();
    expect(reply.body).not.toContain(minted);
    expect(t.access.blockKey).toHaveBeenCalledWith(keyIdOf(minted!));
    // The hold on the key is finalized (released), not left until a sweep.
    expect(t.db.get(modelKeyKey(TEST_ORG, keyIdOf(minted!)))).toMatchObject({ finalized: true });
    expect(t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY")).toEqual([]);
  });

  it("logs every refused slot key request once, with the operation, the slot and the fixed code, and nothing of a person or a key", async () => {
    const t = await setup();
    await t.asDesignReview();
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const refusedLines = () => logs.mock.calls.map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } }).filter((line) => line.event === "design_review.slot_key_refused");
    // The slot lookup: no slot, an unknown one, and one that is not a slot's shape (the client's text is not repeated).
    expect((await t.key(undefined)).status).toBe(403);
    expect((await t.key("slot-nobody")).status).toBe(403);
    expect((await t.key("../merge")).status).toBe(403);
    // The pass-through checks of model-access.ts: a stale fence, and the slot's checks: no allocated ceiling.
    const stale = issueCapability({ callbackSigningKey: SIGNING_KEY }, t.workspaceId, t.operationId, t.operationItem().fence + 1, { modelAccess: true });
    expect((await t.key("slot-critic", stale)).status).toBe(409);
    t.db.delete(`ORG#${TEST_ORG}#DESIGN_REVIEW#${t.operationId}`, "ALLOC");
    expect((await t.key("slot-critic")).status).toBe(402);
    // The slot's own checks: a forbidden model.
    await t.asDesignReview();
    t.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", orgId: TEST_ORG, revision: 1, guardrails: { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), forbiddenModels: [MODEL] } });
    expect((await t.key("slot-codebase")).status).toBe(403);
    const lines = refusedLines();
    expect(lines.map(({ slot, code }) => `${String(slot)} ${String(code)}`)).toEqual(["none FORBIDDEN", "slot-nobody FORBIDDEN", "invalid FORBIDDEN", "slot-critic STALE_FENCE", "slot-critic BUDGET_EXCEEDED", "slot-codebase MODEL_NOT_ALLOWED"]);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(["code", "component", "event", "operationId", "slot"]);
    for (const line of lines) expect(line.operationId).toBe(t.operationId);
    expect(JSON.stringify(lines)).not.toContain(MAYA.developerId);
    // A slot key that is handed out logs no refusal, and neither does an operation without a binding.
    t.db.delete(agentGuardrailsKey(TEST_ORG));
    expect((await t.key("slot-codebase")).status).toBe(200);
    t.db.set({ ...t.operationItem(), designReview: undefined });
    await t.key(undefined);
    expect(refusedLines()).toHaveLength(6);
    logs.mockRestore();
  });

  it("refuses the key when the binding stored on the operation changed after the request was resolved", async () => {
    const t = await setup();
    const { binding } = await t.asDesignReview();
    // The operation is read once to resolve the slot and once more to load the task's scope; a binding written in between must not be served with the old slot.
    const real = t.db.get.bind(t.db);
    let reads = 0;
    const spy = vi.spyOn(t.db, "get").mockImplementation(((pk: string, sk?: string) => {
      const item = real(pk, sk!);
      if (sk === `OPERATION#${t.operationId}` && item !== undefined && ++reads === 2) return { ...item, designReview: { ...binding, round: 2 } };
      return item;
    }));
    const reply = await t.key("slot-critic");
    spy.mockRestore();
    expect(reply.status).toBe(409);
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });
});

describe("the other model channels", () => {
  it("refuse a design-review operation: no ChatGPT token, no ChatGPT status, no model fallback", async () => {
    const t = await setup();
    await t.asDesignReview();
    const binding = { version: 1 as const, stage: "plan_check" as const, companyRevision: 1, recipeDigest: "a".repeat(64) };
    for (const action of ["chatgpt-token", "chatgpt-status", "model-fallback"] as const) {
      const capability = issueCapability({ callbackSigningKey: SIGNING_KEY }, t.workspaceId, t.operationId, t.operationItem().fence, { chatGptToken: true, modelPolicy: binding });
      const reply = await rawPost(t.handler, `/v1/internal/workspaces/${t.workspaceId}/operations/${t.operationId}/${action}`, capability);
      expect(reply.status, `${action} ${reply.body}`).toBe(409);
      expect(reply.body, action).toContain("A design review cannot use this action.");
    }
    // The same capability on an ordinary plan check (no binding) is NOT refused by this guard.
    t.db.set({ ...t.operationItem(), designReview: undefined });
    const ordinary = await rawPost(t.handler, `/v1/internal/workspaces/${t.workspaceId}/operations/${t.operationId}/chatgpt-token`, issueCapability({ callbackSigningKey: SIGNING_KEY }, t.workspaceId, t.operationId, t.operationItem().fence, { chatGptToken: true }));
    expect(ordinary.body).not.toContain("A design review cannot use this action.");
  });
});

describe("running a design review without a model proxy", () => {
  it("is refused as not run (no verified model) where the broker has no proxy, and allowed where it has one", () => {
    expect(designReviewProxyCheck({})).toEqual({ ok: false, notRunReason: "no_verified_model" });
    expect(designReviewProxyCheck({ modelAccess: { access: fakeModelAccess(), proxyUrl: "" } })).toEqual({ ok: false, notRunReason: "no_verified_model" });
    expect(designReviewProxyCheck({ modelAccess: { access: fakeModelAccess(), proxyUrl: PROXY_URL } })).toEqual({ ok: true });
  });
});
