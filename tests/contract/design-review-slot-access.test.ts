// Design review stage, DR7 slice A (security S1 to S9, N4; money W5): the packet route and the per-slot model keys, through the real broker over a fake table and a fake proxy.
// A design-review operation is a PLAN_CRITIQUE operation that carries a stored `designReview` binding; the stored binding, never the worker, decides which slots exist.
import { randomUUID } from "node:crypto";
import type * as CatalogModule from "@agentx/model-runtime/catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUARDRAILS, DesignReviewBindingSchema, PacketDeliverySchema, agentGuardrailsKey, canonicalModelName, modelKeyKey, packetDigestOf, type DesignReviewBinding, type ModelIdentifier, type ReviewerRole } from "@agentx/contracts";
import { designReviewKeyBudgets } from "../../packages/broker/src/design-review/estimate.js";
import { buildReviewerPacket, type PacketReaders } from "../../packages/broker/src/design-review/packet.js";
import { putSlotPackets, readSlotPacket } from "../../packages/broker/src/design-review/packet-store.js";
import { designReviewProxyCheck } from "../../packages/broker/src/design-review/proxy-check.js";
import { DESIGN_REVIEW_KEY_TTL_SECONDS, designReviewKeyIds, designReviewNoOperationKeyId } from "../../packages/broker/src/design-review/slot-keys.js";
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
  async function asDesignReview(over: { roles?: ReviewerRole[]; merge?: boolean; capUsd?: number | undefined; spentUsd?: number; status?: string; modelRoute?: DesignReviewBinding["reviewers"][number]["modelRoute"]; model?: ModelIdentifier; storePackets?: boolean } = {}) {
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
    if (over.storePackets !== false) await putSlotPackets(state, { orgId: TEST_ORG, operationId, packets: [...built.entries()].map(([keySlot, packet]) => ({ keySlot, packet })), nowMs: Date.now() });
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
    expect(first.body).toBe((await readSlotPacket(t.state as never, TEST_ORG, t.operationId, "slot-critic"))!.text);
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
    expect((await t.packet("slot-critic")).status).toBe(404);
    await putSlotPackets(t.state, { orgId: "org_bbbbbbbbbbbbbbbbbbbb", operationId: t.operationId, packets: [{ keySlot: "slot-critic", packet: built.get("slot-critic")! }], nowMs: Date.now() });
    expect((await t.packet("slot-critic")).status).toBe(404);
  });
});

describe("a slot's model key", () => {
  it("is minted for the slot alone, limited to its model, with its share of the review's money and a life past a reviewer's run", async () => {
    const t = await setup();
    await t.asDesignReview({ capUsd: 10, spentUsd: 1 });
    const reply = await t.key("slot-critic");
    expect(reply.status, reply.body).toBe(200);
    expect(bodyOf(reply)).toMatchObject({ baseUrl: PROXY_URL, apiKey: t.access.mintedKeys()[0] });
    const input = t.access.mintKey.mock.calls[0]![0];
    // Two reviewers and the merge step share what is left under the cap.
    expect(input.maxBudgetUsd).toBe(designReviewKeyBudgets({ capUsd: 10, spentUsd: 1, reviewers: 2, hasMergeModel: true }).reviewerUsd);
    expect(input.maxBudgetUsd).toBe(3);
    expect(input.models).toHaveLength(1);
    expect(input.models![0]).toBe(MODEL.modelId);
    expect(input.ttlSeconds).toBe(DESIGN_REVIEW_KEY_TTL_SECONDS);
    expect(input.ttlSeconds).toBeGreaterThanOrEqual(15 * 60 + 60);
    expect(input.refId).toBe(t.taskId);
    // It is the customer's key like any other of the task: reserved against its budgets, tagged with the task and the operation, and recorded on both.
    const keyId = keyIdOf(t.access.mintedKeys()[0]!);
    expect(t.db.get(modelKeyKey(TEST_ORG, keyId))).toMatchObject({ reserved: true, capUsd: 3, tags: { taskId: t.taskId, operationId: t.operationId } });
    expect(t.taskItem().modelKeyIds).toContain(keyId);
    expect(t.operationItem().modelKeyIds).toContain(keyId);
    // The key is kept sealed: the stored record names the key's id and never the key.
    expect(JSON.stringify(t.db.find(() => true))).not.toContain(t.access.mintedKeys()[0]);
  });

  it("is the same key each time while it lives, differs from every other slot's, and the merge slot has its own", async () => {
    const t = await setup();
    await t.asDesignReview();
    const critic = bodyOf(await t.key("slot-critic"));
    const codebase = bodyOf(await t.key("slot-codebase"));
    const merge = bodyOf(await t.key("merge"));
    expect(new Set([critic.apiKey, codebase.apiKey, merge.apiKey]).size).toBe(3);
    const mintsBefore = t.access.mintKey.mock.calls.length;
    for (const [slot, first] of [["slot-critic", critic], ["slot-codebase", codebase], ["merge", merge]] as const) {
      const again = bodyOf(await t.key(slot));
      expect(again.apiKey).toBe(first.apiKey);
      expect(again.expiresAt).toBe(first.expiresAt);
    }
    expect(t.access.mintKey.mock.calls.length).toBe(mintsBefore);
    expect(mintsBefore).toBe(3);
    expect(t.access.revokeKey).not.toHaveBeenCalled();
    // Minting a slot's key never blocks the keys of the slots that run beside it.
    expect(t.access.blockKey).not.toHaveBeenCalled();
  });

  it("records each slot's key id for verifyRound, the merge key apart, and an operation key that is none of them", async () => {
    const t = await setup();
    const { built } = await t.asDesignReview();
    const keys = { critic: bodyOf(await t.key("slot-critic")).apiKey as string, codebase: bodyOf(await t.key("slot-codebase")).apiKey as string, merge: bodyOf(await t.key("merge")).apiKey as string };
    const ids = await designReviewKeyIds(t.state, t.operationItem() as never);
    expect(ids.bySlot.get("slot-critic")).toBe(keyIdOf(keys.critic));
    expect(ids.bySlot.get("slot-codebase")).toBe(keyIdOf(keys.codebase));
    expect(ids.mergeKeyId).toBe(keyIdOf(keys.merge));
    expect(ids.operationKeyId).toBe(designReviewNoOperationKeyId(t.operationId));
    expect([...ids.bySlot.values()]).not.toContain(ids.operationKeyId);
    // The reviewer that ran on its own key verifies; one that reports another reviewer's key, or the operation's, does not.
    const packet = { packetDigest: built.get("slot-critic")!.packetDigest, estimatedInputTokens: 1_000 };
    const report = (modelKeyId: string) => ({ sessionId: "s1", packetDigest: packet.packetDigest, firstRequestMessages: 2, filesRead: [], tools: ["read"], modelKeyId });
    const verify = (modelKeyId: string) => verifyReviewerReport({ packet, report: report(modelKeyId), usedSessionIds: new Set(), usage: { kind: "unavailable" },
      modelKey: { keyId: ids.bySlot.get("slot-critic")!, otherReviewerKeyIds: new Set([ids.bySlot.get("slot-codebase")!, ids.mergeKeyId!]), operationKeyId: ids.operationKeyId } });
    expect(await verify(keyIdOf(keys.critic))).toMatchObject({ verified: true });
    expect(await verify(keyIdOf(keys.codebase))).toEqual({ verified: false, failure: "model_key_mismatch" });
    expect(await verify(ids.operationKeyId)).toEqual({ verified: false, failure: "model_key_mismatch" });
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

  it("gives no key when the review has no money left under its cap, or no cap", async () => {
    const t = await setup();
    await t.asDesignReview({ capUsd: 5, spentUsd: 5 });
    expect((await t.key("slot-critic")).status).toBe(402);
    await t.asDesignReview({ capUsd: undefined });
    expect((await t.key("slot-critic")).status).toBe(402);
    expect(t.access.mintKey).not.toHaveBeenCalled();
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

  it("gives no Rovara-paid access to a model with no list price", async () => {
    const t = await setup();
    await t.asDesignReview();
    catalog.unpriced = true;
    expect((await t.key("slot-critic")).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    catalog.unpriced = false;
    expect((await t.key("slot-critic")).status).toBe(200);
  });

  it("mints a fresh key for a slot whose kept key has expired, and the record names the new one", async () => {
    const t = await setup();
    await t.asDesignReview();
    const first = bodyOf(await t.key("slot-critic"));
    const record = t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]!;
    t.db.set({ ...record, expiresAt: Date.now() + 30_000 });
    const second = bodyOf(await t.key("slot-critic"));
    expect(second.apiKey).not.toBe(first.apiKey);
    const ids = await designReviewKeyIds(t.state, t.operationItem() as never);
    expect(ids.bySlot.get("slot-critic")).toBe(keyIdOf(second.apiKey as string));
    // A record that no longer opens (damaged) is treated the same way, never served.
    t.db.set({ ...t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY" && item.keySlot === "slot-critic")[0]!, sealed: "AAAA" });
    expect(bodyOf(await t.key("slot-critic")).apiKey).not.toBe(second.apiKey);
  });

  it("does not hand a key kept for another operation or org to this one", async () => {
    const t = await setup();
    await t.asDesignReview();
    const first = bodyOf(await t.key("slot-critic"));
    const record = t.db.find((item) => item.entityType === "DESIGN_REVIEW_SLOT_KEY")[0]!;
    // The same sealed key moved under another operation's record is refused (the seal is bound to the org, operation and slot).
    const moved = { ...record, pk: record.pk, sk: record.sk, operationId: "someone-else" };
    t.db.set(moved);
    expect(bodyOf(await t.key("slot-critic")).apiKey).not.toBe(first.apiKey);
  });

  it("asked for by three slots at once, every slot gets a key, and two asks for one slot answer with one key", async () => {
    const t = await setup();
    await t.asDesignReview({ roles: ["critic", "codebase", "zoom_out"] });
    const replies = await Promise.all(["slot-critic", "slot-codebase", "slot-zoom_out", "merge"].map((slot) => t.key(slot)));
    expect(replies.map((reply) => reply.status), replies.map((reply) => reply.body).join("|")).toEqual([200, 200, 200, 200]);
    expect(new Set(replies.map((reply) => bodyOf(reply).apiKey)).size).toBe(4);
    const both = await Promise.all([t.key("slot-critic"), t.key("slot-critic")]);
    expect(bodyOf(both[0]).apiKey).toBe(bodyOf(both[1]).apiKey);
    // A twin that lost the race is given back, never left live.
    const ids = await designReviewKeyIds(t.state, t.operationItem() as never);
    const minted = t.access.mintedKeys().map(keyIdOf);
    const kept = new Set(ids.bySlot.values());
    for (const orphan of minted.filter((id) => !kept.has(id))) expect(t.access.blockKey).toHaveBeenCalledWith(orphan);
  });
});

describe("running a design review without a model proxy", () => {
  it("is refused as not run (no verified model) where the broker has no proxy, and allowed where it has one", () => {
    expect(designReviewProxyCheck({})).toEqual({ ok: false, notRunReason: "no_verified_model" });
    expect(designReviewProxyCheck({ modelAccess: { access: fakeModelAccess(), proxyUrl: "" } })).toEqual({ ok: false, notRunReason: "no_verified_model" });
    expect(designReviewProxyCheck({ modelAccess: { access: fakeModelAccess(), proxyUrl: PROXY_URL } })).toEqual({ ok: true });
  });
});
